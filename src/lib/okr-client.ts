/**
 * Browser client for the OKR view（CRD 目标完整读写）— GET/POST /local/okr*。
 * 契约与 dev/okr/okr-types.ts 一致：成功 {ok:true,data}；失败 {ok:false,error:{code,message}}
 * （sync-confirm 的 409 另附 conflicts 清单）。客户端只做白名单投影与稳定错误码
 * 折叠（同 profile/report 客户端口径）：桥离线 → unavailable + 「本地桥未启动」文案。
 * 红线：绝不在前端状态里保留任何 cookie 形态字段（敌意 session.value 一律丢弃）。
 */

import { composeErrorMessage } from "./error-message.ts";

const OKR_TIMEOUT_MS = 10_000;
/** 桥侧 fetch_okr.py 硬超时 60s，前端留 10s 余量。 */
const REFRESH_TIMEOUT_MS = 70_000;
/** 桥侧 okr_write.py 硬超时 240s，前端留 10s 余量。 */
const SYNC_TIMEOUT_MS = 250_000;

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "okr_invalid_request",
  "profile_no_session",
  "okr_corrupt",
  "okr_conflict",
  "okr_busy",
  "okr_refresh_failed",
  "okr_sync_failed",
  "okr_unavailable",
] as const;

export type OkrClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export interface OkrConflictInfo {
  readonly key: string;
  readonly field: string;
  readonly crd: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

export class OkrClientError extends Error {
  readonly code: OkrClientErrorCode;
  readonly detail: string;
  readonly conflicts: readonly OkrConflictInfo[];

  constructor(code: OkrClientErrorCode, detail = "", conflicts: readonly OkrConflictInfo[] = []) {
    super(code);
    this.name = "OkrClientError";
    this.code = code;
    this.detail = detail;
    this.conflicts = conflicts;
  }
}

/* 投影类型与 dev/okr/okr-types.ts、fetch_okr.py build() 语义一致（白名单字段）。 */

export type OkrEditKind = "o" | "kr";

export interface OkrEditDraft {
  readonly kind: OkrEditKind;
  readonly oId: string;
  readonly krId: string | null;
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
}

export type OkrWriteState = "pending" | "written" | "already" | "conflict" | "kr-missing" | "failed";

export interface OkrDiffItem {
  readonly key: string;
  readonly kind: OkrEditKind;
  readonly oId: string;
  readonly krId: string | null;
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly crd: string | null;
  readonly state: OkrWriteState;
  readonly conflict: boolean;
  readonly note: string;
}

export interface OkrProgressRecord {
  readonly id: string;
  readonly description: string;
  readonly createdAt: string;
  readonly creator: string;
}

export interface OkrIndicator {
  readonly targetValue: string;
  readonly unit: string;
  readonly currentValue: string;
}

export interface OkrKeyResult {
  readonly idx: string;
  readonly id: string;
  readonly title: string;
  readonly weight: number | null;
  readonly typeLabel: string;
  readonly targetLabel: string;
  readonly progress: number | null;
  readonly status: number | null;
  readonly indicator: OkrIndicator | null;
}

export interface OkrObjective {
  readonly idx: string;
  readonly id: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly desc: string;
  readonly weight: number | null;
  readonly typeLabel: string;
  readonly status: number | null;
  readonly progress: number | null;
  readonly krCount: number;
  readonly keyResults: readonly OkrKeyResult[];
  readonly progressRecords: readonly OkrProgressRecord[];
  readonly periodName: string;
}

export interface OkrPeriodRef {
  readonly id: string;
  readonly name: string;
  readonly periodType: string;
}

export interface OkrSnapshot {
  readonly generatedAt: string;
  readonly mode: string;
  readonly period: { readonly id: string; readonly name: string; readonly periodType: string } | null;
  readonly periodsFY: readonly OkrPeriodRef[];
  readonly user: { readonly name: string; readonly nick: string; readonly dept: string };
  readonly auditLabel: string;
  readonly totals: { readonly oCount: number; readonly krCount: number; readonly crdProgressCount: number };
  readonly objectives: readonly OkrObjective[];
}

export interface OkrSessionView {
  readonly empId: string;
  readonly name: string;
  readonly masked: string;
  readonly state: string;
}

export interface OkrOverview {
  readonly hasSnapshot: boolean;
  readonly snapshot: OkrSnapshot | null;
  readonly edits: readonly OkrEditDraft[];
  readonly exportedAt: string;
  readonly baseSnapshotAt: string;
  readonly session: OkrSessionView;
}

export interface OkrRefreshSummary {
  readonly generatedAt: string;
  readonly mode: string;
  readonly period: { readonly id: string; readonly name: string; readonly periodType: string } | null;
  readonly totals: { readonly oCount: number; readonly krCount: number; readonly crdProgressCount: number };
  readonly sizeKb: number;
}

export interface OkrDryResult {
  readonly mode: "dry-run";
  readonly ok: boolean;
  readonly items: readonly OkrDiffItem[];
  readonly note: string;
}

export interface OkrConfirmResult {
  readonly mode: "confirm";
  readonly ok: boolean;
  readonly wrote: number;
  readonly items: readonly OkrDiffItem[];
  readonly note: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const asNullableText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const asNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstText = (record: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
};

function asEdit(value: unknown): OkrEditDraft | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "kr" ? "kr" : value.kind === "o" ? "o" : null;
  if (!kind || typeof value.oId !== "string" || typeof value.field !== "string") return null;
  return {
    kind,
    oId: value.oId,
    krId: kind === "kr" && typeof value.krId === "string" ? value.krId : null,
    field: value.field,
    from: asNullableText(value.from),
    to: asNullableText(value.to),
  };
}

function asEditList(value: unknown): readonly OkrEditDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map(asEdit).filter((edit): edit is OkrEditDraft => edit !== null);
}

