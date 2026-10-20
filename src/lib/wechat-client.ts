/**
 * Browser client for 微信办公台账 — GET /local/wechat(+bindings/tree/custorg) 只读投影、
 * PUT/DELETE /local/wechat/bindings 本地台账写、POST /local/wechat/custorg-import
 * dry→confirm 两步导入。
 *
 * 口径（与 dev/wechat/wechat-types.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃、未知枚举如实降级/丢弃、data 形态不符整包 invalid_response
 *   ——绝不半真半假（沿 worklog-client 先例）；
 * - 错误分层：{error:{code,message}} → WechatClientError(code, detail)，
 *   wechatErrorMessage 给可直接展示的中文诚实文案；
 * - 只读 GET 超时 15s、写路径 20s（台账写含备份/审计多步文件操作，留足余量）；
 * - confirm 由客户端自动补 confirm === token（桥侧仍严格校验，双保险）。
 */

import { composeErrorMessage } from "./error-message.ts";
import type {
  WechatCustomerStatus,
  WechatGroupView,
  WechatLabelView,
  WechatMentionView,
  WechatQrTreeView,
  WechatRecentAtView,
  WechatSingleView,
  WechatSnapshotOkView,
  WechatSnapshotView,
  WechatSourceView,
  WechatStatsView,
  WechatTodoView,
  WechatUrgency,
} from "./wechat-model.ts";

const WECHAT_GET_TIMEOUT_MS = 15_000;
const WECHAT_WRITE_TIMEOUT_MS = 20_000;
const TOKEN_PATTERN = /^[0-9a-f]{16}$/;

export type WechatClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "wechat_invalid_request"
  | "binding_not_found"
  | "wechat_busy"
  | "confirm_mismatch"
  | "wechat_store_failed"
  | "wechat_unavailable"
  | "method_not_allowed";

const KNOWN_CODES: ReadonlySet<string> = new Set<WechatClientErrorCode>([
  "unavailable", "invalid_response", "wechat_invalid_request", "binding_not_found",
  "wechat_busy", "confirm_mismatch", "wechat_store_failed", "wechat_unavailable", "method_not_allowed",
]);

const CUSTOMER_STATUSES: ReadonlySet<string> = new Set<WechatCustomerStatus>(["confirmed", "matched", "pending"]);
const URGENCIES: ReadonlySet<string> = new Set<WechatUrgency>(["high", "mid", "low", "overdue"]);
const AUDIT_OPS: ReadonlySet<string> = new Set(["bind", "unbind", "custorg-import"]);

export class WechatClientError extends Error {
  readonly code: WechatClientErrorCode;
  readonly detail: string;

  constructor(code: WechatClientErrorCode, detail = "") {
    super(code);
    this.name = "WechatClientError";
    this.code = code;
    this.detail = detail;
  }
}

export interface WechatBindingView {
  readonly groupId: string;
  readonly custKeys: readonly string[];
  readonly note: string;
  readonly updatedAt: string;
}

export interface WechatAuditView {
  readonly at: string;
  readonly op: "bind" | "unbind" | "custorg-import";
  readonly groupId: string;
  readonly custKeys: readonly string[];
  readonly note: string;
  readonly customers: number;
  readonly rows: number;
  readonly ok: boolean;
}

export interface WechatBindingsSnapshot {
  readonly updatedAt: string;
  readonly entries: readonly WechatBindingView[];
  readonly total: number;
  readonly auditTail: readonly WechatAuditView[];
}

export interface WechatCustorgDiffView {
  readonly key: string;
  readonly incomingRows: number;
  readonly existingRows: number;
}

export interface WechatCustorgDryView {
  readonly phase: "dry";
  readonly token: string;
  readonly customerCount: number;
  readonly rowCount: number;
  readonly willImport: readonly WechatCustorgDiffView[];
  readonly willOverwrite: readonly WechatCustorgDiffView[];
  readonly note: string;
}

export interface WechatCustorgConfirmedView {
  readonly phase: "confirmed";
  readonly token: string;
  readonly customerCount: number;
  readonly rowCount: number;
  readonly totalCustomers: number;
  readonly totalRows: number;
  readonly updatedAt: string;
}

export interface WechatBindingInput {
  readonly groupId: string;
  readonly custKeys: readonly string[];
  readonly note?: string;
}

