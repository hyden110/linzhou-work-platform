import type { OpsCard, OpsDigest, OpsRefreshStatus, OpsWechatLink } from "./ops-types";

const SAFE_ERRORS = new Set([
  "digest_unavailable",
  "invalid_url",
  "invalid_request",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
]);

export class OpsClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OpsClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string, query?: Record<string, string>): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function request(path: string, init: RequestInit & { query?: Record<string, string> }, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path, init.query), { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new OpsClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERRORS.has(payload.error)
      ? payload.error
      : "unavailable";
    throw new OpsClientError(code);
  }
  return payload;
}

function isOpsDigest(value: unknown): value is OpsDigest {
  return isRecord(value)
    && value.schemaVersion === 1
    && isRecord(value.sources)
    && Array.isArray(value.items);
}

function isOpsRefreshStatus(value: unknown): value is OpsRefreshStatus {
  return isRecord(value) && ["idle", "running", "succeeded", "failed"].includes(String(value.state));
}

function isOpsCard(value: unknown): value is OpsCard {
  return isRecord(value)
    && typeof value.date === "string"
    && isRecord(value.overview)
    && typeof value.overview.text === "string"
    && Array.isArray(value.groups);
}

function isOpsWechatLink(value: unknown): value is OpsWechatLink {
  return isRecord(value) && typeof value.id === "string" && typeof value.url === "string";
}

export async function fetchOpsDigest(fetchImpl: typeof fetch = fetch): Promise<{ digest: OpsDigest; refresh: OpsRefreshStatus | null }> {
  const payload = await request("/local/ops/digest", { method: "GET" }, fetchImpl);
  if (!isOpsDigest(payload.data)) throw new OpsClientError("invalid_response");
  return {
    digest: payload.data,
    refresh: isOpsRefreshStatus(payload.refresh) ? payload.refresh : null,
  };
}

export async function fetchOpsRefreshStatus(fetchImpl: typeof fetch = fetch): Promise<OpsRefreshStatus> {
  const payload = await request("/local/ops/refresh", { method: "GET" }, fetchImpl);
  if (!isOpsRefreshStatus(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

export async function startOpsRefresh(fetchImpl: typeof fetch = fetch): Promise<OpsRefreshStatus> {
  const payload = await request("/local/ops/refresh", { method: "POST" }, fetchImpl);
  if (!isOpsRefreshStatus(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

export async function fetchOpsCard(fetchImpl: typeof fetch = fetch): Promise<OpsCard> {
  const payload = await request("/local/ops/card", { method: "GET" }, fetchImpl);
  if (!isOpsCard(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

export async function fetchOpsWechatLinks(fetchImpl: typeof fetch = fetch): Promise<readonly OpsWechatLink[]> {
  const payload = await request("/local/ops/wechat-links", { method: "GET" }, fetchImpl);
  const data = (payload.data as { links?: unknown } | undefined)?.links;
  if (!Array.isArray(data) || data.some((link) => !isOpsWechatLink(link))) throw new OpsClientError("invalid_response");
  return data;
}

export async function registerOpsWechatLink(url: string, fetchImpl: typeof fetch = fetch): Promise<OpsWechatLink> {
  const payload = await request("/local/ops/wechat-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  }, fetchImpl);
  if (!isOpsWechatLink(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

export function opsErrorMessage(error: unknown): string {
  const code = error instanceof OpsClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    digest_unavailable: "还没有运营摘要，点击右上角“刷新数据”采集第一份。",
    invalid_url: "链接格式无效，请粘贴 https:// 开头的完整链接。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
  };
  return messages[code] ?? "请求未完成，请稍后重试。";
}

export const OPS_REFRESH_ERRORS: Record<string, string> = {
  digest_failed: "运营摘要采集失败（详见数据源健康状态）",
  digest_timeout: "运营摘要采集超时",
};
