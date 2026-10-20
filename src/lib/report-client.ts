/**
 * Browser client for the reports view (F6) — GET /local/report/{state,automations,
 * weeklies,weekly} 只读；F6-P1 追加日报回写（草稿保存 / 提交）两步 dry→confirm 客户端：
 * POST /local/report/{save-dry,save-confirm,submit-dry,submit-confirm} + GET /local/report/writes。
 * 客户端层只做白名单投影与稳定错误码折叠，confirm 闸门与所有外部调用一律在服务端；
 * 降级契约同 leads/cases 客户端：桥 500/离线 → unavailable + 「本地桥未启动」文案。
 * 无自动轮询，全部显式拉取。
 */

import { composeErrorMessage } from "./error-message.ts";

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

/**
 * F6-P1 日报回写错误码：与 dev/report/report-write-types.ts 服务端 ReportWriteErrorCode 对齐。
 * report_unconfigured 已并入 SAFE_ERRORS，此处不重复；method_not_allowed 亦复用读侧码。
 */
const WRITE_ERRORS = [
  "report_invalid_request",
  "confirm_mismatch",
  "confirm_stale",
  "no_record",
  "record_conflict",
  "already_submitted",
  "cooldown",
  "dws_missing",
  "dws_failed",
  "ssh_unavailable",
  "submit_failed",
  "write_unavailable",
] as const;

export type ReportWriteClientErrorCode = (typeof WRITE_ERRORS)[number];

export type ReportClientErrorCode = (typeof SAFE_ERRORS)[number] | ReportWriteClientErrorCode;

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);
const WRITE_ERROR_SET: ReadonlySet<string> = new Set<string>(WRITE_ERRORS);

/** record_conflict 时服务端返回的冲突明细（期望 recordId vs 钉钉侧当前 recordId 与最新字段）。 */
export interface ReportSaveConflicts {
  readonly expectedRecordId: string;
  readonly currentRecordId: string;
  readonly current: Partial<ReportTodayRecord>;
}

export class ReportClientError extends Error {
  readonly code: ReportClientErrorCode;
  readonly detail: string;
  readonly conflicts: ReportSaveConflicts | null;

