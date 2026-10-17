const SAFE_ERRORS = new Set([
  "inspection_unavailable",
  "invalid_request",
  "not_found",
  "already_decided",
  "blocked_recommendation",
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

export function pplErrorMessage(error: unknown): string {
  const code = error instanceof PplClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    inspection_unavailable: "还没有巡检产物，点击「立即巡检」生成第一份。",
    not_found: "推荐条目已过期，请刷新巡检。",
    already_decided: "该条已有决策。",
    blocked_recommendation: "金额缺失，补齐前不能同意创建。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
  };
  return messages[code] ?? "巡检请求未完成，请稍后重试。";
}
