/**
 * Worklog collector (dev) — 本机 Qoder 系工作库的只读扫描（donor:
 * base/sa-workbench tools/fetch/worklog_collect.js，搬语义不搬代码）。
 *
 * 红线（不可放宽）：
 * - 只读：所有源库一律以 node:sqlite readOnly 打开（donor 同口径），本模块对源库
 *   零写入、零副作用文件；测试用临时合成库断言扫描前后 sha256/size/mtime 不变。
 * - 路径：源库路径只由固定实例名在 app support 根内拼出；assertWithinRoot 拒绝
 *   相对路径、.. 穿越与根外路径。
 * - 隐私：错误备注回传前脱敏（源库绝对路径/根目录/家目录一律替换），不出绝对路径。
 * - 无凭据接触、无子进程：整个采集面只有本地 sqlite 只读查询，SQL 全为常量。
 *
 * 语义（与 donor 对齐）：
 * - vscdb（Qoder/QoderCN state.vscdb）：ItemTable 里 lingma.chat.localHistory.% 的
 *   JSON 数组，同 sessionId 多轮取最早一条的标题代表任务；
 * - agents（QoderWork/QwenWorkCN agents.db）：chats 表 chat_type='task' 且未删除
 *   未归档，created_at 秒/毫秒双形态兼容；
 * - 时间过滤：本桥按请求范围 [fromMs, toMs] 闭区间取（donor 是水位增量，
 *   V2 是只读查询面，语义换算为范围过滤）。
 */

import { existsSync as defaultExistsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";

/** 标题上限（donor TITLE_MAX=160）。 */
export const WORKLOG_TITLE_MAX = 160;
/** 源库缺失时的诚实说明（直接可展示）。 */
export const SOURCE_MISSING_NOTE = "未安装或库文件不存在";

/** donor INVISIBLE_RE：零宽/双向控制字符会整单被下游拒绝，采集侧先清掉。 */
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

const VSCDB_SQL = "SELECT value FROM ItemTable WHERE key LIKE 'lingma.chat.localHistory.%'";
const AGENTS_SQL = "SELECT id, name, created_at FROM chats WHERE chat_type = 'task' AND deleted_at IS NULL AND archived_at IS NULL";

/** 只读 sqlite 游标契约（测试注入假 reader；缺省 node:sqlite readOnly 实现）。 */
export interface SqliteReader {
  all(sql: string): readonly Record<string, unknown>[];
  close(): void;
}
export type SqliteOpener = (dbPath: string) => SqliteReader;

export interface WorklogSource {
  readonly instance: string;
  readonly kind: "vscdb" | "agents";
  readonly dbPath: string;
}

export interface CollectedSession {
  readonly sessionId: string;
  readonly ts: number;
  readonly title: string;
}

export type SourceScanStatus = "ok" | "missing" | "error";

export interface SourceScanResult {
  readonly source: WorklogSource;
  readonly status: SourceScanStatus;
  readonly note?: string;
  readonly sessions: readonly CollectedSession[];
}

export interface ScanDeps {
  readonly openReader: SqliteOpener;
  readonly existsSync?: (path: string) => boolean;
  /** 传入即启用路径红线校验：dbPath 必须在该根内（绝对路径、无 .. 穿越）。 */
  readonly root?: string;
}

export interface SessionRange {
  readonly fromMs: number;
  readonly toMs: number;
}

/** 标题规整（donor clipTitle）：去不可见字符、折空白、160 字截断加省略号。 */
export function clipWorklogTitle(value: unknown): string {
  const flat = String(value ?? "").replace(INVISIBLE_RE, "").trim().replace(/\s+/g, " ");
  return flat.length > WORKLOG_TITLE_MAX ? `${flat.slice(0, WORKLOG_TITLE_MAX)}…` : flat;
}

/** 路径红线：candidate 必须是绝对路径且落在 root 内（前缀相似目录不算在内）。 */
export function assertWithinRoot(root: string, candidate: string): void {
  if (!isAbsolute(candidate)) {
    throw new Error("源库路径必须是绝对路径。");
  }
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error("路径越界：源库必须位于本机工作库根目录内。");
  }
}

/**
 * vscdb localHistory → 会话（donor sessionsFromLocalHistory 的范围过滤版）：
 * 同 sessionId 取最早一条的标题代表任务；坏 JSON/非数组/缺 sessionId 或 title 一律跳过。
 * 纯函数：不改动输入。
 */
