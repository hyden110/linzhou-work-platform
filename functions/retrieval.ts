import { rankPassages, type RankedPassage } from "./ranking.ts";

export type RetrievalMode = "qa" | "search" | "assistant";
export type RetrievalStatus = "answered" | "results-only" | "keyword-fallback" | "insufficient-evidence" | "failed";

export interface RetrievalCitation {
  id: string;
  locator: { kind: string; value: string };
  text: string;
}

interface StoredCitation extends RetrievalCitation {
  vector?: string;
}

export interface RetrievalDocument {
  id: string;
  source: string;
  sourceLabel: string;
  type: string;
  title: string;
  modifiedAt: string;
  topics: string[];
  location: string;
  relativePath: string;
  summary: string;
  citations: StoredCitation[];
  vector?: string;
}

export interface EmbeddingMetadata {
  provider: string;
  model: string;
  dimensions: number;
  encoding: "int8-base64";
}

export interface RetrievalBundle {
  schemaVersion: number;
  mode: "safe-retrieval-bundle";
  generatedAt: string;
  documentCount: number;
  skippedCount: number;
  embedding?: EmbeddingMetadata;
  documents: RetrievalDocument[];
}

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

export interface AnswerEvidence {
  documentId: string;
  sourceLabel: string;
  title: string;
  summary: string;
  citations: Array<RetrievalCitation & { referenceId: string }>;
}

export interface AnswerGenerationRequest {
  query: string;
  mode: Exclude<RetrievalMode, "search">;
  context?: RetrievalContext;
  evidence: AnswerEvidence[];
  requestId: string;
}

export interface GeneratedAnswer {
  answer: string;
  citationIds: string[];
}

export type AnswerGenerator = (request: AnswerGenerationRequest) => Promise<GeneratedAnswer>;
export type QueryEmbedder = (text: string) => Promise<Float32Array>;

export interface RetrievalDependencies {
  generateAnswer?: AnswerGenerator;
  embedQuery?: QueryEmbedder;
}

export type CitedReference = RetrievalCitation & {
  referenceId: string;
  documentId: string;
  source: string;
  sourceLabel: string;
  title: string;
};

export interface RetrievalResponse {
  status: RetrievalStatus;
  answer?: string;
  citations: CitedReference[];
  results: RetrievalResult[];
  retrievalMode: "hybrid-local";
  vectorSearch: "semantic" | "keyword-only";
  diagnosticId?: string;
}

const MAX_QUERY_CHARACTERS = 500;
const MAX_FILTER_VALUES = 12;
const MAX_CONTEXT_CHARACTERS = 500;
const MAX_RESULTS = 12;
const MAX_EVIDENCE_DOCUMENTS = 5;
const MAX_CITATIONS_PER_DOCUMENT = 3;
const MAX_ANSWER_CITATIONS = 8;
const MIN_FINGERPRINT_CHARACTERS = 24;
const MIN_PASSAGE_COVERAGE = 0.5;
const MIN_PASSAGE_VECTOR = 0.5;
// Calibrated on .local-cache/retrieval-eval.json (2026-10-13, word-weighted coverage):
// in-scope vector ≥ 0.565, OOS vector ≤ 0.497; OOS coverage reaches 0.601, so coverage alone cannot vouch for evidence.
const STRONG_COVERAGE = 0.6;
const KEYWORD_ONLY_STRONG_COVERAGE = 0.5;
const STRONG_VECTOR = 0.53;
const COVERAGE_VECTOR_FLOOR = 0.5;
const SECOND_HIT_WEIGHT = 0.3;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MODES = new Set<RetrievalMode>(["qa", "search", "assistant"]);
const CONTEXT_FIELDS = ["customer", "industry", "goal", "constraints"] as const;

export class RetrievalValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FILTER_VALUES) {
    throw new RetrievalValidationError(`${field} must be a bounded string array`);
  }
  const values = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 80) {
      throw new RetrievalValidationError(`${field} contains an invalid value`);
    }
    return item.trim();
  });
  return [...new Set(values)];
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new RetrievalValidationError(`${field} must be an ISO date`);
  }
  return value.trim();
}

function validateFilters(value: unknown): RetrievalFilters | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RetrievalValidationError("filters must be an object");
  const filters: RetrievalFilters = {
    sources: optionalStringList(value.sources, "filters.sources"),
    types: optionalStringList(value.types, "filters.types"),
    topics: optionalStringList(value.topics, "filters.topics"),
    start: optionalDate(value.start, "filters.start"),
    end: optionalDate(value.end, "filters.end"),
  };
  if (filters.start && filters.end && Date.parse(filters.start) > Date.parse(filters.end)) {
    throw new RetrievalValidationError("filters.start must not be after filters.end");
  }
  return filters;
}

function validateContext(value: unknown): RetrievalContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RetrievalValidationError("context must be an object");
  return Object.fromEntries(
    CONTEXT_FIELDS.flatMap((field) => {
      const item = value[field];
      if (item === undefined) return [];
      if (typeof item !== "string" || item.length > MAX_CONTEXT_CHARACTERS) {
        throw new RetrievalValidationError(`context.${field} must be a bounded string`);
      }
      const normalized = item.trim();
      return normalized ? [[field, normalized]] : [];
    }),
  );
}

