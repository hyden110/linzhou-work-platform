export type RetrievalMode = "qa" | "search" | "assistant";
export type RetrievalStatus = "answered" | "results-only" | "keyword-fallback" | "insufficient-evidence" | "failed";

export interface RetrievalFilters {
  sources?: string[];
  types?: string[];
  topics?: string[];
  start?: string;
  end?: string;
}

export interface RetrievalContext {
  customer?: string;
  industry?: string;
  goal?: string;
  constraints?: string;
}

export interface RetrievalRequest {
  query: string;
  mode: RetrievalMode;
  requestId: string;
  filters?: RetrievalFilters;
  context?: RetrievalContext;
}

export interface RetrievalCitation {
  id: string;
  referenceId: string;
  documentId: string;
  source: string;
  sourceLabel: string;
  title: string;
  locator: { kind: string; value: string };
  text: string;
}

export interface CitationGroup {
  documentId: string;
  title: string;
  sourceLabel: string;
  items: Array<{ number: number; citation: RetrievalCitation }>;
}

/** One card per document; numbers stay aligned with the [n] markers rendered in the answer. */
export function groupCitationsByDocument(citations: readonly RetrievalCitation[]): CitationGroup[] {
  return citations.reduce<CitationGroup[]>((groups, citation, index) => {
    const item = { number: index + 1, citation };
    const existing = groups.find((group) => group.documentId === citation.documentId);
    if (!existing) {
      return [...groups, { documentId: citation.documentId, title: citation.title, sourceLabel: citation.sourceLabel, items: [item] }];
    }
    return groups.map((group) => (group === existing ? { ...group, items: [...group.items, item] } : group));
  }, []);
}

export interface RetrievalResult {
  documentId: string;
  source: string;
  sourceLabel: string;
  type: string;
  title: string;
  modifiedAt: string;
  topics: string[];
  location: string;
  relativePath: string;
  summary: string;
  score: number;
  keywordScore: number;
  vectorScore: number;
}

export interface RetrievalResponse {
  status: RetrievalStatus;
  answer?: string;
  citations: RetrievalCitation[];
  results: RetrievalResult[];
  retrievalMode: "hybrid-local";
  vectorSearch?: "semantic" | "keyword-only";
  diagnosticId?: string;
}

const SAFE_ERROR_CODES = new Set([
  "invalid_json",
  "invalid_request",
  "method_not_allowed",
  "origin_not_allowed",
  "payload_too_large",
  "rate_limited",
  "retrieval_unavailable",
  "unsupported_media_type",
]);
const RESPONSE_STATUSES = new Set<RetrievalStatus>([
  "answered",
  "results-only",
  "keyword-fallback",
  "insufficient-evidence",
  "failed",
]);

export class RetrievalClientError extends Error {
  readonly code: string;
  readonly diagnosticId?: string;

  constructor(code: string, diagnosticId?: string) {
    super(code);
    this.name = "RetrievalClientError";
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRetrievalResponse(value: unknown): value is RetrievalResponse {
  if (!isRecord(value)) return false;
  return typeof value.status === "string"
    && RESPONSE_STATUSES.has(value.status as RetrievalStatus)
    && Array.isArray(value.citations)
    && Array.isArray(value.results)
    && value.retrievalMode === "hybrid-local"
    && (value.answer === undefined || typeof value.answer === "string");
}

function endpoint(): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL("/functions/v1/app", origin);
}

export async function retrieveKnowledge(
  request: RetrievalRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RetrievalResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    const response = await fetchImpl(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_CODES.has(payload.error)
        ? payload.error
        : "retrieval_unavailable";
      const diagnosticId = isRecord(payload) && typeof payload.diagnosticId === "string"
        ? payload.diagnosticId
        : undefined;
      throw new RetrievalClientError(code, diagnosticId);
    }
    const data = isRecord(payload) ? payload.data : undefined;
    if (!isRetrievalResponse(data)) throw new RetrievalClientError("invalid_response");
    return data;
  } catch (error) {
    if (error instanceof RetrievalClientError) throw error;
    throw new RetrievalClientError(error instanceof DOMException && error.name === "AbortError"
      ? "request_timeout"
      : "network_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