export interface WechatCustorgRowView {
  readonly dept: string;
  readonly name: string;
  readonly title: string;
  readonly contact: string;
}

export interface WechatCustorgLedgerEntryView {
  readonly key: string;
  readonly name: string;
  readonly rowCount: number;
  readonly rows: readonly WechatCustorgRowView[];
}

/** GET /local/wechat/custorg 台账只读视图：空台账如实空数组（绝不半真半假）。 */
export interface WechatCustorgLedgerView {
  readonly updatedAt: string;
  readonly customers: readonly WechatCustorgLedgerEntryView[];
  readonly totalCustomers: number;
  readonly totalRows: number;
}

/* ---------------- 基础工具 ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  init: { method: string; body?: unknown; timeoutMs: number },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(localUrl(path), {
      method: init.method,
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    }));
  } catch {
    throw new WechatClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new WechatClientError(error.code as WechatClientErrorCode, asText(error.message));
    }
    throw new WechatClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new WechatClientError("invalid_response");
  return payload.data;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function asStats(value: unknown): WechatStatsView {
  const record = isRecord(value) ? value : {};
  return {
    groups: asNumber(record.groups),
    groupsActive7: asNumber(record.groupsActive7),
    groupsActive30: asNumber(record.groupsActive30),
    groupsMine7: asNumber(record.groupsMine7),
    custBound: asNumber(record.custBound),
    atMeAll: asNumber(record.atMeAll),
    atMe30: asNumber(record.atMe30),
    todos: asNumber(record.todos),
    todosHigh: asNumber(record.todosHigh),
    unread: asNumber(record.unread),
    singleUnreplied: asNumber(record.singleUnreplied),
    messages: asNumber(record.messages),
  };
}

function asSource(value: unknown): WechatSourceView {
  const record = isRecord(value) ? value : {};
  return {
    dbs: asNumber(record.dbs),
    tables: asNumber(record.tables),
    messages: asNumber(record.messages),
    groups: asNumber(record.groups),
    singles: asNumber(record.singles),
    window: asNumber(record.window),
  };
}

function asCounts(value: unknown, keys: readonly string[]): Record<string, number> {
  const record = isRecord(value) ? value : {};
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = asNumber(record[key]);
  return out;
}

function asRecentAt(value: unknown): WechatRecentAtView | null {
  if (!isRecord(value)) return null;
  return { t: asNumber(value.t), name: asText(value.name), textMasked: asText(value.textMasked) };
}

function asGroup(value: unknown): WechatGroupView | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  const status = asText(value.customerStatus);
  const atMe = isRecord(value.atMe) ? value.atMe : {};
  return {
    id: asText(value.id),
    name: asText(value.name),
    memberCount: asNumber(value.memberCount),
    muted: value.muted === true,
    unread: asNumber(value.unread),
    lastMsgAt: asNumber(value.lastMsgAt),
    lastSummaryMasked: asText(value.lastSummaryMasked),
    custKeys: asStringArray(value.custKeys),
    customerStatus: CUSTOMER_STATUSES.has(status) ? (status as WechatCustomerStatus) : "pending",
    bindNote: asText(value.bindNote),
    msg: asCounts(value.msg, ["d7", "d30", "dWin", "all"]) as WechatGroupView["msg"],
    senders: asCounts(value.senders, ["d7", "d30", "all"]) as WechatGroupView["senders"],
    mine: asCounts(value.mine, ["d7", "d30", "all", "lastAt"]) as WechatGroupView["mine"],
    atMe: {
      all: asNumber(atMe.all),
      lastAt: asNumber(atMe.lastAt),
      daysSince: typeof atMe.daysSince === "number" && Number.isFinite(atMe.daysSince) ? atMe.daysSince : null,
      unreplied: atMe.unreplied === true,
    },
    recentAtMe: (Array.isArray(value.recentAtMe) ? value.recentAtMe : [])
      .map(asRecentAt)
      .filter((row): row is WechatRecentAtView => row !== null),
  };
}

function asTodo(value: unknown): WechatTodoView | null {
  if (!isRecord(value) || !asText(value.groupId)) return null;
  const urgency = asText(value.urgency);
  if (!URGENCIES.has(urgency)) return null;
  return {
    groupId: asText(value.groupId),
    groupName: asText(value.groupName),
    custKeys: asStringArray(value.custKeys),
    urgency: urgency as WechatUrgency,
    daysSince: asNumber(value.daysSince),
    at: asNumber(value.at),
    fromName: asText(value.fromName),
    textMasked: asText(value.textMasked),
  };
}

function asMention(value: unknown): WechatMentionView | null {
  if (!isRecord(value)) return null;
  const kind = asText(value.kind);
  if (kind !== "at" && kind !== "single") return null;
  return {
    kind,
    t: asNumber(value.t),
    convId: asText(value.convId),
    convName: asText(value.convName),
    group: value.group === true,
    custKeys: asStringArray(value.custKeys),
    fromName: asText(value.fromName),
    textMasked: asText(value.textMasked),
    unread: value.unread === true,
  };
}

function asSingle(value: unknown): WechatSingleView | null {
  if (!isRecord(value) || !asText(value.idMasked)) return null;
  return {
    idMasked: asText(value.idMasked),
    name: asText(value.name),
    muted: value.muted === true,
    msg: asCounts(value.msg, ["d7", "d30", "all"]) as WechatSingleView["msg"],
    lastMsgAt: asNumber(value.lastMsgAt),
    unread: asNumber(value.unread),
    lastSummaryMasked: asText(value.lastSummaryMasked),
    unreplied: value.unreplied === true,
  };
}

function asLabel(value: unknown): WechatLabelView | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "number" || typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

function asSnapshot(data: Record<string, unknown>): WechatSnapshotView {
  const status = asText(data.status);
  if (status === "missing") {
    return {
      status: "missing",
      missingNote: asText(data.missingNote),
      steps: asStringArray(data.steps),
    };
  }
  if (status !== "ok") throw new WechatClientError("invalid_response");
  const ok: WechatSnapshotOkView = {
    status: "ok",
    version: asNumber(data.version),
    updatedAt: asText(data.updatedAt),
    meName: asText(data.meName),
    source: asSource(data.source),
    stats: asStats(data.stats),
    groups: (Array.isArray(data.groups) ? data.groups : []).map(asGroup).filter((row): row is WechatGroupView => row !== null),
    todos: (Array.isArray(data.todos) ? data.todos : []).map(asTodo).filter((row): row is WechatTodoView => row !== null),
    mentions: (Array.isArray(data.mentions) ? data.mentions : []).map(asMention).filter((row): row is WechatMentionView => row !== null),
    singles: (Array.isArray(data.singles) ? data.singles : []).map(asSingle).filter((row): row is WechatSingleView => row !== null),
    labels: (Array.isArray(data.labels) ? data.labels : []).map(asLabel).filter((row): row is WechatLabelView => row !== null),
  };
  return ok;
}

function asBinding(value: unknown): WechatBindingView | null {
  if (!isRecord(value) || !asText(value.groupId) || !Array.isArray(value.custKeys)) return null;
  return {
    groupId: asText(value.groupId),
    custKeys: asStringArray(value.custKeys),
    note: asText(value.note),
    updatedAt: asText(value.updatedAt),
  };
}

function asAudit(value: unknown): WechatAuditView | null {
  if (!isRecord(value)) return null;
  const op = asText(value.op);
  if (!AUDIT_OPS.has(op)) return null;
  return {
    at: asText(value.at),
    op: op as WechatAuditView["op"],
    groupId: asText(value.groupId),
    custKeys: asStringArray(value.custKeys),
    note: asText(value.note),
    customers: asNumber(value.customers),
    rows: asNumber(value.rows),
    ok: value.ok !== false,
  };
}

function asBindings(data: Record<string, unknown>): WechatBindingsSnapshot {
  return {
    updatedAt: asText(data.updatedAt),
    entries: (Array.isArray(data.entries) ? data.entries : []).map(asBinding).filter((row): row is WechatBindingView => row !== null),
    total: asNumber(data.total),
    auditTail: (Array.isArray(data.auditTail) ? data.auditTail : []).map(asAudit).filter((row): row is WechatAuditView => row !== null),
  };
}

function asCustorgRow(value: unknown): WechatCustorgRowView | null {
  if (!isRecord(value)) return null;
  const row: WechatCustorgRowView = {
    dept: asText(value.dept),
    name: asText(value.name),
    title: asText(value.title),
    contact: asText(value.contact),
  };
  return row.dept || row.name || row.title ? row : null;
}

/** 台账客户白名单投影：key 空的整条丢弃；行数按投影后实际行数重算（不信服务端计数）。 */
function asCustorgEntry(value: unknown): WechatCustorgLedgerEntryView | null {
  if (!isRecord(value) || asText(value.key).trim() === "") return null;
  const key = asText(value.key).trim();
  const rows = (Array.isArray(value.rows) ? value.rows : [])
    .map(asCustorgRow)
    .filter((row): row is WechatCustorgRowView => row !== null);
  return { key, name: asText(value.name).trim() || key, rowCount: rows.length, rows };
}

