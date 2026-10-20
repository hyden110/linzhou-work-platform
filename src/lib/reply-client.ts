/**
 * Browser client for reply center (F9) — 消息中心明细 + AI 回复建议 + 钉钉人工确认发送。
 * GET /local/reply/{candidates,history,sends}、POST /local/reply/{suggest,send}。
 *
 * 口径（与 dev/reply/reply-types.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃、坏形状整包 invalid_response，绝不半真半假；
 * - 错误分层：{error:{code,message}} → ReplyClientError(code, detail)，
 *   replyErrorMessage 给可直接展示的中文诚实文案（engine_missing / quota_exceeded /
 *   no_channel 三态绝不粉饰：缺引擎就说缺引擎，不暗示"稍后自动重试云端"）；
 * - 超时分层：普通 GET 15s；suggest 130s（桥侧引擎硬超时 120s）；send 60s（dws 45s）——
 *   客户端超时必须比桥侧长，否则桥还在干活客户端先断，用户会重复点；
 * - send 必须带 confirm（桥侧要求 confirm === id 才执行 dws），confirm 由发送弹窗铸造。
 */

import { composeErrorMessage } from "./error-message.ts";
import type { ReplyCandidate } from "./reply-model.ts";

const REPLY_GET_TIMEOUT_MS = 15_000;
const REPLY_SUGGEST_TIMEOUT_MS = 130_000;
const REPLY_SEND_TIMEOUT_MS = 60_000;

/** 客户端本地错误码 + 桥侧稳定错误码全集（reply-types.ts ReplyErrorCode）。 */
export type ReplyClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "reply_invalid_request"
  | "reply_not_found"
  | "engine_missing"
  | "engine_error"
  | "quota_exceeded"
  | "confirm_mismatch"
  | "no_channel"
  | "no_group"
  | "no_text"
  | "too_long"
  | "dws_missing"
  | "send_failed"
  | "reply_unavailable"
  | "method_not_allowed";

const KNOWN_CODES: ReadonlySet<string> = new Set<ReplyClientErrorCode>([
  "unavailable", "invalid_response", "reply_invalid_request", "reply_not_found",
  "engine_missing", "engine_error", "quota_exceeded", "confirm_mismatch",
  "no_channel", "no_group", "no_text", "too_long", "dws_missing", "send_failed",
  "reply_unavailable", "method_not_allowed",
]);

export class ReplyClientError extends Error {
  readonly code: ReplyClientErrorCode;
  readonly detail: string;

  constructor(code: ReplyClientErrorCode, detail = "") {
    super(code);
    this.name = "ReplyClientError";
    this.code = code;
    this.detail = detail;
  }
}

/** 额度视图（candidates/suggest 应答携带；used=今日全局已用）。 */
export interface ReplyQuotaView {
  readonly day: string;
  readonly used: number;
  readonly limit: number;
  readonly perConvLimit: number;
}

/** GET /local/reply/candidates 的投影。 */
export interface ReplyCandidatesSnapshot {
  readonly savedAt: string;
  readonly items: readonly ReplyCandidate[];
  readonly quota: ReplyQuotaView;
  readonly engine: { readonly available: boolean; readonly localOnly: boolean };
}

/** 草稿历史行（只存结论不存消息原文）。 */
export interface ReplyDraftRow {
  readonly sid: string;
  readonly id: string;
  readonly convTitle: string;
  readonly needReply: boolean;
  readonly text: string;
  readonly tone: string;
  readonly reason: string;
  readonly ms: number;
  readonly engine: string;
  readonly at: string;
}

/** 发送审计行（正文只落掩码预览）。 */
export interface ReplySendAudit {
  readonly at: string;
  readonly id: string;
  readonly group: string;
  readonly exitCode: number | string | null;
  readonly maskedPreview: string;
}

/** POST /local/reply/suggest 成功结果。 */
export interface ReplySuggestOutcome {
  readonly id: string;
  readonly needReply: boolean;
  readonly text: string;
  readonly tone: string;
  readonly reason: string;
  readonly ms: number;
  readonly engine: string;
  readonly contextProfile: boolean;
  readonly quota: ReplyQuotaView;
}

/** POST /local/reply/send 成功结果。 */
export interface ReplySendOutcome {
  readonly id: string;
  readonly group: string;
  readonly exitCode: number;
  readonly audited: boolean;
  readonly at: string;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asQuotaView(value: unknown): ReplyQuotaView {
  const record = isRecord(value) ? value : {};
  return {
    day: asText(record.day),
    used: asNumber(record.used),
    limit: asNumber(record.limit, 60),
    perConvLimit: asNumber(record.perConvLimit, 6),
  };
}

function asCandidate(value: unknown): ReplyCandidate | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  const channel = value.channel;
  return {
    id: asText(value.id),
    title: asText(value.title),
    createdAt: asText(value.createdAt),
    read: value.read === true,
    channel: channel === "dingtalk" || channel === "wechat" ? channel : "",
    group: asText(value.group),
    replied: value.replied === true,
  };
}

function asDraftRow(value: unknown): ReplyDraftRow | null {
  if (!isRecord(value) || !asText(value.sid)) return null;
  return {
    sid: asText(value.sid),
    id: asText(value.id),
    convTitle: asText(value.convTitle),
    needReply: value.needReply === true,
    text: asText(value.text),
    tone: asText(value.tone),
    reason: asText(value.reason),
    ms: asNumber(value.ms),
    engine: asText(value.engine),
    at: asText(value.at),
  };
}

function asSendAudit(value: unknown): ReplySendAudit | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  const code = value.exitCode;
  return {
    at: asText(value.at),
    id: asText(value.id),
    group: asText(value.group),
    exitCode: typeof code === "number" || typeof code === "string" || code === null ? code : null,
    maskedPreview: asText(value.maskedPreview),
  };
}

