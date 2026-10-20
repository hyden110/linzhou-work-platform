/**
 * MCP bridge contracts — MCP 服务（只读工具封装 + API KEY 管理）+ MCP 连接器发现/体检。
 * donor: base/sa-workbench scripts/lib/mcpserver/{index,keys,protocol,tools,audit}.js +
 * scripts/lib/mcp.js + scripts/mcpkeys.js（搬语义不搬代码）。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * MCP_ROUTES 常量供接线——集成方只需在 local-router 的委托链里
 * `?? await mcpBridge.handle(request)` 即可挂载全部九条路由（405/错误映射都在子路由内闭环），
 * 沿 reply/agentloop 桥先例。
 *
 * 红线（与任务口径一致，不可放宽）：
 * - key 明文只在创建响应出现一次；落盘/审计/日志/视图一律 sha256（对外只报前 8 位 hint）；
 * - 审计 append-only jsonl 0600，绝不落 key 材料；
 * - 服务默认关；toggle 需 body.confirm 严格 === true（布尔）才生效；
 * - 连接器配置写一律 dry→confirm 两步：confirm 严格 === dry 铸造的一次性 token；
 *   写前备份 .bak、原子写、失败回滚并如实报错；
 * - JSON-RPC 入口（tools/list、tools/call 只读白名单工具）实现为纯函数，本批不挂监听端口。
 */

/** 稳定错误码：路由按 code 映射 400/404/405/409/502/503。 */
export type McpErrorCode =
  | "mcp_invalid_request"
  | "mcp_not_found"
  | "mcp_confirm_mismatch"
  | "mcp_busy"
  | "mcp_store_unavailable"
  | "mcp_upstream_error"
  | "mcp_unavailable"
  | "method_not_allowed";

export class McpBridgeError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = "McpBridgeError";
    this.code = code;
  }
}

/** 路由表（供接线）：九条路由与任务口径一一对应。 */
export const MCP_ROUTES = [
  { method: "GET", path: "/local/mcp/service", operation: "service" },
  { method: "POST", path: "/local/mcp/keys", operation: "createKey" },
  { method: "POST", path: "/local/mcp/keys/revoke", operation: "revokeKey" },
  { method: "GET", path: "/local/mcp/keys", operation: "keys" },
  { method: "POST", path: "/local/mcp/service/toggle", operation: "toggle" },
  { method: "GET", path: "/local/mcp/connectors", operation: "connectors" },
  { method: "POST", path: "/local/mcp/connectors/check", operation: "check" },
  { method: "POST", path: "/local/mcp/connectors/dry", operation: "dry" },
  { method: "POST", path: "/local/mcp/connectors/confirm", operation: "confirm" },
] as const;

export type McpRoute = (typeof MCP_ROUTES)[number];