function asCustorgLedger(data: Record<string, unknown>): WechatCustorgLedgerView {
  const customers = (Array.isArray(data.customers) ? data.customers : [])
    .map(asCustorgEntry)
    .filter((row): row is WechatCustorgLedgerEntryView => row !== null);
  return {
    updatedAt: asText(data.updatedAt),
    customers,
    totalCustomers: customers.length,
    totalRows: customers.reduce((sum, customer) => sum + customer.rowCount, 0),
  };
}

function asDiffRows(value: unknown): WechatCustorgDiffView[] {
  return (Array.isArray(value) ? value : [])
    .filter((row): row is Record<string, unknown> => isRecord(row) && asText(row.key) !== "")
    .map((row) => ({ key: asText(row.key), incomingRows: asNumber(row.incomingRows), existingRows: asNumber(row.existingRows) }));
}

function asDry(data: Record<string, unknown>): WechatCustorgDryView {
  const token = asText(data.token);
  if (asText(data.phase) !== "dry" || !TOKEN_PATTERN.test(token)) throw new WechatClientError("invalid_response");
  return {
    phase: "dry",
    token,
    customerCount: asNumber(data.customerCount),
    rowCount: asNumber(data.rowCount),
    willImport: asDiffRows(data.willImport),
    willOverwrite: asDiffRows(data.willOverwrite),
    note: asText(data.note),
  };
}

