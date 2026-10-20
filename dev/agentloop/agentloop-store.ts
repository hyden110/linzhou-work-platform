/**
 * AgentLoop store — 凭据文件（0600 原子写）+ 出票审计（append-only jsonl）。
 * donor: tools/credctl.js（0600/掩码口径）+ scripts/lib/agentloop.js 审计语义。
 * 落 .local-cache/agentloop/：creds.json（AK/SK，只写不回显）、tickets.jsonl（审计）。
 * 写路径全部 0600（目录 0700）+ 唯一 tmp + rename 原子写（沿 reply/notify 桥口径）。
 */

import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import type { AgentloopCreds, AgentloopTicketAudit } from "./agentloop-types.ts";

/* dev/agentloop/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_AGENTLOOP_DIR = joinPath(PROJECT_ROOT, ".local-cache", "agentloop");

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 审计行白名单投影：缺 at/status 的残行返回 null；status 非 "ok" 一律按 "error" 呈现（绝不假绿）。 */
export function projectTicketAudit(raw: unknown): AgentloopTicketAudit | null {
  if (!isRecord(raw)) return null;
  const at = asText(raw.at);
  if (!at || raw.status === undefined || raw.status === null) return null;
  return {
    at,
    action: "ticket",
    status: raw.status === "ok" ? "ok" : "error",
    ticketMask: asText(raw.ticketMask),
    ttl: asNumber(raw.ttl),
    expireAt: asText(raw.expireAt),
    reason: asText(raw.reason),
  };
}

export interface AgentloopStore {
  /** 读凭据：缺失/损坏 → null（如实「未设置」，绝不猜）。 */
  readonly loadCreds: () => Promise<AgentloopCreds | null>;
  /** 写凭据（0600 原子写）；失败上抛由桥映射 store_unavailable。 */
  readonly saveCreds: (ak: string, sk: string) => Promise<AgentloopCreds>;
  /** 删除凭据（幂等）：返回是否真删了东西。 */
  readonly clearCreds: () => Promise<boolean>;
  /** 追加一行出票审计（append-only，0600）。 */
  readonly appendTicketAudit: (audit: AgentloopTicketAudit) => Promise<void>;
  /** 读审计尾 limit 行（最新在前）；缺失/坏行如实跳过。 */
  readonly readTicketAudits: (limit: number) => Promise<readonly AgentloopTicketAudit[]>;
}

export interface AgentloopStoreOptions {
  readonly now?: () => number;
}

export function createAgentloopStore(dir: string, options: AgentloopStoreOptions = {}): AgentloopStore {
  const now = options.now ?? Date.now;
  const credsPath = joinPath(dir, "creds.json");
  const ticketsPath = joinPath(dir, "tickets.jsonl");

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    /* mkdir 对已存在目录不改权限：显式收敛一次，保证 0700 口径稳定。 */
    await chmod(dir, 0o700).catch(() => {});
  }

  /** 0600 原子写：唯一 tmp + rename；失败清理 tmp（沿 reply 桥口径）。 */
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

  /** 凭据读回投影：ak/sk 任一缺失即视为未设置（半份凭据不如没有）。 */
  function projectCreds(raw: unknown): AgentloopCreds | null {
    if (!isRecord(raw)) return null;
    const ak = asText(raw.accessKeyId);
    const sk = asText(raw.accessKeySecret);
    if (!ak || !sk) return null;
    return { ak, sk, updatedAt: asText(raw.updatedAt) };
  }

  async function loadCreds(): Promise<AgentloopCreds | null> {
    try {
      return projectCreds(JSON.parse(await readFile(credsPath, "utf-8")));
    } catch {
      return null; // 缺失/损坏：如实「未设置」，绝不静默重建
    }
  }

  async function saveCreds(ak: string, sk: string): Promise<AgentloopCreds> {
    const updatedAt = new Date(now()).toISOString();
    await writeAtomic(credsPath, JSON.stringify({ accessKeyId: ak, accessKeySecret: sk, updatedAt }, null, 1));
    return { ak, sk, updatedAt };
  }

  async function clearCreds(): Promise<boolean> {
    try {
      await unlink(credsPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function appendTicketAudit(audit: AgentloopTicketAudit): Promise<void> {
    await ensureDir();
    await appendFile(ticketsPath, `${JSON.stringify(audit)}\n`, { encoding: "utf-8", mode: 0o600 });
    await chmod(ticketsPath, 0o600).catch(() => {});
  }

  /** 审计全量读（append-only 文件天然按时间正序）；坏行跳过，绝不因一行坏丢整账。 */
  async function readTicketAudits(limit: number): Promise<readonly AgentloopTicketAudit[]> {
    let raw: string;
    try {
      raw = await readFile(ticketsPath, "utf-8");
    } catch {
      return [];
    }
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return projectTicketAudit(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is AgentloopTicketAudit => row !== null);
    return rows.slice(Math.max(0, rows.length - limit)).reverse();
  }

  return { loadCreds, saveCreds, clearCreds, appendTicketAudit, readTicketAudits };
}
