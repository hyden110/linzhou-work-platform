import { parseSolutionPlan, type SolutionDegradeCode, type SolutionEngine, type SolutionPlan } from "./assistant-contract.ts";
import type { AssistantRetrieval } from "./assistant-client.ts";

/**
 * Client for the local-only 方案版本历史 endpoints (`dev/local-router.ts`). The
 * versions are archives of plans this machine already generated, so the browser
 * only reads and deletes them; nothing here can reach a published deployment.
 */

export interface SolutionSeriesSummary {
  seriesId: string;
  customer: string;
  industry: string;
  goal: string;
  title: string;
  versionCount: number;
  latestVersion: number;
  updatedAt: string;
  latestEngine: SolutionEngine;
  latestDegraded?: SolutionDegradeCode;
}

export interface SolutionVersion {
  versionId: string;
  version: number;
  createdAt: string;
  engine: SolutionEngine;
  degraded?: SolutionDegradeCode;
  retrieval: AssistantRetrieval;
  plan: SolutionPlan;
}

export interface SolutionSeriesDetail {
  seriesId: string;
  customer: string;
  industry: string;
  goal: string;
  versions: SolutionVersion[];
}

const SAFE_ERROR_CODES = new Set([
  "invalid_request",
  "not_found",
  "rate_limited",
  "method_not_allowed",
  "origin_not_allowed",
  "host_not_allowed",
  "invalid_response",
  "unavailable",
]);
const MAX_SUMMARIES = 50;
const MAX_VERSIONS = 20;
const REQUEST_TIMEOUT_MS = 15_000;

export class SolutionHistoryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SolutionHistoryError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

function endpoint(query?: Record<string, string>): URL {
  const url = new URL("/local/solutions", localOrigin());
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function request(fetchImpl: typeof fetch, url: URL, method: "GET" | "DELETE"): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new SolutionHistoryError(error instanceof DOMException && error.name === "TimeoutError"
      ? "request_timeout"
      : "unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new SolutionHistoryError(isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_CODES.has(payload.error)
      ? payload.error
      : "unavailable");
  }
  return isRecord(payload) ? payload.data : undefined;
}

const ENGINES = new Set<SolutionEngine>(["qoder-cli", "template"]);
const DEGRADE_CODES = new Set<SolutionDegradeCode>([
  "cli-not-found",
  "cli-timeout",
  "cli-failed",
  "cli-invalid-output",
]);

function parseEngine(value: unknown): SolutionEngine | undefined {
  return typeof value === "string" && ENGINES.has(value as SolutionEngine) ? (value as SolutionEngine) : undefined;
}

function parseDegraded(value: unknown): SolutionDegradeCode | undefined {
  return typeof value === "string" && DEGRADE_CODES.has(value as SolutionDegradeCode)
    ? (value as SolutionDegradeCode)
    : undefined;
}

function parseRetrieval(value: unknown): AssistantRetrieval {
  const record = isRecord(value) ? value : {};
  return {
    status: record.status === "results-only" ? "results-only" : "insufficient-evidence",
    vectorSearch: record.vectorSearch === "semantic" ? "semantic" : "keyword-only",
    resultCount: typeof record.resultCount === "number" && Number.isFinite(record.resultCount)
      ? Math.max(0, Math.trunc(record.resultCount))
      : 0,
    queries: Array.isArray(record.queries)
      ? record.queries.filter((query): query is string => typeof query === "string").slice(0, 6)
      : [],
  };
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, max).join("");
}

function parseSummary(value: unknown): SolutionSeriesSummary | undefined {
  if (!isRecord(value)) return undefined;
  const seriesId = boundedText(value.seriesId, 16);
  const customer = boundedText(value.customer, 80);
  const goal = boundedText(value.goal, 500);
  const engine = parseEngine(value.latestEngine);
  const versionCount = typeof value.versionCount === "number" ? Math.max(1, Math.trunc(value.versionCount)) : 0;
  const updatedAt = typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
    ? value.updatedAt
    : "";
  if (!seriesId || !customer || !goal || !engine || !versionCount || !updatedAt) return undefined;
  const degraded = parseDegraded(value.latestDegraded);
  return {
    seriesId,
    customer,
    industry: boundedText(value.industry, 40),
    goal,
    title: boundedText(value.title, 90),
    versionCount,
    latestVersion: typeof value.latestVersion === "number" ? Math.max(1, Math.trunc(value.latestVersion)) : versionCount,
    updatedAt,
    latestEngine: engine,
    ...(degraded ? { latestDegraded: degraded } : {}),
  };
}

