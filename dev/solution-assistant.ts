import {
  RetrievalValidationError,
  retrieve,
  validateRetrievalRequest,
  type CitedReference,
  type RetrievalBundle,
  type RetrievalResponse,
  type RetrievalResult,
} from "../functions/retrieval.ts";
import { SOLUTION_LIMITS, type SolutionEvidence, type SolutionPlan } from "../src/lib/assistant-contract.ts";
import { createSolutionGenerator, type SolutionGenerator } from "./solution-generator.ts";

/**
 * Local-only 方案助手 endpoint logic: validate the browser request, gather redacted
 * evidence with the same retrieval code the deployed Function uses, then hand it to
 * the Qoder CLI generator. Lives in `dev/` because the CLI is a machine-local binary.
 */

export interface SolutionRetrievalStatus {
  readonly status: "results-only" | "insufficient-evidence";
  readonly vectorSearch: RetrievalResponse["vectorSearch"];
  readonly resultCount: number;
  readonly queries: string[];
}

export interface SolutionAssistantResult {
  readonly plan: SolutionPlan;
  readonly retrieval: SolutionRetrievalStatus;
  readonly input: SolutionRequestInput;
}

export class SolutionAssistantError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnosticId?: string;

  constructor(status: number, code: string, diagnosticId?: string) {
    super(code);
    this.name = "SolutionAssistantError";
    this.status = status;
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

export interface SolutionRequestInput {
  readonly requestId: string;
  readonly customer: string;
  readonly industry: string;
  readonly goal: string;
  readonly constraints: string;
}

export interface SolutionAssistantDependencies {
  readonly loadBundle?: () => Promise<RetrievalBundle>;
  readonly generate?: SolutionGenerator;
  readonly rateLimit?: { maxRequests: number; windowMs: number };
  readonly now?: () => number;
}

const MAX_BODY_BYTES = 8 * 1024;
const MAX_QUERY_CHARACTERS = 480;
const MAX_RETRIEVAL_QUERIES = 5;
const MAX_MERGED_RESULTS = 12;
const DEFAULT_RATE_LIMIT = { maxRequests: 6, windowMs: 60_000 };
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRetrievalBundle(value: unknown): value is RetrievalBundle {
  if (!isRecord(value)) return false;
  return value.mode === "safe-retrieval-bundle"
    && typeof value.schemaVersion === "number"
    && Array.isArray(value.documents);
}

let cachedBundle: Promise<RetrievalBundle> | undefined;

async function readDefaultBundle(): Promise<RetrievalBundle> {
  const module = await import("../functions/retrieval-bundle.json", { with: { type: "json" } });
  const bundle: unknown = module.default;
  if (!isRetrievalBundle(bundle)) throw new Error("retrieval bundle is invalid");
  return bundle;
}

function defaultLoadBundle(): Promise<RetrievalBundle> {
  cachedBundle ??= readDefaultBundle().catch((error) => {
    cachedBundle = undefined;
    throw error;
  });
  return cachedBundle;
}

function boundedField(value: unknown, min: number, max: number, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new SolutionAssistantError(400, "invalid_request");
    return "";
  }
  if (typeof value !== "string") throw new SolutionAssistantError(400, "invalid_request");
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text.length < min || text.length > max) throw new SolutionAssistantError(400, "invalid_request");
  return text;
}

export function parseSolutionRequest(body: unknown): SolutionRequestInput {
  if (!isRecord(body)) throw new SolutionAssistantError(400, "invalid_request");
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new SolutionAssistantError(400, "invalid_request");
  return {
    requestId,
    customer: boundedField(body.customer, 1, 80, true),
    industry: boundedField(body.industry, 0, 40, false),
    goal: boundedField(body.goal, 4, 500, true),
    constraints: boundedField(body.constraints, 0, 500, false),
  };
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new SolutionAssistantError(415, "unsupported_media_type");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new SolutionAssistantError(413, "payload_too_large");
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) throw new SolutionAssistantError(413, "payload_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SolutionAssistantError) throw error;
    throw new SolutionAssistantError(400, "invalid_json");
  }
}

function toEvidence(citations: readonly CitedReference[]): SolutionEvidence[] {
  return citations.slice(0, SOLUTION_LIMITS.evidence).map((citation) => ({
    referenceId: citation.referenceId,
    title: citation.title,
    sourceLabel: citation.sourceLabel,
    locator: `${citation.locator.kind} ${citation.locator.value}`,
    text: citation.text,
  }));
}

/** First meaningful clause of the goal, used to build a focused keyword query. */
function goalHeadline(goal: string): string {
  const clause = goal.split(/[，,。；;、\n]/).map((part) => part.trim()).find((part) => part.length >= 2) ?? goal;
  return Array.from(clause).slice(0, 30).join("");
}

/** Boilerplate verbs and prepositions that open most goal sentences but carry no retrieval signal. */
const LEADING_FILLER = /^(?:我们|你们|客户|希望|需要|想要|计划|帮我|建设|打造|构建|实现|搭建|建立|引入|落地|推进|开展|完成|规划|设计|面向|针对|围绕|基于|通过|利用|结合|关于|一个|一套)+/;

/**
 * The topic core of the goal: filler-free, particle-free and short. BM25 coverage is
 * matched-query weight over total query weight, so one out-of-corpus token in a long
 * sentence can push every passage below the relevance gate; a tight core still recalls.
 */
