/**
 * Browser client for MCP 服务（只读工具封装 + API KEY 管理）+ MCP 连接器发现/体检。
 * GET /local/mcp/{service,keys,connectors}、
 * POST /local/mcp/{keys,keys/revoke,service/toggle,connectors/check,connectors/dry,connectors/confirm}。
 *
 * 口径（与 dev/mcp/mcp-types.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃、坏形状整包 invalid_response，绝不半真半假；
 * - 错误分层：{error:{code,message}} → McpClientError(code, detail)，mcpErrorMessage
 *   给可直接展示的中文诚实文案（busy/store_unavailable 不粉饰：锁忙就说锁忙）；
 * - 超时分层：普通读写 15s；体检 120s（桥侧总预算 90s）；confirm 写 30s（备份+原子写）——
 *   客户端超时必须比桥侧长，否则桥还在干活客户端先断，用户会重复点；
 * - key 明文只在创建应答出现一次：客户端不做任何缓存/持久化，只交给面板一次性展示；
 * - confirm 参数由面板人工确认铸造（toggle=布尔 true；revoke=String(keyId)；写=一次性 token）。
 */

import { composeErrorMessage } from "./error-message.ts";
import type {
  McpAuditItem,
  McpCheckResultItem,
  McpCheckSnapshot,
  McpConfirmSnapshot,
  McpConnectorItem,
  McpConnectorOpName,
  McpConnectorSourceItem,
  McpConnectorSummary,
  McpConnectorsSnapshot,
  McpDrySnapshot,
  McpKeyCreatedSnapshot,
  McpKeyViewItem,
  McpKeysSnapshot,
  McpScopeName,
  McpServiceSnapshot,
  McpToggleSnapshot,
} from "./mcp-model.ts";

/** 客户端本地错误码 + 桥侧稳定错误码全集（dev/mcp/mcp-types.ts McpErrorCode）。 */
export type McpClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "mcp_invalid_request"
  | "mcp_not_found"
  | "mcp_confirm_mismatch"
  | "mcp_busy"
  | "mcp_store_unavailable"
  | "mcp_upstream_error"
  | "mcp_unavailable"
  | "method_not_allowed";

export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  readonly detail: string;

  constructor(code: McpClientErrorCode, detail = "") {
    super(code);
    this.name = "McpClientError";
    this.code = code;
    this.detail = detail;
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<McpClientErrorCode>([
  "unavailable", "invalid_response", "mcp_invalid_request", "mcp_not_found",
  "mcp_confirm_mismatch", "mcp_busy", "mcp_store_unavailable", "mcp_upstream_error",
  "mcp_unavailable", "method_not_allowed",
]);

const MCP_GET_TIMEOUT_MS = 15_000;
const MCP_WRITE_TIMEOUT_MS = 15_000;
/** 体检桥侧总预算 90s：客户端必须更长，否则桥还在握手客户端先断。 */
const MCP_CHECK_TIMEOUT_MS = 120_000;
/** confirm 写 = 备份 + 原子写 + 回读校验：给足 30s。 */
const MCP_CONFIRM_TIMEOUT_MS = 30_000;

export interface McpKeyCreateInput {
  readonly name: string;
  readonly scope?: readonly McpScopeName[];
  readonly note?: string;
}

export interface McpConnectorDryInput {
  readonly op: McpConnectorOpName;
  readonly role: string;
  readonly name: string;
  readonly def?: Record<string, unknown>;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const SCOPE_SET: ReadonlySet<string> = new Set(["service", "keys", "connectors", "meta"]);

function asScopes(value: unknown): readonly McpScopeName[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is McpScopeName => typeof s === "string" && SCOPE_SET.has(s));
}

function asKeyView(value: unknown): McpKeyViewItem | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  return {
    id,
    name: asText(value.name),
    hashPrefix: asText(value.hashPrefix),
    scopes: asScopes(value.scopes),
    createdAt: asText(value.createdAt),
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : null,
    note: asText(value.note),
  };
}

function asKeyViews(value: unknown): readonly McpKeyViewItem[] {
  if (!Array.isArray(value)) throw new McpClientError("invalid_response");
  return value.map(asKeyView).filter((row): row is McpKeyViewItem => row !== null);
}

function asAuditItem(value: unknown): McpAuditItem | null {
  if (!isRecord(value) || !asText(value.action)) return null;
  return {
    at: asText(value.at),
    action: asText(value.action),
    keyId: typeof value.keyId === "number" ? value.keyId : null,
    target: asText(value.target),
    ok: value.ok === true,
    note: asText(value.note),
  };
}

