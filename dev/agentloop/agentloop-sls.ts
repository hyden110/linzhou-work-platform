/**
 * AgentLoop SLS client — 零依赖经典签名客户端（donor scripts/lib/sls.js 语义）。
 * 只实现两个调用：listLogstores（只读探活）、createTicket（外部写，仅 confirm 闸门后）。
 * 网络经 SlsFetch 注入点：测试 stub 绝不真联网；缺省真 fetch + AbortSignal 硬超时 + 有界读取。
 * creds 由桥内部瞬时传入：本模块不落盘、不打印、不进错误消息。
 */

import { buildResource, buildStringToSign, sanitizeUpstreamDetail, signHmacSha1 } from "./agentloop-model.ts";
import {
  AGENTLOOP_API_VERSION,
  AGENTLOOP_MAX_UPSTREAM_BYTES,
  AGENTLOOP_SIGNATURE_METHOD,
  AGENTLOOP_TICKET_HOST,
  type AgentloopCreds,
  type SlsFetch,
  type SlsFetchInit,
  type SlsFetchResponse,
} from "./agentloop-types.ts";

/** 上游错误归类（donor errFrom：401/403 → auth，404 → notfound，其余 error，网络层 network）。 */
export type SlsErrorCode = "auth" | "notfound" | "error" | "network";

export class SlsRequestError extends Error {
  readonly code: SlsErrorCode;
  readonly status: number | null;

  constructor(code: SlsErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SlsRequestError";
    this.code = code;
    this.status = status;
  }
}

/** 缺省真 fetch：硬超时 + 响应体有界读取（超限截断），凭据只进 headers。 */
export async function defaultSlsFetch(url: string, init: SlsFetchInit): Promise<SlsFetchResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body || undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    const reason = (error as Error)?.name === "TimeoutError" ? "超时" : String((error as Error)?.message ?? error);
    throw new SlsRequestError("network", `SLS 请求失败：${sanitizeUpstreamDetail(reason, 120)}`);
  }
  /* 有界输出：只读前 AGENTLOOP_MAX_UPSTREAM_BYTES，防敌意/异常上游撑爆内存。 */
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, bodyText: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.byteLength;
      if (size >= AGENTLOOP_MAX_UPSTREAM_BYTES) break;
    }
  }
  await reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(size, AGENTLOOP_MAX_UPSTREAM_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.byteLength - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { status: response.status, bodyText: new TextDecoder().decode(merged) };
}

/** 上游错误体解析（donor errFrom 语义：errorCode + errorMessage 都如实带上，非 JSON 用 HTTP 状态兜底）。 */
function errorFromStatus(status: number, bodyText: string): SlsRequestError {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(bodyText);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  const parts = parsed
    ? [parsed.errorCode, parsed.errorMessage].filter((part): part is string => typeof part === "string" && part.length > 0)
    : [];
  const rawMessage = parts.length > 0 ? parts.join("：") : `HTTP ${status}`;
  const code: SlsErrorCode = status === 401 || status === 403 ? "auth" : status === 404 ? "notfound" : "error";
  return new SlsRequestError(code, sanitizeUpstreamDetail(rawMessage), status);
}

function signedHeaders(input: {
  readonly method: string;
  readonly host: string;
  readonly resource: string;
  readonly dateGmt: string;
  readonly creds: Pick<AgentloopCreds, "ak" | "sk">;
}): Record<string, string> {
  const stringToSign = buildStringToSign({ method: input.method, date: input.dateGmt, resource: input.resource });
  const signature = signHmacSha1(stringToSign, input.creds.sk);
  return {
    Authorization: `SLS ${input.creds.ak}:${signature}`,
    Date: input.dateGmt,
    Host: input.host,
    "x-log-apiversion": AGENTLOOP_API_VERSION,
    "x-log-signaturemethod": AGENTLOOP_SIGNATURE_METHOD,
  };
}

export interface SlsClient {
  /** GET {project}.{region}.log.aliyuncs.com/logstores —— 只读，返回 logstore 名列表。 */
  readonly listLogstores: (
    project: string,
    region: string,
    creds: Pick<AgentloopCreds, "ak" | "sk">,
    timeoutMs: number,
    dateGmt: string,
  ) => Promise<readonly string[]>;
  /** POST cn-shanghai.log.aliyuncs.com/tickets?expirationTime=ttl —— 外部写出票。 */
  readonly createTicket: (
    creds: Pick<AgentloopCreds, "ak" | "sk">,
    ttlSec: number,
    timeoutMs: number,
    dateGmt: string,
  ) => Promise<{ readonly ticket: string; readonly ttl: number }>;
}

export function createSlsClient(slsFetch: SlsFetch = defaultSlsFetch): SlsClient {
  async function listLogstores(
    project: string,
    region: string,
    creds: Pick<AgentloopCreds, "ak" | "sk">,
    timeoutMs: number,
    dateGmt: string,
  ): Promise<readonly string[]> {
    const host = `${project}.${region}.log.aliyuncs.com`;
    const resource = buildResource("/logstores");
    const response = await slsFetch(`https://${host}${resource}`, {
      method: "GET",
      headers: signedHeaders({ method: "GET", host, resource, dateGmt, creds }),
      timeoutMs,
    });
    if (response.status !== 200) throw errorFromStatus(response.status, response.bodyText);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      /* 空体按无列表处理 */
    }
    const stores = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).logstores
      : null;
    if (!Array.isArray(stores)) return [];
    return stores.filter((name): name is string => typeof name === "string").slice(0, 500);
  }

  async function createTicket(
    creds: Pick<AgentloopCreds, "ak" | "sk">,
    ttlSec: number,
    timeoutMs: number,
    dateGmt: string,
  ): Promise<{ readonly ticket: string; readonly ttl: number }> {
    /* donor 口径：TTL 收敛到 [60, 2592000]，出票端点固定上海。 */
    const ttl = Math.max(60, Math.min(2_592_000, Math.round(Number(ttlSec) || 86_400)));
    const resource = buildResource("/tickets", { expirationTime: ttl });
    const response = await slsFetch(`https://${AGENTLOOP_TICKET_HOST}${resource}`, {
      method: "POST",
      headers: signedHeaders({ method: "POST", host: AGENTLOOP_TICKET_HOST, resource, dateGmt, creds }),
      timeoutMs,
    });
    if (response.status !== 200) throw errorFromStatus(response.status, response.bodyText);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      /* 非 JSON 应答按缺 ticket 处理 */
    }
    const ticket = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).ticket
      : null;
    if (typeof ticket !== "string" || !ticket) {
      throw new SlsRequestError("error", "出票响应缺少 ticket", response.status);
    }
    return { ticket, ttl };
  }

  return { listLogstores, createTicket };
}
