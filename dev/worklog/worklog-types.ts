/** STUB（TDD RED 阶段占位）— 类型与常量已定型，行为实现见 GREEN 提交。 */
import type { WorklogClassifiedEntry } from "../../src/lib/worklog-model.ts";

export type WorklogErrorCode =
  | "worklog_invalid_request"
  | "worklog_sqlite_unavailable"
  | "worklog_scan_failed"
  | "worklog_unavailable"
  | "method_not_allowed";

export class WorklogBridgeError extends Error {
  readonly code: WorklogErrorCode;
  constructor(code: WorklogErrorCode, message: string) {
    super(message);
    this.name = "WorklogBridgeError";
    this.code = code;
  }
}

export const WORKLOG_ROUTES = [
  { method: "GET", path: "/local/worklog", operation: "list" },
  { method: "GET", path: "/local/worklog/summary", operation: "summary" },
] as const;
export type WorklogRoute = (typeof WORKLOG_ROUTES)[number];

export const WORKLOG_MAX_ENTRIES = 500;

export type WorklogOverallStatus = "ok" | "partial" | "missing";

export interface WorklogSourceView {
  readonly instance: string;
  readonly kind: string;
  readonly status: "ok" | "missing" | "error";
  readonly count: number;
  readonly note: string;
}

export interface WorklogRangeView {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

export interface WorklogListView {
  readonly generatedAt: string;
  readonly range: WorklogRangeView;
  readonly status: WorklogOverallStatus;
  readonly missingNote: string;
  readonly sources: readonly WorklogSourceView[];
  readonly total: number;
  readonly truncated: boolean;
  readonly entries: readonly WorklogClassifiedEntry[];
  readonly counts: {
    readonly byStage: Readonly<Record<string, number>>;
    readonly byCluster: readonly { readonly name: string; readonly count: number }[];
    readonly unclassified: number;
  };
}

export interface WorklogSummaryView {
  readonly generatedAt: string;
  readonly range: WorklogRangeView;
  readonly status: WorklogOverallStatus;
  readonly missingNote: string;
  readonly sources: readonly WorklogSourceView[];
  readonly total: number;
  readonly unclassified: number;
  readonly byDay: readonly { readonly date: string; readonly count: number }[];
  readonly byStage: readonly { readonly id: string; readonly name: string; readonly count: number; readonly highConfidence: number }[];
  readonly byCluster: readonly { readonly name: string; readonly count: number }[];
}

export interface WorklogBridge {
  readonly list: (query: URLSearchParams) => Promise<WorklogListView>;
  readonly summary: (query: URLSearchParams) => Promise<WorklogSummaryView>;
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
