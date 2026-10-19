import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCasesConfig } from "../cases/cases-config.ts";
import { redactNote } from "./health-redact.ts";
import type { HealthBridgeRow } from "./health-types.ts";

/**
 * bridges 组（F4）：聚合本仓 8 个既有桥的就绪状态。只从各桥既有配置/状态
 * 读取——crm/dingtalk/fbi/ppl/kb/ops 的产物投影函数本来就只读 .local-cache，
 * maas 行只判其依赖的 CRM 快照存在性（人工覆盖计数待 MaaS 桥批次入库后回接），
 * cases 只读配置文件本身（绝不触发渠道 CLI 扇出）。不新发明探测、不为凑数造字段；
 * 每行独立 try/catch，单桥异常只降级该行。
 */

export interface BridgeProbeInputs {
  readonly crmSnapshot: () => Promise<unknown | undefined>;
  readonly dingtalkWrites: () => Promise<readonly unknown[]>;
  readonly fbiMetrics: () => Promise<unknown | null>;
  readonly pplInspection: () => Promise<unknown | undefined>;
  readonly kbConfig: () => Promise<{
    readonly sources: readonly { readonly enabled: boolean; readonly type: string }[];
  }>;
  readonly opsDigest: () => Promise<unknown | undefined>;
  /** maas 候选所依赖的 CRM 快照存在性（只判存在，内容不进快照）。 */
  readonly maasSnapshotPath: string;
  readonly casesConfigPath: string;
}

export interface BridgeCollectResult {
  readonly rows: readonly HealthBridgeRow[];
  /** 供 caps 组派生修法提示：kb 启用源类型 / cases 配置形态。 */
  readonly kbEnabledTypes: readonly string[];
  readonly casesRepos: number;
  readonly casesOss: boolean;
}

/** 单桥失败只影响该行：异常降级为脱敏后的 last-error，绝不拖垮其余行。 */
async function safeRow(name: string, probe: () => Promise<HealthBridgeRow>): Promise<HealthBridgeRow> {
  try {
    return await probe();
  } catch (error) {
    return {
      name,
      state: "error",
      detail: redactNote(error instanceof Error ? error.message : error) || "读取桥状态失败",
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fbiRow(raw: unknown): HealthBridgeRow {
  if (raw === null || raw === undefined) {
    return { name: "fbi-metrics", state: "unconfigured", detail: "无指标产物（驾驶舱 FBI 指标尚未刷新）" };
  }
  const state = (raw as { state?: unknown }).state;
  const label = typeof state === "string" ? state : "unknown";
  return { name: "fbi-metrics", state: "ok", detail: `指标产物就绪 · 状态 ${label}` };
}

function pplRow(raw: unknown): HealthBridgeRow {
  if (raw === undefined || raw === null) {
    return { name: "ppl-inspection", state: "unconfigured", detail: "无巡检产物（PPL 巡检尚未刷新）" };
  }
  const reports = asCount((raw as { reportCount?: unknown }).reportCount);
  const recommendations = Array.isArray((raw as { recommendations?: unknown }).recommendations)
    ? ((raw as { recommendations: readonly unknown[] }).recommendations).length
    : 0;
  return { name: "ppl-inspection", state: "ok", detail: `巡检就绪 · 报告 ${reports} 条 · 建议 ${recommendations} 条` };
}

export async function collectBridges(inputs: BridgeProbeInputs): Promise<BridgeCollectResult> {
  let kbEnabledTypes: readonly string[] = [];
  let casesRepos = 0;
  let casesOss = false;

  const rows = await Promise.all([
    safeRow("crm", async () => {
      const snapshot = await inputs.crmSnapshot();
      return snapshot
        ? { name: "crm", state: "ok" as const, detail: "客户快照就绪" }
        : { name: "crm", state: "unconfigured" as const, detail: "缺 .local-cache/crm-snapshot.json（同步中心手动同步生成）" };
    }),
    safeRow("dingtalk", async () => {
      const writes = await inputs.dingtalkWrites();
      return { name: "dingtalk", state: "ok" as const, detail: `写通道记录 ${writes.length} 条可读` };
    }),
    safeRow("fbi-metrics", async () => fbiRow(await inputs.fbiMetrics())),
    safeRow("ppl-inspection", async () => pplRow(await inputs.pplInspection())),
    safeRow("kb", async () => {
      const config = await inputs.kbConfig();
      const enabled = config.sources.filter((source) => source.enabled);
      kbEnabledTypes = enabled.map((source) => source.type);
      return enabled.length > 0
        ? { name: "kb", state: "ok" as const, detail: `启用知识源 ${enabled.length}/${config.sources.length} 个` }
        : { name: "kb", state: "unconfigured" as const, detail: "无启用知识源（补 .local-cache/kb.json，参考 config/kb.json.example）" };
    }),
    safeRow("cases", async () => {
      const config = await loadCasesConfig(inputs.casesConfigPath);
      if (!config) {
        return { name: "cases", state: "unconfigured" as const, detail: "未配置 .local-cache/cases.json（参考 config/cases.json.example）" };
      }
      casesRepos = config.repos.length;
      casesOss = config.oss !== null;
      if (!casesRepos && !casesOss) {
        return { name: "cases", state: "unconfigured" as const, detail: "cases.json 未含 code.repos 或 oss.bucket" };
      }
      return {
        name: "cases",
        state: "ok" as const,
        detail: `已配置 · 仓库 ${casesRepos} 个 · OSS 桶 ${casesOss ? 1 : 0} 个`,
      };
    }),
    safeRow("ops", async () => {
      const digest = await inputs.opsDigest();
      if (!digest) {
        return { name: "ops", state: "unconfigured" as const, detail: "无运营摘要产物（ops 刷新生成）" };
      }
      const items = Array.isArray((digest as { items?: unknown }).items)
        ? ((digest as { items: readonly unknown[] }).items).length
        : 0;
      return { name: "ops", state: "ok" as const, detail: `摘要就绪 · 条目 ${items} 条` };
    }),
    safeRow("maas", async () => {
      if (!(await fileExists(inputs.maasSnapshotPath))) {
        return { name: "maas", state: "unconfigured" as const, detail: "CRM 快照缺失，MaaS 候选不可生成（同步中心手动同步生成）" };
      }
      return { name: "maas", state: "ok" as const, detail: "CRM 快照就绪 · 候选可生成" };
    }),
  ]);

  return { rows, kbEnabledTypes, casesRepos, casesOss };
}