export function validateRetrievalRequest(value: unknown): RetrievalRequest {
  if (!isRecord(value)) throw new RetrievalValidationError("request body must be an object");
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (query.length < 2 || query.length > MAX_QUERY_CHARACTERS) {
    throw new RetrievalValidationError("query must contain 2 to 500 characters");
  }
  if (typeof value.mode !== "string" || !MODES.has(value.mode as RetrievalMode)) {
    throw new RetrievalValidationError("mode is invalid");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new RetrievalValidationError("requestId is invalid");
  }
  return {
    query,
    mode: value.mode as RetrievalMode,
    requestId: value.requestId,
    filters: validateFilters(value.filters),
    context: validateContext(value.context),
  };
}

interface RankedDocument {
  document: RetrievalDocument;
  score: number;
  coverage: number;
  vector: number;
  passages: RankedPassage[];
}

function passesFilters(document: RetrievalDocument, filters?: RetrievalFilters): boolean {
  if (!filters) return true;
  if (filters.sources?.length && !filters.sources.includes(document.source) && !filters.sources.includes(document.sourceLabel)) return false;
  if (filters.types?.length && !filters.types.includes(document.type)) return false;
  if (filters.topics?.length && !filters.topics.some((topic) => document.topics.includes(topic))) return false;
  const modifiedAt = Date.parse(document.modifiedAt);
  if (filters.start && (!Number.isFinite(modifiedAt) || modifiedAt < Date.parse(filters.start))) return false;
  if (filters.end && (!Number.isFinite(modifiedAt) || modifiedAt > Date.parse(filters.end))) return false;
  return true;
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isRelevant(passage: RankedPassage): boolean {
  return passage.coverage >= MIN_PASSAGE_COVERAGE || passage.vector >= MIN_PASSAGE_VECTOR;
}

function rankDocuments(passages: readonly RankedPassage[], documents: readonly RetrievalDocument[]): RankedDocument[] {
  const grouped = new Map<number, RankedPassage[]>();
  passages.filter(isRelevant).forEach((passage) => {
    grouped.set(passage.documentIndex, [...(grouped.get(passage.documentIndex) ?? []), passage]);
  });
  const seenTitles = new Set<string>();
  return [...grouped.entries()]
    .map(([documentIndex, hits]) => ({
      document: documents[documentIndex],
      score: hits[0].fused + (hits[1]?.fused ?? 0) * SECOND_HIT_WEIGHT,
      coverage: Math.max(...hits.map((hit) => hit.coverage)),
      vector: Math.max(...hits.map((hit) => hit.vector)),
      passages: hits,
    }))
    .sort((left, right) => (
      right.score - left.score
      || right.document.modifiedAt.localeCompare(left.document.modifiedAt)
      || left.document.id.localeCompare(right.document.id)
    ))
    .filter((item) => {
      const key = titleKey(item.document.title);
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, MAX_RESULTS);
}

function toResult(ranked: RankedDocument, topScore: number): RetrievalResult {
  const { document } = ranked;
  return {
    documentId: document.id,
    source: document.source,
    sourceLabel: document.sourceLabel,
    type: document.type,
    title: document.title,
    modifiedAt: document.modifiedAt,
    topics: [...document.topics],
    location: document.location,
    relativePath: document.relativePath,
    summary: document.summary,
    score: roundScore(topScore ? ranked.score / topScore : 0),
    keywordScore: roundScore(ranked.coverage),
    vectorScore: roundScore(Math.max(0, ranked.vector)),
  };
}

/** PPTX extraction leaks embedded-object digests (long hex runs); they carry no meaning and bloat every projection. */
const DIGEST_RUN = /[0-9A-Fa-f]{32,}/g;
const TABLE_RULE = /\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?/g;

/** Markdown sources keep table pipes, rules and emphasis markers that read as noise once flattened into a snippet. */
function cleanSnippet(text: string): string {
  return text
    .replace(DIGEST_RUN, "")
    .replace(TABLE_RULE, " ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .trim();
}

/** Copies such as "方案_副本" or "方案 (1)" share content with the original; listing both wastes evidence slots. */
function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s_-]*(?:副本|拷贝|copy)(?:\s*\d+)?$/u, "")
    .replace(/\s*[(（]\d+[)）]$/u, "")
    .replace(/[\s_·-]+/g, "");
}

function citedReference(document: RetrievalDocument, citation: StoredCitation): CitedReference {
  return {
    id: citation.id,
    locator: { ...citation.locator },
    text: cleanSnippet(citation.text),
    referenceId: `${document.id}:${citation.id}`,
    documentId: document.id,
    source: document.source,
    sourceLabel: document.sourceLabel,
    title: document.title,
  };
}

function evidenceCitations(ranked: RankedDocument): CitedReference[] {
  const { document } = ranked;
  const hitIndexes = ranked.passages.map((passage) => passage.citationIndex).filter((index) => index >= 0);
  const indexes = hitIndexes.length ? hitIndexes : document.citations.length ? [0] : [];
  return indexes.slice(0, MAX_CITATIONS_PER_DOCUMENT).map((index) => citedReference(document, document.citations[index]));
}

