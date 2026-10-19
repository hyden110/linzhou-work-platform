import { join as joinPath, resolve as resolvePath } from "node:path";

import { redact } from "../health/health-redact.ts";
import type { WakeEndpointLink } from "./agents-types.ts";

/**
 * Config for the agents bridge (F7). Shape mirrors the brief's contract; the
 * real file lives at .local-cache/agents.json（gitignored, personal-only），
 * template at config/agents.json.example（全空值占位）。
 * 与 leads/cases/report 桥同一契约：配置缺失 / 坏 JSON / 形态不符 = 如实降级，
 * 绝不抛错、绝不造数据、绝不默认指向静态台仓库路径。
 *
 * 凭据红线：本配置只描述「凭据探测方式」（json-file 的路径与字段名），
 * 任何凭据值都不落配置；ECS endpoints 只存 URL 与条目名，绝不存 Basic Auth。
 */

/* dev/agents/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_AGENTS_CONFIG_PATH = joinPath(PROJECT_ROOT, ".local-cache", "agents.json");

/** QoderWake daemon 端口文件（照静态台 scripts/refresh.js WAKE_PORT_FILE）。 */
export const DEFAULT_WAKE_PORT_PATH = "~/.qoderwake/run/daemon.port";
/** daemon 端口回退值（照静态台 probeWakeDaemon）。 */
export const WAKE_DEFAULT_PORT = 19820;

/** 端点 id：小写字母数字中划线下划线，1–24 位。 */
const ENDPOINT_ID_PATTERN = /^[a-z0-9_-]{1,24}$/;
/**
 * 端点 URL 白名单：http(s) + host[:port] + 可选路径段。
 * 拒绝 userinfo（user:pass@）、query（?token=…）与一切会夹带凭据的形态——
 * 入口 URL 是「新建窗口的基址」，不需要也不允许携带凭据。
 */
