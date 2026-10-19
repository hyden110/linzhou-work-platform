import { join, resolve as resolvePath } from "node:path";

import { DEFAULT_CASES_CONFIG_PATH } from "../cases/cases-config.ts";
import { createCrmBridge } from "../crm-bridge.ts";
import { createDingtalkBridge } from "../dingtalk-bridge.ts";
import { createFbiMetricsBridge } from "../fbi-metrics-bridge.ts";
import { createKbBridge } from "../kb-bridge.ts";
import { createOpsBridge } from "../ops-bridge.ts";
import { createPplInspectionBridge } from "../ppl-inspection-bridge.ts";
import { collectBridges } from "./health-bridges.ts";
import {
  CLI_SPECS,
  DEFAULT_CLI_TIMEOUT_MS,
  collectCli,
  createDefaultHealthRunner,
  type HealthCommandRunner,
} from "./health-cli.ts";
import type { HealthCapRow, HealthSnapshot } from "./health-types.ts";

/**
 * Environment health bridge (F4) — read-only inventory of "can I still fetch
 * data right now?", grouped as bridges / cli / caps. Zero writes: no runs/ or
 * snapshot files are ever produced here. Env values are never read out (set/
 * unset only); child-process output is redacted before it may enter a row.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");

export interface HealthBridgeOptions {
  readonly now?: () => number;
  /** 只读 env 注入；值只用于 set/unset 判定，绝不进快照。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: HealthCommandRunner;
  readonly cliTimeoutMs?: number;
  readonly cacheDir?: string;
  readonly casesConfigPath?: string;
  readonly crmSnapshot?: () => Promise<unknown | undefined>;
  readonly dingtalkWrites?: () => Promise<readonly unknown[]>;
  readonly fbiMetrics?: () => Promise<unknown | null>;
  readonly pplInspection?: () => Promise<unknown | undefined>;
  readonly kbConfig?: () => Promise<{
    readonly sources: readonly { readonly enabled: boolean; readonly type: string }[];
  }>;
  readonly opsDigest?: () => Promise<unknown | undefined>;
}

export interface HealthBridge {
  readonly snapshot: () => Promise<HealthSnapshot>;
}

/** CLI bin 覆盖：与 cases-bridge 同口径（env 可覆写，缺省用裸命令名）。 */
function resolveBins(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    a1: env.A1_BIN ?? "a1",
    ossutil: env.OSSUTIL_BIN ?? "ossutil",
    qodercli: env.QODERCLI_BIN ?? "qodercli",
    dws: env.DWS_BIN ?? "dws",
    aliyun: env.ALIYUN_BIN ?? "aliyun",
  };
}

function envSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return String(env[key] ?? "").trim().length > 0;
}

/** 与 dev/ops-bridge.ts isPushEnabled 同口径（1/true/yes），值本身不进快照。 */
function pushEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.OPS_DINGTALK_PUSH_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function createHealthBridge(options: HealthBridgeOptions = {}): HealthBridge {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const run = options.run ?? createDefaultHealthRunner();
  const cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const cacheDir = options.cacheDir ?? join(PROJECT_ROOT, ".local-cache");
  const casesConfigPath = options.casesConfigPath ?? DEFAULT_CASES_CONFIG_PATH;
  /* 缺省时轻量实例化既有桥（与 local-router 同款 ?? createXxx() 模式）；
   * 全部聚合只调只读投影函数，绝不触发刷新/写盘/渠道 CLI。 */
  const crmSnapshot = options.crmSnapshot ?? createCrmBridge().snapshot;
  const dingtalkWrites = options.dingtalkWrites ?? createDingtalkBridge().writes;
  const fbiMetrics = options.fbiMetrics ?? createFbiMetricsBridge().metrics;
  const pplInspection = options.pplInspection ?? createPplInspectionBridge().inspection;
  const kbConfig = options.kbConfig ?? createKbBridge().config;
  const opsDigest = options.opsDigest ?? createOpsBridge().digest;

  return {
    snapshot: async (): Promise<HealthSnapshot> => {
      const [bridges, cliRows] = await Promise.all([
        collectBridges({
          crmSnapshot,
          dingtalkWrites,
          fbiMetrics,
          pplInspection,
          kbConfig,
          opsDigest,
          maasSnapshotPath: join(cacheDir, "crm-snapshot.json"),
          casesConfigPath,
        }),
        collectCli(run, resolveBins(env), cliTimeoutMs),
      ]);

      const cliByName = new Map(cliRows.map((row) => [row.name, row]));
      const caps: HealthCapRow[] = [
        {
          name: "DASHSCOPE_API_KEY",
          state: envSet(env, "DASHSCOPE_API_KEY") ? "ok" : "unconfigured",
          set: envSet(env, "DASHSCOPE_API_KEY"),
          note: envSet(env, "DASHSCOPE_API_KEY")
            ? "已设置（值不入快照）· AI 摘要与语义检索可用"
            : "未设置：AI 摘要与语义检索未启用；在启动本机桥的终端 export DASHSCOPE_API_KEY 后重启",
        },
        {
          name: "OPS_DINGTALK_PUSH_ENABLED",
          state: pushEnabled(env) ? "ok" : "unconfigured",
          set: envSet(env, "OPS_DINGTALK_PUSH_ENABLED"),
          note: pushEnabled(env)
            ? "推送总开关已打开（接收人另见下一行）"
            : "未开启：运营日报卡只能 dry-run 预览；置 1/true/yes 后重启本机桥才会真发",
        },
        {
          name: "OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID",
          state: envSet(env, "OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID") ? "ok" : "unconfigured",
          set: envSet(env, "OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID"),
          note: envSet(env, "OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID")
            ? "接收人已设置（仅本人单聊，值不入快照）"
            : "未设置：无接收人，真发会被拒绝（recipient_not_configured）",
        },
      ];

      /* 条件修法行：只在实际出现「配置要它、CLI 没有它」时才出现，不凑数。 */
      const dwsRow = cliByName.get("dws");
      const dwsMissing = dwsRow?.state === "missing" || dwsRow?.state === "error";
      if (bridges.kbEnabledTypes.some((type) => type === "dingtalk" || type === "bailian") && dwsMissing) {
        caps.push({
          name: "kb-dws",
          state: "error",
          set: false,
          note: "知识库配置启用了 dws 类外部源，但 dws CLI 不可用；修法：dws auth login 完成钉钉授权",
        });
      }
      const a1Row = cliByName.get("a1");
      const ossutilRow = cliByName.get("ossutil");
      if (bridges.casesRepos > 0 && a1Row?.state === "missing") {
        caps.push({
          name: "cases-a1",
          state: "error",
          set: false,
          note: "案例库配置了 code.repos 但 a1 未安装；修法：" + (CLI_SPECS.find((spec) => spec.key === "a1")?.fix ?? ""),
        });
      }
      if (bridges.casesOss && ossutilRow?.state === "missing") {
        caps.push({
          name: "cases-ossutil",
          state: "error",
          set: false,
          note: "案例库配置了 oss.bucket 但 ossutil 未安装；修法：" + (CLI_SPECS.find((spec) => spec.key === "ossutil")?.fix ?? ""),
        });
      }

      return { ok: true, fetchedAt: new Date(now()).toISOString(), bridges: bridges.rows, cli: cliRows, caps };
    },
  };
}