/** API KEY scope 白名单（body.scope 逐项校验，未知 scope 一律 400 拒绝）。 */
export const MCP_SCOPES = ["service", "keys", "connectors", "meta"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** key 形态：sak_ + 32 位十六进制（16 字节随机）。 */
export const MCP_KEY_PREFIX = "sak_";
export const MCP_KEY_PATTERN = /^sak_[0-9a-f]{32}$/;
/** 对外只报 sha256 前 8 位 hint（绝不回明文/全 hash）。 */
export const MCP_HASH_HINT_CHARS = 8;
/** GET /local/mcp/service 附带的审计尾行数。 */
export const MCP_AUDIT_TAIL = 20;
/** dry token 有效期（内存态，重启即作废；沿 agentloop 出票闸门先例）。 */
export const MCP_DRY_TOKEN_TTL_MS = 5 * 60_000;
/** 未消费 dry token 上限（防内存膨胀；插入序淘汰最早的）。 */
export const MCP_DRY_TOKEN_CAP = 50;
/** 单连接器握手超时。 */
export const MCP_HANDSHAKE_TIMEOUT_MS = 20_000;
/** 批量体检总预算（超时后不再起新握手，未轮到的留 skipped）。 */
export const MCP_CHECK_BUDGET_MS = 90_000;
/** 批量体检并发上限（stdio 会真起进程，不能一把全放）。 */
export const MCP_CHECK_CONCURRENCY = 3;
/** 连接器名白名单（1–80 字符，禁引号与控制符）。 */
export const MCP_CONNECTOR_NAME_MAX = 80;
/** stdio 子进程输出硬上限（超限中止，防内存打爆）。 */
export const MCP_CHILD_OUTPUT_MAX = 4 * 1024 * 1024;
/** JSON-RPC 工具结果 text 上限。 */
export const MCP_MAX_TEXT = 64 * 1024;

/* ---------------- API KEY ---------------- */

/** key 掩码视图（落盘记录投影）：只含 sha256 前 8 位 + scope + 时间，绝无明文/全 hash。 */
export interface McpKeyView {
  readonly id: number;
  readonly name: string;
  readonly hashPrefix: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly note: string;
}

/** POST /local/mcp/keys 的 data：key 明文仅此一次，之后任何应答不再出现。 */
export interface McpKeyCreateResult {
  readonly key: string;
  readonly record: McpKeyView;
  readonly note: string;
}

/** GET /local/mcp/keys 的 data。 */
export interface McpKeysView {
  readonly keys: readonly McpKeyView[];
  readonly active: number;
  readonly revoked: number;
  readonly scopes: readonly McpScope[];
}

/* ---------------- 审计 ---------------- */

/** 审计行（append-only jsonl）：只有 keyId/hashPrefix 级引用，绝无 key 材料。 */
export interface McpAuditRow {
  readonly at: string;
  readonly action: string;
  readonly keyId: number | null;
  readonly target: string;
  readonly ok: boolean;
  readonly note: string;
}

/* ---------------- 服务状态 ---------------- */

/** GET /local/mcp/service 的 data（服务默认关；key 只报 sha256 前 8 + scope + 创建时间）。 */
export interface McpServiceState {
  readonly enabled: boolean;
  readonly tools: number;
  readonly toolNames: readonly string[];
  readonly scopes: readonly McpScope[];
  readonly keys: { readonly active: number; readonly revoked: number };
  readonly keyViews: readonly McpKeyView[];
  readonly auditTail: readonly McpAuditRow[];
  readonly rpcMounted: false;
}

/** POST /local/mcp/service/toggle 的 data。 */
export interface McpToggleResult {
  readonly enabled: boolean;
  readonly at: string;
}

/* ---------------- 连接器 ---------------- */

export type McpConnectorOp = "set" | "enable" | "disable" | "remove";
export type McpConnectorTransport = "stdio" | "http" | "sse" | "unknown";
export type McpCheckStatus =
  | "ok"
  | "down"
  | "error"
  | "unauthorized"
  | "disabled"
  | "unconfigured"
  | "skipped";

/** 来源清单行（发现视图）：shown 一律 ~ 相对形态，绝不回绝对路径。 */
export interface McpConnectorSourceView {
  readonly role: string;
  readonly label: string;
  readonly shown: string;
  readonly effective: boolean;
  readonly writable: boolean;
  readonly exists: boolean;
  readonly count: number;
  readonly error: string | null;
}

/** 连接器出站视图：凭据（env/headers 值、url query、长 token arg）已掩码。 */
export interface McpConnectorView {
  readonly name: string;
  readonly transport: McpConnectorTransport;
  readonly disabled: boolean;
  readonly valid: boolean;
  readonly effective: boolean;
  readonly sources: readonly string[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly exists?: boolean;
  readonly url?: string;
  readonly env?: readonly { readonly name: string; readonly secret: boolean }[];
  readonly headers?: readonly string[];
}

export interface McpConnectorSummary {
  readonly total: number;
  readonly effective: number;
  readonly notLoaded: number;
  readonly disabled: number;
  readonly broken: number;
}

/** GET /local/mcp/connectors 的 data。 */
export interface McpConnectorsView {
  readonly sources: readonly McpConnectorSourceView[];
  readonly servers: readonly McpConnectorView[];
  readonly summary: McpConnectorSummary;
}

/** 单连接器体检结论（逐连接器状态 + 原因，诚实呈现不粉饰）。 */
export interface McpConnectorCheckResult {
  readonly name: string;
  readonly status: McpCheckStatus;
  readonly note: string;
  readonly toolCount?: number;
  readonly tools?: readonly string[];
  readonly ms?: number;
  readonly checkedAt: string;
}

/** POST /local/mcp/connectors/check 的 data。 */
export interface McpCheckView {
  readonly checkedAt: string;
  readonly ms: number;
  readonly attempted: number;
  readonly skipped: number;
  readonly results: readonly McpConnectorCheckResult[];
}

/** dry→confirm 两步写的 dry 应答：目标文件 + 掩码 diff 摘要 + 一次性 token。 */
export interface McpDryResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly op: McpConnectorOp;
  readonly role: string;
  readonly name: string;
  readonly existed: boolean;
  readonly target: { readonly shown: string; readonly role: string; readonly dot: string };
  readonly diff: { readonly before: string | null; readonly after: string | null };
  readonly note: string;
}

/** confirm 应答（写成功后）：backup 为 ~ 相对形态展示。 */
export interface McpConfirmResult {
  readonly op: McpConnectorOp;
  readonly role: string;
  readonly name: string;
  readonly existed: boolean;
  readonly backup: string;
  readonly note: string;
  readonly server: McpConnectorView | null;
}

/* ---------------- 子进程 / 网络注入点 ---------------- */

/**
 * stdio 子进程句柄（测试注入合成实现，零真实子进程）：
 * 生产实现 = child_process.spawn（数组参数 + shell:false + 硬超时 + 有界输出）。
 */
export interface McpChildHandle {
  readonly write: (line: string) => void;
  readonly onData: (cb: (chunk: string) => void) => void;
  readonly onError: (cb: (error: { code?: string; message: string }) => void) => void;
  readonly onClose: (cb: (code: number | null) => void) => void;
  readonly kill: () => void;
}

export type McpSpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly env: Record<string, string> },
) => McpChildHandle;