const ENDPOINT_URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~-]+(?::\d{2,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
/** 端点条目上限：防配置膨胀（照静态台三节点矩阵的实际规模）。 */
export const MAX_WAKE_ENDPOINTS = 8;
/** 文本字段长度上限（条目名 / 路径）。 */
const TEXT_MAX = 120;

/** AgentLoop 凭据探测方式：本批只支持 json-file（读非敏感字段的形态并出掩码）。 */
export type AgentLoopSourceKind = "json-file";

export interface AgentLoopSourceConfig {
  readonly kind: AgentLoopSourceKind;
  readonly path: string;
  readonly field: string;
}

/** views 覆盖行：project + logstore 必填，其余照静态台回落。 */
export interface AgentLoopViewInput {
  readonly id: string;
  readonly t: string;
  readonly sub: string;
  readonly project: string;
  readonly logstore: string;
  readonly region: string;
}

export interface AgentsConfig {
  readonly wake: {
    readonly daemonPortPath: string;
    readonly endpoints: readonly WakeEndpointLink[];
  };
  readonly agentloop: {
    readonly source: AgentLoopSourceConfig | null;
    readonly views: readonly AgentLoopViewInput[];
  };
  readonly wechat: {
    readonly snapshotPath: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** 配置里的 ~/ 路径按注入 HOME 展开（对齐 report 桥 expandKeyPath 语义）。 */
export function expandHomePath(path: string, home: string): string {
  const clean = String(home ?? "").replace(/\/$/, "");
  return path.startsWith("~/") && clean ? `${clean}${path.slice(1)}` : path;
}

function sanitizeEndpoint(raw: unknown): WakeEndpointLink | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id).trim();
  /* t/url 过 F6 redact（词边界 + 长度下限）：敌意配置里的凭据形态文本到不了前端。 */
  const t = redact(asText(raw.t).trim()).slice(0, TEXT_MAX);
  const url = redact(asText(raw.url).trim());
  if (!ENDPOINT_ID_PATTERN.test(id) || !t) return null;
  if (!ENDPOINT_URL_PATTERN.test(url)) return null;
  return { id, t, url };
}

function sanitizeEndpoints(raw: unknown): WakeEndpointLink[] {
  if (!Array.isArray(raw)) return [];
  const endpoints: WakeEndpointLink[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const endpoint = sanitizeEndpoint(entry);
    if (!endpoint || seen.has(endpoint.id)) continue;
    seen.add(endpoint.id);
    endpoints.push(endpoint);
    if (endpoints.length >= MAX_WAKE_ENDPOINTS) break;
  }
  return endpoints;
}

function sanitizeSource(raw: unknown): AgentLoopSourceConfig | null {
  if (!isRecord(raw)) return null;
  const kind = asText(raw.kind).trim();
  if (kind !== "json-file") return null;
  const path = expandHomePath(asText(raw.path).trim(), "");
  const field = asText(raw.field).trim();
  if (!path || path.length > TEXT_MAX || !field || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field)) return null;
  return { kind, path, field };
}

function sanitizeViewRow(raw: unknown): AgentLoopViewInput | null {
  if (!isRecord(raw)) return null;
  const project = redact(asText(raw.project).trim());
  const logstore = redact(asText(raw.logstore).trim());
  if (!project || project.length > TEXT_MAX || !logstore || logstore.length > TEXT_MAX) return null;
  const clip = (value: unknown, fallback: string): string => {
    const text = redact(asText(value).trim()).slice(0, TEXT_MAX);
    return text || fallback;
  };
  return {
    id: clip(raw.id, logstore),
    t: clip(raw.t, logstore),
    sub: clip(raw.sub, logstore),
    project,
    logstore,
    region: clip(raw.region, "cn-beijing"),
  };
}

function sanitizeViews(raw: unknown): AgentLoopViewInput[] {
  if (!Array.isArray(raw)) return [];
  const views: AgentLoopViewInput[] = [];
  for (const entry of raw) {
    const row = sanitizeViewRow(entry);
    if (row) views.push(row);
    if (views.length >= MAX_WAKE_ENDPOINTS) break;
  }
  return views;
}

/** 三段独立 sanitize：每段缺失/不合法都只降级该段，绝不让整份配置报废。 */
export function sanitizeAgentsConfig(raw: unknown, home = ""): AgentsConfig {
  const source = isRecord(raw) ? raw : {};
  const wake = isRecord(source.wake) ? source.wake : {};
  const agentloop = isRecord(source.agentloop) ? source.agentloop : {};
  const wechat = isRecord(source.wechat) ? source.wechat : {};
  const daemonPortPathRaw = asText(wake.daemonPortPath).trim();
  const snapshotPathRaw = asText(wechat.snapshotPath).trim();
  return {
    wake: {
      daemonPortPath: expandHomePath(daemonPortPathRaw || DEFAULT_WAKE_PORT_PATH, home),
      endpoints: sanitizeEndpoints(wake.endpoints),
    },
    agentloop: {
      source: sanitizeSource(agentloop.statusSource),
      views: sanitizeViews(agentloop.views),
    },
    wechat: {
      snapshotPath: expandHomePath(snapshotPathRaw, home),
    },
  };
}

/** 配置缺省时的引导文案（路由 400 与页内指引共用）。 */
export function agentsConfigNote(): string {
  return "未配置 .local-cache/agents.json（参考 config/agents.json.example）：按需补 wake / agentloop / wechat 三段。";
}

/** AgentLoop 凭据探测未配置的引导文案。 */
export function agentloopSourceNote(): string {
  return "未配置 AgentLoop 凭据探测方式（agentloop.statusSource：kind=\"json-file\" + path + field）。"
    + "本台只读凭据的存在性与掩码，绝不读取或透出 AK/SK 明文；凭据配置与出票待授权，本台未开通。";
}

/** 微信快照路径未配置 / 文件未生成的引导文案。 */
export function wechatSnapshotNote(reason: "no-path" | "no-file"): string {
  if (reason === "no-path") {
    return "未配置微信办公快照路径（wechat.snapshotPath）：本台不读消息表、不做解密同步，"
      + "请把静态库本机常驻同步生成的 data/wechat.json 绝对路径填入 .local-cache/agents.json（参考 config/agents.json.example）。";
  }
  return "快照文件尚未生成：实时群台账 / @我待办由静态台本机常驻同步维护，本台仅展示快照；"
    + "确认 wechat.snapshotPath 指向的文件已生成后刷新。";
}
