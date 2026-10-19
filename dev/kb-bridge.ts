/**
 * Unified knowledge retrieval bridge (F2) — public entry.
 * Implementation lives in ./kb/*; this file re-exports the public surface so
 * the router and tests can import from `dev/kb-bridge.ts`.
 */
export { DEFAULT_KB_CONFIG_PATH, createKbBridge, rrfFuse, RRF_K, type KbBridge, type KbBridgeOptions, type RrfHit } from "./kb/kb-bridge.ts";
export { KB_ID_PATTERN } from "./kb/kb-config.ts";
export { KbBridgeError } from "./kb/kb-types.ts";
export type {
  KbConfig,
  KbDoc,
  KbHit,
  KbSearchOutcome,
  KbSource,
  KbSourceType,
  KbSourceStatus,
  KbSourceView,
  KbSpace,
  KbSummaryHit,
  KbSummaryResult,
} from "./kb/kb-types.ts";
