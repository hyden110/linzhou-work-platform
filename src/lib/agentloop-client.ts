/**
 * Browser client for AgentLoop ops — 凭据管理 + 连接测试 + 两步出票。
 * GET/PUT/DELETE /local/agentloop/creds、POST /local/agentloop/{test,ticket-dry,ticket-confirm}、
 * GET /local/agentloop/tickets。
 *
 * 口径（与 dev/agentloop/agentloop-types.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃、坏形状整包 invalid_response，绝不半真半假；
 * - 错误分层：{error:{code,message}} → AgentloopClientError(code, detail)，
 *   agentloopErrorMessage 给可直接展示的中文诚实文案；
 * - 超时分层：客户端超时必须大于桥侧（桥侧探活 8s/视图 × ≤8 视图、出票 15s）：
 *   GET/PUT/DELETE/dry 15s，test 75s，confirm 30s——否则桥还在干活客户端先断，用户会重复点；
 * - 凭据值只出现在 PUT 请求体（发给本机桥），任何视图/日志都不回显；
 * - confirm 必须由确认弹窗在人工逐条勾选后铸造（confirm = dry 返回的一次性 token）。
 */

import { composeErrorMessage } from "./error-message.ts";

export const AGENTLOOP_GET_TIMEOUT_MS = 15_000;
export const AGENTLOOP_TEST_TIMEOUT_MS = 75_000;
export const AGENTLOOP_CONFIRM_TIMEOUT_MS = 30_000;

/** 客户端本地错误码 + 桥侧稳定错误码全集（agentloop-types.ts AgentloopErrorCode）。 */
export type AgentloopClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "agentloop_invalid_request"
  | "agentloop_not_found"
  | "agentloop_creds_missing"
  | "agentloop_confirm_mismatch"
  | "agentloop_upstream_auth"
  | "agentloop_upstream_error"
  | "agentloop_store_unavailable"
  | "agentloop_unavailable"
  | "method_not_allowed";

const KNOWN_CODES: ReadonlySet<string> = new Set<AgentloopClientErrorCode>([
  "unavailable", "invalid_response", "agentloop_invalid_request", "agentloop_not_found",
  "agentloop_creds_missing", "agentloop_confirm_mismatch", "agentloop_upstream_auth",
  "agentloop_upstream_error", "agentloop_store_unavailable", "agentloop_unavailable",
  "method_not_allowed",
]);

export class AgentloopClientError extends Error {
  readonly code: AgentloopClientErrorCode;
  readonly detail: string;

  constructor(code: AgentloopClientErrorCode, detail = "") {
    super(code);
    this.name = "AgentloopClientError";
    this.code = code;
    this.detail = detail;
  }
}

/** GET /local/agentloop/creds 的投影（掩码视图，绝无凭据值）。 */
export interface AgentloopCredsSnapshot {
  readonly set: boolean;
  readonly mask: string | null;
  readonly updatedAt: string | null;
}

export interface AgentloopProbeTargetRow {
  readonly id: string;
  readonly t: string;
  readonly ok: boolean;
  readonly note: string;
}

/** POST /local/agentloop/test 的投影（诚实三态：未设置 / 有效 / 异常 + 原因）。 */
export interface AgentloopTestSnapshot {
  readonly state: "unset" | "ok" | "error";
  readonly note: string;
  readonly targets: readonly AgentloopProbeTargetRow[];
  readonly checkedAt: string;
}

/** POST /local/agentloop/ticket-dry 的投影（掩码请求摘要 + 一次性 token）。 */
export interface AgentloopTicketDrySnapshot {
  readonly token: string;
  readonly expiresAt: string;
  readonly credsMask: string;
  readonly request: {
    readonly method: string;
    readonly host: string;
    readonly resource: string;
    readonly apiVersion: string;
    readonly signatureMethod: string;
    readonly authorizationPreview: string;
    readonly ttlSec: number;
    readonly region: string;
    readonly externalWrite: boolean;
  };
}

