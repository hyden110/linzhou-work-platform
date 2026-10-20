/**
 * Browser client for worklog (只读) — GET /local/worklog + GET /local/worklog/summary。
 *
 * 口径（与 dev/worklog/worklog-types.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃、未知 stageId 回落 null（未分类，不猜）、未知 status 整包
 *   invalid_response——绝不半真半假；
 * - 错误分层：{error:{code,message}} → WorklogClientError(code, detail)，
 *   worklogErrorMessage 给可直接展示的中文诚实文案（sqlite 缺失/扫描失败/源库缺失
 *   都不粉饰）；
 * - 超时 20s：桥侧是同步 sqlite 只读扫描，大库首扫偏慢，客户端超时须留足余量；
 * - 请求全程只读 GET，无任何写路径。
 */

import { composeErrorMessage } from "./error-message.ts";
import { WORKLOG_STAGE_IDS } from "./worklog-model.ts";

const WORKLOG_GET_TIMEOUT_MS = 20_000;

/** 客户端本地错误码 + 桥侧稳定错误码全集（worklog-types.ts WorklogErrorCode）。 */
export type WorklogClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "worklog_invalid_request"
  | "worklog_sqlite_unavailable"
  | "worklog_scan_failed"
  | "worklog_unavailable"
  | "method_not_allowed";

const KNOWN_CODES: ReadonlySet<string> = new Set<WorklogClientErrorCode>([
  "unavailable", "invalid_response", "worklog_invalid_request", "worklog_sqlite_unavailable",
  "worklog_scan_failed", "worklog_unavailable", "method_not_allowed",
]);

