import type { OpsCard, OpsDigest, OpsPushPreview, OpsRefreshStatus, OpsWechatLink } from "./ops-types";

const SAFE_ERRORS = new Set([
  "digest_unavailable",
  "invalid_url",
  "invalid_request",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "preview_required",
  "preview_stale",
  "push_disabled",
  "recipient_not_configured",
  "push_failed",
  "push_uncertain",
  "push_in_progress",
  "preview_consumed",
]);

/** 单次批量登记上限：每条一次本机 POST，留足余量避开本机 60 次/分钟限流。 */
export const OPS_WECHAT_BATCH_MAX = 50;

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

function isOpsPushPreview(value: unknown): value is OpsPushPreview {
  return isRecord(value)
    && (value.mode === "dry_run" || value.mode === "sent")
    && typeof value.previewId === "string"
    && typeof value.cardText === "string";
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

/** dry-run：只生成预览与 previewId，绝不发送（后端保证不调用 dws）。 */
export async function previewOpsPush(fetchImpl: typeof fetch = fetch): Promise<OpsPushPreview> {
  const payload = await request("/local/ops/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun: true }),
  }, fetchImpl);
  if (!isOpsPushPreview(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

/** 真发：必须携带最近一次 dry-run 的 previewId；逐次确认，前端不记住确认状态。 */
export async function sendOpsPush(previewId: string, fetchImpl: typeof fetch = fetch): Promise<OpsPushPreview> {
  const payload = await request("/local/ops/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, previewId }),
  }, fetchImpl);
  if (!isOpsPushPreview(payload.data)) throw new OpsClientError("invalid_response");
  return payload.data;
}

/** 批量登记结果：逐条记录成败，单条失败不影响其他条。 */
export interface WechatBatchEntry {
  readonly url: string;
  readonly link: OpsWechatLink | null;
  readonly error: string | null;
}

/**
 * 逐个登记（串行、本地端点），永不新增外部请求面；调用方需先经 splitWechatLinks 清洗。
 * 超过 OPS_WECHAT_BATCH_MAX 条整批拒绝（batch_too_large），不发出任何请求。
 */
export async function registerOpsWechatLinks(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<readonly WechatBatchEntry[]> {
  if (urls.length > OPS_WECHAT_BATCH_MAX) throw new OpsClientError("batch_too_large");
  const entries: WechatBatchEntry[] = [];
  for (const url of urls) {
    try {
      entries.push({ url, link: await registerOpsWechatLink(url, fetchImpl), error: null });
    } catch (caught) {
      entries.push({ url, link: null, error: opsErrorMessage(caught) });
    }
  }
  return entries;
}

export function opsErrorMessage(error: unknown): string {
  const code = error instanceof OpsClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    digest_unavailable: "还没有运营摘要，点击右上角“刷新数据”采集第一份。",
    invalid_url: "链接格式无效，请粘贴 https:// 开头的完整链接。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
    preview_required: "缺少确认参数：请先生成预览，再携带 confirm 与 previewId 发送。",
    preview_stale: "预览已过期（内容已变化或已发送过），请重新生成预览后再确认。",
    push_disabled: "推送总开关未开启（OPS_DINGTALK_PUSH_ENABLED）。",
    recipient_not_configured: "未配置接收人（OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID，仅本人单聊）。",
    push_failed: "推送命令执行失败，请检查 dws 登录态后重新预览再试。",
    push_uncertain: "推送超时，结果未知（消息可能已送达）。为防重复发送，本次运行内同一内容不会再发；请先到钉钉核对，确未收到可重启本机服务后重新预览发送。",
    push_in_progress: "已有一次推送正在发送中，请等待其完成，不要重复确认。",
    preview_consumed: "该预览已被确认发送过，请重新生成预览后再确认。",
    batch_too_large: `单次最多登记 ${OPS_WECHAT_BATCH_MAX} 条链接，请分批提交。`,
  };
  return messages[code] ?? "请求未完成，请稍后重试。";
}

export const OPS_REFRESH_ERRORS: Record<string, string> = {
  digest_failed: "运营摘要采集失败（详见数据源健康状态）",
  digest_timeout: "运营摘要采集超时",
};

/** 预览已作废（内容变化/已发送/已消费）时，前端须丢弃本地旧预览并要求重新生成。 */
export function shouldDiscardPushPreview(error: unknown): boolean {
  return error instanceof OpsClientError
    && (error.code === "preview_stale" || error.code === "preview_consumed" || error.code === "push_uncertain");
}