/** POST /local/agentloop/ticket-confirm 的投影（票据只回掩码）。 */
export interface AgentloopTicketConfirmSnapshot {
  readonly ticketMask: string;
  readonly ttl: number;
  readonly issuedAt: string;
  readonly expireAt: string;
  readonly region: string;
  readonly audited: boolean;
}

export interface AgentloopTicketAuditRow {
  readonly at: string;
  readonly action: "ticket";
  readonly status: "ok" | "error";
  readonly ticketMask: string;
  readonly ttl: number;
  readonly expireAt: string;
  readonly reason: string;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asCredsSnapshot(value: Record<string, unknown>): AgentloopCredsSnapshot {
  return {
    set: value.set === true,
    mask: value.set === true ? asNullableText(value.mask) : null,
    updatedAt: value.set === true ? asNullableText(value.updatedAt) : null,
  };
}

function asProbeTarget(value: unknown): AgentloopProbeTargetRow | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  return {
    id: asText(value.id),
    t: asText(value.t),
    ok: value.ok === true,
    note: asText(value.note),
  };
}

function asAuditRow(value: unknown): AgentloopTicketAuditRow | null {
  if (!isRecord(value) || !asText(value.at)) return null;
  if (value.status !== "ok" && value.status !== "error") return null;
  return {
    at: asText(value.at),
    action: "ticket",
    status: value.status,
    ticketMask: asText(value.ticketMask),
    ttl: asNumber(value.ttl),
    expireAt: asText(value.expireAt),
    reason: asText(value.reason),
  };
}

/* ---------------- 请求（超时分层；错误 {code,message} 如实上抛） ---------------- */

function agentloopUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  timeoutMs: number,
  method: "GET" | "PUT" | "DELETE" | "POST",
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(agentloopUrl(path), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch {
    throw new AgentloopClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new AgentloopClientError(error.code as AgentloopClientErrorCode, asText(error.message));
    }
    throw new AgentloopClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new AgentloopClientError("invalid_response");
  return payload.data;
}

/** GET /local/agentloop/creds —— 掩码视图（set/mask/updatedAt，绝无凭据值）。 */
export async function fetchAgentloopCreds(fetchImpl: typeof fetch = fetch): Promise<AgentloopCredsSnapshot> {
  return asCredsSnapshot(await requestJson("/local/agentloop/creds", AGENTLOOP_GET_TIMEOUT_MS, "GET", undefined, fetchImpl));
}

