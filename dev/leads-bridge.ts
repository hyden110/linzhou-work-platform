/**
 * Leads radar bridge (F5) — public entry, mirroring health-bridge.ts /
 * cases-bridge.ts: implementation lives in ./leads/ and this file re-exports
 * the public surface so the router and tests can import from dev/leads-bridge.ts.
 */
export { createLeadsBridge, type LeadsBridge, type LeadsBridgeOptions } from "./leads/leads-bridge.ts";
export { LeadsSyncError } from "./leads/leads-types.ts";
export type {
  LeadNews,
  LeadRow,
  LeadTier,
  LeadsConfig,
  LeadsRefreshResult,
  LeadsRefreshSummary,
  LeadsSnapshot,
  LeadsSyncErrorCode,
} from "./leads/leads-types.ts";