/* ---------------- 请求（超时分层；错误 {code,message} 如实上抛） ---------------- */

function replyUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  timeoutMs: number,
  method: "GET" | "POST",
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(replyUrl(path), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch {
    throw new ReplyClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new ReplyClientError(error.code as ReplyClientErrorCode, asText(error.message));
    }
    throw new ReplyClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new ReplyClientError("invalid_response");
  return payload.data;
}

/** GET /local/reply/candidates —— 待回复候选（钉钉源、未读或未回复）+ 额度 + 引擎可用性。 */
export async function fetchReplyCandidates(fetchImpl: typeof fetch = fetch): Promise<ReplyCandidatesSnapshot> {
  const data = await requestJson("/local/reply/candidates", REPLY_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  if (!Array.isArray(data.items)) throw new ReplyClientError("invalid_response");
  const engine = isRecord(data.engine) ? data.engine : {};
  return {
    savedAt: asText(data.savedAt),
    items: data.items.map(asCandidate).filter((row): row is ReplyCandidate => row !== null),
    quota: asQuotaView(data.quota),
    engine: { available: engine.available === true, localOnly: engine.localOnly !== false },
  };
}

/** GET /local/reply/history —— 草稿历史（最近 200 条结论，最新在前）。 */
export async function fetchReplyHistory(fetchImpl: typeof fetch = fetch): Promise<readonly ReplyDraftRow[]> {
  const data = await requestJson("/local/reply/history", REPLY_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  if (!Array.isArray(data.rows)) throw new ReplyClientError("invalid_response");
  return data.rows.map(asDraftRow).filter((row): row is ReplyDraftRow => row !== null);
}

/** GET /local/reply/sends —— 发送审计尾 50（最新在前）+ 总数。 */
export async function fetchReplySends(
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly sends: readonly ReplySendAudit[]; readonly total: number }> {
  const data = await requestJson("/local/reply/sends", REPLY_GET_TIMEOUT_MS, "GET", undefined, fetchImpl);
  if (!Array.isArray(data.sends)) throw new ReplyClientError("invalid_response");
  return {
    sends: data.sends.map(asSendAudit).filter((row): row is ReplySendAudit => row !== null),
    total: asNumber(data.total),
  };
}

/** POST /local/reply/suggest —— body {id}；只走本机引擎，缺失即 engine_missing（不回落云端）。 */
export async function suggestReply(id: string, fetchImpl: typeof fetch = fetch): Promise<ReplySuggestOutcome> {
  const data = await requestJson("/local/reply/suggest", REPLY_SUGGEST_TIMEOUT_MS, "POST", { id }, fetchImpl);
  if (!asText(data.id)) throw new ReplyClientError("invalid_response");
  return {
    id: asText(data.id),
    needReply: data.needReply === true,
    text: asText(data.text),
    tone: asText(data.tone),
    reason: asText(data.reason),
    ms: asNumber(data.ms),
    engine: asText(data.engine),
    contextProfile: data.contextProfile === true,
    quota: asQuotaView(data.quota),
  };
}

/**
 * POST /local/reply/send —— body {id,text,confirm}；桥侧要求 confirm 严格 === id 才执行 dws。
 * confirm 必须由发送弹窗在人工确认后铸造（逐条确认，绝不批量代确认）。
 */
export async function sendReply(
  input: { readonly id: string; readonly text: string; readonly confirm: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ReplySendOutcome> {
  const data = await requestJson(
    "/local/reply/send",
    REPLY_SEND_TIMEOUT_MS,
    "POST",
    { id: input.id, text: input.text, confirm: input.confirm },
    fetchImpl,
  );
  if (!asText(data.id)) throw new ReplyClientError("invalid_response");
  return {
    id: asText(data.id),
    group: asText(data.group),
    exitCode: asNumber(data.exitCode),
    audited: data.audited === true,
    at: asText(data.at),
  };
}

/** 错误码 → 可直接展示的中文诚实文案（三态重点：缺引擎/超额度/无通道都不粉饰）。 */
export function replyErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行桥服务后重试。",
    invalid_response: "本机服务返回了无法识别的回复中心数据。",
    reply_invalid_request: "请求参数不合法：请刷新页面后重试。",
    reply_not_found: "候选不存在或已过期：请刷新收件箱后重试。",
    engine_missing: "本机未检测到 AI 引擎（qoder/qodercli）：回复建议只走本机引擎，绝不回落云端 API。请安装后重试。",
    engine_error: "本机引擎生成失败或超时：未产生建议，可稍后重试或手动撰写正文。",
    quota_exceeded: "今日建议生成额度已用完（每会话 6 条 / 全局 60 条）：请手动撰写回复，明日自动恢复。",
    confirm_mismatch: "人工确认未完成：本次没有发送任何消息。请在弹窗中逐条确认后重试。",
    no_channel: "该消息来源没有自动发送通道（当前仅钉钉可发）：请使用一键复制，在对应客户端由人发送。",
    no_group: "未能解析钉钉会话 id（openConversationId）：本次不发送，请使用一键复制人工发送。",
    no_text: "没有可发送的正文：请先生成建议或在草稿编辑框输入内容。",
    too_long: "正文超过 600 字上限：不会截断发送，请删减后重试。",
    dws_missing: "未找到 dws CLI：本次未发送。请安装 dws 并完成 dws auth login 后重试。",
    send_failed: "钉钉发送失败：请到钉钉核对该消息是否已发出，勿盲目重发。",
    reply_unavailable: "回复服务暂时不可用：请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  const code = error instanceof ReplyClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof ReplyClientError ? error.detail : "");
}
