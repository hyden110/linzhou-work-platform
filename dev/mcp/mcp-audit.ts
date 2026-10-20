import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import type { McpAuditRow } from "./mcp-types.ts";

/**
 * MCP 服务审计日志 — append-only jsonl（0600），绝不落 key 材料。
 * donor: scripts/lib/mcpserver/audit.js（搬语义不搬代码）。
 *
 * 每行一条 JSON：{at, action, keyId, target, ok, note}。action 取值：
 * key_created / key_revoked / service_toggle / connector_write / connector_check / rpc_call。
 * note 只允许掩码级信息（hashPrefix、连接器名、op）；写失败不阻断主流程（旁路）。
 */

/* dev/mcp/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_MCP_AUDIT_FILE = joinPath(PROJECT_ROOT, ".local-cache", "mcp", "audit.jsonl");

/** GET /local/mcp/service 附带审计尾的读取上限（同 MCP_AUDIT_TAIL 口径）。 */
const RECENT_HARD_CAP = 200;

export interface McpAuditInput {
  readonly action: string;
  readonly keyId?: number | null;
  readonly target?: string;
  readonly ok?: boolean;
  readonly note?: string;
}

export interface McpAuditLog {
  readonly append: (rec: McpAuditInput) => Promise<void>;
  readonly recent: (limit?: number) => Promise<readonly McpAuditRow[]>;
  readonly file: () => string;
}

export interface McpAuditLogOptions {
  readonly file?: string;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 审计行白名单投影：坏行返回 null（读路径双保险，坏行丢弃不猜）。 */
export function projectAuditRow(raw: unknown): McpAuditRow | null {
  if (!isRecord(raw)) return null;
  const action = typeof raw.action === "string" ? raw.action : "";
  if (!action) return null;
  const keyId = typeof raw.keyId === "number" && Number.isInteger(raw.keyId) ? raw.keyId : null;
  return {
    at: typeof raw.at === "string" ? raw.at : "",
    action,
    keyId,
    target: typeof raw.target === "string" ? raw.target.slice(0, 200) : "",
    ok: raw.ok === true,
    note: typeof raw.note === "string" ? raw.note.slice(0, 300) : "",
  };
}

export function createAuditLog(options: McpAuditLogOptions = {}): McpAuditLog {
  const file = options.file ?? DEFAULT_MCP_AUDIT_FILE;
  const now = options.now ?? Date.now;

  async function append(rec: McpAuditInput): Promise<void> {
    const row = {
      at: new Date(now()).toISOString(),
      action: String(rec.action).slice(0, 40),
      keyId: typeof rec.keyId === "number" ? rec.keyId : null,
      target: String(rec.target ?? "").slice(0, 200),
      ok: rec.ok !== false,
      note: String(rec.note ?? "").slice(0, 300),
    };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dirname(file), 0o700).catch(() => {});
    await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: "utf-8", mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }

  /** 审计尾（最新在前）；缺失/损坏 → 如实空表，坏行跳过绝不因一行坏丢整账。 */
  async function recent(limit = 20): Promise<readonly McpAuditRow[]> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), RECENT_HARD_CAP);
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      return [];
    }
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return projectAuditRow(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is McpAuditRow => row !== null);
    return rows.slice(Math.max(0, rows.length - n)).reverse();
  }

  return { append, recent, file: () => file };
}
