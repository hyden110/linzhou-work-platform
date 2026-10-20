import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { DEFAULT_CASES_CONFIG_PATH } from "../cases/cases-config.ts";
import { createCrmBridge } from "../crm-bridge.ts";
import { createDingtalkBridge } from "../dingtalk-bridge.ts";
import { createFbiMetricsBridge } from "../fbi-metrics-bridge.ts";
import { createKbBridge } from "../kb-bridge.ts";
import { createOpsBridge } from "../ops-bridge.ts";
import { createPplInspectionBridge } from "../ppl-inspection-bridge.ts";
import { collectBridges, type BridgeCollectResult, type MaasOverridesProbe } from "./health-bridges.ts";
import {
  CLI_SPECS,
  DEFAULT_CLI_TIMEOUT_MS,
  collectCli,
  createDefaultHealthRunner,
  type HealthCommandRunner,
} from "./health-cli.ts";
import { RENEW_KEYS, renewCli } from "./health-renew.ts";
import { redactNote } from "./health-redact.ts";
import {
  HEALTH_ROUTES,
  HealthBridgeError,
  type HealthBridgeRow,
  type HealthCapRow,
  type HealthCheckSnapshot,
  type HealthCliRow,
  type HealthGroupName,
  type HealthGroupCheckedAt,
  type HealthRenewResult,
  type HealthSnapshot,
} from "./health-types.ts";

/**
 * Environment health bridge (F4) — read-only inventory of "can I still fetch
 * data right now?", grouped as bridges / cli / caps. Env values are never read
 * out (set/unset only); child-process output is redacted before it may enter a
 * row.
 *
 * 两组端点语义：
 *   snapshot()               纯只读全量体检（GET /local/health 既有接线，零写盘）；
 *   check({group})           现场重检：只重跑该组，其余组沿用上轮持久化快照，
 *                            结果原子落盘 .local-cache/health.json（0600，供数据源总表消费）；
 *   renew({keys?})           登录态续期检测：重跑 CLI 登录态子命令，绝不落盘，
 *                            凭据/身份值绝不入结果。
 * 子路由模式与 ontology/datasource 桥一致：local-router.ts 禁改，本桥自带
 * handle(request) 并导出 HEALTH_ROUTES 供接线（GET /local/health 不在表内，
 * 保持既有显式接线，handle 对它返回 undefined）。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");

const GROUP_NAMES: readonly HealthGroupName[] = ["bridges", "cli", "caps"];

/** 请求体体积上限：check/renew body 只有 {group} / {keys}，1KB 足够。 */
const MAX_BODY_BYTES = 1024;

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

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
  /** 可选只读依赖：MaaS 覆盖表状态（不缺省实例化，未注入则 maas 行只判快照）。 */
  readonly maasOverrides?: () => Promise<MaasOverridesProbe>;
}

export interface HealthBridge {
  readonly snapshot: () => Promise<HealthSnapshot>;
  readonly check: (body: unknown) => Promise<HealthCheckSnapshot>;
  readonly renew: (body: unknown) => Promise<HealthRenewResult>;
  readonly handle: (request: Request) => Promise<Response | undefined>;
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

/** caps 组派生：3 行 env set/unset + 条件修法行（只在真实缺口出现时）。 */
function deriveCaps(
  agg: BridgeCollectResult,
  cliRows: readonly HealthCliRow[],
  env: NodeJS.ProcessEnv,
): readonly HealthCapRow[] {
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

  const dwsRow = cliByName.get("dws");
  const dwsMissing = dwsRow?.state === "missing" || dwsRow?.state === "error";
  if (agg.kbEnabledTypes.some((type) => type === "dingtalk" || type === "bailian") && dwsMissing) {
    caps.push({
      name: "kb-dws",
      state: "error",
      set: false,
      note: "知识库配置启用了 dws 类外部源，但 dws CLI 不可用；修法：dws auth login 完成钉钉授权",
    });
  }
  const a1Row = cliByName.get("a1");
  const ossutilRow = cliByName.get("ossutil");
  if (agg.casesRepos > 0 && a1Row?.state === "missing") {
    caps.push({
      name: "cases-a1",
      state: "error",
      set: false,
      note: "案例库配置了 code.repos 但 a1 未安装；修法：" + (CLI_SPECS.find((spec) => spec.key === "a1")?.fix ?? ""),
    });
  }
  if (agg.casesOss && ossutilRow?.state === "missing") {
    caps.push({
      name: "cases-ossutil",
      state: "error",
      set: false,
      note: "案例库配置了 oss.bucket 但 ossutil 未安装；修法：" + (CLI_SPECS.find((spec) => spec.key === "ossutil")?.fix ?? ""),
    });
  }
  return caps;
}

/* ---------------- 持久化快照（check 专用；snapshot()/renew() 绝不写盘） ---------------- */

interface PersistedSnapshot {
  readonly bridges: readonly HealthBridgeRow[];
  readonly cli: readonly HealthCliRow[];
  readonly caps: readonly HealthCapRow[];
  readonly groupCheckedAt: HealthGroupCheckedAt;
}

function isPersisted(value: unknown): value is PersistedSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const gca = v.groupCheckedAt as Record<string, unknown> | undefined;
  return Array.isArray(v.bridges) && Array.isArray(v.cli) && Array.isArray(v.caps)
    && Boolean(gca) && typeof gca === "object"
    && GROUP_NAMES.every((g) => typeof gca[g] === "string" && gca[g]);
}