const WRITE_STATES: readonly string[] = ["pending", "written", "already", "conflict", "kr-missing", "failed"];

function asDiffItem(value: unknown): OkrDiffItem | null {
  if (!isRecord(value) || typeof value.key !== "string") return null;
  const state = WRITE_STATES.includes(asText(value.state)) ? (asText(value.state) as OkrWriteState) : "failed";
  return {
    key: value.key,
    kind: value.kind === "kr" ? "kr" : "o",
    oId: asText(value.oId),
    krId: asNullableText(value.krId),
    field: asText(value.field),
    before: asNullableText(value.before),
    after: asNullableText(value.after),
    crd: asNullableText(value.crd),
    state,
    conflict: value.conflict === true || state === "conflict",
    note: asText(value.note),
  };
}

function asDiffItems(value: unknown): readonly OkrDiffItem[] {
  if (!Array.isArray(value)) return [];
  return value.map(asDiffItem).filter((item): item is OkrDiffItem => item !== null);
}

/** CRD 进展记录字段口径不稳（gmtCreate/createdAt/content 混用）：白名单兜底投影。 */
function asProgressRecord(value: unknown): OkrProgressRecord | null {
  if (!isRecord(value)) return null;
  const creator = isRecord(value.creator) ? firstText(value.creator, ["name", "nickNameCn"]) : firstText(value, ["creatorName", "creator"]);
  return {
    id: firstText(value, ["_id", "id"]),
    description: firstText(value, ["description", "content", "htContent", "text"]),
    createdAt: firstText(value, ["gmtCreate", "createdAt", "createTime", "htCreate", "gmtModified"]),
    creator,
  };
}

/** 进展时间倒序（字符串时间戳可直接比较；空时间沉底）。 */
export function sortProgressDesc(records: readonly OkrProgressRecord[]): readonly OkrProgressRecord[] {
  return [...records].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function asProgressRecords(value: unknown): readonly OkrProgressRecord[] {
  if (!Array.isArray(value)) return [];
  return sortProgressDesc(
    value.map(asProgressRecord).filter((record): record is OkrProgressRecord => record !== null),
  );
}

function asIndicator(value: unknown): OkrIndicator | null {
  if (!isRecord(value)) return null;
  return {
    targetValue: firstText(value, ["targetValue"]),
    unit: firstText(value, ["unit"]),
    currentValue: firstText(value, ["currentValue"]),
  };
}

function asKeyResult(value: unknown): OkrKeyResult | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    idx: asText(value.idx),
    id: value.id,
    title: asText(value.title),
    weight: asNullableNumber(value.weight),
    typeLabel: asText(value.typeLabel),
    targetLabel: asText(value.targetLabel),
    progress: asNullableNumber(value.progress),
    status: asNullableNumber(value.status),
    indicator: asIndicator(value.indicator),
  };
}