  constructor(code: ReportClientErrorCode, detail = "", conflicts: ReportSaveConflicts | null = null) {
    super(code);
    this.name = "ReportClientError";
    this.code = code;
    this.detail = detail;
    this.conflicts = conflicts;
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

/* ---------------------------------------------------------------------------
 * F6-P1 日报回写（草稿保存 / 提交）客户端：两步 dry→confirm。
 * 客户端只做白名单投影与稳定错误码折叠；confirm 闸门、冷却、审计、外部调用全在服务端。
 * ------------------------------------------------------------------------- */

/** 客户端白名单（与服务端 REPORT_WRITABLE_FIELDS 一致；UI 只发这 5 个字段）。 */
export const REPORT_WRITABLE_FIELDS = ["topic", "followup", "opportunity", "risk", "other"] as const;
export type ReportWritableField = (typeof REPORT_WRITABLE_FIELDS)[number];
/** 单字段文本上限（与服务端 REPORT_MAX_TEXT 一致，供 UI 预检禁用保存）。 */
export const REPORT_MAX_TEXT = 4000;

const WRITE_DRY_TIMEOUT_MS = 150_000; /* dws 查询 + SSH 通道探测 */
const WRITE_CONFIRM_TIMEOUT_MS = 210_000; /* record update + 回读 / run-now + outbox 回读 */
const WRITES_TIMEOUT_MS = 15_000; /* 本地审计尾读 */

export interface ReportSaveDiffItem {
  readonly key: ReportWritableField;
  readonly fieldId: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

export interface ReportSaveDry {
  readonly token: string;
  readonly recordId: string;
  readonly at: string;
  readonly today: string;
  readonly diff: readonly ReportSaveDiffItem[];
}

export interface ReportSaveConfirm {
  readonly recordId: string;
  readonly verified: boolean;
  readonly at: string;
  readonly updated: readonly ReportWritableField[];
  readonly audited: boolean;
  readonly note: string;
}

export interface ReportSubmittedInfo {
  readonly n: number;
  readonly items: ReadonlyArray<{ readonly title: string; readonly time: string }>;
}

export interface ReportSubmitChannel {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly lastStatus: string;
  readonly nextAt: string;
  readonly note: string;
}

export interface ReportSubmitDry {
  readonly token: string;
  readonly at: string;
  readonly today: string;
  readonly blocked: boolean;
  readonly cooldownRemainMs: number;
  readonly alreadySubmitted: ReportSubmittedInfo | null;
  readonly channel: ReportSubmitChannel;
  readonly note: string;
}

export interface ReportSubmitConfirm {
  readonly at: string;
  readonly executed: boolean;
  readonly runId: string;
  readonly sessionId: string;
  readonly verified: boolean;
  readonly submittedN: number;
  readonly audited: boolean;
  readonly note: string;
}

export interface ReportWriteAudit {
  readonly at: string;
  readonly op: "save" | "submit";
  readonly phase: "update" | "run" | "verify";
  readonly target: string;
  readonly exitCode: number | string | null;
  readonly executed: boolean;
  readonly ok: boolean;
  readonly verified: boolean;
  readonly maskedPreview: string;
}

export interface ReportWrites {
  readonly writes: readonly ReportWriteAudit[];
  readonly total: number;
}

/** 保存请求的可写单元格（只含白名单字段；其余服务端整体拒绝）。 */
export type ReportSaveCells = Partial<Record<ReportWritableField, string>>;

function asConflicts(value: Record<string, unknown> | undefined): ReportSaveConflicts | null {
  if (!value) return null;
  const current = isRecord(value.current) ? value.current : {};
  return {
    expectedRecordId: asText(value.expectedRecordId),
    currentRecordId: asText(value.currentRecordId),
    current: {
      topic: asText(current.topic),
      dept: asText(current.dept),
      workStatus: asText(current.workStatus),
      followup: asText(current.followup),
      opportunity: asText(current.opportunity),
      risk: asText(current.risk),
      other: asText(current.other),
      modifiedAt: asText(current.modifiedAt),
    },
  };
}

function isWritableKey(value: string): value is ReportWritableField {
  return (REPORT_WRITABLE_FIELDS as readonly string[]).includes(value);
}

function asDiffItem(value: unknown): ReportSaveDiffItem | undefined {
  if (!isRecord(value)) return undefined;
  const key = asText(value.key);
  if (!isWritableKey(key)) return undefined;
  return {
    key,
    fieldId: asText(value.fieldId),
    before: asText(value.before),
    after: asText(value.after),
    changed: value.changed === true,
  };
}

function asSaveDry(value: unknown): ReportSaveDry | undefined {
  if (!isRecord(value) || !asText(value.token)) return undefined;
  return {
    token: asText(value.token),
    recordId: asText(value.recordId),
    at: asText(value.at),
    today: asText(value.today),
    diff: Array.isArray(value.diff)
      ? value.diff.map(asDiffItem).filter((item): item is ReportSaveDiffItem => item !== undefined)
      : [],
  };
}

function asSaveConfirm(value: unknown): ReportSaveConfirm | undefined {
  if (!isRecord(value) || !asText(value.recordId)) return undefined;
  return {
    recordId: asText(value.recordId),
    verified: value.verified === true,
    at: asText(value.at),
    updated: Array.isArray(value.updated)
      ? value.updated
          .map(asText)
          .filter((key): key is ReportWritableField => isWritableKey(key))
      : [],
    audited: value.audited === true,
    note: asText(value.note),
  };
}

function asSubmittedInfo(value: unknown): ReportSubmittedInfo | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return {
    n: typeof value.n === "number" && Number.isFinite(value.n) ? value.n : value.items.length,
    items: value.items.filter(isRecord).map((item) => ({ title: asText(item.title), time: asText(item.time) })),
  };
}

function asChannel(value: unknown): ReportSubmitChannel {
  const source = isRecord(value) ? value : {};
  return {
    available: source.available === true,
    enabled: source.enabled === true,
    lastStatus: asText(source.lastStatus),
    nextAt: asText(source.nextAt),
    note: asText(source.note),
  };
}

function asSubmitDry(value: unknown): ReportSubmitDry | undefined {
  if (!isRecord(value) || !asText(value.token)) return undefined;
  return {
    token: asText(value.token),
    at: asText(value.at),
    today: asText(value.today),
    blocked: value.blocked === true,
    cooldownRemainMs:
      typeof value.cooldownRemainMs === "number" && Number.isFinite(value.cooldownRemainMs) ? value.cooldownRemainMs : 0,
    alreadySubmitted: value.alreadySubmitted == null ? null : asSubmittedInfo(value.alreadySubmitted),
    channel: asChannel(value.channel),
    note: asText(value.note),
  };
}

function asSubmitConfirm(value: unknown): ReportSubmitConfirm | undefined {
  if (!isRecord(value) || !asText(value.at)) return undefined;
  return {
    at: asText(value.at),
    executed: value.executed === true,
    runId: asText(value.runId),
    sessionId: asText(value.sessionId),
    verified: value.verified === true,
    submittedN: typeof value.submittedN === "number" && Number.isFinite(value.submittedN) ? value.submittedN : 0,
    audited: value.audited === true,
    note: asText(value.note),
  };
}

function asWriteAudit(value: unknown): ReportWriteAudit | undefined {
  if (!isRecord(value) || !asText(value.at)) return undefined;
  const op = asText(value.op);
  const phase = asText(value.phase);
  const exitCode = value.exitCode;
  return {
    at: asText(value.at),
    op: op === "submit" ? "submit" : "save",
    phase: phase === "run" || phase === "verify" ? phase : "update",
    target: asText(value.target),
    exitCode:
      typeof exitCode === "number" || typeof exitCode === "string" ? exitCode : null,
    executed: value.executed === true,
    ok: value.ok === true,
    verified: value.verified === true,
    maskedPreview: asText(value.maskedPreview),
  };
}

function asWrites(value: unknown): ReportWrites | undefined {
  if (!isRecord(value) || !Array.isArray(value.writes)) return undefined;
  return {
    writes: value.writes.map(asWriteAudit).filter((row): row is ReportWriteAudit => row !== undefined),
    total: typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0,
  };
}

/** 只保留白名单字段的字符串值——非白名单 / 非字符串一律丢弃（服务端会整体拒绝，客户端先收敛）。 */
function sanitizeCells(cells: ReportSaveCells): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of REPORT_WRITABLE_FIELDS) {
    const value = cells[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
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

/**
 * 写路由统一传输：解析 {ok:true,data} / {ok:false,error:{code,message,data?}} 信封。
 * - 网络异常 / 非法 JSON / 未知 code → 折叠为 unavailable（不泄露上游原文）；
 * - 已知读码（SAFE）与写码（WRITE）分别透传；record_conflict 额外投影冲突清单；
 * - detail 用服务端 message（已脱敏截断），供 composeErrorMessage 追加展示。
 */
async function requestWriteJson(
  method: "GET" | "POST",
  path: string,
  timeoutMs: number,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(reportUrl(path), {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }));
  } catch {
    throw new ReportClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!isRecord(payload)) throw new ReportClientError("unavailable");
  if (payload.ok === true && isRecord(payload.data)) return payload.data;
  const error = isRecord(payload.error) ? payload.error : {};
  const code = asText(error.code);
  const message = asText(error.message);
  const data = isRecord(error.data) ? error.data : undefined;
  if (SAFE_ERROR_SET.has(code)) throw new ReportClientError(code as ReportClientErrorCode, message);
  if (WRITE_ERROR_SET.has(code)) {
    throw new ReportClientError(
      code as ReportWriteClientErrorCode,
      message,
      code === "record_conflict" ? asConflicts(data) : null,
    );
  }
  throw new ReportClientError("unavailable", message);
}

/** POST /local/report/save-dry —— 预检并返回白名单字段 diff + 一次性 confirm token（不写）。 */
export async function saveReportDraftDry(
  input: { readonly recordId: string; readonly cells: ReportSaveCells },
  fetchImpl: typeof fetch = fetch,
): Promise<ReportSaveDry> {
  const data = await requestWriteJson(
    "POST",
    "/local/report/save-dry",
    WRITE_DRY_TIMEOUT_MS,
    { recordId: String(input?.recordId ?? ""), cells: sanitizeCells(input?.cells ?? {}) },
    fetchImpl,
  );
  const view = asSaveDry(data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** POST /local/report/save-confirm —— confirm 严格 === dry token 才执行 record update（服务端闸门）。 */
export async function saveReportDraftConfirm(
  confirm: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReportSaveConfirm> {
  const data = await requestWriteJson(
    "POST",
    "/local/report/save-confirm",
    WRITE_CONFIRM_TIMEOUT_MS,
    { confirm: String(confirm ?? "") },
    fetchImpl,
  );
  const view = asSaveConfirm(data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** POST /local/report/submit-dry —— 提交预检（冷却 / outbox 去重 / SSH 通道探测），返回 token。 */
export async function submitReportDry(fetchImpl: typeof fetch = fetch): Promise<ReportSubmitDry> {
  const data = await requestWriteJson("POST", "/local/report/submit-dry", WRITE_DRY_TIMEOUT_MS, {}, fetchImpl);
  const view = asSubmitDry(data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** POST /local/report/submit-confirm —— confirm 严格 === token 才 run-now 触发；冷却内 429 诚实拒绝。 */
export async function submitReportConfirm(
  confirm: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReportSubmitConfirm> {
  const data = await requestWriteJson(
    "POST",
    "/local/report/submit-confirm",
    WRITE_CONFIRM_TIMEOUT_MS,
    { confirm: String(confirm ?? "") },
    fetchImpl,
  );
  const view = asSubmitConfirm(data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
}

/** GET /local/report/writes —— 写审计尾 50（最新在前，正文已掩码）。 */
export async function fetchReportWrites(fetchImpl: typeof fetch = fetch): Promise<ReportWrites> {
  const data = await requestWriteJson("GET", "/local/report/writes", WRITES_TIMEOUT_MS, undefined, fetchImpl);
  const view = asWrites(data);
  if (!view) throw new ReportClientError("invalid_response");
  return view;
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
    report_invalid_request:
      "保存请求含本机不接受的字段或内容：仅可写 topic/followup/opportunity/risk/other 五个字段、单字段 ≤4000 字且不可为空。本次未写入任何内容。",
    confirm_mismatch: "两步确认缺少确认码：请重新预检后勾选确认，本次未执行任何写入。",
    confirm_stale: "确认码已过期或已被使用（有效期 10 分钟、一次性）：请重新预检后再确认，本次未执行。",
    no_record: "未找到今日日报记录：初稿任务可能还没生成当天记录，请稍后重试或联系管理员。",
    record_conflict: "记录已被外部更新（可能初稿任务刚跑完）：本次未覆盖任何内容，已带出最新记录，请刷新后重新编辑。",
    already_submitted: "今日已提交过日报，不重复发送。",
    cooldown: "距上次提交不足 5 分钟冷却：为防重复触发远端，本次提交已被拒绝，请等冷却结束后重试（不会自动重发）。",
    dws_missing: "未找到 dws CLI：本次保存未执行、未写入任何内容，请确认已安装 dws 并 dws auth login 后重试。",
    dws_failed: "钉钉 aitable 回写失败：本次保存未生效，请按页面 dws 状态与修复指引处理后重试。",
    ssh_unavailable: "远端提交通道（SSH/ECS QoderWake）不可用：本次提交未触发，请确认 ECS 密钥与 waker 配置后重试。",
    submit_failed: "远端提交触发失败：本次提交未完成，请检查 automation 任务状态后重试。",
    write_unavailable: "日报回写服务遇到未知故障：本次未假装成功，请稍后重试。",
  };
  const code = error instanceof ReportClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  return composeErrorMessage(base, error instanceof ReportClientError ? error.detail : "");
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