function asConfirmed(data: Record<string, unknown>): WechatCustorgConfirmedView {
  const token = asText(data.token);
  if (asText(data.phase) !== "confirmed" || !TOKEN_PATTERN.test(token)) throw new WechatClientError("invalid_response");
  return {
    phase: "confirmed",
    token,
    customerCount: asNumber(data.customerCount),
    rowCount: asNumber(data.rowCount),
    totalCustomers: asNumber(data.totalCustomers),
    totalRows: asNumber(data.totalRows),
    updatedAt: asText(data.updatedAt),
  };
}

function asTree(data: Record<string, unknown>): WechatQrTreeView {
  const status = asText(data.status);
  if (status !== "ok" && status !== "missing") throw new WechatClientError("invalid_response");
  const nodes = (Array.isArray(data.nodes) ? data.nodes : [])
    .filter((node): node is Record<string, unknown> => {
      if (!isRecord(node)) return false;
      const kind = asText(node.kind);
      return (kind === "cust" || kind === "unbound") && asText(node.key) !== "";
    })
    .map((node) => ({
      key: asText(node.key),
      name: asText(node.name),
      kind: asText(node.kind) as "cust" | "unbound",
      groups: asNumber(node.groups),
      awaiting: asNumber(node.awaiting),
      msgD30: asNumber(node.msgD30),
      children: (Array.isArray(node.children) ? node.children : [])
        .filter((leaf): leaf is Record<string, unknown> => isRecord(leaf) && asText(leaf.groupId) !== "")
        .map((leaf) => ({
          groupId: asText(leaf.groupId),
          name: asText(leaf.name),
          custKeys: asStringArray(leaf.custKeys),
          unreplied: leaf.unreplied === true,
          atMeAll: asNumber(leaf.atMeAll),
          msgD30: asNumber(leaf.msgD30),
          muted: leaf.muted === true,
        })),
    }));
  return { status, missingNote: asText(data.missingNote), steps: asStringArray(data.steps), nodes };
}

/* ---------------- 请求 ---------------- */

/** GET /local/wechat —— 快照白名单投影（缺失 → status:"missing" + 修复指引）。 */
export async function fetchWechatSnapshot(fetchImpl: typeof fetch = fetch): Promise<WechatSnapshotView> {
  return asSnapshot(await requestJson("/local/wechat", { method: "GET", timeoutMs: WECHAT_GET_TIMEOUT_MS }, fetchImpl));
}

