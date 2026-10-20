import { randomBytes } from "node:crypto";

import type { McpKeyStore } from "./mcp-keys.ts";
import {
  createSessionStore,
  dispatch,
  parseMessage,
  rpcError,
  type DispatchContext,
  type RpcFrame,
  type SessionStore,
} from "./mcp-protocol.ts";
import type { McpTool } from "./mcp-tools.ts";

/**
 * MCP JSON-RPC 入口（纯函数，零监听）— Bearer API KEY 鉴权 → 帧解析 → dispatch。
 * donor: scripts/lib/mcpserver/index.js route 语义（搬语义不搬代码）。
 *
 * 本批不在主桥开新监听端口（红线：不改 function-local-node.ts）；此入口供测试自环与
 * 将来挂端口用。无 key / 坏 key → 401（-32004）；tools/list 按 key scope 过滤；
 * tools/call 越权 → 403（-32003）而非「不存在」（诚实告知权限缺口）。
 */

export interface RpcEndpointOptions {
  readonly keyStore: McpKeyStore;
  readonly tools: readonly McpTool[];
  readonly serverInfo?: { name: string; version: string };
  readonly instructions?: string;
  readonly sessions?: SessionStore;
  readonly now?: () => number;
  readonly randomHex?: (n: number) => string;
  /** 每次调用后的审计钩子（旁路；入口本身零副作用）。 */
  readonly onCall?: (info: { keyId: number; method: string; tool: string | null; ok: boolean; http: number }) => void;
}

export interface RpcEndpoint {
  readonly handleText: (text: string, opts: { rawKey?: string; sid?: string }) => Promise<RpcFrame>;
  readonly state: () => { tools: number; sessions: number };
}

const DEFAULT_INSTRUCTIONS = "SA 工作台 V2 MCP 只读服务：服务状态 / key 掩码列表 / 连接器发现 / 审计尾。写操作不可用。";

export function createRpcEndpoint(options: RpcEndpointOptions): RpcEndpoint {
  const now = options.now ?? Date.now;
  const randomHex = options.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  const sessions = options.sessions ?? createSessionStore({ now, randomHex });
  const serverInfo = options.serverInfo ?? { name: "sa-workbench-v2", version: "0.1.0" };
  const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
  const byName = new Map(options.tools.map((t) => [t.name, t]));

  async function handleText(text: string, opts: { rawKey?: string; sid?: string } = {}): Promise<RpcFrame> {
    const rec = opts.rawKey ? await options.keyStore.verify(opts.rawKey) : null;
    if (!rec) {
      return rpcError(null, -32004, "API KEY 缺失或无效（Authorization: Bearer sak_…）", 401, {
        "WWW-Authenticate": 'Bearer realm="sa-workbench-v2-mcp"',
      });
    }
    const parsed = parseMessage(text);
    if (!parsed.ok) return rpcError(null, parsed.code, parsed.note, parsed.http);

    let tool: string | null = null;
    const ctx: DispatchContext = {
      sid: opts.sid ?? "",
      sessions,
      serverInfo,
      instructions,
      tools: () => options.tools
        .filter((t) => rec.scopes.includes(t.scope))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, scope: t.scope })),
      lookup: (name: string) => {
        const t = byName.get(name);
        if (!t) return null;
        return { tool: t, allowed: rec.scopes.includes(t.scope) };
      },
      run: async (t, args) => {
        tool = t.name;
        try {
          return await t.run(args);
        } catch (e) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, note: String((e as Error)?.message ?? e).slice(0, 300) }) }],
            isError: true,
          };
        }
      },
    };

    let frame: RpcFrame;
    try {
      frame = await dispatch(parsed.msg, ctx);
    } catch (e) {
      frame = rpcError(parsed.msg.id, -32603, `内部错误：${String((e as Error)?.message ?? e).slice(0, 200)}`, 500);
    }
    options.onCall?.({ keyId: rec.id, method: parsed.msg.method, tool, ok: frame.http < 400, http: frame.http });
    return frame;
  }

  return { handleText, state: () => ({ tools: options.tools.length, sessions: sessions.size() }) };
}
