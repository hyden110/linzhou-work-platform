/**
 * Browser client for the reports view (F6) — GET /local/report/{state,automations,
 * weeklies,weekly}。全只读：工作台不提供保存 / 发送入口（「待授权，本台未开通」），
 * 客户端层只做白名单投影与稳定错误码折叠；降级契约同 leads/cases 客户端：
 * 桥 500/离线 → unavailable + 「本地桥未启动」文案。无自动轮询，全部显式拉取。
 */

const REPORT_TIMEOUT_MS = 120_000; /* 桥侧 dws/SSH 上限 90s + 网络余量 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "report_unconfigured",
  "report_unavailable",
  "report_upstream",
] as const;

export type ReportClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class ReportClientError extends Error {
  readonly code: ReportClientErrorCode;
  readonly detail: string;

  constructor(code: ReportClientErrorCode, detail = "") {
    super(code);
    this.name = "ReportClientError";
    this.code = code;
    this.detail = detail;
  }
}

/* 投影类型与 dev/report/report-types.ts 语义一致（白名单字段）。 */

export interface ReportTodayRecord {
  readonly recordId: string;
  readonly topic: string;
  readonly dept: string;
  readonly workStatus: string;
  readonly followup: string;
  readonly opportunity: string;
  readonly risk: string;
  readonly other: string;
  readonly modifiedAt: string;
}

export interface ReportSubmitted {
  readonly n: number;
  readonly items: ReadonlyArray<{ readonly title: string; readonly time: string }>;
}

export interface ReportDwsStatus {
  readonly ok: boolean;
  readonly code: string;
  readonly note: string;
  readonly fix: string;
}

export interface ReportState {
  readonly configured: boolean;
  readonly configNote: string;
  readonly today: string;
  readonly weekday: number;
  readonly dws: ReportDwsStatus;
  readonly record: ReportTodayRecord | null;
  readonly recordNote: string;
  readonly submitted: ReportSubmitted | null;
  readonly submittedNote: string;
}

export interface ReportAutomationJob {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly cond: string;
  readonly lastStatus: string;
  readonly lastAt: string;
  readonly nextAt: string;
}

export interface ReportAutomations {
  readonly configured: boolean;
  readonly configNote: string;
  readonly at: string;
  readonly jobs: readonly ReportAutomationJob[];
}

export interface ReportWeeklyItem {
  readonly name: string;
  readonly nodeId: string;
  readonly url: string;
  readonly created: string;
  readonly updated: string;
}

export interface ReportWeeklies {
  readonly at: string;
  readonly folderUrl: string;
  readonly items: readonly ReportWeeklyItem[];
  readonly hasMore: boolean;
}

export interface ReportWeeklyDoc {
  readonly at: string;
  readonly nodeId: string;
  readonly name: string;
  readonly url: string;
  readonly markdown: string;
  readonly truncated: boolean;
  readonly contentHash: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function asDws(value: unknown): ReportDwsStatus {
  const source = isRecord(value) ? value : {};
  return {
    ok: source.ok === true,
    code: asText(source.code),
    note: asText(source.note),
    fix: asText(source.fix),
  };
}

function asRecordView(value: unknown): ReportTodayRecord | null {
  if (!isRecord(value) || !asText(value.recordId)) return null;
  return {
    recordId: asText(value.recordId),
    topic: asText(value.topic),
    dept: asText(value.dept),
    workStatus: asText(value.workStatus),
    followup: asText(value.followup),
    opportunity: asText(value.opportunity),
    risk: asText(value.risk),
    other: asText(value.other),
    modifiedAt: asText(value.modifiedAt),
  };
}

function asSubmitted(value: unknown): ReportSubmitted | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return {
    n: typeof value.n === "number" && Number.isFinite(value.n) ? value.n : value.items.length,
    items: value.items
      .filter(isRecord)
      .map((item) => ({ title: asText(item.title), time: asText(item.time) })),
  };
}

function asState(value: unknown): ReportState | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean") return undefined;
  const record = value.record == null ? null : asRecordView(value.record);
  const submitted = value.submitted == null ? null : asSubmitted(value.submitted);
  return {
    configured: value.configured,
    configNote: asText(value.configNote),
    today: asText(value.today),
    weekday: typeof value.weekday === "number" && Number.isFinite(value.weekday) ? value.weekday : -1,
    dws: asDws(value.dws),
    record,
    recordNote: asText(value.recordNote),
    submitted,
    submittedNote: asText(value.submittedNote),
  };
}

function asJob(value: unknown): ReportAutomationJob | undefined {
  if (!isRecord(value) || !asText(value.id)) return undefined;
  return {
    key: asText(value.key),
    id: asText(value.id),
    name: asText(value.name),
    enabled: value.enabled === true,
    cond: asText(value.cond),
    lastStatus: asText(value.lastStatus),
    lastAt: asText(value.lastAt),
    nextAt: asText(value.nextAt),
  };
}