/** GET /local/wechat/tree —— qr-tree 分组只读（客户 → 群 两层折叠树）。 */
export async function fetchWechatTree(fetchImpl: typeof fetch = fetch): Promise<WechatQrTreeView> {
  return asTree(await requestJson("/local/wechat/tree", { method: "GET", timeoutMs: WECHAT_GET_TIMEOUT_MS }, fetchImpl));
}

/** GET /local/wechat/bindings —— 群↔客户绑定台账（含审计尾）。 */
export async function fetchWechatBindings(fetchImpl: typeof fetch = fetch): Promise<WechatBindingsSnapshot> {
  return asBindings(await requestJson("/local/wechat/bindings", { method: "GET", timeoutMs: WECHAT_GET_TIMEOUT_MS }, fetchImpl));
}

/** PUT /local/wechat/bindings —— 本地台账写（桥侧 0600 原子 + 备份 + 单飞 + 审计）。 */
export async function putWechatBinding(input: WechatBindingInput, fetchImpl: typeof fetch = fetch): Promise<WechatBindingsSnapshot> {
  return asBindings(await requestJson("/local/wechat/bindings", {
    method: "PUT",
    body: { groupId: input.groupId, custKeys: [...input.custKeys], note: input.note ?? "" },
    timeoutMs: WECHAT_WRITE_TIMEOUT_MS,
  }, fetchImpl));
}

/** DELETE /local/wechat/bindings —— 解绑（同闸门）。 */
export async function deleteWechatBinding(groupId: string, fetchImpl: typeof fetch = fetch): Promise<WechatBindingsSnapshot> {
  return asBindings(await requestJson("/local/wechat/bindings", {
    method: "DELETE",
    body: { groupId },
    timeoutMs: WECHAT_WRITE_TIMEOUT_MS,
  }, fetchImpl));
}

/** POST /local/wechat/custorg-import（第一步）—— dry：只回 token + diff 摘要，绝不落盘。 */
export async function custorgImportDry(text: string, fetchImpl: typeof fetch = fetch): Promise<WechatCustorgDryView> {
  return asDry(await requestJson("/local/wechat/custorg-import", {
    method: "POST",
    body: { text },
    timeoutMs: WECHAT_WRITE_TIMEOUT_MS,
  }, fetchImpl));
}

/** POST /local/wechat/custorg-import（第二步）—— confirm：自动补 confirm === token（桥侧仍严格校验）。 */
export async function custorgImportConfirm(
  input: { readonly text: string; readonly token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<WechatCustorgConfirmedView> {
  return asConfirmed(await requestJson("/local/wechat/custorg-import", {
    method: "POST",
    body: { text: input.text, token: input.token, confirm: input.token },
    timeoutMs: WECHAT_WRITE_TIMEOUT_MS,
  }, fetchImpl));
}

/** GET /local/wechat/custorg —— 本地客户组织台账只读回显（导入后可核对，不是只写）。 */
export async function fetchWechatCustorg(fetchImpl: typeof fetch = fetch): Promise<WechatCustorgLedgerView> {
  return asCustorgLedger(await requestJson("/local/wechat/custorg", { method: "GET", timeoutMs: WECHAT_GET_TIMEOUT_MS }, fetchImpl));
}

/** 错误码 → 可直接展示的中文诚实文案（写闸门/缺失态都不粉饰）。 */
export function wechatErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行微信台账桥后重试。",
    invalid_response: "本机服务返回了无法识别的微信台账数据。",
    wechat_invalid_request: "请求参数不合法：请检查群 id / 客户键形态。",
    binding_not_found: "该群不在本地绑定台账中：无需解绑或已解除。",
    wechat_busy: "台账写入进行中（单飞锁）：请等待上一笔完成后重试。",
    confirm_mismatch: "导入确认未完成：confirm 必须严格等于本次文本的 dry token，本次未写入。",
    wechat_store_failed: "本地台账写入失败（0600 原子写/备份/审计任一环节）：本次未生效，请重试。",
    wechat_unavailable: "微信台账服务遇到未知故障：请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  const code = error instanceof WechatClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof WechatClientError ? error.detail : "");
}
