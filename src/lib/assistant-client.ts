import { parseSolutionPlan, type SolutionPlan } from "./assistant-contract.ts";

/**
 * Client for the local-only 方案助手 endpoint (`dev/local-router.ts`). The plan is
 * generated on this machine by the Qoder CLI, so the browser waits far longer than
 * for ordinary retrieval and still validates every field it renders.
 */

export interface AssistantRequest {
  requestId: string;
  customer: string;
  industry: string;
  goal: string;
  constraints: string;
}

export interface AssistantRetrieval {
  status: "results-only" | "insufficient-evidence";
  vectorSearch: "semantic" | "keyword-only";
  resultCount: number;
  queries: string[];
}

export interface AssistantResponse {
  plan: SolutionPlan;
  retrieval: AssistantRetrieval;
}

const SAFE_ERROR_CODES = new Set([
  "invalid_json",
  "invalid_request",
  "payload_too_large",
  "unsupported_media_type",
  "method_not_allowed",
  "origin_not_allowed",
  "host_not_allowed",
  "rate_limited",
  "assistant_busy",
  "assistant_unavailable",
]);
const GENERATION_TIMEOUT_MS = 270_000;
const MAX_QUERIES = 6;
const MAX_QUERY_CHARACTERS = 200;

export class AssistantClientError extends Error {
  readonly code: string;
  readonly diagnosticId?: string;

  constructor(code: string, diagnosticId?: string) {
    super(code);
    this.name = "AssistantClientError";
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRetrieval(value: unknown): AssistantRetrieval {
  if (!isRecord(value)) {
    return { status: "insufficient-evidence", vectorSearch: "keyword-only", resultCount: 0, queries: [] };
  }
  return {
    status: value.status === "results-only" ? "results-only" : "insufficient-evidence",
    vectorSearch: value.vectorSearch === "semantic" ? "semantic" : "keyword-only",
    resultCount: typeof value.resultCount === "number" && Number.isFinite(value.resultCount)
      ? Math.max(0, Math.trunc(value.resultCount))
      : 0,
    queries: Array.isArray(value.queries)
      ? value.queries
        .filter((query): query is string => typeof query === "string")
        .slice(0, MAX_QUERIES)
        .map((query) => Array.from(query).slice(0, MAX_QUERY_CHARACTERS).join(""))
      : [],
  };
}

function endpoint(): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL("/local/assistant", origin);
}

export async function generateSolution(
  request: AssistantRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AssistantResponse> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AssistantClientError(error instanceof DOMException && error.name === "TimeoutError"
      ? "request_timeout"
      : "network_unavailable");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_CODES.has(payload.error)
      ? payload.error
      : "assistant_unavailable";
    const diagnosticId = isRecord(payload) && typeof payload.diagnosticId === "string"
      ? payload.diagnosticId
      : undefined;
    throw new AssistantClientError(code, diagnosticId);
  }

  const envelope = isRecord(payload) ? payload : undefined;
  const plan = parseSolutionPlan(envelope?.data);
  if (!plan) throw new AssistantClientError("invalid_response");
  return { plan, retrieval: parseRetrieval(envelope?.retrieval) };
}

export function assistantErrorMessage(error: unknown): string {
  if (!(error instanceof AssistantClientError)) return "方案助手暂时不可用，请稍后重试。";
  const messages: Record<string, string> = {
    network_unavailable: "本机方案服务未响应，请先运行 npm run dev:function。",
    request_timeout: "方案生成超时，本机 Qoder CLI 未在限定时间内返回，请重试。",
    assistant_busy: "上一份方案仍在生成中，请等待完成后再提交。",
    rate_limited: "方案生成请求过于频繁，请稍后再试。",
    assistant_unavailable: "方案生成失败，请稍后重试。",
    invalid_response: "本机服务返回了无法识别的方案数据，请重新生成。",
    invalid_request: "请求内容不合法，请检查客户名称与业务目标的长度。",
    invalid_json: "请求内容不合法，请重新提交。",
    payload_too_large: "输入内容过长，请精简业务目标或约束描述。",
    unsupported_media_type: "请求格式不被本机服务接受。",
    method_not_allowed: "请求方式不被本机服务接受。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
  };
  const message = messages[error.code] ?? "方案助手暂时不可用，请稍后重试。";
  return error.diagnosticId ? `${message} 诊断编号：${error.diagnosticId}` : message;
}
