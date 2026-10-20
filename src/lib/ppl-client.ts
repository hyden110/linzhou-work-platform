import type { MaasCandidatesFile } from "./crm-types";

const SAFE_ERRORS = new Set([
  "inspection_unavailable",
  "invalid_request",
  "not_found",
  "already_decided",
  "blocked_recommendation",
  "snapshot_unavailable",
  "overrides_corrupt",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
]);

export class PplClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PplClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

export type PplDedupeStatus = "exists" | "suspected" | "new";
export type PplItemState = "pending" | "approved" | "discarded" | "creating" | "created" | "failed";

export interface PplRecommendation {
  readonly id: string;
  /** 推荐指纹（返工 #2）：与决策指纹比对，不符视为新待处理。 */
  readonly fingerprint: string | null;
  readonly customerName: string;
  readonly cid: string | null;
  readonly suggestedProjectName: string;
  readonly opportunityType: string;
  readonly amountYuan: number | null;
  readonly blocked: boolean;
  readonly blockReason: string | null;
  readonly dedupe: { readonly status: PplDedupeStatus | string; readonly evidence: unknown };
  readonly changeNote: string | null;
}

export interface PplDecision {
  readonly id: string;
  readonly recommendationId: string;
  readonly action: "approve" | "discard";
  readonly decidedAt: string;
  readonly note: string | null;
  readonly fingerprint: string | null;
}

export interface PplInspection {
  readonly state: string;
  readonly generatedAt: string;
  readonly snapshotGeneratedAt: string | null;
  readonly snapshotStale: boolean;
  readonly reportCount: number;
  readonly recommendations: readonly PplRecommendation[];
  readonly summary: Record<string, number>;
  readonly error: string | null;
}

export interface PplInspectionBundle {
  readonly inspection: PplInspection;
  readonly decisions: readonly PplDecision[];
}

/** 巡检产物三态（返工 #4）：failed 必须显式透出，不得当空结果静默。 */
export type PplInspectionStatus = "empty" | "failed" | "stale" | "ok";

export function pplInspectionStatus(inspection: PplInspection | null | undefined): PplInspectionStatus {
  if (!inspection) return "empty";
  if (inspection.state !== "ok") return "failed";
  if (inspection.snapshotStale) return "stale";
  return "ok";
}

function isRecommendation(value: unknown): value is PplRecommendation {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.customerName === "string" && isRecord(value.dedupe);
}

function isInspection(value: unknown): value is PplInspection {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.generatedAt !== "string") return false;
  if (!Array.isArray(value.recommendations)) return false;
  return value.recommendations.every((item) => !item || isRecommendation(item));
}

function isDecision(value: unknown): value is PplDecision {
  if (!isRecord(value)) return false;
  return typeof value.recommendationId === "string" && (value.action === "approve" || value.action === "discard");
}

async function request(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path), { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new PplClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERRORS.has(payload.error)
      ? payload.error
      : "unavailable";
    throw new PplClientError(code);
  }
  return payload;
}

/** GET /local/ppl/inspection —— 404（还没有产物）返回 null，面板显示「未巡检」。 */
export async function fetchPplInspection(fetchImpl: typeof fetch = fetch): Promise<PplInspectionBundle | null> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/ppl/inspection"), { method: "GET", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new PplClientError("unavailable");
  }
  if (response.status === 404) return null;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERRORS.has(payload.error)
      ? payload.error
      : "unavailable";
    throw new PplClientError(code);
  }
  if (!isInspection(payload.data)) throw new PplClientError("invalid_response");
  const inspection: PplInspection = {
    ...payload.data,
    recommendations: payload.data.recommendations.map((item) => ({ ...item, fingerprint: item.fingerprint ?? null })),
  };
  const decisions = (Array.isArray(payload.decisions) ? payload.decisions.filter(isDecision) : [])
    .map((decision) => ({ ...decision, fingerprint: decision.fingerprint ?? null }));
  return { inspection, decisions };
}

export async function startPplRefresh(fetchImpl: typeof fetch = fetch): Promise<void> {
  await request("/local/ppl/refresh", { method: "POST" }, fetchImpl);
}

export async function decidePplRecommendation(
  recommendationId: string,
  action: "approve" | "discard",
  note?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PplDecision> {
  const payload = await request("/local/ppl/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recommendationId, action, note }),
  }, fetchImpl);
  if (!isDecision(payload.data)) throw new PplClientError("invalid_response");
  return { ...payload.data, fingerprint: payload.data.fingerprint ?? null };
}

// ---------------------------------------------------------------------------
// MaaS 候选复核（D4）：候选生成 + 人工覆盖表（本机优先，回退 public 静态表）
// ---------------------------------------------------------------------------

export type MaasOverrideStatus = "maas" | "non_maas" | "unconfirmed";
/** 覆盖表只存 maas/non_maas；unconfirmed 表示「清除覆盖、回到关键词初筛」。 */
export type MaasOverridesMap = Record<string, "maas" | "non_maas">;