function topicCore(goal: string): string {
  const headline = goalHeadline(goal);
  let core = headline;
  for (let previous = ""; core !== previous && core.length > 0;) {
    previous = core;
    core = core.replace(LEADING_FILLER, "").trim();
  }
  const cleaned = (core || headline).replace(/的/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned.length >= 2 ? cleaned : headline).slice(0, 30).join("");
}

/**
 * A single long query rarely clears the BM25 coverage gate, so the assistant also
 * searches shorter customer-, domain- and topic-focused variants and merges what they recall.
 */
export function retrievalQueries(input: SolutionRequestInput): string[] {
  const core = topicCore(input.goal);
  const candidates = [
    [input.customer, core].filter(Boolean).join(" "),
    [input.industry, core].filter(Boolean).join(" "),
    core,
    [input.customer, input.industry, input.goal, input.constraints].filter(Boolean).join(" "),
    input.customer,
  ];
  return [...new Set(candidates.map((query) => query.trim().slice(0, MAX_QUERY_CHARACTERS)))]
    .filter((query) => query.length >= 2)
    .slice(0, MAX_RETRIEVAL_QUERIES);
}

async function gatherEvidence(
  bundle: RetrievalBundle,
  input: SolutionRequestInput,
): Promise<{ retrieval: SolutionRetrievalStatus; citations: CitedReference[] }> {
  const queries = retrievalQueries(input);
  const best = new Map<string, RetrievalResult>();
  const citations: CitedReference[] = [];
  const seen = new Set<string>();
  let semantic = false;

  for (const query of queries) {
    let response: RetrievalResponse;
    try {
      // The derived queries already carry the customer, industry and goal; adding them
      // again as retrieval context would only dilute BM25 coverage for every passage.
      response = await retrieve(validateRetrievalRequest({
        query,
        mode: "search",
        requestId: input.requestId,
      }), bundle);
    } catch (error) {
      // A derived query can fall outside the retrieval bounds; the others still count.
      if (error instanceof RetrievalValidationError) continue;
      throw error;
    }
    semantic = semantic || response.vectorSearch === "semantic";
    for (const result of response.results) {
      const current = best.get(result.documentId);
      if (!current || result.score > current.score) best.set(result.documentId, result);
    }
    for (const citation of response.citations) {
      if (seen.has(citation.referenceId)) continue;
      seen.add(citation.referenceId);
      citations.push(citation);
    }
  }

  const results = [...best.values()]
    .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
    .slice(0, MAX_MERGED_RESULTS);
  const rank = new Map(results.map((result, index) => [result.documentId, index]));
  const ordered = citations
    .filter((citation) => rank.has(citation.documentId))
    .sort((left, right) => (rank.get(left.documentId) ?? 0) - (rank.get(right.documentId) ?? 0))
    .slice(0, SOLUTION_LIMITS.evidence);

  return {
    citations: ordered,
    retrieval: {
      status: results.length ? "results-only" : "insufficient-evidence",
      vectorSearch: semantic ? "semantic" : "keyword-only",
      resultCount: results.length,
      queries,
    },
  };
}

function createRateLimiter(config: { maxRequests: number; windowMs: number }, now: () => number) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const timestamp = now();
    const current = entries.get(key);
    const next = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + config.windowMs }
      : { ...current, count: current.count + 1 };
    entries.set(key, next);
    if (entries.size > 100) {
      for (const [entryKey, entry] of entries) {
        if (entry.resetAt <= timestamp) entries.delete(entryKey);
      }
    }
    return next.count <= config.maxRequests;
  };
}

export function createSolutionAssistant(dependencies: SolutionAssistantDependencies = {}) {
  const loadBundle = dependencies.loadBundle ?? defaultLoadBundle;
  const generate = dependencies.generate ?? createSolutionGenerator();
  const allowRequest = createRateLimiter(dependencies.rateLimit ?? DEFAULT_RATE_LIMIT, dependencies.now ?? Date.now);
  let busy = false;

  return async (request: Request): Promise<SolutionAssistantResult> => {
    if (!allowRequest(request.headers.get("origin") ?? "local")) {
      throw new SolutionAssistantError(429, "rate_limited");
    }
    const input = parseSolutionRequest(await readBody(request));
    if (busy) throw new SolutionAssistantError(429, "assistant_busy");
    busy = true;
    try {
      const bundle = await loadBundle();
      if (!isRetrievalBundle(bundle)) throw new Error("retrieval bundle is invalid");
      const { citations, retrieval } = await gatherEvidence(bundle, input);
      const plan = await generate({
        input: {
          customer: input.customer,
          industry: input.industry,
          goal: input.goal,
          constraints: input.constraints,
        },
        evidence: toEvidence(citations),
        requestId: input.requestId,
      });
      return { plan, retrieval, input };
    } catch (error) {
      if (error instanceof SolutionAssistantError) throw error;
      const diagnosticId = `sol-${crypto.randomUUID()}`;
      console.error(JSON.stringify({ event: "solution_request_failed", diagnosticId, requestId: input.requestId }));
      throw new SolutionAssistantError(503, "assistant_unavailable", diagnosticId);
    } finally {
      busy = false;
    }
  };
}
