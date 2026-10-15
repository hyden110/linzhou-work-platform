import type { LocalRuntimeStatus, YunqiHighlights } from "../types";

/**
 * Client for the local-only endpoints served by `dev/function-local-node.ts`.
 * These routes exist only while the workbench runs on this machine; a published
 * deployment has no local runtime and every call degrades to `available: false`.
 * The browser only ever sends opaque document ids — never a path.
 */

const SAFE_ERROR_CODES = new Set([
  "host_not_allowed",
  "origin_not_allowed",
  "rate_limited",
  "method_not_allowed",
  "invalid_request",
  "not_found",
  "preview_unsupported",
  "preview_unavailable",
  "open_failed",
  "highlights_unavailable",
]);

const OFFLINE_STATUS: LocalRuntimeStatus = { available: false, open: false, preview: false };

export class LocalClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "LocalClientError";
    this.code = code;
  }
}

export interface OpenedDocument {
  id: string;
  extension: string;
  bytes: number;
  preview: boolean;
}

export type PreviewKind = "pdf" | "text";

export interface LocalPreview {
  kind: PreviewKind;
  text?: string;
  url?: string;
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

async function readError(response: Response): Promise<LocalClientError> {
  const payload: unknown = await response.json().catch(() => undefined);
  const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_CODES.has(payload.error)
    ? payload.error
    : "unavailable";
  return new LocalClientError(code);
}

export async function fetchLocalStatus(fetchImpl: typeof fetch = fetch): Promise<LocalRuntimeStatus> {
  try {
    const response = await fetchImpl(localUrl("/local/status"), { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return OFFLINE_STATUS;
    const payload: unknown = await response.json();
    const data = isRecord(payload) ? payload.data : undefined;
    if (!isRecord(data) || data.localRuntime !== true) return OFFLINE_STATUS;
    return { available: true, open: data.open === true, preview: data.preview === true };
  } catch {
    return OFFLINE_STATUS;
  }
}

function isYunqiHighlights(value: unknown): value is YunqiHighlights {
  if (!isRecord(value)) return false;
  return value.mode === "local-content-highlights"
    && Array.isArray(value.layers)
    && Array.isArray(value.trends)
    && Array.isArray(value.forums)
    && isRecord(value.thesis)
    && isRecord(value.stats);
}

export async function fetchYunqiHighlights(fetchImpl: typeof fetch = fetch): Promise<YunqiHighlights> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/highlights"), { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new LocalClientError("unavailable");
  }
  if (!response.ok) throw await readError(response);
  const payload: unknown = await response.json().catch(() => undefined);
  const data = isRecord(payload) ? payload.data : undefined;
  if (!isYunqiHighlights(data)) throw new LocalClientError("invalid_response");
  return data;
}

function isOpenedDocument(value: unknown): value is OpenedDocument {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.extension === "string" && typeof value.bytes === "number";
}

export async function openLocalDocument(id: string, fetchImpl: typeof fetch = fetch): Promise<OpenedDocument> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/open"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LocalClientError("unavailable");
  }
  if (!response.ok) throw await readError(response);
  const payload: unknown = await response.json().catch(() => undefined);
  const data = isRecord(payload) ? payload.data : undefined;
  if (!isOpenedDocument(data)) throw new LocalClientError("invalid_response");
  return data;
}

export async function fetchLocalPreview(id: string, fetchImpl: typeof fetch = fetch): Promise<LocalPreview> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/preview", { id }), { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new LocalClientError("unavailable");
  }
  if (!response.ok) throw await readError(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/")) {
    return { kind: "text", text: await response.text() };
  }
  return { kind: "pdf", url: URL.createObjectURL(await response.blob()) };
}

export function localErrorMessage(error: unknown): string {
  if (!(error instanceof LocalClientError)) return "本机服务未响应，请确认已启动 npm run dev:function。";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    not_found: "本机索引里没有这份资料，请先运行一次同步。",
    preview_unsupported: "该格式无法在浏览器内预览，请用本机应用打开。",
    preview_unavailable: "预览读取失败，文件可能已被移动或过大。",
    open_failed: "调用系统打开失败，请确认本机默认应用可用。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    rate_limited: "本机打开请求过于频繁，请稍后再试。",
    highlights_unavailable: "云栖重点内容尚未生成，请运行 sync/yunqi_highlights.py。",
    invalid_response: "本机服务返回了无法识别的数据。",
    invalid_request: "请求参数无效。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  return messages[error.code] ?? "本机服务暂时不可用。";
}