function isCandidatesFile(value: unknown): value is MaasCandidatesFile {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.generatedAt === "string"
    && typeof value.totalCustomers === "number"
    && Array.isArray(value.candidates)
    && value.candidates.every((item: unknown) => isRecord(item) && typeof item.cid === "string");
}

/** 只认 maas/non_maas，其余值（含非法类型）一律丢弃；缺失/非法 → 空表。 */
function sanitizeOverrides(raw: unknown): MaasOverridesMap {
  const overrides: MaasOverridesMap = {};
  if (!isRecord(raw)) return overrides;
  for (const [cid, value] of Object.entries(raw)) {
    if (cid && (value === "maas" || value === "non_maas")) overrides[cid] = value;
  }
  return overrides;
}

/** GET /local/crm/maas-candidates —— 快照缺失/非法时后端 404（snapshot_unavailable）。 */
export async function fetchMaasCandidates(fetchImpl: typeof fetch = fetch): Promise<MaasCandidatesFile> {
  const payload = await request("/local/crm/maas-candidates", { method: "GET" }, fetchImpl);
  if (!isCandidatesFile(payload.data)) throw new PplClientError("invalid_response");
  return payload.data;
}

/** GET /local/crm/maas-overrides —— 服务端已做「本机 → public → 空表」回退。 */
export async function fetchMaasOverrides(fetchImpl: typeof fetch = fetch): Promise<MaasOverridesMap> {
  const payload = await request("/local/crm/maas-overrides", { method: "GET" }, fetchImpl);
  return sanitizeOverrides((payload.data as { overrides?: unknown } | undefined)?.overrides);
}

/** 服务端覆盖表来源；corrupt = 本机文件存在但损坏（保存会被 409 拒绝）。 */
export type MaasOverridesSource = "local" | "public" | "empty" | "corrupt";

export interface MaasOverridesState {
  readonly overrides: MaasOverridesMap;
  /** 未知/缺失（旧服务端）→ null，不臆造来源。 */
  readonly source: MaasOverridesSource | null;
}

const OVERRIDE_SOURCES: readonly string[] = ["local", "public", "empty", "corrupt"];

/** GET /local/crm/maas-overrides —— 带来源标记，用于识别「本机覆盖表损坏」。 */
export async function fetchMaasOverridesState(fetchImpl: typeof fetch = fetch): Promise<MaasOverridesState> {
  const payload = await request("/local/crm/maas-overrides", { method: "GET" }, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : {};
  const source = typeof data.source === "string" && OVERRIDE_SOURCES.includes(data.source)
    ? data.source as MaasOverridesSource
    : null;
  return { overrides: sanitizeOverrides(data.overrides), source };
}

/** 复核下拉的占位值：非人工覆盖行以「初筛：…」为当前值，选 MaaS 才是真实变更。 */
export const MAAS_SCREEN_VALUE = "screen";

export interface MaasReviewSelection {
  readonly value: MaasOverrideStatus | typeof MAAS_SCREEN_VALUE;
  readonly placeholder: string | null;
}

export function maasReviewSelection(decision: { readonly status: string; readonly basis: string }): MaasReviewSelection {
  if (decision.basis === "override" && (decision.status === "maas" || decision.status === "non_maas")) {
    return { value: decision.status, placeholder: null };
  }
  return { value: MAAS_SCREEN_VALUE, placeholder: decision.basis === "keyword" ? "初筛：疑似" : "初筛：未分类" };
}

/** 下拉值 → 可保存状态；占位值/未知值返回 null（不触发保存）。 */
export function maasReviewChoice(value: string): MaasOverrideStatus | null {
  return value === "maas" || value === "non_maas" || value === "unconfirmed" ? value : null;
}

/** POST /local/crm/maas-overrides —— 保存后返回服务端最新覆盖表（保存后刷新即生效）。 */
export async function saveMaasOverride(
  cid: string,
  status: MaasOverrideStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<MaasOverridesMap> {
  const payload = await request("/local/crm/maas-overrides", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cid, status }),
  }, fetchImpl);
  return sanitizeOverrides((payload.data as { overrides?: unknown } | undefined)?.overrides);
}

export function pplErrorMessage(error: unknown): string {
  const code = error instanceof PplClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    inspection_unavailable: "还没有巡检产物，点击「立即巡检」生成第一份。",
    not_found: "推荐条目已过期，请刷新巡检。",
    already_decided: "该条已有决策。",
    blocked_recommendation: "金额缺失，补齐前不能同意创建。",
    snapshot_unavailable: "还没有鲲鹏快照，候选生成不可用；仍可在下方手动分类。",
    overrides_corrupt: "本机覆盖表损坏，请先修复 .local-cache/maas-overrides.json 后再保存。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
  };
  return messages[code] ?? "巡检请求未完成，请稍后重试。";
}
