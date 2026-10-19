import { readFile, stat } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { redact, redactNote } from "../health/health-redact.ts";
import {
  agentsConfigNote,
  agentloopSourceNote,
  expandHomePath,
  sanitizeAgentsConfig,
  wechatSnapshotNote,
  WAKE_DEFAULT_PORT,
  type AgentsConfig,
} from "./agents-config.ts";
import { AgentsBridgeError } from "./agents-types.ts";
import type {
  AgentLoopStatusView,
  AgentLoopViewRow,
  AgentsWakeState,
  WakeDaemonStatus,
  WakeDaemonView,
  WakeEntryLink,
  WechatSnapshotSource,
  WechatSnapshotStats,
  WechatSnapshotView,
} from "./agents-types.ts";

/**
 * Agents bridge (F7) — 数字员工只读桥。语义 ported from base/sa-workbench
 * （搬语义不搬代码）：
 * - daemon 探测照 scripts/refresh.js probeWakeDaemon + presales.js：端口读
 *   ~/.qoderwake/run/daemon.port（回退 19820），GET /api/health，三态 + note；
 * - 入口语义照 assets/pages/agents.js + core.js wakeFrames：console/wakers/
 *   knowledge/conversations 四视图。内嵌 Console 有 401→登录→回跳死循环问题
 *   （agents.js 头部注释），本台一律新窗口外链，绝不做 iframe；
 * - AgentLoop 状态照 scripts/bridge.js agentStatusView：configured/mask/
 *   updatedAt/console/views；凭据只读存在性与掩码（照 scripts/lib/agentloop.js
 *   maskAk），绝不读取/透出 AK/SK 明文，出票一律不做；
 * - 微信照 data/wechat.json 结构概要做白名单投影：只有统计，绝不读消息表。
 *
 * F7-P0 只读红线：唯一网络动作是本机 daemon 的 GET /api/health（显式 ≤5s）；
 * 无任何写命令 / 写端点 / keychain 写 / dws / SSH / 轮询。
 */

/** AgentLoop 控制台入口（照静态台 scripts/lib/agentloop.js CONSOLE）。 */
export const AGENTLOOP_CONSOLE = "https://agentloop.console.aliyun.com/agentloop/home";

/** daemon 健康探测显式超时（brief 红线 ≤5s；静态台 2s，本台放宽到 5s 上限）。 */
export const WAKE_PROBE_TIMEOUT_MS = 5000;

/** daemon 功能视图入口（照 core.js wakeFrames 默认 tabs 的路径表）。 */
export const WAKE_ENTRY_PATHS: readonly WakeEntryLink[] = [
  { id: "console", t: "Console", path: "/" },
  { id: "wakers", t: "Wakers", path: "/wakers" },
  { id: "knowledge", t: "Knowledge", path: "/knowledge" },
  { id: "conversations", t: "Conversations", path: "/conversations" },
];

/** 凭据掩码形态照静态台 agentloop.js maskAk：≤8 位前 2+****，否则前 4+****+后 4。 */
export function maskAk(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 2)}****` : `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export const AGENTLOOP_WRITES_NOTE = "凭据管理与出票：待授权，本台未开通";

const FIRST_LINE_MAX = 200;
const PILOT_SCAN_VIEWS_MAX = 12;

export interface AgentsBridgeOptions {
  readonly configPath?: string;
  /** 注入式文件读取表（测试用）：path → 内容；未命中 = 文件缺失。 */
  readonly files?: Readonly<Record<string, string | null>>;
  /** 生产默认：真实 fs 读取，任何失败都折叠为 null（= 文件缺失，如实降级）。 */
  readonly readTextFile?: (path: string) => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly home?: string;
  readonly now?: () => number;
  readonly statMtime?: (path: string) => Promise<string | null>;
}

