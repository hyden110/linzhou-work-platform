/**
 * Notify bridge (F6) — public entry, mirroring leads-bridge.ts / report-bridge.ts:
 * implementation lives in ./notify/ and this file re-exports the public surface
 * so the router and tests can import from dev/notify-bridge.ts.
 */
export { createNotifyBridge, DEFAULT_NOTIFY_INBOX_PATH, type NotifyBridge, type NotifyBridgeOptions } from "./notify/notify-bridge.ts";
export { NotifyBridgeError, NOTIFY_KIND_LABELS, NOTIFY_KINDS } from "./notify/notify-types.ts";
export {
  cleanNotifyText,
  normalizeNotifyIncoming,
  NOTIFY_SECRET_PATTERN,
} from "./notify/notify-model.ts";
export type {
  NotifyErrorCode,
  NotifyItem,
  NotifyItemsView,
  NotifyKind,
  NotifyReadResult,
  NotifyStateView,
} from "./notify/notify-types.ts";
