/**
 * MCP model — 纯函数派生层（MCP 服务 + API KEY + 连接器发现/体检 的展示口径）。
 * 零依赖、零 I/O、零时钟：输入是桥应答投影（mcp-client.ts），输出是面板可直接渲染的
 * 标签/摘要/语气（tone）。dev 桥与浏览器端共用同一份契约字段名（配 dev/mcp-bridge_test.ts）。
 *
 * 口径：
 * - 所有展示值只来自掩码视图（hashPrefix / masked url / ~ 路径）——模型层不做任何还原；
 * - 状态语气四档：mint=正常 / danger=不可达或异常 / amber=需要人处理（未授权） / dim=中性；
 * - 诚实呈现：未知枚举值不猜，原样回显（fallback 到入参本身或「未知」）。
 */

/* ---------------- 契约类型（与 dev/mcp/mcp-types.ts 视图一一对应） ---------------- */

export type McpScopeName = "service" | "keys" | "connectors" | "meta";

export interface McpKeyViewItem {
  readonly id: number;
  readonly name: string;
  readonly hashPrefix: string;
  readonly scopes: readonly McpScopeName[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly note: string;
}

export interface McpAuditItem {
  readonly at: string;
  readonly action: string;
  readonly keyId: number | null;
  readonly target: string;
  readonly ok: boolean;
  readonly note: string;
}

export interface McpServiceSnapshot {
  readonly enabled: boolean;
  readonly tools: number;
  readonly toolNames: readonly string[];
  readonly scopes: readonly McpScopeName[];
  readonly keys: { readonly active: number; readonly revoked: number };
  readonly keyViews: readonly McpKeyViewItem[];
  readonly auditTail: readonly McpAuditItem[];
  readonly rpcMounted: false;
}

export interface McpKeysSnapshot {
  readonly keys: readonly McpKeyViewItem[];
  readonly active: number;
  readonly revoked: number;
  readonly scopes: readonly McpScopeName[];
}

export interface McpKeyCreatedSnapshot {
  readonly key: string;
  readonly record: McpKeyViewItem;
  readonly note: string;
}

export interface McpToggleSnapshot {
  readonly enabled: boolean;
  readonly at: string;
}

export interface McpConnectorSourceItem {
  readonly role: string;
  readonly label: string;
  readonly shown: string;
  readonly effective: boolean;
  readonly writable: boolean;
  readonly exists: boolean;
  readonly count: number;
  readonly error: string | null;
}

export type McpTransport = "stdio" | "http" | "sse" | "unknown";

export interface McpConnectorItem {
  readonly name: string;
  readonly transport: McpTransport;
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

export interface McpConnectorsSnapshot {
  readonly sources: readonly McpConnectorSourceItem[];
  readonly servers: readonly McpConnectorItem[];
  readonly summary: McpConnectorSummary;
}

export type McpCheckStatus =
  | "ok"
  | "down"
  | "error"
  | "unauthorized"
  | "disabled"
  | "unconfigured"
  | "skipped";

export interface McpCheckResultItem {
  readonly name: string;
  readonly status: McpCheckStatus;
  readonly note: string;
  readonly toolCount?: number;
  readonly tools?: readonly string[];
  readonly ms?: number;
  readonly checkedAt: string;
}

export interface McpCheckSnapshot {
  readonly checkedAt: string;
  readonly ms: number;
  readonly attempted: number;
  readonly skipped: number;
  readonly results: readonly McpCheckResultItem[];
}

export type McpConnectorOpName = "set" | "enable" | "disable" | "remove";

export interface McpDrySnapshot {
  readonly token: string;
  readonly expiresAt: string;
  readonly op: McpConnectorOpName;
  readonly role: string;
  readonly name: string;
  readonly existed: boolean;
  readonly target: { readonly shown: string; readonly role: string; readonly dot: string };
  readonly diff: { readonly before: string | null; readonly after: string | null };
  readonly note: string;
}

export interface McpConfirmSnapshot {
  readonly op: McpConnectorOpName;
  readonly role: string;
  readonly name: string;
  readonly existed: boolean;
  readonly backup: string;
  readonly note: string;
  readonly server: McpConnectorItem | null;
}

/* ---------------- 纯函数派生（展示口径） ---------------- */

/** scope 选项（创建 key 表单用；顺序 = 桥侧白名单序）。 */
export const MCP_SCOPE_OPTIONS: readonly { readonly value: McpScopeName; readonly label: string; readonly hint: string }[] = [
  { value: "service", label: "service", hint: "审计尾读取" },
  { value: "keys", label: "keys", hint: "key 掩码列表" },
  { value: "connectors", label: "connectors", hint: "连接器发现清单" },
  { value: "meta", label: "meta", hint: "服务状态" },
];

export type McpTone = "mint" | "danger" | "amber" | "dim";

const CHECK_STATUS_META: Record<string, { readonly label: string; readonly tone: McpTone }> = {
  ok: { label: "正常", tone: "mint" },
  down: { label: "不可达", tone: "danger" },
  error: { label: "异常", tone: "danger" },
  unauthorized: { label: "未授权", tone: "amber" },
  disabled: { label: "已禁用", tone: "dim" },
  unconfigured: { label: "未配置", tone: "dim" },
  skipped: { label: "未体检", tone: "dim" },
};

/** 体检状态 → 展示标签 + 语气；未知枚举原样回显（诚实，不猜）。 */
export function checkStatusMeta(status: string): { readonly label: string; readonly tone: McpTone } {
  return CHECK_STATUS_META[status] ?? { label: String(status ?? "") || "未知", tone: "dim" };
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  key_created: "创建 key",
  key_revoked: "吊销 key",
  service_toggle: "服务开关",
  connector_write: "连接器写入",
  connector_check: "连接器体检",
  rpc_call: "RPC 调用",
};

export function auditActionLabel(action: string): string {
  const key = String(action ?? "");
  if (!key) return "未知动作";
  return AUDIT_ACTION_LABELS[key] ?? key;
}

const TRANSPORT_LABELS: Record<string, string> = {
  stdio: "stdio（本地进程）",
  http: "HTTP",
  sse: "SSE",
  unknown: "未知",
};

export function transportLabel(transport: string): string {
  const key = String(transport ?? "");
  return TRANSPORT_LABELS[key] ?? key;
}

const CONNECTOR_OP_LABELS: Record<string, string> = {
  set: "写入定义",
  enable: "启用",
  disable: "禁用",
  remove: "移除",
};

export function connectorOpLabel(op: string): string {
  const key = String(op ?? "");
  return CONNECTOR_OP_LABELS[key] ?? key;
}

export function keyStatusOf(key: McpKeyViewItem): "active" | "revoked" {
  return key.revokedAt ? "revoked" : "active";
}

/** 服务一行摘要：开关 + 工具数 + key 计数，全部来自掩码视图。 */
export function serviceHeadline(state: McpServiceSnapshot): string {
  const head = state.enabled ? "服务已开启" : "服务已关闭";
  return `${head} · ${String(state.tools)} 个只读工具 · ${String(state.keys.active)} 个有效 key（${String(state.keys.revoked)} 已吊销）`;
}

/** 连接器一行摘要：只回掩码后的 command/url（凭据在桥侧已抹掉）。 */
export function connectorHeadline(connector: McpConnectorItem): string {
  if (connector.transport === "stdio") {
    const parts = [connector.command ?? "", ...(connector.args ?? []).slice(0, 2)].filter(Boolean);
    return parts.length ? `stdio · ${parts.join(" ")}` : "stdio · 缺 command";
  }
  if (connector.url) return `${connector.transport} · ${connector.url}`;
  if (connector.transport === "http" || connector.transport === "sse") return `${connector.transport} · 缺 url`;
  return "未知 · 定义不完整（缺 command / url）";
}

/** 掩码 diff 展示：合法 JSON 美化，解析失败原样回显（诚实）；null 保持 null。 */
export function prettyJsonOrNull(text: string | null): string | null {
  if (text === null) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