function requireKeysCount(value: unknown): { readonly active: number; readonly revoked: number } {
  if (!isRecord(value) || typeof value.active !== "number" || typeof value.revoked !== "number") {
    throw new McpClientError("invalid_response");
  }
  return { active: asNumber(value.active), revoked: asNumber(value.revoked) };
}

const TRANSPORTS: ReadonlySet<string> = new Set(["stdio", "http", "sse", "unknown"]);
const CHECK_STATUSES: ReadonlySet<string> = new Set(["ok", "down", "error", "unauthorized", "disabled", "unconfigured", "skipped"]);
const CONNECTOR_OPS: ReadonlySet<string> = new Set(["set", "enable", "disable", "remove"]);

function asSourceItem(value: unknown): McpConnectorSourceItem | null {
  if (!isRecord(value) || !asText(value.role)) return null;
  return {
    role: asText(value.role),
    label: asText(value.label),
    shown: asText(value.shown),
    effective: value.effective === true,
    writable: value.writable === true,
    exists: value.exists === true,
    count: asNumber(value.count),
    error: typeof value.error === "string" ? value.error : null,
  };
}

function asConnectorItem(value: unknown): McpConnectorItem | null {
  if (!isRecord(value) || !asText(value.name)) return null;
  const transport = TRANSPORTS.has(asText(value.transport)) ? (asText(value.transport) as McpConnectorItem["transport"]) : "unknown";
  const item: { -readonly [K in keyof McpConnectorItem]: McpConnectorItem[K] } = {
    name: asText(value.name),
    transport,
    disabled: value.disabled === true,
    valid: value.valid === true,
    effective: value.effective === true,
    sources: Array.isArray(value.sources) ? value.sources.filter((s): s is string => typeof s === "string") : [],
  };
  if (typeof value.command === "string") item.command = value.command;
  if (Array.isArray(value.args)) item.args = value.args.filter((a): a is string => typeof a === "string");
  if (typeof value.exists === "boolean") item.exists = value.exists;
  if (typeof value.url === "string") item.url = value.url;
  if (Array.isArray(value.env)) {
    item.env = value.env
      .filter(isRecord)
      .map((e) => ({ name: asText(e.name), secret: e.secret === true }));
  }
  if (Array.isArray(value.headers)) item.headers = value.headers.filter((h): h is string => typeof h === "string");
  return item;
}

function asSummary(value: unknown): McpConnectorSummary {
  const record = isRecord(value) ? value : {};
  return {
    total: asNumber(record.total),
    effective: asNumber(record.effective),
    notLoaded: asNumber(record.notLoaded),
    disabled: asNumber(record.disabled),
    broken: asNumber(record.broken),
  };
}

function asCheckResult(value: unknown): McpCheckResultItem | null {
  if (!isRecord(value) || !asText(value.name) || !CHECK_STATUSES.has(asText(value.status))) return null;
  const item: { -readonly [K in keyof McpCheckResultItem]: McpCheckResultItem[K] } = {
    name: asText(value.name),
    status: asText(value.status) as McpCheckResultItem["status"],
    note: asText(value.note),
    checkedAt: asText(value.checkedAt),
  };
  if (typeof value.toolCount === "number") item.toolCount = value.toolCount;
  if (Array.isArray(value.tools)) item.tools = value.tools.filter((t): t is string => typeof t === "string");
  if (typeof value.ms === "number") item.ms = value.ms;
  return item;
}

/* ---------------- 请求（超时分层；错误 {code,message} 如实上抛） ---------------- */

function mcpUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  timeoutMs: number,
  method: "GET" | "POST",
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(mcpUrl(path), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch {
    throw new McpClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new McpClientError(error.code as McpClientErrorCode, asText(error.message));
    }
    throw new McpClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new McpClientError("invalid_response");
  return payload.data;
}

