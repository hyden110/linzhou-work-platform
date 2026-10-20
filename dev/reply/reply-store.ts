import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import {
  REPLY_HISTORY_LIMIT,
  type ReplyDraftRow,
  type ReplyQuota,
  type ReplySendAudit,
} from "./reply-types.ts";

/**
 * Reply store (F9) — 草稿历史 / 额度账本 / 发送审计的本机存取。
 * donor: scripts/lib/reply/store.js（sqlite 三表）→ V2 落 .local-cache/reply/ 三文件：
 * - store.json   草稿历史（只存结论不存输入上下文；cap 200；损坏如实空表绝不静默重建真相）；
 * - quota.json   额度账本（day + total + conv 计数；跨日归零；只有会话键与次数，无正文）；
 * - sends.jsonl  发送审计（append-only；一行一次真实子进程尝试；正文只落掩码预览）。
 * 写路径全部 0600（目录 0700）+ 唯一 tmp + rename 原子写（沿 notify/ontology 桥口径）。
 */

/* dev/reply/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_REPLY_DIR = joinPath(PROJECT_ROOT, ".local-cache", "reply");

/** 北京时区日键（额度按自然日归零，工作台口径统一东八区）。 */
export function beijingDayKey(nowMs: number): string {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 草稿行白名单投影：坏行返回 null（读路径双保险，坏行丢弃不猜）。 */
export function projectDraftRow(raw: unknown): ReplyDraftRow | null {
  if (!isRecord(raw)) return null;
  const sid = asText(raw.sid);
  const id = asText(raw.id);
  if (!sid || !id) return null;
  return {
    sid,
    id,
    convKey: asText(raw.convKey),
    convTitle: asText(raw.convTitle),
    needReply: raw.needReply === true,
    text: asText(raw.text),
    tone: asText(raw.tone),
    reason: asText(raw.reason),
    ms: asNumber(raw.ms),
    engine: asText(raw.engine),
    at: asText(raw.at),
  };
}

/** 审计行白名单投影：坏行返回 null；exitCode 只认 数字/字符串/null 三形态。 */
export function projectSendAudit(raw: unknown): ReplySendAudit | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id);
  if (!id) return null;
  const rawCode = raw.exitCode;
  const exitCode: number | string | null =
    typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? rawCode : null;
  return {
    at: asText(raw.at),
    id,
    group: asText(raw.group),
    exitCode,
    maskedPreview: asText(raw.maskedPreview),
  };
}

function emptyQuota(day: string): ReplyQuota {
  return { day, total: 0, conv: {} };
}

/** quota.json 读回投影：形态不符/跨日一律回当日新账本（total 0，绝不带上旧账）。 */
function projectQuota(raw: unknown, day: string): ReplyQuota {
  if (!isRecord(raw) || asText(raw.day) !== day) return emptyQuota(day);
  const rawConv = isRecord(raw.conv) ? raw.conv : {};
  const conv: Record<string, { count: number }> = {};
  for (const [key, value] of Object.entries(rawConv)) {
    const count = isRecord(value) ? asNumber(value.count) : 0;
    if (count > 0) conv[key] = { count };
  }
  return { day, total: Math.max(0, asNumber(raw.total)), conv };
}

export interface ReplyStore {
  /** 草稿历史（最新在前，≤ REPLY_HISTORY_LIMIT）；文件缺失/损坏 → 如实空表。 */
  readonly loadHistory: () => Promise<readonly ReplyDraftRow[]>;
  /** 记一条草稿结论：头部插入 + cap 200 + 0600 原子写。 */
  readonly recordDraft: (row: ReplyDraftRow) => Promise<void>;
  /** 读额度账本：跨日/损坏一律回当日新账本（total 0）。 */
  readonly loadQuota: (day: string) => Promise<ReplyQuota>;
  /** 落额度账本（0600 原子写）。 */
  readonly saveQuota: (quota: ReplyQuota) => Promise<void>;
  /** 追加一行发送审计（append-only，0600）。 */
  readonly appendSend: (audit: ReplySendAudit) => Promise<void>;
  /** 读审计尾 limit 行（最新在前）；缺失/损坏 → 如实空表（坏行跳过）。 */
  readonly readSends: (limit: number) => Promise<readonly ReplySendAudit[]>;
  /** 全量成功发送（exitCode 0）的候选 id 集合：candidates 派生 replied 位用。 */
  readonly loadSentIds: () => Promise<ReadonlySet<string>>;
}

export interface ReplyStoreOptions {
  readonly now?: () => number;
}

export function createReplyStore(dir: string, options: ReplyStoreOptions = {}): ReplyStore {
  const now = options.now ?? Date.now;
  const historyPath = joinPath(dir, "store.json");
  const quotaPath = joinPath(dir, "quota.json");
  const sendsPath = joinPath(dir, "sends.jsonl");

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    /* mkdir 对已存在目录不改权限：显式收敛一次，保证 0700 口径稳定。 */
    await chmod(dir, 0o700).catch(() => {});
  }

  /** 0600 原子写：唯一 tmp + rename；失败清理 tmp（沿 notify 桥口径）。 */
  async function writeAtomic(path: string, payload: string): Promise<void> {
    await ensureDir();
    const tmpPath = `${path}.${process.pid}.${now()}.tmp`;
    try {
      await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, path);
      await chmod(path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  async function readJsonLenient(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch {
      return null;
    }
  }

  async function loadHistory(): Promise<readonly ReplyDraftRow[]> {
    const raw = await readJsonLenient(historyPath);
    const rows = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : [];
    return rows
      .map((row) => projectDraftRow(row))
      .filter((row): row is ReplyDraftRow => row !== null)
      .slice(0, REPLY_HISTORY_LIMIT);
  }

  async function recordDraft(row: ReplyDraftRow): Promise<void> {
    const current = await loadHistory();
    const next = [row, ...current].slice(0, REPLY_HISTORY_LIMIT);
    await writeAtomic(historyPath, JSON.stringify({ savedAt: new Date(now()).toISOString(), rows: next }, null, 2));
  }

  async function loadQuota(day: string): Promise<ReplyQuota> {
    return projectQuota(await readJsonLenient(quotaPath), day);
  }

  async function saveQuota(quota: ReplyQuota): Promise<void> {
    await writeAtomic(quotaPath, JSON.stringify(quota, null, 1));
  }

  async function appendSend(audit: ReplySendAudit): Promise<void> {
    await ensureDir();
    await appendFile(sendsPath, `${JSON.stringify(audit)}\n`, { encoding: "utf-8", mode: 0o600 });
    await chmod(sendsPath, 0o600).catch(() => {});
  }

  /** 审计全量读（append-only 文件天然按时间正序）；坏行跳过，绝不因一行坏丢整账。 */
  async function readAllSends(): Promise<readonly ReplySendAudit[]> {
    let raw: string;
    try {
      raw = await readFile(sendsPath, "utf-8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return projectSendAudit(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is ReplySendAudit => row !== null);
  }

  async function readSends(limit: number): Promise<readonly ReplySendAudit[]> {
    const all = await readAllSends();
    return all.slice(Math.max(0, all.length - limit)).reverse();
  }

  async function loadSentIds(): Promise<ReadonlySet<string>> {
    const all = await readAllSends();
    return new Set(all.filter((row) => row.exitCode === 0).map((row) => row.id));
  }

  return { loadHistory, recordDraft, loadQuota, saveQuota, appendSend, readSends, loadSentIds };
}
