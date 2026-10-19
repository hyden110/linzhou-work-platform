/**
 * Browser client for the unified knowledge retrieval bridge (F2) —
 * /local/kb/search · /local/kb/summary · /local/kb/sources.
 *
 * Degrade contract: an offline bridge (npm run dev:function not running) maps
 * to KbClientError("unavailable") so AskView can show 「本地桥未启动」 instead of
 * a white screen; a failed summary keeps the search hits untouched (无摘要，
 * 不阻塞检索结果).
 */

const SEARCH_TIMEOUT_MS = 30_000; /* 桥侧扇出 25s + 网络余量 */
const SUMMARY_TIMEOUT_MS = 190_000; /* 桥侧 qodercli 180s + 余量 */
const SOURCES_TIMEOUT_MS = 30_000;

const SAFE_ERRORS = [
  "unavailable",
  "invalid_request",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "kb_unavailable",
  "kb_read_failed",
  "kb_summary_failed",
  "source_not_found",
] as const;

export type KbClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class KbClientError extends Error {
  readonly code: KbClientErrorCode;

  constructor(code: KbClientErrorCode) {
    super(code);
    this.name = "KbClientError";
    this.code = code;
  }
}

export interface KbHit {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly space: string;
  readonly path: string;
  readonly url: string;
  readonly snippet: string;
  readonly rank: number;
  readonly score: number;
}

export interface KbSourceStatus {
  readonly sourceId: string;
  readonly name: string;
  readonly type: string;
  readonly ok: boolean;
  readonly n: number;
  readonly ms: number;
  readonly note?: string;
}

export interface KbSearchOutcome {
  readonly q: string;
  readonly hits: readonly KbHit[];
  readonly status: readonly KbSourceStatus[];
}

export interface KbExternalAnswer {
  readonly hits: readonly KbHit[];
  readonly status: readonly KbSourceStatus[];
  readonly summary?: string;
}

export interface KbSourceView {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly ok: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function kbUrl(path: string, query?: Record<string, string>): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function requestJson(
  path: string,
  query: Record<string, string> | undefined,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(kbUrl(path, query), init);
  } catch {
    throw new KbClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new KbClientError(payload.error as KbClientErrorCode);
    }
    throw new KbClientError("unavailable");
  }
  return payload;
}

function asHit(value: unknown): KbHit | undefined {
  if (!isRecord(value)) return undefined;
  const requiredString = (key: string) => typeof value[key] === "string";
  if (!requiredString("sourceId") || !requiredString("id") || !requiredString("title")) return undefined;
  return {
    sourceId: value.sourceId as string,
    sourceName: typeof value.sourceName === "string" ? value.sourceName : "",
    type: typeof value.type === "string" ? value.type : "",
    id: value.id as string,
    title: value.title as string,
    space: typeof value.space === "string" ? value.space : "",
    path: typeof value.path === "string" ? value.path : "",
    url: typeof value.url === "string" ? value.url : "",
    snippet: typeof value.snippet === "string" ? value.snippet : "",
    rank: typeof value.rank === "number" ? value.rank : 0,
    score: typeof value.score === "number" ? value.score : 0,
  };
}

function asSearchOutcome(value: unknown): KbSearchOutcome | undefined {
  if (!isRecord(value) || typeof value.q !== "string" || !Array.isArray(value.hits)) return undefined;
  const hits = value.hits.map(asHit).filter((hit): hit is KbHit => hit !== undefined);
  const status = (Array.isArray(value.status) ? value.status : []).filter(isRecord).map((entry) => ({
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
    name: typeof entry.name === "string" ? entry.name : "",
    type: typeof entry.type === "string" ? entry.type : "",
    ok: entry.ok === true,
    n: typeof entry.n === "number" ? entry.n : 0,
    ms: typeof entry.ms === "number" ? entry.ms : 0,
    note: typeof entry.note === "string" ? entry.note : undefined,
  }));
  return { q: value.q, hits, status };
}

/** GET /local/kb/search —— 多源扇出 + RRF 融合后的外部命中。 */
export async function searchKb(query: string, fetchImpl: typeof fetch = fetch): Promise<KbSearchOutcome> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 200) throw new KbClientError("invalid_request");
  const payload = await requestJson("/local/kb/search", { q: trimmed }, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  }, fetchImpl);
  const outcome = asSearchOutcome(payload.data);
  if (!outcome) throw new KbClientError("invalid_response");
  return outcome;
}

/**
 * POST /local/kb/summary —— 摘要请求只携带 白名单字段（标题/路径/摘要片段）；
 * 越界字段（如 customerName/cid）在此被剥掉，绝不离开本机。
 */
export async function requestKbSummary(
  query: string,
  hits: readonly KbHit[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const payload = await requestJson("/local/kb/summary", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      q: query,
      hits: hits.map((hit) => ({
        sourceId: hit.sourceId,
        id: hit.id,
        title: hit.title,
        space: hit.space,
        source: hit.sourceName,
        snippet: hit.snippet,
      })),
    }),
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  }, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data || typeof data.answer !== "string" || !data.answer.trim()) {
    throw new KbClientError("kb_summary_failed");
  }
  return data.answer;
}

/** 检索 + 尽力摘要：摘要失败 → 命中照常返回，summary 为空（降级不阻塞）。 */
export async function searchExternalKb(query: string, fetchImpl: typeof fetch = fetch): Promise<KbExternalAnswer> {
  const outcome = await searchKb(query, fetchImpl);
  if (!outcome.hits.length) return { hits: outcome.hits, status: outcome.status };
  try {
    const summary = await requestKbSummary(query, outcome.hits, fetchImpl);
    return { hits: outcome.hits, status: outcome.status, summary };
  } catch {
    return { hits: outcome.hits, status: outcome.status };
  }
}

/** GET /local/kb/sources —— 当前启用的外部来源（缺失/坏配置 → 空数组）。 */
export async function fetchKbSources(fetchImpl: typeof fetch = fetch): Promise<KbSourceView[]> {
  const payload = await requestJson("/local/kb/sources", undefined, {
    signal: AbortSignal.timeout(SOURCES_TIMEOUT_MS),
  }, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  const sources = data && Array.isArray(data.sources) ? data.sources : [];
  return sources.filter(isRecord).flatMap((source) => {
    if (typeof source.id !== "string" || !source.id) return [];
    return [{
      id: source.id,
      name: typeof source.name === "string" ? source.name : source.id,
      label: typeof source.label === "string" ? source.label : source.id,
      ok: source.ok === true,
    }];
  });
}

export function kbErrorMessage(error: unknown): string {
  const code = error instanceof KbClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_request: "检索词为空或超过 200 字。",
    invalid_response: "本机服务返回了无法识别的数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    kb_unavailable: "外部知识检索暂时不可用，请稍后重试。",
    kb_read_failed: "外部文档原文读取失败，请稍后重试。",
    kb_summary_failed: "AI 摘要生成失败，已跳过摘要；检索结果不受影响，可重试。",
    source_not_found: "未找到该知识库来源，请检查本机 .local-cache/kb.json 配置。",
  };
  return messages[code] ?? "外部知识检索暂不可用，请稍后重试。";
}
