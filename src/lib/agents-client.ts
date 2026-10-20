/**
 * Browser client for the agents view (F7) — GET /local/agents/{state,agentloop,wechat}。
 * 全只读：数字员工视图不提供凭据管理 / 出票 / 绑定管理入口（「待授权，本台未开通」），
 * 客户端层只做白名单投影与稳定错误码折叠；降级契约同 report/leads 客户端：
 * 桥 500/离线 → unavailable + 「本地桥未启动」文案。无自动轮询，全部显式拉取。
 */

import { composeErrorMessage } from "./error-message.ts";
import { clockCn } from "./report-client.ts";

export { clockCn };

const AGENTS_TIMEOUT_MS = 15_000; /* 桥侧 daemon 探测上限 5s + 余量 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "agents_unconfigured",
  "agents_unavailable",
] as const;

export type AgentsClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class AgentsClientError extends Error {
  readonly code: AgentsClientErrorCode;
  readonly detail: string;

  constructor(code: AgentsClientErrorCode, detail = "") {
    super(code);
    this.name = "AgentsClientError";
    this.code = code;
    this.detail = detail;
  }
}

/* 投影类型与 dev/agents/agents-types.ts 语义一致（白名单字段）。 */

export type WakeDaemonStatus = "ok" | "degraded" | "down";

export interface WakeDaemonView {
  readonly status: WakeDaemonStatus;
  readonly port: number;
  readonly url: string;
  readonly http: number | null;
  readonly note: string;
  readonly checkedAt: string;
}

export interface WakeEntryLink {
  readonly id: string;
  readonly t: string;
  readonly path: string;
}

export interface WakeEndpointLink {
  readonly id: string;
  readonly t: string;
  readonly url: string;
}

export interface AgentsWakeState {
  readonly daemon: WakeDaemonView;
  readonly entries: readonly WakeEntryLink[];
  readonly endpoints: readonly WakeEndpointLink[];
}

export interface AgentLoopViewRow {
  readonly id: string;
  readonly t: string;
  readonly sub: string;
  readonly project: string;
  readonly logstore: string;
  readonly region: string;
}

export interface AgentLoopStatusView {
  readonly configured: boolean;
  readonly mask: string | null;
  readonly updatedAt: string | null;
  readonly note: string;
  readonly console: string;
  readonly views: readonly AgentLoopViewRow[];
  readonly writesNote: string;
}

export interface WechatSnapshotStats {
  readonly groups: number | null;
  readonly groupsActive7: number | null;
  readonly groupsActive30: number | null;
  readonly groupsMine7: number | null;
  readonly custBound: number | null;
  readonly atMeAll: number | null;
}

export interface WechatSnapshotSource {
  readonly dbs: number | null;
  readonly tables: number | null;
  readonly messages: number | null;
  readonly groups: number | null;
  readonly singles: number | null;
  readonly window: number | null;
}