export interface AgentsBridge {
  /** GET /local/agents/state：daemon 探测 + 视图入口 + 配置的 ECS 端点（只读）。 */
  readonly state: () => Promise<AgentsWakeState>;
  /** GET /local/agents/agentloop：凭据存在性 + 掩码 + console 外链 + views。 */
  readonly agentloop: () => Promise<AgentLoopStatusView>;
  /** GET /local/agents/wechat：微信办公快照统计的白名单投影。 */
  readonly wechat: () => Promise<WechatSnapshotView>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function firstLine(text: unknown): string {
  return String(text ?? "").trim().split("\n")[0] ?? "";
}

/** 数值白名单：有限非负数原样收，其余（缺失/字符串/负数）一律 null 容错。 */
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clip(text: string, max: number): string {
  return text.slice(0, max);
}

/** 端口文件解析：正整数（<65536）生效，其余回退默认（照静态台口径）。 */
export function parsePortFile(raw: string | null): number {
  if (raw === null) return WAKE_DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : WAKE_DEFAULT_PORT;
}

/** 凭据子树键（词级）：对象值挂在这些键下时整支跳过，杜绝从嵌套凭据里取值。 */
const CREDENTIAL_SUBTREE = /token|secret|password|passwd|cookie|credential|apikey|api[-_]?key|access[-_]?key|authorization/i;

/**
 * 在 JSON 值里找指定字段名的字符串叶值：只匹配键名完全相等的叶子；
 * 凭据命名的对象子树整支跳过（扫描顺序 = JSON 键序，跳过保证不会先撞进
 * credentials 嵌套块）。只返回第一个命中，绝不聚合、绝不透出其他字段。
 */
export function findSourceField(value: unknown, field: string, depth = 0): string | null {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findSourceField(entry, field, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (key === field && typeof entry === "string" && entry.trim()) return entry.trim();
    if (isRecord(entry) || Array.isArray(entry)) {
      if (CREDENTIAL_SUBTREE.test(key)) continue;
      const hit = findSourceField(entry, field, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * pilot config 的 views 兜底扫描（照静态台 resolveViews 的降级口径）：
 * 只收带非空 project + logstore 的对象，只投影 id/t/sub/project/logstore/region
 * 白名单字段（title 优先做 t），region 缺省 cn-beijing，凭据子树整支跳过。
 */
export function scanPilotViews(value: unknown, depth = 0): AgentLoopViewRow[] {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => scanPilotViews(entry, depth + 1));
  if (!isRecord(value)) return [];
  const clipField = (key: string, fallback: string): string =>
    clip(redact(asText(value[key]).trim()), 120) || fallback;
  const rows: AgentLoopViewRow[] = [];
  const project = asText(value.project).trim();
  const logstore = asText(value.logstore).trim();
  if (project && logstore) {
    rows.push({
      id: clipField("id", logstore),
      t: clipField("t", clipField("title", logstore)),
      sub: clipField("sub", logstore),
      project: clip(redact(project), 120),
      logstore: clip(redact(logstore), 120),
      region: clipField("region", "cn-beijing"),
    });
  }
  for (const [key, entry] of Object.entries(value)) {
    if (rows.length >= PILOT_SCAN_VIEWS_MAX) break;
    if (key === "views") continue;
    if (!isRecord(entry) && !Array.isArray(entry)) continue;
    if (CREDENTIAL_SUBTREE.test(key)) continue;
    rows.push(...scanPilotViews(entry, depth + 1));
  }
  return rows.slice(0, PILOT_SCAN_VIEWS_MAX);
}

export function createAgentsBridge(options: AgentsBridgeOptions = {}): AgentsBridge {
  const configPath = options.configPath ?? defaultConfigPath();
  const home = String(options.home ?? process.env.HOME ?? "").replace(/\/$/, "");
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const statMtime = options.statMtime ?? defaultStatMtime;
  const overrides = options.files;
  const readTextFile = options.readTextFile
    ?? (overrides
      ? async (path: string): Promise<string | null> =>
        Object.prototype.hasOwnProperty.call(overrides, path) ? overrides[path] : null
      : defaultReadTextFile);

  /** 整份配置缺失 / 坏 JSON → null（调用方按「各段缺失」如实降级）。 */
  async function config(): Promise<AgentsConfig | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(configPath, "utf-8"));
    } catch {
      return null;
    }
    return sanitizeAgentsConfig(raw, home);
  }

  async function state(): Promise<AgentsWakeState> {
    const loaded = await config();
    const wake = loaded?.wake ?? sanitizeAgentsConfig({}, home).wake;
    const daemon = await probeWakeDaemon(wake.daemonPortPath);
    return { daemon, entries: WAKE_ENTRY_PATHS, endpoints: wake.endpoints };
  }

  /** 端口读文件（回退 19820）→ GET /api/health（≤5s）→ ok/degraded/down + note。 */
  async function probeWakeDaemon(portPath: string): Promise<WakeDaemonView> {
    const port = parsePortFile(await readTextFile(portPath));
    const url = `http://127.0.0.1:${port}`;
    const checkedAt = new Date(now()).toISOString();
    try {
      const response = await fetchImpl(`${url}/api/health`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(WAKE_PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        return { status: "ok", port, url, http: response.status, note: `daemon 在线（/api/health ${response.status}）`, checkedAt };
      }
      return { status: "degraded", port, url, http: response.status, note: `/api/health HTTP ${response.status}（daemon 异常）`, checkedAt };
    } catch (error) {
      const message = redactNote(clip(firstLine(error instanceof Error ? error.message : error), FIRST_LINE_MAX));
      return { status: "down", port, url, http: null, note: `daemon 未连通（${message || "未知错误"}）`, checkedAt };
    }
  }

  async function agentloop(): Promise<AgentLoopStatusView> {
    const loaded = await config();
    if (!loaded) throw new AgentsBridgeError("agents_unconfigured", agentsConfigNote());
    const source = loaded.agentloop.source;
    if (!source) throw new AgentsBridgeError("agents_unconfigured", agentloopSourceNote());

    const sourcePath = expandHomePath(source.path, home);
    const raw = await readTextFile(sourcePath);
    let configured = false;
    let mask: string | null = null;
    let note = "";
    let parsed: unknown;
    if (raw === null) {
      note = `凭据探测文件不可读或未生成（${redact(sourcePath)}）——按未配置处理，绝不猜测。`;
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch {
        note = `凭据探测文件不是合法 JSON（${redact(sourcePath)}）——按未配置处理。`;
      }
      if (parsed !== undefined) {
        const value = findSourceField(parsed, source.field);
        if (value !== null) {
          configured = true;
          mask = maskAk(value);
          note = "凭据已配置（本台只读掩码，明文不读取、不透出）。";
        } else {
          note = `探测字段 ${redact(source.field)} 未出现在凭据文件中——按未配置处理。`;
        }
      }
    }

    const views = loaded.agentloop.views.length > 0
      ? loaded.agentloop.views
      : parsed !== undefined
        ? scanPilotViews(parsed)
        : [];

    return {
      configured,
      mask,
      updatedAt: configured ? await statMtime(sourcePath) : null,
      note,
      console: AGENTLOOP_CONSOLE,
      views,
      writesNote: AGENTLOOP_WRITES_NOTE,
    };
  }

  async function wechat(): Promise<WechatSnapshotView> {
    const loaded = await config();
    const snapshotPath = loaded?.wechat.snapshotPath ?? "";
    if (!snapshotPath) {
      throw new AgentsBridgeError("agents_unconfigured", wechatSnapshotNote("no-path"));
    }
    const raw = await readTextFile(snapshotPath);
    if (raw === null) {
      throw new AgentsBridgeError("agents_unconfigured", wechatSnapshotNote("no-file"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentsBridgeError(
        "agents_unavailable",
        `微信快照文件不是合法 JSON（${redact(snapshotPath)}）——等待常驻同步重建后刷新。`,
      );
    }
    const source = isRecord(parsed) ? parsed : {};
    const me = isRecord(source.me) ? source.me : {};
    const rawSource = isRecord(source.source) ? source.source : {};
    const rawStats = isRecord(source.stats) ? source.stats : {};
    const stats: WechatSnapshotStats = {
      groups: asCount(rawStats.groups),
      groupsActive7: asCount(rawStats.groupsActive7),
      groupsActive30: asCount(rawStats.groupsActive30),
      groupsMine7: asCount(rawStats.groupsMine7),
      custBound: asCount(rawStats.custBound),
      atMeAll: asCount(rawStats.atMeAll),
    };
    const sourceView: WechatSnapshotSource = {
      dbs: asCount(rawSource.dbs),
      tables: asCount(rawSource.tables),
      messages: asCount(rawSource.messages),
      groups: asCount(rawSource.groups),
      singles: asCount(rawSource.singles),
      window: asCount(rawSource.window),
    };
    return {
      at: new Date(now()).toISOString(),
      updatedAt: clip(redact(asText(source.updatedAt)), 40),
      me: {
        wxid: clip(redact(asText(me.wxid).trim()), 64),
        name: clip(redact(asText(me.name).trim()), 64),
      },
      source: sourceView,
      stats,
    };
  }

  return { state, agentloop, wechat };
}

function defaultConfigPath(): string {
  return joinPath(resolvePath(import.meta.dirname, "..", ".."), ".local-cache", "agents.json");
}

async function defaultReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function defaultStatMtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}
