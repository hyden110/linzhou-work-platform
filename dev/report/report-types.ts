/**
 * Contracts for the report bridge (F6) — 日周报只读桥（当日 AI 表格草稿 + OA outbox
 * 提交状态 + ECS QoderWake 定时任务状态 + 双周报目录/正文）。
 * Semantics ported from base/sa-workbench scripts/lib/report/index.js（搬语义不搬代码）。
 *
 * F6-P0 只读红线：
 * - 仅 4 条 dws 只读命令（aitable record query / report outbox list / drive list / doc read）
 *   与 1 条 SSH 只读探测（automation detail）；绝不实现 save/draft/send/weekly-save/
 *   weekly-send/ppl-ai/ppl-refresh，绝不跑 record update / chat +dm / record create。
 * - 编辑 / 发送能力在 UI 上明确标注「待授权，本台未开通」，不提供按钮假象。
 */

/** 稳定错误码：路由按 code 映射 400/502，message 已过 redact。 */
export type ReportErrorCode =
  | "report_unconfigured"
  | "report_unavailable"
  | "report_upstream";

/**
 * report_unconfigured 也覆盖「请求参数/白名单拒绝」类 400（对齐静态版 errCode：
 * config → 400 的口径，例如 node 不在双周报目录白名单）。
 */
export class ReportBridgeError extends Error {
  readonly code: ReportErrorCode;

  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = "ReportBridgeError";
    this.code = code;
  }
}

/** dws 层失败细分（照静态版分类），随 report_upstream 的 detail 透出供页面给修复指引。 */
export type DwsFailureKind = "need_auth" | "no_enterprise" | "dws-error";

/** 8 个只读字段的 AI 表格字段 ID 映射（照静态版 READ_FIELDS）。 */
export interface ReportFieldIds {
  readonly topic: string;
  readonly dept: string;
  readonly workStatus: string;
  readonly date: string;
  readonly followup: string;
  readonly opportunity: string;
  readonly risk: string;
  readonly other: string;
}

/** 日报段配置（baseId/tableId/字段映射 + 可选 OA 模板名）。 */
export interface ReportDailyConfig {
  readonly baseId: string;
  readonly tableId: string;
  readonly fields: ReportFieldIds;
  readonly templateName: string;
}

/** 双周报段配置（钉钉文档空间「双周报」文件夹）。 */
export interface ReportWeeklyConfig {
  readonly folderId: string;
  readonly workspaceId: string;
}

export type ReportRemoteJobKey = "draft" | "submit" | "weekly";

/** ECS QoderWake 定时任务（只读状态展示；本批绝不触发 run-now）。 */
export interface ReportRemoteJob {
  readonly key: ReportRemoteJobKey;
  readonly trigger: string;
  readonly name: string;
}

/** SSH 远端段配置（host/key/bin/wakerId 均过静态版同款正则后才进入命令模板）。 */
export interface ReportRemoteConfig {
  readonly host: string;
  readonly key: string;
  readonly bin: string;
  readonly wakerId: string;
  readonly timeoutMs: number;
  readonly jobs: readonly ReportRemoteJob[];
}

/** 三段各自独立校验的配置：缺哪段就 null + 如实 note，绝不造数据。 */
export interface ReportConfig {
  readonly daily: ReportDailyConfig | null;
  readonly dailyNote: string;
  readonly weekly: ReportWeeklyConfig | null;
  readonly weeklyNote: string;
  readonly remote: ReportRemoteConfig | null;
  readonly remoteNote: string;
}

/** 当日记录视图（照静态版 recordView：cellText 归一后的 7 个业务字段 + 修改时间）。 */
export interface ReportTodayRecord {
  readonly recordId: string;
  readonly topic: string;
  readonly dept: string;
  readonly workStatus: string;
  readonly followup: string;
  readonly opportunity: string;
  readonly risk: string;
  readonly other: string;
  readonly modifiedAt: string;
}

/** outbox 今日提交状态（照静态版 outboxToday：今日条数 + 最近 5 条）。 */
export interface ReportSubmitted {
  readonly n: number;
  readonly items: ReadonlyArray<{ readonly title: string; readonly time: string }>;
}

/** dws 子状态：state 里单段失败不拖垮整包（照静态版 out.dws / submittedNote）。 */
export interface ReportDwsStatus {
  readonly ok: boolean;
  readonly code: string;
  readonly note: string;
  readonly fix: string;
}

/** GET /local/report/state 的 data。 */
export interface ReportState {
  readonly configured: boolean;
  readonly configNote: string;
  readonly today: string;
  readonly weekday: number;
  readonly dws: ReportDwsStatus;
  readonly record: ReportTodayRecord | null;
  readonly recordNote: string;
  readonly submitted: ReportSubmitted | null;
  readonly submittedNote: string;
}

/** 定时任务只读状态行（照静态版 automations jobs 投影）。 */
export interface ReportAutomationJob {
  readonly key: ReportRemoteJobKey;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly cond: string;
  readonly lastStatus: string;
  readonly lastAt: string;
  readonly nextAt: string;
}

/** GET /local/report/automations 的 data（remote 未配置时 configured:false + note）。 */
export interface ReportAutomations {
  readonly configured: boolean;
  readonly configNote: string;
  readonly at: string;
  readonly jobs: readonly ReportAutomationJob[];
}

/** 双周报目录条目（只读元数据，不含正文）。 */
export interface ReportWeeklyItem {
  readonly name: string;
  readonly nodeId: string;
  readonly url: string;
  readonly created: string;
  readonly updated: string;
}

/** GET /local/report/weeklies 的 data。 */
export interface ReportWeeklies {
  readonly at: string;
  readonly folderUrl: string;
  readonly items: readonly ReportWeeklyItem[];
  readonly hasMore: boolean;
}

/** GET /local/report/weekly?node= 的 data（正文只读，≤200KB 截断）。 */
export interface ReportWeeklyDoc {
  readonly at: string;
  readonly nodeId: string;
  readonly name: string;
  readonly url: string;
  readonly markdown: string;
  readonly truncated: boolean;
  readonly contentHash: string;
}
