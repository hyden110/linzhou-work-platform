import { randomBytes } from "node:crypto";

/**
 * MCP 服务协议层（JSON-RPC 2.0 帧 + 会话，传输无关纯函数）。
 * donor: scripts/lib/mcpserver/protocol.js（搬语义不搬代码）。
 *
 * 错误码口径：-32700(parse,400) / -32600(invalid,400) / -32601(未知方法,200) /
 * -32602(参数/未知工具,200) / -32001(会话不存在,404) / -32002(未初始化,400) /
 * -32003(scope 越权,403) / -32004(未授权,401)。本批不开监听端口：dispatch 为纯函数。
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
export const CANONICAL_PROTOCOL_VERSION = "2024-11-05";

export interface RpcFrame {
  readonly http: number;
  readonly body: string | null;
  readonly headers?: Record<string, string> | null;
}

export interface RpcMessage {
  readonly jsonrpc: string;
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface SessionRecord {
  readonly sid: string;
  ready: boolean;
  at: number;
}

export interface SessionStore {
  readonly get: (sid: string) => SessionRecord | null;
  readonly create: () => SessionRecord;
  readonly drop: (sid: string) => boolean;
  readonly size: () => number;
}

export interface DispatchToolDescriptor {
  readonly name: string;
  readonly scope: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolRunResult {
  readonly content: readonly { type: string; text: string }[];
  readonly isError?: boolean;
}

export interface DispatchTool extends DispatchToolDescriptor {
  readonly run: (args: Record<string, unknown>) => Promise<ToolRunResult>;
}

export interface DispatchContext {
  readonly sid: string;
  readonly sessions: SessionStore;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly instructions: string;
  /** 已按 key scope 过滤的线上目录。 */
  readonly tools: () => readonly DispatchToolDescriptor[];
  /** {tool, allowed} | null（allowed = scope 判定，越权给 403 而非「不存在」）。 */
  readonly lookup: (name: string) => { tool: DispatchTool; allowed: boolean } | null;
  readonly run: (tool: DispatchTool, args: Record<string, unknown>) => Promise<ToolRunResult>;
}

/* ---------------- 响应构造 ---------------- */

export function rpcResult(id: string | number | null | undefined, result: unknown, headers: Record<string, string> | null = null): RpcFrame {
  return { http: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) };
}

export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  http = 200,
  headers: Record<string, string> | null = null,
): RpcFrame {
  return { http, headers, body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) };
}

/* ---------------- 帧解析 ---------------- */

export type ParsedMessage = { ok: true; msg: RpcMessage } | { ok: false; code: number; http: number; note: string };

export function parseMessage(text: string): ParsedMessage {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, code: -32700, http: 400, note: "Parse error" };
  }
  if (Array.isArray(j)) return { ok: false, code: -32600, http: 400, note: "batch 数组暂不支持" };
  if (!j || typeof j !== "object") return { ok: false, code: -32600, http: 400, note: "invalid Request" };
  const rec = j as Record<string, unknown>;
  if (rec.jsonrpc !== "2.0" || typeof rec.method !== "string" || !rec.method) {
    return { ok: false, code: -32600, http: 400, note: "invalid Request" };
  }
  if ("id" in rec && rec.id !== null && typeof rec.id !== "string" && typeof rec.id !== "number") {
    return { ok: false, code: -32600, http: 400, note: "invalid Request id" };
  }
  return { ok: true, msg: rec as unknown as RpcMessage };
}

