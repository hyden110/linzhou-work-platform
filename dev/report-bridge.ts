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

/* ---- F6-P1 写能力（日报回写：草稿保存 / 提交）----
 * local-router.ts 属禁改文件，写路由由本桥自带 handle(request) 子路由闭环；
 * 集成方接线（沿 reply 桥先例）：
 *   import 行：import { createReportWriteBridge, REPORT_WRITE_ROUTES } from "./report-bridge.ts";
 *   handle 链行：在既有 delegated 链里加 `?? await reportWriteBridge.handle(request)`。 */
export { createReportWriteBridge, type ReportWriteBridgeOptions } from "./report/report-write.ts";
export {
  DRY_TOKEN_TTL_MS,
  REPORT_MAX_TEXT,
  REPORT_WRITE_ROUTES,
  REPORT_WRITABLE_FIELDS,
  ReportWriteBridgeError,
  SUBMIT_COOLDOWN_MS,
  WRITES_TAIL,
} from "./report/report-write-types.ts";
export type {
  ReportSaveConfirmResult,
  ReportSaveDiffItem,
  ReportSaveDryResult,
  ReportSubmitChannel,
  ReportSubmitConfirmResult,
  ReportSubmitDryResult,
  ReportSubmittedInfo,
  ReportWritableField,
  ReportWriteAudit,
  ReportWriteBridge,
  ReportWriteErrorCode,
  ReportWriteRoute,
  ReportWritesView,
} from "./report/report-write-types.ts";
export {
  createReportWriteStore,
  DEFAULT_REPORT_WRITE_DIR,
  maskWritePreview,
  projectWriteAudit,
  type ReportWriteStore,
} from "./report/report-write-store.ts";
