/**
 * Reply bridge contracts (F9) — 消息中心明细 + AI 回复建议 + 钉钉人工确认发送。
 * donor: base/sa-workbench scripts/lib/reply/{suggest,context,enrich,send,store}.js +
 * scripts/bridge.js /reply/*（搬语义不搬代码）。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * REPLY_ROUTES 常量供接线——集成方只需在 local-router 里
 * `const routed = await replyBridge.handle(request); if (routed) return routed;`
 * 即可挂载全部五条路由（405/错误映射都在子路由内闭环），沿 F8 本体桥先例。
 *
 * 错误分层：所有失败响应为 {ok:false, error:{code, message}}；code 为下方稳定错误码，
 * message 为可直接展示的中文文案（不含绝对路径、不含凭据、不含消息正文）。
 *
 * 红线（与 donor 一致，不可放宽）：
 * - 建议生成只走本机引擎（qoder/qodercli），缺失即 engine_missing 诚实失败，绝不回落云端 API；
 * - 发送仅钉钉：dws chat message send --group <openConversationId>，且 body.confirm 必须
 *   严格 === 候选 id 才执行（页面逐条人工确认的服务端闸门）；微信/未知源一律 no_channel 只许复制；
 * - 额度：每会话每日 ≤6、全局每日 ≤60（quota.json，跨进程重启生效，重启不能刷额度）；
 * - store 只存结论（建议草稿文本/语气/理由），不存消息原文上下文；发送审计只存掩码预览。
 */

import type { ReplyCandidate } from "../../src/lib/reply-model.ts";

/** 稳定错误码：路由按 code 映射 400/404/409/429/405/502/503。 */
export type ReplyErrorCode =
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

export class ReplyBridgeError extends Error {
  readonly code: ReplyErrorCode;

  constructor(code: ReplyErrorCode, message: string) {
    super(message);
    this.name = "ReplyBridgeError";
    this.code = code;
  }
}

/** 路由表（供接线）：五条路由与任务口径一一对应。 */
export const REPLY_ROUTES = [
  { method: "GET", path: "/local/reply/candidates", operation: "candidates" },
  { method: "GET", path: "/local/reply/history", operation: "history" },
  { method: "POST", path: "/local/reply/suggest", operation: "suggest" },
  { method: "POST", path: "/local/reply/send", operation: "send" },
  { method: "GET", path: "/local/reply/sends", operation: "sends" },
] as const;

export type ReplyRoute = (typeof REPLY_ROUTES)[number];

/** 额度（donor suggest.js DEF：每会话日 ≤6、全局日 ≤60）。 */
export const REPLY_QUOTA_PER_CONV_DAY = 6;
export const REPLY_QUOTA_PER_DAY = 60;
/** 建议正文上限（donor DEF.maxTextChars / send DEF.maxChars 同口径：能生成就发得出去）。 */
export const REPLY_MAX_TEXT_CHARS = 600;
/** 草稿历史上限（store.json 只留最近 200 条结论）。 */
export const REPLY_HISTORY_LIMIT = 200;
/** GET /local/reply/sends 返回的审计尾行数。 */
export const REPLY_SENDS_TAIL = 50;
/** 本机引擎超时（donor DEF.timeoutMs 120s）。 */
export const REPLY_ENGINE_TIMEOUT_MS = 120_000;
/** dws 发送超时（donor send DEF.timeoutMs 45s）。 */
export const REPLY_SEND_TIMEOUT_MS = 45_000;
/** 审计掩码预览长度（只留可核对的开头，不留全文）。 */
export const REPLY_PREVIEW_CHARS = 24;

/** 额度账本（quota.json 同形状；conv 键 = openConversationId，无 cid 时回落候选 id）。 */
export interface ReplyQuota {
  readonly day: string;
  readonly total: number;
  readonly conv: Readonly<Record<string, { readonly count: number }>>;
}

/** 额度视图（candidates/suggest 应答里的只读投影）。 */
export interface ReplyQuotaView {
  readonly day: string;
  readonly used: number;
  readonly limit: number;
  readonly perConvLimit: number;
}

/** 草稿历史行（store.json；只存结论不存输入上下文，donor store.js 口径）。 */
export interface ReplyDraftRow {
  readonly sid: string;
  readonly id: string;
  readonly convKey: string;
  readonly convTitle: string;
  readonly needReply: boolean;
  readonly text: string;
  readonly tone: string;
  readonly reason: string;
  readonly ms: number;
  readonly engine: string;
  readonly at: string;
}

/** 发送审计行（sends.jsonl；append-only，正文只落掩码预览）。 */
export interface ReplySendAudit {
  readonly at: string;
  readonly id: string;
  readonly group: string;
  readonly exitCode: number | string | null;
  readonly maskedPreview: string;
}

/** GET /local/reply/candidates 的 data。 */
export interface ReplyCandidatesView {
  readonly savedAt: string;
  readonly items: readonly ReplyCandidate[];
  readonly quota: ReplyQuotaView;
  readonly engine: { readonly available: boolean; readonly localOnly: true };
}

/** GET /local/reply/history 的 data。 */
export interface ReplyHistoryView {
  readonly rows: readonly ReplyDraftRow[];
}

/** POST /local/reply/suggest 的 data（成功）。 */
export interface ReplySuggestResult {
  readonly id: string;
  readonly needReply: boolean;
  readonly text: string;
  readonly tone: string;
  readonly reason: string;
  readonly ms: number;
  readonly engine: string;
  readonly localOnly: true;
  readonly contextProfile: boolean;
  readonly quota: ReplyQuotaView;
}

/** POST /local/reply/send 的 data（成功）。 */
export interface ReplySendResult {
  readonly id: string;
  readonly group: string;
  readonly exitCode: number;
  readonly audited: boolean;
  readonly at: string;
}

/** GET /local/reply/sends 的 data（最新在前）。 */
export interface ReplySendsView {
  readonly sends: readonly ReplySendAudit[];
  readonly total: number;
}

/** 子进程契约：execFile 数组 argv、无 shell、硬超时；stdin 供引擎 prompt（不进 argv/ps）。 */
export interface ReplyCommandResult {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed?: boolean;
}

export interface ReplyCommandOptions {
  readonly timeoutMs: number;
  readonly stdin?: string;
}

export type ReplyCommandRunner = (
  file: string,
  args: readonly string[],
  options: ReplyCommandOptions,
) => Promise<ReplyCommandResult>;

export interface ReplyBridge {
  /** GET /local/reply/candidates —— 待回复候选（notify items 纯派生 + 审计回填 replied）。 */
  readonly candidates: () => Promise<ReplyCandidatesView>;
  /** GET /local/reply/history —— 草稿历史（.local-cache/reply/store.json，只读）。 */
  readonly history: () => Promise<ReplyHistoryView>;
  /** POST /local/reply/suggest —— body {id}；失败抛 ReplyBridgeError（稳定错误码）。 */
  readonly suggest: (body: unknown) => Promise<ReplySuggestResult>;
  /** POST /local/reply/send —— body {id,text,confirm}；confirm 必须严格 === id。 */
  readonly send: (body: unknown) => Promise<ReplySendResult>;
  /** GET /local/reply/sends —— 发送审计尾 50（最新在前）。 */
  readonly sends: () => Promise<ReplySendsView>;
  /** 子路由：命中 REPLY_ROUTES 返回 Response；非 reply 路径返回 undefined（供主路由委托）。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
