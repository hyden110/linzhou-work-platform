/**
 * Worklog classifier (dev) — 桥侧聚合口径：把各源只读扫描结果映射为分类条目，
 * 并派生 list/summary 两个视图（分类与聚类的纯函数在 src/lib/worklog-model.ts，
 * 浏览器端共用同一口径；本文件只做桥侧组装，零 I/O、零时钟）。
 */

import {
  classifyWorklogEntries,
  summarizeWorklog,
  WORKLOG_STAGES,
  type WorklogClassifiedEntry,
} from "../../src/lib/worklog-model.ts";
import { clipWorklogTitle, type CollectedSession, type SourceScanResult, type WorklogSource } from "./worklog-collector.ts";
import {
  WORKLOG_MAX_ENTRIES,
  type WorklogListView,
  type WorklogOverallStatus,
  type WorklogRangeView,
  type WorklogSourceView,
  type WorklogSummaryView,
} from "./worklog-types.ts";

/** 全源缺失时的诚实说明（面板直接展示；绝不伪造条目）。 */
export const MISSING_NOTE =
  "未检测到本机 Qoder 工作库（Qoder / QoderCN / QoderWork / QwenWorkCN）：本机暂无可采集的工作记录源，未生成任何条目。";

/** 单源扫描结果 → 对外视图（note 已在 collector 侧脱敏）。 */
export function sourceViewOf(result: SourceScanResult): WorklogSourceView {
  return {
    instance: result.source.instance,
    kind: result.source.kind,
    status: result.status,
    count: result.sessions.length,
    note: result.note ?? "",
  };
}

/** 汇总状态：有 ok 且有 error → partial；有 ok → ok；否则 missing（全 error 由桥抛 502）。 */
export function overallStatusOf(sources: readonly WorklogSourceView[]): WorklogOverallStatus {
  const anyOk = sources.some((s) => s.status === "ok");
  const anyError = sources.some((s) => s.status === "error");
  if (anyOk && anyError) return "partial";
  if (anyOk) return "ok";
  return "missing";
}

/** 各源会话 → 统一 sourceKey（donor `qoder:<instance>:<sessionId>`）→ 分类条目。 */
export function entriesOf(
  scans: readonly { readonly source: WorklogSource; readonly sessions: readonly CollectedSession[] }[],
): WorklogClassifiedEntry[] {
  const sessions = scans.flatMap((scan) =>
    scan.sessions.map((session) => ({
      sourceKey: `qoder:${scan.source.instance}:${session.sessionId}`,
      instance: scan.source.instance,
      ts: session.ts,
      title: clipWorklogTitle(session.title),
    })),
  );
  return classifyWorklogEntries(sessions);
}

/** 最近活跃在前 + 上限截断（donor maxItems=500 口径）；truncated 如实上报。 */
export function rankEntries(entries: readonly WorklogClassifiedEntry[]): {
  kept: readonly WorklogClassifiedEntry[];
  truncated: boolean;
} {
  const sorted = [...entries].sort((a, b) => b.ts - a.ts);
  return { kept: sorted.slice(0, WORKLOG_MAX_ENTRIES), truncated: sorted.length > WORKLOG_MAX_ENTRIES };
}

export interface ViewParts {
  readonly generatedAt: string;
  readonly range: WorklogRangeView;
  readonly sources: readonly WorklogSourceView[];
  readonly entries: readonly WorklogClassifiedEntry[];
  readonly status: WorklogOverallStatus;
}

/** GET /local/worklog 的 data：分类条目 + 每类计数（环节零填充、聚类 top、未分类）。 */
export function buildListView(parts: ViewParts): WorklogListView {
  const { kept, truncated } = rankEntries(parts.entries);
  const summary = summarizeWorklog(kept);
  const byStage: Record<string, number> = {};
  for (const stage of WORKLOG_STAGES) byStage[stage.id] = 0;
  for (const row of summary.byStage) byStage[row.id] = row.count;
  return {
    generatedAt: parts.generatedAt,
    range: parts.range,
    status: parts.status,
    missingNote: parts.status === "missing" ? MISSING_NOTE : "",
    sources: parts.sources,
    total: kept.length,
    truncated,
    entries: kept,
    counts: {
      byStage,
      byCluster: summary.byCluster,
      unclassified: summary.unclassified,
    },
  };
}

/** GET /local/worklog/summary 的 data：按日（升序）/按环节/按聚类聚合。 */
export function buildSummaryView(parts: ViewParts): WorklogSummaryView {
  const { kept } = rankEntries(parts.entries);
  const summary = summarizeWorklog(kept);
  return {
    generatedAt: parts.generatedAt,
    range: parts.range,
    status: parts.status,
    missingNote: parts.status === "missing" ? MISSING_NOTE : "",
    sources: parts.sources,
    total: summary.total,
    unclassified: summary.unclassified,
    byDay: summary.byDay,
    byStage: summary.byStage,
    byCluster: summary.byCluster,
  };
}
