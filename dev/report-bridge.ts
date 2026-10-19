/**
 * Report bridge (F6) — public entry, mirroring leads-bridge.ts / health-bridge.ts:
 * implementation lives in ./report/ and this file re-exports the public surface
 * so the router and tests can import from dev/report-bridge.ts.
 */
export {
  MD_MAX,
  beijingDate,
  beijingWeekday,
  createReportBridge,
  parseAutomationDetail,
  type ReportBridge,
  type ReportBridgeOptions,
} from "./report/report-bridge.ts";
export { ReportBridgeError } from "./report/report-types.ts";
export type {
  ReportAutomationJob,
  ReportAutomations,
  ReportConfig,
  ReportDwsStatus,
  ReportErrorCode,
  ReportFieldIds,
  ReportRemoteConfig,
  ReportRemoteJob,
  ReportRemoteJobKey,
  ReportState,
  ReportSubmitted,
  ReportTodayRecord,
  ReportWeeklyConfig,
  ReportWeeklyDoc,
  ReportWeeklyItem,
  ReportWeeklies,
} from "./report/report-types.ts";