export interface WechatSnapshotView {
  readonly at: string;
  readonly updatedAt: string;
  readonly me: { readonly wxid: string; readonly name: string };
  readonly source: WechatSnapshotSource;
  readonly stats: WechatSnapshotStats;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** 三态收敛：白名单外的状态一律折叠为 down（绝不把未知状态画成在线）。 */
function asDaemonStatus(value: unknown): WakeDaemonStatus {
  return value === "ok" || value === "degraded" ? value : "down";
}

function asDaemon(value: unknown): WakeDaemonView {
  const source = isRecord(value) ? value : {};
  return {
    status: asDaemonStatus(source.status),
    port: typeof source.port === "number" && Number.isFinite(source.port) && source.port > 0 ? source.port : 0,
    url: asText(source.url),
    http: typeof source.http === "number" && Number.isFinite(source.http) ? source.http : null,
    note: asText(source.note),
    checkedAt: asText(source.checkedAt),
  };
}

function asEntry(value: unknown): WakeEntryLink | undefined {
  if (!isRecord(value) || !asText(value.id)) return undefined;
  return { id: asText(value.id), t: asText(value.t), path: asText(value.path) };
}

function asEndpoint(value: unknown): WakeEndpointLink | undefined {
  if (!isRecord(value) || !asText(value.id)) return undefined;
  return { id: asText(value.id), t: asText(value.t), url: asText(value.url) };
}

function asWakeState(value: unknown): AgentsWakeState | undefined {
  if (!isRecord(value) || !isRecord(value.daemon)) return undefined;
  return {
    daemon: asDaemon(value.daemon),
    entries: Array.isArray(value.entries) ? value.entries.map(asEntry).filter((e): e is WakeEntryLink => e !== undefined) : [],
    endpoints: Array.isArray(value.endpoints) ? value.endpoints.map(asEndpoint).filter((e): e is WakeEndpointLink => e !== undefined) : [],
  };
}

function asViewRow(value: unknown): AgentLoopViewRow | undefined {
  if (!isRecord(value) || !asText(value.id)) return undefined;
  return {
    id: asText(value.id),
    t: asText(value.t),
    sub: asText(value.sub),
    project: asText(value.project),
    logstore: asText(value.logstore),
    region: asText(value.region),
  };
}

function asLoopStatus(value: unknown): AgentLoopStatusView | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean") return undefined;
  return {
    configured: value.configured,
    mask: typeof value.mask === "string" && value.mask ? value.mask : null,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : null,
    note: asText(value.note),
    console: asText(value.console),
    views: Array.isArray(value.views) ? value.views.map(asViewRow).filter((r): r is AgentLoopViewRow => r !== undefined) : [],
    writesNote: asText(value.writesNote),
  };
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asStats(value: unknown): WechatSnapshotStats {
  const source = isRecord(value) ? value : {};
  return {
    groups: asCount(source.groups),
    groupsActive7: asCount(source.groupsActive7),
    groupsActive30: asCount(source.groupsActive30),
    groupsMine7: asCount(source.groupsMine7),
    custBound: asCount(source.custBound),
    atMeAll: asCount(source.atMeAll),
  };
}

function asSource(value: unknown): WechatSnapshotSource {
  const source = isRecord(value) ? value : {};
  return {
    dbs: asCount(source.dbs),
    tables: asCount(source.tables),
    messages: asCount(source.messages),
    groups: asCount(source.groups),
    singles: asCount(source.singles),
    window: asCount(source.window),
  };
}

function asWechatView(value: unknown): WechatSnapshotView | undefined {
  if (!isRecord(value) || !isRecord(value.me)) return undefined;
  const me = isRecord(value.me) ? value.me : {};
  return {
    at: asText(value.at),
    updatedAt: asText(value.updatedAt),
    me: { wxid: asText(me.wxid), name: asText(me.name) },
    source: asSource(value.source),
    stats: asStats(value.stats),
  };
}

function agentsUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(path: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(agentsUrl(path), {
      method: "GET",
      signal: AbortSignal.timeout(AGENTS_TIMEOUT_MS),
    }));
  } catch {
    throw new AgentsClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new AgentsClientError(payload.error as AgentsClientErrorCode, asText(payload.message));
    }
    throw new AgentsClientError("unavailable");
  }
  return payload;
}

/** GET /local/agents/state —— daemon 健康 + 视图入口 + 配置的 ECS 端点（down 也是数据）。 */
export async function fetchAgentsState(fetchImpl: typeof fetch = fetch): Promise<AgentsWakeState> {
  const payload = await requestJson("/local/agents/state", fetchImpl);
  const state = asWakeState(payload.data);
  if (!state) throw new AgentsClientError("invalid_response");
  return state;
}

/** GET /local/agents/agentloop —— 凭据存在性与掩码 + console 外链 + views 列表。 */
export async function fetchAgentsAgentloop(fetchImpl: typeof fetch = fetch): Promise<AgentLoopStatusView> {
  const payload = await requestJson("/local/agents/agentloop", fetchImpl);
  const status = asLoopStatus(payload.data);
  if (!status) throw new AgentsClientError("invalid_response");
  return status;
}

/** GET /local/agents/wechat —— 微信办公快照统计（白名单投影，缺字段容错 null）。 */
export async function fetchAgentsWechat(fetchImpl: typeof fetch = fetch): Promise<WechatSnapshotView> {
  const payload = await requestJson("/local/agents/wechat", fetchImpl);
  const view = asWechatView(payload.data);
  if (!view) throw new AgentsClientError("invalid_response");
  return view;
}

export function agentsErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的数字员工数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    agents_unconfigured: "未配置数字员工数据源：补 .local-cache/agents.json（参考 config/agents.json.example）后刷新。",
    agents_unavailable: "数字员工数据暂不可用：快照或凭据探测文件读取失败，确认文件可读后刷新。",
  };
  const code = error instanceof AgentsClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  return composeErrorMessage(base, error instanceof AgentsClientError ? error.detail : "");
}