function asAutomations(value: unknown): ReportAutomations | undefined {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return undefined;
  return {
    configured: value.configured === true,
    configNote: asText(value.configNote),
    at: asText(value.at),
    jobs: value.jobs.map(asJob).filter((job): job is ReportAutomationJob => job !== undefined),
  };
}

function asWeeklyItem(value: unknown): ReportWeeklyItem | undefined {
  if (!isRecord(value) || !asText(value.nodeId)) return undefined;
  return {
    name: asText(value.name),
    nodeId: asText(value.nodeId),
    url: asText(value.url),
    created: asText(value.created),
    updated: asText(value.updated),
  };
}

function asWeeklies(value: unknown): ReportWeeklies | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  return {
    at: asText(value.at),
    folderUrl: asText(value.folderUrl),
    items: value.items.map(asWeeklyItem).filter((item): item is ReportWeeklyItem => item !== undefined),
    hasMore: value.hasMore === true,
  };
}

function asDoc(value: unknown): ReportWeeklyDoc | undefined {
  if (!isRecord(value) || !asText(value.nodeId)) return undefined;
  return {
    at: asText(value.at),
    nodeId: asText(value.nodeId),
    name: asText(value.name),
    url: asText(value.url),
    markdown: asText(value.markdown),
    truncated: value.truncated === true,
    contentHash: asText(value.contentHash),
  };
}

function reportUrl(path: string, query?: Record<string, string>): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function requestJson(path: string, query?: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(reportUrl(path, query), {
      method: "GET",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }));
  } catch {
    throw new ReportClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new ReportClientError(payload.error as ReportClientErrorCode, asText(payload.message));
    }
    throw new ReportClientError("unavailable");
  }
  return payload;
}

/** GET /local/report/state —— 当日草稿 + outbox 提交状态（未配置机器 configured:false 照常返回）。 */
export async function fetchReportState(fetchImpl: typeof fetch = fetch): Promise<ReportState> {
  const payload = await requestJson("/local/report/state", undefined, fetchImpl);
  const state = asState(payload.data);
  if (!state) throw new ReportClientError("invalid_response");
  return state;
}

/** GET /local/report/automations —— QoderWake 定时任务只读状态（fresh=1 绕过 60s TTL）。 */
export async function fetchReportAutomations(
  options?: { readonly fresh?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<ReportAutomations> {
  const payload = await requestJson("/local/report/automations", options?.fresh ? { fresh: "1" } : undefined, fetchImpl);
  const view = asAutomations(payload.data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** GET /local/report/weeklies —— 双周报目录（fresh=1 绕过 5min TTL）。 */
export async function fetchReportWeeklies(
  options?: { readonly fresh?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<ReportWeeklies> {
  const payload = await requestJson("/local/report/weeklies", options?.fresh ? { fresh: "1" } : undefined, fetchImpl);
  const view = asWeeklies(payload.data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** GET /local/report/weekly?node= —— 正文只读（≤200KB 截断 + sha256）。 */
export async function fetchReportWeeklyDoc(
  nodeId: string,
  options?: { readonly fresh?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<ReportWeeklyDoc> {
  const query: Record<string, string> = { node: String(nodeId ?? "") };
  if (options?.fresh) query.fresh = "1";
  const payload = await requestJson("/local/report/weekly", query, fetchImpl);
  const doc = asDoc(payload.data);
  if (!doc) throw new ReportClientError("invalid_response");
  return doc;
}

export function reportErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的日周报数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    report_unconfigured: "未配置或参数不合法：确认 .local-cache/report.json（参考 config/report.json.example）后重试。",
    report_unavailable: "日周报暂时不可用：dws / SSH 缺失或调用失败；确认 dws 已安装并 dws auth login 后重试。",
    report_upstream: "钉钉侧返回失败，请按页面 dws 状态与修复指引处理。",
  };
  const code = error instanceof ReportClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  const detail = error instanceof ReportClientError && error.detail ? ` ${error.detail}` : "";
  return `${base}${detail}`;
}

/**
 * 北京时间（UTC+8 固定偏移，与桥侧北京日期边界同口径）的显示时间（评审 P3-1）：
 * - 已带时区的串（Z / ±hh:mm）换算到北京墙钟再显示——桥侧 at 为 UTC ISO，直接截切会早 8 小时；
 * - 不带时区的本地串按「已是北京墙钟」原样截切展示（静态页同口径，dws record 字段常见此形态）；
 * - 解析失败原样返回，绝不吞字段。
 */
export function clockCn(value: string): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (!hasZone) return raw.length >= 16 ? raw.slice(0, 16).replace("T", " ") : raw;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return raw;
  const shifted = new Date(at + 8 * 3_600_000);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}