/* ---------------- 桥面 ---------------- */

export interface McpBridge {
  /** GET /local/mcp/service —— 服务状态（enabled/tools/有效 key 数/审计尾，key 全掩码）。 */
  readonly service: () => Promise<McpServiceState>;
  /** POST /local/mcp/keys —— body {name, scope?, note?}；明文仅此次应答。 */
  readonly createKey: (body: unknown) => Promise<McpKeyCreateResult>;
  /** POST /local/mcp/keys/revoke —— body {keyId, confirm}；confirm 严格 === String(keyId)。 */
  readonly revokeKey: (body: unknown) => Promise<McpKeyView>;
  /** GET /local/mcp/keys —— 掩码列表。 */
  readonly keys: () => Promise<McpKeysView>;
  /** POST /local/mcp/service/toggle —— body {op: enable|disable, confirm: true}；默认关。 */
  readonly toggle: (body: unknown) => Promise<McpToggleResult>;
  /** GET /local/mcp/connectors —— 发现清单只读。 */
  readonly connectors: () => Promise<McpConnectorsView>;
  /** POST /local/mcp/connectors/check —— 只读 discover+handshake 体检（单飞锁）。 */
  readonly check: (body?: unknown) => Promise<McpCheckView>;
  /** POST /local/mcp/connectors/dry —— 铸造一次性 token + 目标文件 + 掩码 diff。 */
  readonly dry: (body: unknown) => Promise<McpDryResult>;
  /** POST /local/mcp/connectors/confirm —— body {confirm}；严格 === token 才写。 */
  readonly confirm: (body: unknown) => Promise<McpConfirmResult>;
  /** 子路由：命中 MCP_ROUTES 返回 Response；非本桥路径返回 undefined（供主路由委托）。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
