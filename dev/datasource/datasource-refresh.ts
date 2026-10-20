/**
 * 组刷新执行器：body {group} → 组内仅 supported 的源走既有桥刷新函数。
 *
 * supported 映射（v2 实接的 5 组）：
 *   cust     → crmBridge.startRefresh()          （后台异步，逐源回 started）
 *   ops      → opsBridge.startRefresh()          （后台异步，逐源回 started）
 *   ppl      → pplInspectionBridge.startRefresh()（后台异步，逐源回 started）
 *   leads    → leadsBridge.refresh()             （awaited，逐源回 ok/failed）
 *   dingtalk → dingtalkBridge.startSummary()     （awaited，逐源回 started/failed）
 * 其余 12 组 unsupported：返回 {supported:false, reason}，绝不伪造成功。
 * 单飞锁在桥层（同组并发 → datasource_busy）；startRefresh 型另有 pre-status running 检查。
 */

import type { DataSource } from "../../src/lib/datasource-model.ts";
import { redactNote } from "../health/health-redact.ts";
import {
  DataSourceBridgeError,
  type DataSourceRefreshDeps,
  type DataSourceRefreshView,
  type SourceRefreshResult,
} from "./datasource-types.ts";

export const SUPPORTED_GROUPS: Readonly<Record<string, string>> = {
  cust: "crm 快照后台刷新（sync/crm_snapshot.py · Cookie 通道）",
  ops: "运营摘要后台刷新（sync/ops_digest.py）",
  ppl: "PPL 巡检后台刷新",
  leads: "拓新企业清单 dws 拉取（awaited）",
  dingtalk: "钉钉当日摘要 dws 拉取（awaited）",
};

export function isSupportedGroup(group: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_GROUPS, group);
}

export function unsupportedReason(group: string): string {
  return `v2 未接「${group}」组刷新通道：该组取数不经本机桥（方式见注册表 cmd 列），不伪造刷新成功`;
}

function startedResults(sources: readonly DataSource[], detail: string): readonly SourceRefreshResult[] {
  return sources.map((s) => ({ sys: s.sys, state: "started" as const, detail }));
}

/** 执行一次组刷新；调用方（桥层）负责单飞锁与 group 合法性校验。 */
export async function runGroupRefresh(
  group: string,
  sources: readonly DataSource[],
  deps: DataSourceRefreshDeps,
  now: () => number,
): Promise<DataSourceRefreshView> {
  const startedAt = new Date(now()).toISOString();

  if (group === "cust" || group === "ops" || group === "ppl") {
    const status = group === "cust" ? deps.crmStatus() : group === "ops" ? deps.opsStatus() : deps.pplStatus();
    if (status.state === "running") {
      throw new DataSourceBridgeError("datasource_busy", `「${group}」组刷新正在进行中，请等待本轮完成`);
    }
    const started = group === "cust" ? deps.crmStart() : group === "ops" ? deps.opsStart() : deps.pplStart();
    return {
      group,
      supported: true,
      reason: null,
      startedAt,
      results: startedResults(sources, `后台刷新已启动（${started.state}），完成后重新拉取总表可见新状态`),
    };
  }

  if (group === "leads") {
    try {
      const result = await deps.leadsRefresh();
      const { total, open } = result.summary;
      return {
        group,
        supported: true,
        reason: null,
        startedAt,
        results: sources.map((s) => ({
          sys: s.sys,
          state: "ok" as const,
          detail: `已拉取 ${total} 行${typeof open === "number" ? `（open ${open}）` : ""}`,
        })),
      };
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? String((error as { code?: string }).code) : "";
      const message = redactNote(error instanceof Error ? error.message : String(error));
      throw new DataSourceBridgeError(
        "datasource_refresh_failed",
        `leads 刷新失败${code ? `（${code}）` : ""}：${message}`,
      );
    }
  }

  if (group === "dingtalk") {
    const result = await deps.dingtalkStartSummary();
    if (!result.ok) {
      return {
        group,
        supported: true,
        reason: null,
        startedAt,
        results: sources.map((s) => ({
          sys: s.sys,
          state: "failed" as const,
          detail: `刷新未执行：${result.error ?? "unknown_error"}`,
        })),
      };
    }
    return {
      group,
      supported: true,
      reason: null,
      startedAt,
      results: sources.map((s) => ({
        sys: s.sys,
        state: result.reused ? ("skipped" as const) : ("started" as const),
        detail: result.reused ? "今日摘要已在刷新中/已完成，复用本轮结果" : "当日摘要刷新已启动（dws 通道）",
      })),
    };
  }

  return { group, supported: false, reason: unsupportedReason(group), startedAt, results: [] };
}
