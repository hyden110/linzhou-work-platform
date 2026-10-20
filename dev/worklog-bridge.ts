/**
 * Worklog bridge — public entry, mirroring reply-bridge.ts / report-bridge.ts:
 * implementation lives in ./worklog/ and this file re-exports the public surface
 * so the router and tests can import from dev/worklog-bridge.ts.
 */
export { createWorklogBridge, DEFAULT_APP_SUPPORT_DIR, type WorklogBridgeOptions } from "./worklog/worklog-bridge.ts";
export {
  WorklogBridgeError,
  WORKLOG_MAX_ENTRIES,
  WORKLOG_ROUTES,
  type WorklogBridge,
  type WorklogErrorCode,
  type WorklogListView,
  type WorklogOverallStatus,
  type WorklogRangeView,
  type WorklogRoute,
  type WorklogSourceView,
  type WorklogSummaryView,
} from "./worklog/worklog-types.ts";
export {
  assertWithinRoot,
  clipWorklogTitle,
  createNodeSqliteOpener,
  defaultWorklogSources,
  scanWorklogSource,
  sessionsFromChats,
  sessionsFromLocalHistory,
  SOURCE_MISSING_NOTE,
  WORKLOG_TITLE_MAX,
  type CollectedSession,
  type ScanDeps,
  type SessionRange,
  type SourceScanResult,
  type SourceScanStatus,
  type SqliteOpener,
  type SqliteReader,
  type WorklogSource,
} from "./worklog/worklog-collector.ts";
export {
  buildListView,
  buildSummaryView,
  entriesOf,
  MISSING_NOTE,
  overallStatusOf,
  rankEntries,
  sourceViewOf,
  type ViewParts,
} from "./worklog/worklog-classifier.ts";
