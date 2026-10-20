import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { redactText } from "./report-dws.ts";
import {
  REPORT_PREVIEW_CHARS,
  type ReportWriteAudit,
} from "./report-write-types.ts";

/**
 * Report write store (F6-P1) — 写审计（writes.jsonl）的本机存取。
 * donor: scripts/lib/report/index.js outbox 已提交状态 + V2 reply 桥 sends.jsonl 先例：
 * - append-only：一行一次真实外部写尝试 / 一次回读校验，只追加、绝不改写；
 * - 0600 文件 / 0700 目录（沿 reply-store 口径）；
 * - 正文只落掩码预览（先 redactText 脱敏、折空白、截 24 字），审计不落全文；
 * - 坏行跳过，绝不因一行坏丢整账；文件缺失 → 如实空表。
 * 冷却（submit run-now 5 分钟）从审计派生（lastSubmitRunMs），重启不能刷冷却。
 */

/* dev/report/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_REPORT_WRITE_DIR = joinPath(PROJECT_ROOT, ".local-cache", "report");

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 审计掩码预览：先脱敏、折空白、截 24 字（长文加省略号）——审计不落全文。 */
export function maskWritePreview(text: string): string {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length > REPORT_PREVIEW_CHARS ? `${flat.slice(0, REPORT_PREVIEW_CHARS)}…` : flat;
}

/** 审计行白名单投影：坏行返回 null（读路径双保险，不猜不补）。 */
export function projectWriteAudit(raw: unknown): ReportWriteAudit | null {
  if (!isRecord(raw)) return null;
  const op = raw.op === "save" || raw.op === "submit" ? raw.op : null;
  const phase = raw.phase === "update" || raw.phase === "run" || raw.phase === "verify" ? raw.phase : null;
  const at = asText(raw.at);
  if (!op || !phase || !at) return null;
  const rawCode = raw.exitCode;
  const exitCode: number | string | null =
    typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? rawCode : null;
  return {
    at,
    op,
    phase,
    target: asText(raw.target),
    exitCode,
    executed: raw.executed === true,
    ok: raw.ok === true,
    verified: raw.verified === true,
    maskedPreview: asText(raw.maskedPreview),
  };
}

export interface ReportWriteStore {
  /** 追加一行写审计（append-only，0600）。 */
  readonly appendWrite: (row: ReportWriteAudit) => Promise<void>;
  /** 全量审计行（时间正序；坏行跳过）；文件缺失 → 如实空表。 */
  readonly readWrites: () => Promise<readonly ReportWriteAudit[]>;
  /** 最近一次真实 submit run-now 尝试的毫秒时间（冷却派生用；无 → 0）。 */
  readonly lastSubmitRunMs: () => Promise<number>;
}

export function createReportWriteStore(dir: string): ReportWriteStore {
  const writesPath = joinPath(dir, "writes.jsonl");

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    /* mkdir 对已存在目录不改权限：显式收敛一次，保证 0700 口径稳定。 */
    await chmod(dir, 0o700).catch(() => {});
  }

  async function appendWrite(row: ReportWriteAudit): Promise<void> {
    await ensureDir();
    await appendFile(writesPath, `${JSON.stringify(row)}\n`, { encoding: "utf-8", mode: 0o600 });
    await chmod(writesPath, 0o600).catch(() => {});
  }

  async function readWrites(): Promise<readonly ReportWriteAudit[]> {
    let raw: string;
    try {
      raw = await readFile(writesPath, "utf-8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return projectWriteAudit(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is ReportWriteAudit => row !== null);
  }

  async function lastSubmitRunMs(): Promise<number> {
    const rows = await readWrites();
    let max = 0;
    for (const row of rows) {
      if (row.op !== "submit" || row.phase !== "run" || !row.executed) continue;
      const parsed = Date.parse(row.at);
      if (Number.isFinite(parsed) && parsed > max) max = parsed;
    }
    return max;
  }

  return { appendWrite, readWrites, lastSubmitRunMs };
}
