/**
 * Browser client for the published-cases ledger (F3) — GET /local/cases.
 *
 * Degrade contract: an offline bridge (npm run dev:function not running) maps
 * to CasesClientError("unavailable") so the panel shows 「本地桥未启动」 instead
 * of a white screen; an unconfigured machine keeps configured:false visible so
 * the guide copy (补 .local-cache/cases.json + a1/ossutil) can render.
 */

const CASES_TIMEOUT_MS = 150_000; /* 桥侧渠道上限（ossutil ls 120s）+ 网络余量 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "cases_unavailable",
] as const;

export type CasesClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class CasesClientError extends Error {
  readonly code: CasesClientErrorCode;

  constructor(code: CasesClientErrorCode) {
    super(code);
    this.name = "CasesClientError";
    this.code = code;
  }
}

export interface PublishedCase {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly cust: string;
  readonly updatedAt: string;
  readonly entryUrl: string;
  readonly srcs: readonly string[];
  readonly pageCount: number;
}

export interface CasesChannelStatus {
  readonly state: "ok" | "degraded" | "error" | "unconfigured";
  readonly note: string;
  readonly count: number;
}

export interface CasesSnapshot {
  readonly configured: boolean;
  readonly cases: readonly PublishedCase[];
  readonly channels: Readonly<Record<"code" | "oss", CasesChannelStatus>>;
  readonly fetchedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function casesUrl(): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL("/local/cases", origin);
}

/** 入口链接护栏：只放行 http(s)，其余（javascript:/data:/file:）一律空串。 */
export function safeCaseUrl(url: unknown): string {
  const text = String(url ?? "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

const CHANNEL_STATES = new Set(["ok", "degraded", "error", "unconfigured"]);

function asChannelStatus(value: unknown): CasesChannelStatus | undefined {
  if (!isRecord(value) || typeof value.state !== "string" || !CHANNEL_STATES.has(value.state)) return undefined;
  return {
    state: value.state as CasesChannelStatus["state"],
    note: typeof value.note === "string" ? value.note : "",
    count: typeof value.count === "number" ? value.count : 0,
  };
}

function asCase(value: unknown): PublishedCase | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name,
    title: typeof value.title === "string" ? value.title : "",
    cust: typeof value.cust === "string" ? value.cust : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    entryUrl: safeCaseUrl(value.entryUrl),
    srcs: Array.isArray(value.srcs) ? value.srcs.filter((src): src is string => typeof src === "string") : [],
    pageCount: typeof value.pageCount === "number" ? value.pageCount : 1,
  };
}

function asSnapshot(value: unknown): CasesSnapshot | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean" || !Array.isArray(value.cases) || !isRecord(value.channels)) {
    return undefined;
  }
  const code = asChannelStatus(value.channels.code);
  const oss = asChannelStatus(value.channels.oss);
  if (!code || !oss) return undefined;
  const cases = value.cases.map(asCase).filter((entry): entry is PublishedCase => entry !== undefined);
  return {
    configured: value.configured,
    cases,
    channels: { code, oss },
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
  };
}

/** GET /local/cases —— 只读案例台账快照（未配置机器 configured:false 照常返回）。 */
export async function fetchPublishedCases(fetchImpl: typeof fetch = fetch): Promise<CasesSnapshot> {
  let response: Response;
  try {
    response = await fetchImpl(casesUrl(), { signal: AbortSignal.timeout(CASES_TIMEOUT_MS) });
  } catch {
    throw new CasesClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new CasesClientError(payload.error as CasesClientErrorCode);
    }
    throw new CasesClientError("unavailable");
  }
  const snapshot = asSnapshot(payload.data);
  if (!snapshot) throw new CasesClientError("invalid_response");
  return snapshot;
}

export function casesErrorMessage(error: unknown): string {
  const code = error instanceof CasesClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的案例数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    cases_unavailable: "案例台账暂时不可用，请稍后重试；渠道报错会在恢复后如实显示。",
  };
  return messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
}