function parseVersion(value: unknown): SolutionVersion | undefined {
  if (!isRecord(value)) return undefined;
  const versionId = boundedText(value.versionId, 64);
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    ? value.createdAt
    : "";
  const engine = parseEngine(value.engine);
  const plan = parseSolutionPlan(value.plan);
  if (!versionId || !createdAt || !engine || !plan) return undefined;
  const version = typeof value.version === "number" && Number.isFinite(value.version)
    ? Math.max(1, Math.trunc(value.version))
    : undefined;
  if (version === undefined) return undefined;
  const degraded = parseDegraded(value.degraded);
  return {
    versionId,
    version,
    createdAt,
    engine,
    ...(degraded ? { degraded } : {}),
    retrieval: parseRetrieval(value.retrieval),
    plan,
  };
}

export async function fetchSolutionSeries(fetchImpl: typeof fetch = fetch): Promise<SolutionSeriesSummary[]> {
  const data = await request(fetchImpl, endpoint(), "GET");
  const series = isRecord(data) && Array.isArray(data.series) ? data.series : undefined;
  if (!series) throw new SolutionHistoryError("invalid_response");
  return series
    .map((item: unknown) => parseSummary(item))
    .filter((item: SolutionSeriesSummary | undefined): item is SolutionSeriesSummary => item !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SUMMARIES);
}

export async function fetchSolutionSeriesVersions(
  seriesId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SolutionSeriesDetail> {
  const data = await request(fetchImpl, endpoint({ series: seriesId }), "GET");
  if (!isRecord(data)) throw new SolutionHistoryError("invalid_response");
  const key = isRecord(data.key) ? data.key : {};
  const rawVersions = Array.isArray(data.versions) ? data.versions : [];
  const versions = rawVersions
    .map((item: unknown) => parseVersion(item))
    .filter((item: SolutionVersion | undefined): item is SolutionVersion => item !== undefined)
    .sort((left, right) => right.version - left.version)
    .slice(0, MAX_VERSIONS);
  if (!versions.length) throw new SolutionHistoryError("not_found");
  return {
    seriesId: boundedText(data.seriesId, 16) || seriesId,
    customer: boundedText(key.customer, 80),
    industry: boundedText(key.industry, 40),
    goal: boundedText(key.goal, 500),
    versions,
  };
}

/** Deletes one archived version; resolves to how many remain in that series. */
export async function deleteSolutionVersion(
  seriesId: string,
  versionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const url = new URL(`/local/solutions/${encodeURIComponent(seriesId)}/${encodeURIComponent(versionId)}`, localOrigin());
  const data = await request(fetchImpl, url, "DELETE");
  const remaining = isRecord(data) && typeof data.remaining === "number" ? Math.max(0, Math.trunc(data.remaining)) : undefined;
  if (remaining === undefined) throw new SolutionHistoryError("invalid_response");
  return remaining;
}

export function solutionHistoryErrorMessage(error: unknown): string {
  if (!(error instanceof SolutionHistoryError)) return "历史方案读取失败，请稍后重试。";
  const messages: Record<string, string> = {
    unavailable: "本机方案服务未响应，请先运行 npm run dev:function。",
    request_timeout: "读取历史方案超时，请重试。",
    not_found: "这份历史方案已不在本机存档中。",
    invalid_response: "本机服务返回了无法识别的历史方案数据。",
    invalid_request: "历史方案请求参数无效。",
    rate_limited: "历史方案请求过于频繁，请稍后再试。",
    method_not_allowed: "请求方式不被本机服务接受。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
  };
  return messages[error.code] ?? "历史方案暂时不可用，请稍后重试。";
}