function fingerprintText(text: string | undefined): string {
  return (text ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Renamed deck versions (-v2, 云栖大会-…) share the cover and the matched passage; a second copy adds no evidence. */
function contentKey(ranked: RankedDocument): string | undefined {
  const { document, passages } = ranked;
  const cover = fingerprintText(document.citations[0]?.text);
  if (cover.length < MIN_FINGERPRINT_CHARACTERS) return undefined;
  const hitIndex = passages.find((passage) => passage.citationIndex >= 0)?.citationIndex ?? 0;
  return `${cover}\u0000${fingerprintText(document.citations[hitIndex]?.text)}`;
}

function distinctEvidence(ranked: readonly RankedDocument[]): RankedDocument[] {
  const seen = new Set<string>();
  return ranked.filter((item) => {
    const key = contentKey(item);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EVIDENCE_DOCUMENTS);
}

function answerEvidence(evidence: readonly RankedDocument[]): AnswerEvidence[] {
  return evidence.map((ranked) => ({
    documentId: ranked.document.id,
    sourceLabel: ranked.document.sourceLabel,
    title: ranked.document.title,
    summary: ranked.document.summary,
    citations: evidenceCitations(ranked).map(({ id, locator, text, referenceId }) => ({ id, locator, text, referenceId })),
  }));
}

function validatedAnswer(
  generated: GeneratedAnswer,
  citations: readonly CitedReference[],
): { answer: string; citations: CitedReference[] } {
  const answer = typeof generated.answer === "string" ? generated.answer.trim() : "";
  const citationIds = Array.isArray(generated.citationIds)
    ? [...new Set(generated.citationIds)].slice(0, MAX_ANSWER_CITATIONS)
    : [];
  const available = new Map(citations.map((citation) => [citation.referenceId, citation]));
  const selected = citationIds.flatMap((id) => {
    const citation = available.get(id);
    return citation && answer.includes(`[${id}]`) ? [citation] : [];
  });
  if (!answer || answer.length > 6_000 || !selected.length || selected.length !== citationIds.length) {
    throw new Error("generated answer is not bound to available citations");
  }
  return { answer, citations: selected };
}

async function queryVector(
  text: string,
  bundle: RetrievalBundle,
  embedQuery: QueryEmbedder | undefined,
  requestId: string,
): Promise<Float32Array | undefined> {
  if (!embedQuery || !bundle.embedding) return undefined;
  try {
    const vector = await embedQuery(text);
    return vector.length === bundle.embedding.dimensions ? vector : undefined;
  } catch {
    console.error(JSON.stringify({ event: "query_embedding_failed", requestId }));
    return undefined;
  }
}

export async function retrieve(
  request: RetrievalRequest,
  bundle: RetrievalBundle,
  dependencies: RetrievalDependencies = {},
): Promise<RetrievalResponse> {
  const contextText = [
    request.context?.customer,
    request.context?.industry,
    request.context?.goal,
    request.context?.constraints,
  ].filter(Boolean).join(" ");
  const searchText = [request.query, contextText].filter(Boolean).join(" ");
  const vector = await queryVector(searchText, bundle, dependencies.embedQuery, request.requestId);
  const vectorSearch = vector ? "semantic" as const : "keyword-only" as const;
  const allowed = bundle.documents.map((document) => passesFilters(document, request.filters));
  const passages = rankPassages(bundle.documents, allowed, searchText, vector, bundle.embedding?.dimensions ?? 0);
  const ranked = rankDocuments(passages, bundle.documents);
  const sufficient = ranked.some((item) => (vector
    ? item.vector >= STRONG_VECTOR || (item.coverage >= STRONG_COVERAGE && item.vector >= COVERAGE_VECTOR_FLOOR)
    : item.coverage >= KEYWORD_ONLY_STRONG_COVERAGE));
  const base = { retrievalMode: "hybrid-local" as const, vectorSearch };

  if (!sufficient) {
    return { ...base, status: "insufficient-evidence", citations: [], results: [] };
  }

  const results = ranked.map((item) => toResult(item, ranked[0].score));
  const evidence = distinctEvidence(ranked);
  const citations = evidence.flatMap(evidenceCitations);
  if (request.mode === "search") {
    return { ...base, status: "results-only", citations, results };
  }
  if (!dependencies.generateAnswer || !citations.length) {
    return { ...base, status: "keyword-fallback", citations, results };
  }

  try {
    const generated = await dependencies.generateAnswer({
      query: request.query,
      mode: request.mode,
      context: request.context,
      evidence: answerEvidence(evidence),
      requestId: request.requestId,
    });
    const validated = validatedAnswer(generated, citations);
    return { ...base, status: "answered", answer: validated.answer, citations: validated.citations, results };
  } catch (error) {
    const diagnosticId = `ai-${crypto.randomUUID()}`;
    const reason = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    console.error(JSON.stringify({ event: "answer_generation_failed", diagnosticId, requestId: request.requestId, reason }));
    return { ...base, status: "keyword-fallback", citations, results, diagnosticId };
  }
}