/** PUT /local/agentloop/creds —— 保存凭据（0600 原子写）；应答仍为掩码视图。 */
export async function saveAgentloopCreds(
  input: { readonly accessKeyId: string; readonly accessKeySecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AgentloopCredsSnapshot> {
  const data = await requestJson(
    "/local/agentloop/creds",
    AGENTLOOP_GET_TIMEOUT_MS,
    "PUT",
    { accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret },
    fetchImpl,
  );
  return asCredsSnapshot(data);
}

/** DELETE /local/agentloop/creds —— 幂等删除；removed 如实报是否真删了东西。 */
export async function deleteAgentloopCreds(
  fetchImpl: typeof fetch = fetch,
): Promise<AgentloopCredsSnapshot & { readonly removed: boolean }> {
  const data = await requestJson("/local/agentloop/creds", AGENTLOOP_GET_TIMEOUT_MS, "DELETE", undefined, fetchImpl);
  return { ...asCredsSnapshot(data), removed: data.removed === true };
}

/** POST /local/agentloop/test —— 只读连接探测（诚实三态，未知状态一律按异常呈现）。 */
export async function testAgentloopConnection(fetchImpl: typeof fetch = fetch): Promise<AgentloopTestSnapshot> {
  const data = await requestJson("/local/agentloop/test", AGENTLOOP_TEST_TIMEOUT_MS, "POST", {}, fetchImpl);
  const state = data.state === "unset" ? "unset" : data.state === "ok" ? "ok" : "error";
  const targets = Array.isArray(data.targets)
    ? data.targets.map(asProbeTarget).filter((row): row is AgentloopProbeTargetRow => row !== null)
    : [];
  return { state, note: asText(data.note), targets, checkedAt: asText(data.checkedAt) };
}

/** POST /local/agentloop/ticket-dry —— 出票预检（零网络；铸造一次性 confirm token）。 */
export async function dryAgentloopTicket(fetchImpl: typeof fetch = fetch): Promise<AgentloopTicketDrySnapshot> {
  const data = await requestJson("/local/agentloop/ticket-dry", AGENTLOOP_GET_TIMEOUT_MS, "POST", {}, fetchImpl);
  const token = asText(data.token);
  if (!token) throw new AgentloopClientError("invalid_response");
  const request = isRecord(data.request) ? data.request : {};
  return {
    token,
    expiresAt: asText(data.expiresAt),
    credsMask: asText(data.credsMask),
    request: {
      method: asText(request.method),
      host: asText(request.host),
      resource: asText(request.resource),
      apiVersion: asText(request.apiVersion),
      signatureMethod: asText(request.signatureMethod),
      authorizationPreview: asText(request.authorizationPreview),
      ttlSec: asNumber(request.ttlSec),
      region: asText(request.region),
      externalWrite: request.externalWrite === true,
    },
  };
}

/**
 * POST /local/agentloop/ticket-confirm —— body {confirm}；桥侧要求 confirm 严格 === dry token
 * 且未过期才真实出票。confirm 必须由确认弹窗在人工逐条勾选后原样下发（服务端闸门）。
 */
export async function confirmAgentloopTicket(
  confirm: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentloopTicketConfirmSnapshot> {
  const data = await requestJson(
    "/local/agentloop/ticket-confirm",
    AGENTLOOP_CONFIRM_TIMEOUT_MS,
    "POST",
    { confirm },
    fetchImpl,
  );
  const ticketMask = asText(data.ticketMask);
  if (!ticketMask) throw new AgentloopClientError("invalid_response");
  return {
    ticketMask,
    ttl: asNumber(data.ttl),
    issuedAt: asText(data.issuedAt),
    expireAt: asText(data.expireAt),
    region: asText(data.region),
    audited: data.audited === true,
  };
}

/** GET /local/agentloop/tickets —— 出票审计尾 50（最新在前，票据只落掩码）。 */
export async function fetchAgentloopTickets(
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly tickets: readonly AgentloopTicketAuditRow[]; readonly total: number }> {
  const data = await requestJson("/local/agentloop/tickets", AGENTLOOP_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  const tickets = Array.isArray(data.tickets)
    ? data.tickets.map(asAuditRow).filter((row): row is AgentloopTicketAuditRow => row !== null)
    : [];
  return { tickets, total: asNumber(data.total) };
}

/** 错误码 → 可直接展示的中文诚实文案（三态与外部写闸门都不粉饰）。 */
export function agentloopErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行桥服务后重试。",
    invalid_response: "本机服务返回了无法识别的 AgentLoop 数据。",
    agentloop_invalid_request: "凭据形态不合法或请求参数有误：AK 为 10–64 位字母数字、SK 为 24–64 位字母数字。",
    agentloop_not_found: "出票预检已过期：请重新预检，并在 5 分钟内完成确认。",
    agentloop_creds_missing: "尚未配置 AgentLoop 凭据：请先保存 AccessKey 后再测试或出票。",
    agentloop_confirm_mismatch: "人工确认未完成：本次没有执行出票。请在弹窗中逐条勾选确认后重试。",
    agentloop_upstream_auth: "SLS 鉴权失败（401/403）：请核对 AccessKey 是否有效、是否有目标项目权限。",
    agentloop_upstream_error: "SLS 出票或探活失败：未产生票据，可稍后重试。",
    agentloop_store_unavailable: "本机凭据存储读写失败：请检查 .local-cache/agentloop 目录权限后重试。",
    agentloop_unavailable: "AgentLoop 服务暂时不可用：请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  const code = error instanceof AgentloopClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof AgentloopClientError ? error.detail : "");
}