/** GET /local/mcp/service —— 服务状态（enabled / 只读工具目录 / key 计数 / 审计尾，全掩码）。 */
export async function fetchMcpService(fetchImpl: typeof fetch = fetch): Promise<McpServiceSnapshot> {
  const data = await requestJson("/local/mcp/service", MCP_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  const keys = requireKeysCount(data.keys);
  if (!Array.isArray(data.toolNames) || !Array.isArray(data.auditTail)) {
    throw new McpClientError("invalid_response");
  }
  return {
    enabled: data.enabled === true,
    tools: asNumber(data.tools),
    toolNames: data.toolNames.filter((n): n is string => typeof n === "string"),
    scopes: asScopes(data.scopes),
    keys,
    keyViews: asKeyViews(data.keyViews),
    auditTail: data.auditTail.map(asAuditItem).filter((row): row is McpAuditItem => row !== null),
    rpcMounted: false, // 桥契约恒 false：本批不挂监听端口
  };
}

/** GET /local/mcp/keys —— 掩码 key 列表（sha256 前 8 位 + scope + 时间，绝无明文）。 */
export async function fetchMcpKeys(fetchImpl: typeof fetch = fetch): Promise<McpKeysSnapshot> {
  const data = await requestJson("/local/mcp/keys", MCP_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  return {
    keys: asKeyViews(data.keys),
    active: asNumber(data.active),
    revoked: asNumber(data.revoked),
    scopes: asScopes(data.scopes),
  };
}

/**
 * POST /local/mcp/keys —— body {name, scope?, note?}；明文 key 仅此一次应答。
 * 客户端不做任何缓存/持久化：面板展示一次后只能吊销重发。
 */
export async function createMcpKey(input: McpKeyCreateInput, fetchImpl: typeof fetch = fetch): Promise<McpKeyCreatedSnapshot> {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 60) {
    throw new McpClientError("mcp_invalid_request", "key 名称必须为 1–60 位非空字符串。");
  }
  const body: Record<string, unknown> = { name };
  if (input.scope !== undefined) {
    const scope = input.scope.filter((s) => SCOPE_SET.has(s));
    if (!scope.length) throw new McpClientError("mcp_invalid_request", "scope 至少选一项（或整个不选走缺省全量）。");
    body.scope = scope;
  }
  if (input.note) body.note = String(input.note).slice(0, 200);
  const data = await requestJson("/local/mcp/keys", MCP_WRITE_TIMEOUT_MS, "POST", body, fetchImpl);
  const record = asKeyView(data.record);
  if (!asText(data.key) || !record) throw new McpClientError("invalid_response");
  return { key: asText(data.key), record, note: asText(data.note) };
}

/** POST /local/mcp/keys/revoke —— confirm 由面板铸造：严格 String(keyId)。 */
export async function revokeMcpKey(
  input: { readonly keyId: number; readonly confirm: string },
  fetchImpl: typeof fetch = fetch,
): Promise<McpKeyViewItem> {
  const data = await requestJson(
    "/local/mcp/keys/revoke",
    MCP_WRITE_TIMEOUT_MS,
    "POST",
    { keyId: input.keyId, confirm: input.confirm },
    fetchImpl,
  );
  const record = asKeyView(data);
  if (!record) throw new McpClientError("invalid_response");
  return record;
}

/** POST /local/mcp/service/toggle —— confirm 必须布尔 true（客户端前置护栏，非 true 即拒发）。 */
export async function toggleMcpService(
  input: { readonly op: "enable" | "disable"; readonly confirm: true },
  fetchImpl: typeof fetch = fetch,
): Promise<McpToggleSnapshot> {
  if (input.op !== "enable" && input.op !== "disable") {
    throw new McpClientError("mcp_invalid_request", "开关操作只能是 enable 或 disable。");
  }
  if (input.confirm !== true) {
    throw new McpClientError("mcp_invalid_request", "开关服务必须显式确认（confirm 严格为布尔 true）。");
  }
  const data = await requestJson(
    "/local/mcp/service/toggle",
    MCP_WRITE_TIMEOUT_MS,
    "POST",
    { op: input.op, confirm: true },
    fetchImpl,
  );
  if (typeof data.enabled !== "boolean") throw new McpClientError("invalid_response");
  return { enabled: data.enabled, at: asText(data.at) };
}

/** GET /local/mcp/connectors —— 发现清单（来源 + 掩码连接器 + summary）。 */
export async function fetchMcpConnectors(fetchImpl: typeof fetch = fetch): Promise<McpConnectorsSnapshot> {
  const data = await requestJson("/local/mcp/connectors", MCP_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  if (!Array.isArray(data.sources) || !Array.isArray(data.servers)) throw new McpClientError("invalid_response");
  return {
    sources: data.sources.map(asSourceItem).filter((row): row is McpConnectorSourceItem => row !== null),
    servers: data.servers.map(asConnectorItem).filter((row): row is McpConnectorItem => row !== null),
    summary: asSummary(data.summary),
  };
}

/** POST /local/mcp/connectors/check —— 只读体检（桥侧单飞锁：并发会如实 mcp_busy）。 */
export async function checkMcpConnectors(
  input: { readonly name?: string; readonly all?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<McpCheckSnapshot> {
  const body: Record<string, unknown> = {};
  if (input.name) body.name = input.name;
  if (input.all === true) body.all = true;
  const data = await requestJson("/local/mcp/connectors/check", MCP_CHECK_TIMEOUT_MS, "POST", body, fetchImpl);
  if (!Array.isArray(data.results)) throw new McpClientError("invalid_response");
  return {
    checkedAt: asText(data.checkedAt),
    ms: asNumber(data.ms),
    attempted: asNumber(data.attempted),
    skipped: asNumber(data.skipped),
    results: data.results.map(asCheckResult).filter((row): row is McpCheckResultItem => row !== null),
  };
}

/** POST /local/mcp/connectors/dry —— 铸造一次性 token + 目标文件 + 掩码 diff（不写任何文件）。 */
export async function dryMcpConnector(input: McpConnectorDryInput, fetchImpl: typeof fetch = fetch): Promise<McpDrySnapshot> {
  if (!CONNECTOR_OPS.has(input.op)) {
    throw new McpClientError("mcp_invalid_request", "写操作只能是 set/enable/disable/remove。");
  }
  const body: Record<string, unknown> = { op: input.op, role: input.role, name: input.name };
  if (input.def !== undefined) body.def = input.def;
  const data = await requestJson("/local/mcp/connectors/dry", MCP_WRITE_TIMEOUT_MS, "POST", body, fetchImpl);
  const target = isRecord(data.target) ? data.target : {};
  const diff = isRecord(data.diff) ? data.diff : {};
  if (!asText(data.token) || !CONNECTOR_OPS.has(asText(data.op))) throw new McpClientError("invalid_response");
  return {
    token: asText(data.token),
    expiresAt: asText(data.expiresAt),
    op: asText(data.op) as McpConnectorOpName,
    role: asText(data.role),
    name: asText(data.name),
    existed: data.existed === true,
    target: { shown: asText(target.shown), role: asText(target.role), dot: asText(target.dot) },
    diff: {
      before: typeof diff.before === "string" ? diff.before : null,
      after: typeof diff.after === "string" ? diff.after : null,
    },
    note: asText(data.note),
  };
}

/** POST /local/mcp/connectors/confirm —— confirm 严格 === dry token（一次性；桥侧写前备份 .bak）。 */
export async function confirmMcpConnector(
  input: { readonly confirm: string },
  fetchImpl: typeof fetch = fetch,
): Promise<McpConfirmSnapshot> {
  const token = String(input.confirm ?? "");
  if (!token) {
    throw new McpClientError("mcp_invalid_request", "缺少一次性 token：请先 dry-run 获取。");
  }
  const data = await requestJson("/local/mcp/connectors/confirm", MCP_CONFIRM_TIMEOUT_MS, "POST", { confirm: token }, fetchImpl);
  if (!CONNECTOR_OPS.has(asText(data.op))) throw new McpClientError("invalid_response");
  return {
    op: asText(data.op) as McpConnectorOpName,
    role: asText(data.role),
    name: asText(data.name),
    existed: data.existed === true,
    backup: asText(data.backup),
    note: asText(data.note),
    server: asConnectorItem(data.server),
  };
}

/** 错误码 → 可直接展示的中文诚实文案（锁忙/存储不可用/确认不匹配都不粉饰）。 */
export function mcpErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行桥服务后重试。",
    invalid_response: "本机服务返回了无法识别的 MCP 数据。",
    mcp_invalid_request: "请求参数不合法：请检查名称/scope/操作后重试。",
    mcp_not_found: "目标不存在或已失效：请刷新列表后重试。",
    mcp_confirm_mismatch: "人工确认未通过：本次没有执行任何写操作。请重新发起并按提示确认。",
    mcp_busy: "上一轮操作还在进行中：等它结束再试（体检/写入不并发放行）。",
    mcp_store_unavailable: "本机存储写入失败（磁盘或权限问题）：本次未生效，原文未动。",
    mcp_upstream_error: "对端或写入校验失败：如实回滚，未留下半坏配置。",
    mcp_unavailable: "MCP 服务暂时不可用：请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  const code = error instanceof McpClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof McpClientError ? error.detail : "");
}