function asObjective(value: unknown): OkrObjective | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const title = asText(value.title);
  const keyResults = Array.isArray(value.keyResults)
    ? value.keyResults.map(asKeyResult).filter((kr): kr is OkrKeyResult => kr !== null)
    : [];
  return {
    idx: asText(value.idx),
    id: value.id,
    title,
    displayTitle: asText(value.displayTitle) || title || asText(value.typeLabel),
    desc: asText(value.desc),
    weight: asNullableNumber(value.weight),
    typeLabel: asText(value.typeLabel),
    status: asNullableNumber(value.status),
    progress: asNullableNumber(value.progress),
    krCount: asNullableNumber(value.krCount) ?? keyResults.length,
    keyResults,
    progressRecords: asProgressRecords(value.progressRecords),
    periodName: isRecord(value.period) ? asText(value.period.name) : "",
  };
}

function asPeriodRef(value: unknown): OkrPeriodRef | null {
  if (!isRecord(value)) return null;
  return { id: asText(value.id), name: asText(value.name), periodType: asText(value.periodType) };
}

/** 白名单投影：敌意多余字段（如 session.value）一律丢弃，绝不进入前端状态。 */
function asSnapshot(value: unknown): OkrSnapshot | null {
  if (!isRecord(value)) return null;
  const period = isRecord(value.period)
    ? { id: asText(value.period.id), name: asText(value.period.name), periodType: asText(value.period.periodType) }
    : null;
  const user = isRecord(value.user) ? value.user : {};
  const totals = isRecord(value.totals) ? value.totals : {};
  const audit = isRecord(value.audit) ? value.audit : {};
  return {
    generatedAt: asText(value.generatedAt),
    mode: asText(value.mode),
    period,
    periodsFY: Array.isArray(value.periodsFY)
      ? value.periodsFY.map(asPeriodRef).filter((entry): entry is OkrPeriodRef => entry !== null)
      : [],
    user: { name: asText(user.name), nick: asText(user.nick), dept: asText(user.dept) },
    auditLabel: asText(audit.statusLabel),
    totals: {
      oCount: asNullableNumber(totals.oCount) ?? 0,
      krCount: asNullableNumber(totals.krCount) ?? 0,
      crdProgressCount: asNullableNumber(totals.crdProgressCount) ?? 0,
    },
    objectives: Array.isArray(value.objectives)
      ? value.objectives.map(asObjective).filter((objective): objective is OkrObjective => objective !== null)
      : [],
  };
}

function asSessionView(value: unknown): OkrSessionView {
  const session = isRecord(value) ? value : {};
  const user = isRecord(session.user) ? session.user : {};
  const meta = isRecord(session.session) ? session.session : {};
  // 只取掩码与状态元数据：任何 value/cookie 形态字段都在投影外。
  return {
    empId: asText(user.empId),
    name: asText(user.name),
    masked: asText(meta.masked),
    state: asText(meta.state) || "unset",
  };
}

function asOverview(value: unknown): OkrOverview | undefined {
  if (!isRecord(value)) return undefined;
  return {
    hasSnapshot: value.hasSnapshot === true,
    snapshot: value.hasSnapshot === true ? asSnapshot(value.snapshot) : null,
    edits: asEditList(value.edits),
    exportedAt: asText(value.exportedAt),
    baseSnapshotAt: asText(value.baseSnapshotAt),
    session: asSessionView(value.session),
  };
}

function okrUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

function asConflicts(value: unknown): readonly OkrConflictInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      key: asText(entry.key),
      field: asText(entry.field),
      crd: asNullableText(entry.crd),
      before: asNullableText(entry.before),
      after: asNullableText(entry.after),
    }))
    .filter((entry) => entry.key !== "");
}

async function requestJson(
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetchImpl(new Request(okrUrl(path), init));
  } catch {
    throw new OkrClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const source = isRecord(payload) ? payload : undefined;
    const error = source && isRecord(source.error) ? source.error : undefined;
    const code = error && typeof error.code === "string" && SAFE_ERROR_SET.has(error.code)
      ? (error.code as OkrClientErrorCode)
      : "unavailable";
    throw new OkrClientError(code, error ? asText(error.message) : "", asConflicts(source?.conflicts));
  }
  return payload;
}

