/**
 * Published-cases ledger bridge (F3) — public entry.
 * Implementation lives in ./cases/*; this file re-exports the public surface so
 * the router and tests can import from `dev/cases-bridge.ts` (same layout as
 * the kb bridge).
 */
export { MAX_CASES, createCasesBridge, type CasesBridge, type CasesBridgeOptions } from "./cases/cases-bridge.ts";
export { DEFAULT_CASES_CONFIG_PATH, sanitizeCasesConfig } from "./cases/cases-config.ts";
export { caseKey, fileTitle, globMatch, mergeRawCases } from "./cases/cases-model.ts";
export { parseOssLs } from "./cases/cases-oss.ts";
export type {
  CasesChannelId,
  CasesChannelState,
  CasesChannelStatus,
  CasesConfig,
  CasesOssSpec,
  CasesRepoSpec,
  CasesSnapshot,
  PublishedCase,
  RawCase,
} from "./cases/cases-types.ts";