export function sessionsFromLocalHistory(rows: readonly { value: unknown }[], range: SessionRange): CollectedSession[] {
  const sessions = new Map<string, CollectedSession>();
  for (const row of Array.isArray(rows) ? rows : []) {
    let entries: unknown;
    try {
      entries = JSON.parse(String(row?.value ?? ""));
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const ts = Number(rec.timestamp) || 0;
      const sessionId = String(rec.sessionId ?? "");
      const title = typeof rec.title === "string" ? rec.title : "";
      if (!sessionId || !title) continue;
      const prev = sessions.get(sessionId);
      if (!prev || ts < prev.ts) sessions.set(sessionId, { sessionId, ts, title });
    }
  }
  return [...sessions.values()].filter((s) => s.ts >= range.fromMs && s.ts <= range.toMs);
}

/** agents.db chats → 会话（donor sessionsFromChats）：created_at 秒/毫秒兼容，name 必填。 */
export function sessionsFromChats(rows: readonly Record<string, unknown>[], range: SessionRange): CollectedSession[] {
  const out: CollectedSession[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = Number(row?.created_at) || 0;
    const ts = raw > 0 && raw < 1e12 ? raw * 1000 : raw;
    const name = String(row?.name ?? "").trim();
    if (!ts || !name) continue;
    if (ts < range.fromMs || ts > range.toMs) continue;
    out.push({ sessionId: String(row?.id ?? ""), ts, title: name });
  }
  return out;
}

/** 固定四实例源清单（donor worklog_collect.js SOURCES 同口径），路径全部在根内拼出。 */
export function defaultWorklogSources(appSupportDir: string): WorklogSource[] {
  const root = resolvePath(appSupportDir);
  return [
    { instance: "Qoder", kind: "vscdb", dbPath: join(root, "Qoder", "User", "globalStorage", "state.vscdb") },
    { instance: "QoderCN", kind: "vscdb", dbPath: join(root, "QoderCN", "User", "globalStorage", "state.vscdb") },
    { instance: "QoderWork", kind: "agents", dbPath: join(root, "QoderWork", "data", "agents.db") },
    { instance: "QwenWorkCN", kind: "agents", dbPath: join(root, "QwenWorkCN", "data", "agents.db") },
  ];
}

/** 错误备注脱敏：源库路径/根目录/家目录一律替换，只留首行并截断（绝对路径不出桥）。 */
function redactNote(error: unknown, source: WorklogSource, root?: string): string {
  let text = String((error as Error)?.message ?? error ?? "").split("\n")[0].trim();
  text = text.split(source.dbPath).join("<db>");
  if (root) text = text.split(resolvePath(root)).join("<root>");
  text = text.split(homedir()).join("~");
  return text.slice(0, 160) || "扫描失败（无错误输出）";
}

/**
 * 扫描单个源：文件不存在 → 诚实 missing；打开/查询失败 → error + 脱敏备注；
 * 成功 → 范围内的会话。reader 用完必关；本函数对源库零写入。
 */
export function scanWorklogSource(source: WorklogSource, range: SessionRange, deps: ScanDeps): SourceScanResult {
  const existsSync = deps.existsSync ?? defaultExistsSync;
  try {
    if (deps.root !== undefined) assertWithinRoot(deps.root, source.dbPath);
    if (!existsSync(source.dbPath)) {
      return { source, status: "missing", note: SOURCE_MISSING_NOTE, sessions: [] };
    }
    const reader = deps.openReader(source.dbPath);
    try {
      const rows = reader.all(source.kind === "vscdb" ? VSCDB_SQL : AGENTS_SQL);
      const sessions = source.kind === "vscdb"
        ? sessionsFromLocalHistory(rows as readonly { value: unknown }[], range)
        : sessionsFromChats(rows, range);
      return { source, status: "ok", sessions };
    } finally {
      try {
        reader.close();
      } catch {
        /* 关闭失败不影响扫描结果 */
      }
    }
  } catch (error) {
    return { source, status: "error", note: redactNote(error, source, deps.root), sessions: [] };
  }
}

/**
 * 缺省 opener：node:sqlite DatabaseSync（readOnly: true，donor 同口径）。
 * Node < 22.5 无此模块 → 返回 null，由桥如实回 503 worklog_sqlite_unavailable。
 */
export async function createNodeSqliteOpener(): Promise<SqliteOpener | null> {
  const sqlite = await import("node:sqlite").catch(() => null);
  const DatabaseSyncCtor = sqlite?.DatabaseSync;
  if (typeof DatabaseSyncCtor !== "function") return null;
  return (dbPath: string): SqliteReader => {
    const db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    return {
      all: (sql: string) => db.prepare(sql).all() as readonly Record<string, unknown>[],
      close: () => db.close(),
    };
  };
}
