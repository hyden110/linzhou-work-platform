/**
 * Reply bridge (F9) — public entry, mirroring report-bridge.ts / notify-bridge.ts:
 * implementation lives in ./reply/ and this file re-exports the public surface
 * so the router and tests can import from dev/reply-bridge.ts.
 */
export { createReplyBridge, type ReplyBridgeOptions } from "./reply/reply-bridge.ts";
export { ReplyBridgeError, REPLY_ROUTES } from "./reply/reply-types.ts";
export {
  REPLY_ENGINE_TIMEOUT_MS,
  REPLY_HISTORY_LIMIT,
  REPLY_MAX_TEXT_CHARS,
  REPLY_PREVIEW_CHARS,
  REPLY_QUOTA_PER_CONV_DAY,
  REPLY_QUOTA_PER_DAY,
  REPLY_SENDS_TAIL,
  REPLY_SEND_TIMEOUT_MS,
} from "./reply/reply-types.ts";
export type {
  ReplyBridge,
  ReplyCandidatesView,
  ReplyCommandOptions,
  ReplyCommandResult,
  ReplyCommandRunner,
  ReplyDraftRow,
  ReplyErrorCode,
  ReplyHistoryView,
  ReplyQuota,
  ReplyQuotaView,
  ReplyRoute,
  ReplySendAudit,
  ReplySendResult,
  ReplySendsView,
  ReplySuggestResult,
} from "./reply/reply-types.ts";
export { beijingDayKey, createReplyStore, DEFAULT_REPLY_DIR, type ReplyStore } from "./reply/reply-store.ts";
export {
  buildSuggestPrompt,
  createDefaultEngineRunner,
  matchCustomerProfile,
  parseEngineJson,
  resolveEngineBin,
  shapeSuggestion,
  REPLY_ENGINE_ARGS,
  REPLY_TONES,
  type CrmProfileLine,
} from "./reply/reply-engine.ts";