/** 逐行取 JSON-RPC 响应：子进程/SSE 常混入告警文本，非 JSON 行直接跳过。 */
export function pickMsg(buf: string, id: number | null): Record<string, unknown> | null {
  for (const ln of String(buf ?? "").split("\n")) {
    const t = ln.replace(/^data:\s*/, "").trim();
    if (!t || t[0] !== "{") continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j && (id == null || j.id === id)) return j;
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

export function errNote(frame: unknown, fallback: string): string {
  const rec = frame as { error?: { message?: unknown; code?: unknown } } | null;
  const m = rec?.error ? rec.error.message ?? rec.error.code : undefined;
  return String(m ?? fallback ?? "").split("\n")[0].slice(0, 200);
}

/* ---------------- 会话存储（内存态，无定时器：TTL 在 get 时惰性判定） ---------------- */

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly cap?: number;
  readonly randomHex?: (n: number) => string;
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  const ttlMs = Math.min(Math.max(Number(options.ttlMs) || 30 * 60_000, 1_000), 24 * 3_600_000);
  const cap = Math.min(Math.max(Number(options.cap) || 512, 1), 4_096);
  const randomHex = options.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  const map = new Map<string, SessionRecord>();

  function sweep(): void {
    const t = now();
    for (const [sid, s] of map) if (t - s.at > ttlMs) map.delete(sid);
  }

  return {
    get(sid: string): SessionRecord | null {
      const s = map.get(sid);
      if (!s) return null;
      if (now() - s.at > ttlMs) {
        map.delete(sid);
        return null;
      }
      s.at = now();
      return s;
    },
    create(): SessionRecord {
      sweep();
      const s: SessionRecord = { sid: randomHex(16), ready: false, at: now() };
      map.set(s.sid, s);
      while (map.size > cap) map.delete(map.keys().next().value as string);
      return s;
    },
    drop(sid: string): boolean {
      return map.delete(sid);
    },
    size(): number {
      return map.size;
    },
  };
}

/* ---------------- 方法分发 ----------------
 * initialize / notifications/initialized / ping / tools/list / tools/call；
 * 其余通知静默 202，未知方法 -32601。会话闸门：未初始化 400、会话失效 404。
 */
export async function dispatch(msg: RpcMessage, ctx: DispatchContext): Promise<RpcFrame> {
  const m = msg.method;
  const isReq = "id" in msg && msg.id !== undefined;

  if (m === "initialize") {
    const params = msg.params;
    if (params == null || typeof params !== "object" || Array.isArray(params)) {
      return rpcError(msg.id, -32602, "initialize 缺少 params", 200);
    }
    const pv = (params as { protocolVersion?: unknown }).protocolVersion;
    const negotiated = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(String(pv))
      ? String(pv)
      : CANONICAL_PROTOCOL_VERSION;
    const sess = ctx.sessions.create();
    return rpcResult(
      msg.id,
      {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: ctx.serverInfo,
        instructions: ctx.instructions,
      },
      { "Mcp-Session-Id": sess.sid },
    );
  }

  if (m === "notifications/initialized") {
    const sess = ctx.sid ? ctx.sessions.get(ctx.sid) : null;
    if (sess) sess.ready = true;
    return { http: 202, body: null };
  }

  if (!isReq) return { http: 202, body: null }; // 其余未知通知静默接收

  if (m !== "ping") {
    if (!ctx.sid) return rpcError(msg.id, -32002, "未初始化：请先 initialize", 400);
    const sess = ctx.sessions.get(ctx.sid);
    if (!sess) return rpcError(msg.id, -32001, "会话不存在或已过期，请重新 initialize", 404);
    if (!sess.ready) return rpcError(msg.id, -32002, "会话未完成 initialized 通知", 400);
  }

  if (m === "ping") return rpcResult(msg.id, {});
  if (m === "tools/list") {
    // 线上目录只回 MCP 协议字段：scope 是站内权限概念，不出站。
    const wire = ctx.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    return rpcResult(msg.id, { tools: wire });
  }
  if (m === "tools/call") {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = params.name;
    if (typeof name !== "string" || !name) return rpcError(msg.id, -32602, "tools/call 缺少 name", 200);
    const args = params.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return rpcError(msg.id, -32602, "tools/call arguments 必须是对象", 200);
    }
    const found = ctx.lookup(name);
    if (!found) return rpcError(msg.id, -32602, `未知工具：${name.slice(0, 80)}`, 200);
    if (!found.allowed) {
      return rpcError(msg.id, -32003, `key 的 scope 不包含 ${found.tool.scope}，无权调用 ${name}`, 403);
    }
    const r = await ctx.run(found.tool, (args ?? {}) as Record<string, unknown>);
    return rpcResult(msg.id, r);
  }
  return rpcError(msg.id, -32601, `未知方法：${m.slice(0, 80)}`, 200);
}
