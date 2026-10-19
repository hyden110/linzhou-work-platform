import { readFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import type {
  ReportConfig,
  ReportDailyConfig,
  ReportFieldIds,
  ReportRemoteConfig,
  ReportRemoteJob,
  ReportRemoteJobKey,
  ReportWeeklyConfig,
} from "./report-types.ts";

/**
 * Config for the report bridge (F6). Shape mirrors base/sa-workbench
 * tools/daily_report.json.example（搬口径不搬文件）；真实配置位于
 * .local-cache/report.json（gitignored, personal-only）。
 * 与 leads/cases 桥同一契约：配置缺失 / 坏 JSON / 形态不符 = 如实降级，
 * 绝不抛错、绝不造数据。三段（daily / weekly / remote）各自独立校验：
 * 只想用周报目录可以不配 remote，只想看定时任务状态可以不配 daily。
 */

/* dev/report/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_REPORT_CONFIG_PATH = joinPath(PROJECT_ROOT, ".local-cache", "report.json");

/** ID 形态：照静态版 ID_RE（baseId/tableId/字段 ID 同款）。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 钉钉文档 node 形态：照静态版 NODE_RE。 */
export const NODE_PATTERN = /^[A-Za-z0-9]{16,64}$/;
/** SSH host：照静态版 HOST_RE（形如 root@host）。 */
const HOST_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/;
/** SSH 私钥路径：非空即可（路径里允许 ~ / . - _ 空格等，展开后 existsSync 再把关）。 */
const KEY_PATTERN = /^\S{1,200}$/;
/** 远端 qoderwake bin：照静态版 BIN_RE（固定模板之外禁止任何 shell 元字符）。 */
const BIN_PATTERN = /^[~/\w .:-]{3,200}$/;
/** wakerId：照静态版 WAKER_RE。 */
const WAKER_PATTERN = /^[A-Za-z0-9_-]{4,40}$/;
/** 触发器 id：照静态版 TRIGGER_RE。 */
export const TRIGGER_PATTERN = /^tr_[A-Za-z0-9]{6,40}$/;

export const READ_FIELD_KEYS: readonly (keyof ReportFieldIds)[] = [
  "topic", "dept", "workStatus", "date", "followup", "opportunity", "risk", "other",
];

const JOB_KEYS: readonly ReportRemoteJobKey[] = ["draft", "submit", "weekly"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

export const DAILY_CONFIG_NOTE =
  "未配置 .local-cache/report.json（参考 config/report.json.example）：补 baseId / tableId 与 8 个字段映射"
  + "（topic / dept / workStatus / date / followup / opportunity / risk / other），并在启动桥的终端完成 dws auth login。";

export function weeklyConfigNote(): string {
  return "未配置 .local-cache/report.json 的 weekly 段（weekly.folderId / weekly.workspaceId，"
    + "钉钉文档空间「双周报」文件夹；参考 config/report.json.example）——周报目录与正文只读不可用。";
}

export function remoteConfigNote(): string {
  return "未配置 .local-cache/report.json 的 remote 段（host / key / bin / wakerId / jobs，"
    + "ECS QoderWake 定时任务；参考 config/report.json.example）——定时任务只读状态不可用，19:00 / 23:15 / 周五的固定排程照常生效。";
}

function sanitizeFields(raw: unknown): { fields: ReportFieldIds } | { missing: string } {
  const source = isRecord(raw) ? raw : {};
  const missing: string[] = [];
  const collected: Record<string, string> = {};
  for (const key of READ_FIELD_KEYS) {
    const entry = source[key];
    const id = isRecord(entry) ? asText(entry.id) : "";
    if (ID_PATTERN.test(id)) collected[key] = id;
    else missing.push(key);
  }
  if (missing.length > 0) return { missing: missing.join(" / ") };
  return { fields: collected as ReportFieldIds };
}

function sanitizeDaily(raw: unknown): { config: ReportDailyConfig } | { note: string } {
  const source = isRecord(raw) ? raw : {};
  const baseId = asText(source.baseId);
  const tableId = asText(source.tableId);
  if (!ID_PATTERN.test(baseId) || !ID_PATTERN.test(tableId)) {
    return { note: "daily 段缺少合法的 baseId / tableId（ID 形态：字母数字下划线中划线，1–64 位）。" };
  }
  const fields = sanitizeFields(source.fields);
  if ("missing" in fields) {
    return { note: `daily 段字段映射缺失或不合法：${fields.missing}。` };
  }
  const templateName = asText(isRecord(source.oa) ? source.oa.templateName : "").trim().slice(0, 60);
  return { config: { baseId, tableId, fields: fields.fields, templateName } };
}

function sanitizeWeekly(raw: unknown): { config: ReportWeeklyConfig } | { note: string } {
  const source = isRecord(raw) ? raw : {};
  const folderId = asText(source.folderId);
  const workspaceId = asText(source.workspaceId);
  if (!NODE_PATTERN.test(folderId) || !NODE_PATTERN.test(workspaceId)) {
    return { note: weeklyConfigNote() };
  }
  return { config: { folderId, workspaceId } };
}

function sanitizeRemote(raw: unknown): { config: ReportRemoteConfig } | { note: string } {
  const source = isRecord(raw) ? raw : {};
  const host = asText(source.host);
  const key = asText(source.key).trim();
  const bin = asText(source.bin).trim();
  const wakerId = asText(source.wakerId);
  if (!HOST_PATTERN.test(host) || !KEY_PATTERN.test(key) || !BIN_PATTERN.test(bin) || !WAKER_PATTERN.test(wakerId)) {
    return { note: "remote 段不完整或不合法：需要 host（形如 root@主机）/ key（SSH 私钥路径）/ bin / wakerId。" };
  }
  const jobsSource = isRecord(source.jobs) ? source.jobs : {};
  const jobs: ReportRemoteJob[] = [];
  for (const jobKey of JOB_KEYS) {
    const entry = jobsSource[jobKey];
    const trigger = isRecord(entry) ? asText(entry.trigger) : "";
    const name = isRecord(entry) ? asText(entry.name).trim().slice(0, 40) : "";
    if (TRIGGER_PATTERN.test(trigger)) jobs.push({ key: jobKey, trigger, name: name || jobKey });
  }
  if (jobs.length === 0) {
    return { note: "remote 段未配置任何合法触发器（jobs.draft / jobs.submit / jobs.weekly 的 trigger 需形如 tr_xxxxxx）。" };
  }
  const timeoutRaw = source.timeoutMs;
  const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 10_000
    ? timeoutRaw
    : 60_000;
  return { config: { host, key, bin, wakerId, timeoutMs, jobs } };
}

/** 三段独立 sanitize：每段缺失/不合法都只降级该段，绝不让整份配置报废。 */
export function sanitizeReportConfig(raw: unknown): ReportConfig {
  const source = isRecord(raw) ? raw : {};
  const daily = sanitizeDaily(source.daily ?? source);
  const weekly = sanitizeWeekly(source.weekly);
  const remote = sanitizeRemote(source.remote);
  return {
    daily: "config" in daily ? daily.config : null,
    dailyNote: "note" in daily ? daily.note : "",
    weekly: "config" in weekly ? weekly.config : null,
    weeklyNote: "note" in weekly ? weekly.note : "",
    remote: "config" in remote ? remote.config : null,
    remoteNote: "note" in remote ? remote.note : "",
  };
}

/** 缺失 / 坏 JSON → null（整份未配置），由调用方走「各段缺失」引导文案。 */
export async function loadReportConfig(configPath: string): Promise<ReportConfig | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return null;
  }
  return sanitizeReportConfig(raw);
}