async function readPersisted(path: string): Promise<PersistedSnapshot | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    return isPersisted(parsed) ? parsed : undefined;
  } catch {
    return undefined; // 缺失或损坏 → 视为无上一轮，全量重跑兜底
  }
}

async function writeJsonAtomic0600(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, path);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: HealthBridgeError["code"]): number {
  if (code === "health_busy") return 409;
  if (code === "health_unavailable") return 502;
  if (code === "method_not_allowed") return 405;
  return 400;
}

export function createHealthBridge(options: HealthBridgeOptions = {}): HealthBridge {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const run = options.run ?? createDefaultHealthRunner();
  const cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const cacheDir = options.cacheDir ?? join(PROJECT_ROOT, ".local-cache");
  const casesConfigPath = options.casesConfigPath ?? DEFAULT_CASES_CONFIG_PATH;
  const snapshotPath = join(cacheDir, "health.json");
  /* 缺省时轻量实例化既有桥（与 local-router 同款 ?? createXxx() 模式）；
   * 全部聚合只调只读投影函数，绝不触发刷新/写盘/渠道 CLI。 */
  const crmSnapshot = options.crmSnapshot ?? createCrmBridge().snapshot;
  const dingtalkWrites = options.dingtalkWrites ?? createDingtalkBridge().writes;
  const fbiMetrics = options.fbiMetrics ?? createFbiMetricsBridge().metrics;
  const pplInspection = options.pplInspection ?? createPplInspectionBridge().inspection;
  const kbConfig = options.kbConfig ?? createKbBridge().config;
  const opsDigest = options.opsDigest ?? createOpsBridge().digest;

  let inflightCheck: Promise<HealthCheckSnapshot> | null = null;

  function collectBridgeGroup(): Promise<BridgeCollectResult> {
    return collectBridges({
      crmSnapshot,
      dingtalkWrites,
      fbiMetrics,
      pplInspection,
      kbConfig,
      opsDigest,
      maasOverrides: options.maasOverrides,
      maasSnapshotPath: join(cacheDir, "crm-snapshot.json"),
      casesConfigPath,
    });
  }

  function collectCliGroup(): Promise<readonly HealthCliRow[]> {
    return collectCli(run, resolveBins(env), cliTimeoutMs);
  }

  async function snapshot(): Promise<HealthSnapshot> {
    const [agg, cliRows] = await Promise.all([collectBridgeGroup(), collectCliGroup()]);
    return { ok: true, fetchedAt: new Date(now()).toISOString(), bridges: agg.rows, cli: cliRows, caps: deriveCaps(agg, cliRows, env) };
  }

  async function runCheck(group: HealthGroupName): Promise<HealthCheckSnapshot> {
    const at = new Date(now()).toISOString();
    const previous = await readPersisted(snapshotPath);
    let bridges: readonly HealthBridgeRow[];
    let cli: readonly HealthCliRow[];
    let capsRow: readonly HealthCapRow[];
    let groupCheckedAt: HealthGroupCheckedAt;

    if (!previous) {
      /* 首轮（或上一轮损坏）：三组全量重跑，时间戳统一为本次。 */
      const [agg, cliRows] = await Promise.all([collectBridgeGroup(), collectCliGroup()]);
      bridges = agg.rows;
      cli = cliRows;
      capsRow = deriveCaps(agg, cliRows, env);
      groupCheckedAt = { bridges: at, cli: at, caps: at };
    } else {
      /* 只重跑请求的组；其余组行与时间戳沿用上轮持久化快照。 */
      bridges = previous.bridges;
      cli = previous.cli;
      capsRow = previous.caps;
      groupCheckedAt = { ...previous.groupCheckedAt };
      if (group === "cli") {
        cli = await collectCliGroup();
        groupCheckedAt = { ...groupCheckedAt, cli: at };
      } else if (group === "bridges") {
        bridges = (await collectBridgeGroup()).rows;
        groupCheckedAt = { ...groupCheckedAt, bridges: at };
      } else {
        /* caps 条件修法行依赖 bridges 中间量（廉价只读）与 cli 行（沿用上轮）。 */
        capsRow = deriveCaps(await collectBridgeGroup(), previous.cli, env);
        groupCheckedAt = { ...groupCheckedAt, caps: at };
      }
    }

    const result: HealthCheckSnapshot = { ok: true, fetchedAt: at, bridges, cli, caps: capsRow, groupCheckedAt };
    await writeJsonAtomic0600(snapshotPath, result);
    return result;
  }

  async function check(body: unknown): Promise<HealthCheckSnapshot> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HealthBridgeError("health_invalid_request", "请求体必须是 JSON 对象：{group}。");
    }
    const group = (body as Record<string, unknown>).group;
    if (typeof group !== "string" || !group) {
      throw new HealthBridgeError("health_invalid_request", "group 必填：bridges / cli / caps。");
    }
    if (!GROUP_NAMES.includes(group as HealthGroupName)) {
      throw new HealthBridgeError("health_invalid_group", `未知体检组：${group.slice(0, 40)}（可选 bridges / cli / caps）`);
    }
    if (inflightCheck) {
      throw new HealthBridgeError("health_busy", "已有一轮现场重检正在进行中，请等待其完成");
    }
    const task = runCheck(group as HealthGroupName).finally(() => {
      inflightCheck = null;
    });
    inflightCheck = task;
    return task;
  }

  async function renew(body: unknown): Promise<HealthRenewResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HealthBridgeError("health_invalid_request", "请求体必须是 JSON 对象：{keys?}。");
    }
    const keys = (body as Record<string, unknown>).keys;
    let wanted: readonly string[];
    if (keys === undefined) {
      wanted = RENEW_KEYS;
    } else if (Array.isArray(keys) && keys.length > 0 && keys.every((k) => typeof k === "string" && RENEW_KEYS.includes(k))) {
      /* 按 RENEW_SPECS 固定顺序输出，天然去重。 */
      wanted = RENEW_KEYS.filter((k) => (keys as readonly string[]).includes(k));
    } else {
      throw new HealthBridgeError("health_invalid_request", `keys 必须是 ${RENEW_KEYS.join("/")} 的非空子集。`);
    }
    const results = await renewCli(wanted, { run, bins: resolveBins(env), timeoutMs: cliTimeoutMs, now });
    return { renewedAt: new Date(now()).toISOString(), results };
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new HealthBridgeError("health_invalid_request", "请求体过大：只需要 {group} 或 {keys}。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new HealthBridgeError("health_invalid_request", "请求体过大：只需要 {group} 或 {keys}。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new HealthBridgeError("health_invalid_request", "请求体不是合法 JSON。");
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const route = HEALTH_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非本桥路径（含 GET /local/health 既有接线）：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      const body = await readBody(request);
      const data = route.operation === "check" ? await check(body) : await renew(body);
      return jsonResponse({ ok: true, data });
    } catch (error) {
      if (error instanceof HealthBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "health_unavailable", message: redactNote("现场体检遇到未知故障，请稍后重试。") } },
        502,
      );
    }
  }

  return { snapshot, check, renew, handle };
}