/** GET /local/okr —— 快照 + 周期列表 + 编辑态 + 掩码会话（绝无 cookie 原值）。 */
export async function fetchOkrOverview(fetchImpl: typeof fetch = fetch): Promise<OkrOverview> {
  const payload = await requestJson("GET", "/local/okr", undefined, OKR_TIMEOUT_MS, fetchImpl);
  const overview = asOverview(payload.data);
  if (!overview) throw new OkrClientError("invalid_response");
  return overview;
}

/** GET /local/okr/edits —— 预检暂存的编辑清单。 */
export async function fetchOkrEdits(
  fetchImpl: typeof fetch = fetch,
): Promise<{ edits: readonly OkrEditDraft[]; exportedAt: string; baseSnapshotAt: string }> {
  const payload = await requestJson("GET", "/local/okr/edits", undefined, OKR_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new OkrClientError("invalid_response");
  return { edits: asEditList(data.edits), exportedAt: asText(data.exportedAt), baseSnapshotAt: asText(data.baseSnapshotAt) };
}

/** POST /local/okr/refresh —— execFile fetch_okr.py 重拉快照（桥侧硬超时 60s）。 */
export async function refreshOkrSnapshot(fetchImpl: typeof fetch = fetch): Promise<OkrRefreshSummary> {
  const payload = await requestJson("POST", "/local/okr/refresh", {}, REFRESH_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new OkrClientError("invalid_response");
  const period = isRecord(data.period)
    ? { id: asText(data.period.id), name: asText(data.period.name), periodType: asText(data.period.periodType) }
    : null;
  const totals = isRecord(data.totals) ? data.totals : {};
  return {
    generatedAt: asText(data.generatedAt),
    mode: asText(data.mode),
    period,
    totals: {
      oCount: asNullableNumber(totals.oCount) ?? 0,
      krCount: asNullableNumber(totals.krCount) ?? 0,
      crdProgressCount: asNullableNumber(totals.crdProgressCount) ?? 0,
    },
    sizeKb: asNullableNumber(data.sizeKb) ?? 0,
  };
}

/** POST /local/okr/sync-dry —— 逐项差异预检（绝不落远端）。 */
export async function runOkrSyncDry(
  edits: readonly OkrEditDraft[],
  baseSnapshotAt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OkrDryResult> {
  const payload = await requestJson("POST", "/local/okr/sync-dry", { edits, baseSnapshotAt }, SYNC_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new OkrClientError("invalid_response");
  return {
    mode: "dry-run",
    ok: data.ok !== false,
    items: asDiffItems(data.items),
    note: asText(data.note),
  };
}

/** POST /local/okr/sync-confirm —— 仅勾选键写入；409 时错误对象携带 conflicts 清单。 */
export async function runOkrSyncConfirm(
  keys: readonly string[],
  acceptConflicts: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<OkrConfirmResult> {
  const payload = await requestJson("POST", "/local/okr/sync-confirm", { keys, acceptConflicts }, SYNC_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new OkrClientError("invalid_response");
  return {
    mode: "confirm",
    ok: data.ok !== false,
    wrote: asNullableNumber(data.wrote) ?? 0,
    items: asDiffItems(data.items),
    note: asText(data.note),
  };
}

export function okrErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的 OKR 数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    okr_invalid_request: "输入未通过校验（编辑项白名单 / id 形态 / 勾选键与预检不一致）。",
    profile_no_session: "尚未配置 BUC 会话：请先到「个人中心」粘贴 Cookie 后重试。",
    okr_corrupt: "本机 OKR 缓存文件损坏，已拒绝读写：请人工检查 .local-cache/okr 后重试。",
    okr_conflict: "勾选项与 CRD 当前值冲突（他人已改）：请逐项确认后再决定是否覆盖。",
    okr_busy: "另一个 OKR 任务正在进行，请等待其完成后重试。",
    okr_refresh_failed: "OKR 快照刷新失败（CRD 拉取或会话问题），详情见错误信息。",
    okr_sync_failed: "OKR 写通道失败（预检 / 确认写入无结果），详情见错误信息。",
    okr_unavailable: "OKR 暂时不可用（本机存储或子进程异常），详情见桥日志。",
  };
  const code = error instanceof OkrClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable!;
  return composeErrorMessage(base, error instanceof OkrClientError ? error.detail : "");
}
