import type { McpScope } from "./mcp-types.ts";
import { MCP_SCOPES, MCP_MAX_TEXT } from "./mcp-types.ts";
import type { DispatchTool, ToolRunResult } from "./mcp-protocol.ts";

/**
 * MCP 服务工具目录（只读面纯函数）— tools/list、tools/call 白名单工具。
 * donor: scripts/lib/mcpserver/tools.js（搬语义不搬代码）。
 *
 * 红线：只收读取面——key 创建/吊销、服务 toggle、连接器写一律不进目录；
 * 所有工具结果只含掩码视图（hashPrefix 级），绝无 key 明文与绝对路径。
 * 四个工具对四个 scope 一一映射：meta=服务状态、keys=key 掩码列表、
 * connectors=连接器发现清单、service=审计尾。
 */

export interface McpToolDeps {
  readonly serviceState: () => Promise<unknown>;
  readonly keyList: () => Promise<unknown>;
  readonly connectorList: () => Promise<unknown>;
  readonly auditTail: () => Promise<unknown>;
}

export type McpTool = DispatchTool;

/** 工具结果统一 {content:[{type:'text',text}]}；text 超预算硬截断（出站纪律）。 */
export function mcpTextResult(obj: unknown, isError?: boolean): ToolRunResult {
  let text: string;
  if (typeof obj === "string") text = obj;
  else {
    try {
      text = JSON.stringify(obj) ?? String(obj);
    } catch {
      text = String(obj);
    }
  }
  return {
    content: [{ type: "text", text: (text ?? "").slice(0, MCP_MAX_TEXT) }],
    isError: isError === true ? true : undefined,
  };
}

function readOnlyTool(
  name: string,
  scope: McpScope,
  description: string,
  run: () => Promise<unknown>,
): McpTool {
  return {
    name,
    scope,
    description,
    inputSchema: { type: "object", properties: {} },
    run: async () => mcpTextResult(await run(), false),
  };
}

export function buildMcpTools(deps: McpToolDeps): readonly McpTool[] {
  return [
    readOnlyTool("mcp_service_state", "meta", "MCP 服务状态（enabled / 工具数 / 有效 key 数，全掩码视图）", deps.serviceState),
    readOnlyTool("mcp_key_list", "keys", "API KEY 掩码列表（sha256 前 8 位 + scope + 时间，绝无明文）", deps.keyList),
    readOnlyTool("mcp_connector_list", "connectors", "本机 MCP 连接器发现清单（凭据已掩码，只读）", deps.connectorList),
    readOnlyTool("mcp_audit_tail", "service", "MCP 服务审计尾（append-only，无 key 材料）", deps.auditTail),
  ];
}

/** 目录覆盖的 scope 集（按 MCP_SCOPES 白名单序，缺项如实缺席）。 */
export function scopesOf(tools: readonly McpTool[]): readonly McpScope[] {
  const present = new Set(tools.map((t) => t.scope));
  return MCP_SCOPES.filter((s) => present.has(s));
}