const OVERALL_STATUSES = ["ok", "partial", "missing"] as const;
export type WorklogOverallStatus = (typeof OVERALL_STATUSES)[number];
const SOURCE_STATUSES = new Set(["ok", "missing", "error"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class WorklogClientError extends Error {
  readonly code: WorklogClientErrorCode;
  readonly detail: string;

  constructor(code: WorklogClientErrorCode, detail = "") {
    super(code);
    this.name = "WorklogClientError";
    this.code = code;
    this.detail = detail;
  }
}

/** 查询参数：days 与 from/to 二选一（桥侧校验，客户端如实透传）。 */
export interface WorklogQuery {
  readonly from?: string;
  readonly to?: string;
  readonly days?: number;
}

export interface WorklogEntryView {
  readonly sourceKey: string;
  readonly instance: string;
  readonly date: string;
  readonly ts: number;
  readonly title: string;
  readonly stageId: string | null;
  readonly confidence: "high" | "medium" | "low";
  readonly cluster: string;
}

export interface WorklogSourceView {
  readonly instance: string;
  readonly kind: string;
  readonly status: string;
  readonly count: number;
  readonly note: string;
}

export interface WorklogRangeView {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

export interface WorklogCountsView {
  readonly byStage: Readonly<Record<string, number>>;
  readonly byCluster: readonly { readonly name: string; readonly count: number }[];
  readonly unclassified: number;
}

/** GET /local/worklog 的投影。 */
export interface WorklogSnapshot {
  readonly generatedAt: string;
  readonly range: WorklogRangeView;
  readonly status: WorklogOverallStatus;
  readonly missingNote: string;
  readonly sources: readonly WorklogSourceView[];
  readonly total: number;
  readonly truncated: boolean;
  readonly entries: readonly WorklogEntryView[];
  readonly counts: WorklogCountsView;
}

/** GET /local/worklog/summary 的投影。 */
export interface WorklogSummarySnapshot {
  readonly generatedAt: string;
  readonly range: WorklogRangeView;
  readonly status: WorklogOverallStatus;
  readonly missingNote: string;
  readonly sources: readonly WorklogSourceView[];
  readonly total: number;
  readonly unclassified: number;
  readonly byDay: readonly { readonly date: string; readonly count: number }[];
  readonly byStage: readonly { readonly id: string; readonly name: string; readonly count: number; readonly highConfidence: number }[];
  readonly byCluster: readonly { readonly name: string; readonly count: number }[];
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

function asOverallStatus(value: unknown): WorklogOverallStatus | null {
  return typeof value === "string" && (OVERALL_STATUSES as readonly string[]).includes(value)
    ? (value as WorklogOverallStatus)
    : null;
}

function asRange(value: unknown): WorklogRangeView {
  const record = isRecord(value) ? value : {};
  return { from: asText(record.from), to: asText(record.to), days: asNumber(record.days) };
}

function asEntry(value: unknown): WorklogEntryView | null {
  if (!isRecord(value) || !asText(value.sourceKey)) return null;
  const stageId = asText(value.stageId);
  const confidence = asText(value.confidence);
  return {
    sourceKey: asText(value.sourceKey),
    instance: asText(value.instance),
    date: asText(value.date),
    ts: asNumber(value.ts),
    title: asText(value.title),
    stageId: WORKLOG_STAGE_IDS.has(stageId) ? stageId : null,
    confidence: CONFIDENCES.has(confidence) ? (confidence as "high" | "medium" | "low") : "low",
    cluster: asText(value.cluster),
  };
}

function asSource(value: unknown): WorklogSourceView | null {
  if (!isRecord(value) || !asText(value.instance) || !SOURCE_STATUSES.has(asText(value.status))) return null;
  return {
    instance: asText(value.instance),
    kind: asText(value.kind),
    status: asText(value.status),
    count: asNumber(value.count),
    note: asText(value.note),
  };
}

function asCounts(value: unknown): WorklogCountsView {
  const record = isRecord(value) ? value : {};
  const byStage: Record<string, number> = {};
  if (isRecord(record.byStage)) {
    for (const [stageId, count] of Object.entries(record.byStage)) {
      if (WORKLOG_STAGE_IDS.has(stageId) && typeof count === "number" && Number.isFinite(count)) byStage[stageId] = count;
    }
  }
  const byCluster = (Array.isArray(record.byCluster) ? record.byCluster : [])
    .filter((row): row is Record<string, unknown> => isRecord(row) && asText(row.name) !== "" && typeof row.count === "number")
    .map((row) => ({ name: asText(row.name), count: asNumber(row.count) }));
  return { byStage, byCluster, unclassified: asNumber(record.unclassified) };
}

/* ---------------- 请求（只读 GET；错误 {code,message} 如实上抛） ---------------- */

function worklogUrl(path: string, query?: WorklogQuery): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  if (query?.days !== undefined) url.searchParams.set("days", String(query.days));
  if (query?.from) url.searchParams.set("from", query.from);
  if (query?.to) url.searchParams.set("to", query.to);
  return url;
}

async function requestJson(path: string, query: WorklogQuery | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(worklogUrl(path, query), {
      method: "GET",
      signal: AbortSignal.timeout(WORKLOG_GET_TIMEOUT_MS),
    }));
  } catch {
    throw new WorklogClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new WorklogClientError(error.code as WorklogClientErrorCode, asText(error.message));
    }
    throw new WorklogClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new WorklogClientError("invalid_response");
  return payload.data;
}

function commonView(data: Record<string, unknown>) {
  const status = asOverallStatus(data.status);
  if (status === null) throw new WorklogClientError("invalid_response");
  const sources = (Array.isArray(data.sources) ? data.sources : [])
    .map(asSource)
    .filter((row): row is WorklogSourceView => row !== null);
  return {
    generatedAt: asText(data.generatedAt),
    range: asRange(data.range),
    status,
    missingNote: asText(data.missingNote),
    sources,
  };
}

/** GET /local/worklog —— 范围内分类条目 + 每类计数（源库缺失时 status:"missing"）。 */
export async function fetchWorklog(query?: WorklogQuery, fetchImpl: typeof fetch = fetch): Promise<WorklogSnapshot> {
  const data = await requestJson("/local/worklog", query, fetchImpl);
  if (!Array.isArray(data.entries)) throw new WorklogClientError("invalid_response");
  return {
    ...commonView(data),
    total: asNumber(data.total),
    truncated: data.truncated === true,
    entries: data.entries.map(asEntry).filter((row): row is WorklogEntryView => row !== null),
    counts: asCounts(data.counts),
  };
}

/** GET /local/worklog/summary —— 按日/按环节/按聚类聚合（同一套范围参数）。 */
export async function fetchWorklogSummary(query?: WorklogQuery, fetchImpl: typeof fetch = fetch): Promise<WorklogSummarySnapshot> {
  const data = await requestJson("/local/worklog/summary", query, fetchImpl);
  const byDay = (Array.isArray(data.byDay) ? data.byDay : [])
    .filter((row): row is Record<string, unknown> => isRecord(row) && DATE_KEY.test(asText(row.date)) && typeof row.count === "number")
    .map((row) => ({ date: asText(row.date), count: asNumber(row.count) }));
  const byStage = (Array.isArray(data.byStage) ? data.byStage : [])
    .filter((row): row is Record<string, unknown> => isRecord(row) && WORKLOG_STAGE_IDS.has(asText(row.id)) && typeof row.count === "number")
    .map((row) => ({ id: asText(row.id), name: asText(row.name), count: asNumber(row.count), highConfidence: asNumber(row.highConfidence) }));
  const byCluster = (Array.isArray(data.byCluster) ? data.byCluster : [])
    .filter((row): row is Record<string, unknown> => isRecord(row) && asText(row.name) !== "" && typeof row.count === "number")
    .map((row) => ({ name: asText(row.name), count: asNumber(row.count) }));
  return {
    ...commonView(data),
    total: asNumber(data.total),
    unclassified: asNumber(data.unclassified),
    byDay,
    byStage,
    byCluster,
  };
}

/** 错误码 → 可直接展示的中文诚实文案（缺 sqlite / 扫描失败 / 缺失态都不粉饰）。 */
export function worklogErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行桥服务后重试。",
    invalid_response: "本机服务返回了无法识别的工作清单数据。",
    worklog_invalid_request: "请求参数不合法：请检查时间范围。",
    worklog_sqlite_unavailable: "本机 Node 缺少 node:sqlite（需 ≥ 22.5）：无法只读扫描工作库，请升级本机 Node 后重启桥服务。",
    worklog_scan_failed: "本机工作库全部打开失败：可能被其他进程占用或已损坏，本次未采集到任何条目。",
    worklog_unavailable: "工作清单服务暂时不可用：请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受（worklog 全链路只读）。",
  };
  const code = error instanceof WorklogClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof WorklogClientError ? error.detail : "");
}
