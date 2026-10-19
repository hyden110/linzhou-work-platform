import { createHash } from "node:crypto";

import {
  DEFAULT_REPORT_CONFIG_PATH,
  DAILY_CONFIG_NOTE,
  loadReportConfig,
  NODE_PATTERN,
  remoteConfigNote,
  weeklyConfigNote,
  type ReportConfig,
} from "./report-config.ts";
import {
  AUTOMATIONS_SSH_TIMEOUT_MS,
  createDefaultReportRunner,
  DOC_READ_TIMEOUT_MS,
  DRIVE_LIST_TIMEOUT_MS,
  OUTBOX_LIST_TIMEOUT_MS,
  RATE_RETRY_SLEEP_MS,
  RECORD_QUERY_TIMEOUT_MS,
  redactText,
  resolveDwsBin,
  runDws,
  runSsh,
  type ReportCommandRunner,
} from "./report-dws.ts";
import { ReportBridgeError } from "./report-types.ts";
import type {
  ReportAutomationJob,
  ReportAutomations,
  ReportDailyConfig,
  ReportDwsStatus,
  ReportState,
  ReportTodayRecord,
  ReportWeeklyDoc,
  ReportWeeklyItem,
  ReportWeeklies,
} from "./report-types.ts";

/**
 * Report bridge (F6) — 日周报只读桥。语义 ported from base/sa-workbench
 * scripts/lib/report/index.js（搬语义不搬代码）：
 * - state：当日草稿（aitable record query）+ OA outbox 今日提交 + 北京日期；
 * - weeklies / weekly：钉盘「双周报」目录与正文（drive list / doc read，≤200KB）；
 * - automations：ECS QoderWake 定时任务只读状态（SSH automation detail，绝不 run-now）。
 * F6-P0 只读红线：不实现 save / draft / send / weekly-save / weekly-send /
 * ppl-ai / ppl-refresh，不跑 record update / chat +dm / record create——UI 上
 * 「编辑 / 发送」一律标注「待授权，本台未开通」。
 */

/** 正文截断上限（照静态版 MD_MAX）。 */
export const MD_MAX = 200 * 1024;
/** automations 状态缓存 TTL（照静态版 60s）。 */
const AUTOMATIONS_TTL_MS = 60_000;
/** 双周报目录缓存 TTL（照静态版 5min）。 */
const WEEKLIES_TTL_MS = 5 * 60_000;
/** 双周报正文缓存 TTL（照静态版 10min）。 */
const WEEKLY_DOC_TTL_MS = 10 * 60_000;

/** SSH 远端 echo 的分隔回显标记（照静态版 split 口径：stdout 里只有标记本身）。 */
const REMOTE_BLOCK_MARK = "=====SA=====";
/** 拼接多任务远端命令的 shell 模板——模板只出现在远端命令 argv 里；
 * stdout 只会回显 MARK（评审 P1-1：split 必须按回显标记切，绝不能拿命令模板切）。 */
const REMOTE_BLOCK_SEP = `; echo "${REMOTE_BLOCK_MARK}"; `;
/** automation detail 只参与投影的键；TASK_DESCRIPTION 及其后内容不进解析。 */
const AUTO_KEYS: readonly string[] = [
  "TRIGGER_ID", "NAME", "ENABLED", "KIND", "CONDITION_SUMMARY",
  "LAST_RUN_STATUS", "LAST_RUN_AT", "NEXT_RUN_AT",
];

export interface ReportBridgeOptions {
  readonly configPath?: string;
  readonly run?: ReportCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReportBridge {
  readonly state: () => Promise<ReportState>;
  readonly automations: (options?: { readonly fresh?: boolean }) => Promise<ReportAutomations>;
  readonly weeklies: (options?: { readonly fresh?: boolean }) => Promise<ReportWeeklies>;
  readonly weekly: (nodeId: string, options?: { readonly fresh?: boolean }) => Promise<ReportWeeklyDoc>;
}

/* ----------------------------------------------------------------------- */
/* 北京日历日（固定 UTC+8；Asia/Shanghai 无夏令时，偏移恒定） */
/* ----------------------------------------------------------------------- */

/** 毫秒时间戳 → 北京日历日 "YYYY-MM-DD"。 */
export function beijingDate(nowMs: number): string {
  const shifted = new Date(nowMs + 8 * 3_600_000);
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${shifted.getUTCDate()}`.padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** 毫秒时间戳 → 北京星期（0=周日 … 6=周六），供「周五双周报」等口径判断。 */
export function beijingWeekday(nowMs: number): number {
  return new Date(nowMs + 8 * 3_600_000).getUTCDay();
}

/* ----------------------------------------------------------------------- */
/* automation detail 解析（只收参考键，TASK_DESCRIPTION 处截断） */
/* ----------------------------------------------------------------------- */

/** 解析单个 automation detail 文本块：KEY: value 行；只收 AUTO_KEYS，遇 TASK_DESCRIPTION 停。 */
export function parseAutomationDetail(block: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of String(block ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (key === "TASK_DESCRIPTION") break;
    if (!AUTO_KEYS.includes(key)) continue;
    parsed[key] = line.slice(sep + 1).trim();
  }
  return parsed;
}

/* ----------------------------------------------------------------------- */
/* 小工具 */
/* ----------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 照静态版 cellText：多态单元格归一为纯文本（{text} / 数组 / 标量）。 */
function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (Array.isArray(cell)) return cell.map((entry) => cellText(entry)).filter(Boolean).join("；");
  if (typeof cell === "object") {
    const record = cell as Record<string, unknown>;
    return cellText(record.text ?? record.value ?? "");
  }
  return String(cell).trim();
}

function lastLine(text: string): string {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

function toIso(value: unknown): string {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function dwsFixFor(code: string): string {
  if (code === "need_auth") return "在启动桥的终端执行 dws auth login 完成钉钉授权后重试。";
  if (code === "no_enterprise") return "在 dws 中完成企业（组织）授权后重试（错误含 ENTERPRISE_NOT_AUTHORIZED）。";
  return "确认本机已安装 dws CLI、网络可达后重试；限流时桥会自动隔 1.5s 重试一次。";
}

/* ----------------------------------------------------------------------- */
/* 工厂 */
/* ----------------------------------------------------------------------- */

export function createReportBridge(options: ReportBridgeOptions = {}): ReportBridge {
  const configPath = options.configPath ?? DEFAULT_REPORT_CONFIG_PATH;
  const run = options.run ?? createDefaultReportRunner();
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? (() => false);
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));

  const dwsBin = resolveDwsBin(env, existsSync);

  interface CacheEntry<T> { readonly at: number; readonly data: T }
  let automationsCache: CacheEntry<ReportAutomations> | null = null;
  let weekliesCache: CacheEntry<ReportWeeklies> | null = null;
  const docCache = new Map<string, CacheEntry<ReportWeeklyDoc>>();

  const atIso = (): string => new Date(now()).toISOString();

  /** 整份配置缺失 / 坏 JSON → null；调用方按「各段缺失」如实降级，绝不造数据。 */
  const config = (): Promise<ReportConfig | null> => loadReportConfig(configPath);

  /* ---------------------------- state ---------------------------- */

  async function state(): Promise<ReportState> {
    const today = beijingDate(now());
    const weekday = beijingWeekday(now());
    const loaded = await config();
    if (!loaded || !loaded.daily) {
      return {
        configured: false,
        configNote: loaded?.dailyNote || DAILY_CONFIG_NOTE,
        today,
        weekday,
        dws: { ok: false, code: "unconfigured", note: "日报段未配置。", fix: dwsFixFor("need_auth") },
        record: null,
        recordNote: "未配置日报段，今日记录不可读。",
        submitted: null,
        submittedNote: "",
      };
    }
    const daily = loaded.daily;

    // ---- 当日草稿：aitable record query（只读；失败降级 dws 段，不抛出）----
    let dwsStatus: ReportDwsStatus = { ok: true, code: "", note: "", fix: "" };
    let record: ReportTodayRecord | null = null;
    let recordNote = "";
    try {
      const filter = {
        operator: "and",
        operands: [{ operator: "date_eq", operands: [daily.fields.date, today] }],
      };
      const payload = await runDws(run, dwsBin, [
        "aitable", "record", "query",
        "--base-id", daily.baseId,
        "--table-id", daily.tableId,
        "--filters", JSON.stringify(filter),
        "--field-ids", Object.values(daily.fields).join(","),
      ], RECORD_QUERY_TIMEOUT_MS, RATE_RETRY_SLEEP_MS, sleep);
      const data = isRecord(payload.data) ? payload.data : {};
      const rows = Array.isArray(data.records) ? data.records : [];
      const mapped = rows
        .map((row) => mapRecord(row, daily.fields))
        .filter((entry): entry is ReportTodayRecord => entry !== null)
        .sort((a, b) => Date.parse(b.modifiedAt || "0") - Date.parse(a.modifiedAt || "0"));
      if (mapped.length > 0) {
        record = mapped[0];
      } else {
        recordNote = "今日尚无记录：通常由 19:00 的 QoderWake「日报初稿」任务写入；周末或任务未运行时为空。";
      }
    } catch (error) {
      const kind = (error as { detail?: string }).detail ?? "unavailable";
      const message = error instanceof Error ? error.message : String(error);
      dwsStatus = { ok: false, code: kind, note: redactText(message).slice(0, 300), fix: dwsFixFor(kind) };
      recordNote = "今日记录不可读：dws 调用失败（见 dws 状态）。";
    }

    // ---- outbox 今日提交（只读；单段失败不拖垮 state）----
    let submitted: ReportSubmitted | null = null;
    let submittedNote = "";
    try {
      const args = [
        "report", "outbox", "list",
        "--cursor", "0", "--size", "20",
        "--start", `${today}T00:00:00+08:00`,
        "--end", `${today}T23:59:59+08:00`,
      ];
      if (daily.templateName) args.push("--template-name", daily.templateName);
      const payload = await runDws(run, dwsBin, args, OUTBOX_LIST_TIMEOUT_MS, RATE_RETRY_SLEEP_MS, sleep);
      const todayRows = extractOutboxRows(payload)
        .map((row) => ({ title: String(row["标题"] ?? "").trim(), ms: Date.parse(String(row["日期"] ?? "")) }))
        .filter((row) => row.title && Number.isFinite(row.ms) && beijingDate(row.ms) === today)
        .sort((a, b) => b.ms - a.ms);
      submitted = {
        n: todayRows.length,
        items: todayRows.slice(0, 5).map((row) => ({ title: row.title, time: new Date(row.ms).toISOString() })),
      };
      submittedNote = todayRows.length > 0 ? `今日已提交 ${todayRows.length} 次。` : "今日尚无提交记录。";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      submittedNote = `outbox 不可读：${redactText(message).slice(0, 200)}`;
    }

    return {
      configured: true,
      configNote: "",
      today,
      weekday,
      dws: dwsStatus,
      record,
      recordNote,
      submitted,
      submittedNote,
    };
  }

  /** 静态版 outbox rows 兼容两种载体：payload.result 与 payload.data.result。 */
  function extractOutboxRows(payload: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(payload.result)) return payload.result.filter(isRecord);
    const data = isRecord(payload.data) ? payload.data : {};
    return Array.isArray(data.result) ? data.result.filter(isRecord) : [];
  }

  /** 静态版 recordView：cells → 7 个业务字段 + lastModifiedTime；非对象行丢弃。 */
  function mapRecord(row: unknown, fields: ReportDailyConfig["fields"]): ReportTodayRecord | null {
    if (!isRecord(row)) return null;
    const cells = isRecord(row.cells) ? row.cells : {};
    return {
      recordId: String(row.recordId ?? ""),
      topic: cellText(cells[fields.topic]),
      dept: cellText(cells[fields.dept]),
      workStatus: cellText(cells[fields.workStatus]),
      followup: cellText(cells[fields.followup]),
      opportunity: cellText(cells[fields.opportunity]),
      risk: cellText(cells[fields.risk]),
      other: cellText(cells[fields.other]),
      modifiedAt: String(row.lastModifiedTime ?? ""),
    };
  }

  /* ---------------------------- weeklies（目录） ---------------------------- */

  async function fetchWeeklies(weekly: NonNullable<ReportConfig["weekly"]>): Promise<ReportWeeklies> {
    const payload = await runDws(run, dwsBin, [
      "drive", "list",
      "--workspace", weekly.workspaceId,
      "--folder", weekly.folderId,
      "--limit", "50",
    ], DRIVE_LIST_TIMEOUT_MS, RATE_RETRY_SLEEP_MS, sleep);
    const data = isRecord(payload.data) ? payload.data : {};
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const items = nodes
      .filter(isRecord)
      .filter((node) => node.nodeType === "file" && NODE_PATTERN.test(String(node.nodeId ?? "")))
      .map((node): ReportWeeklyItem => {
        const nodeId = String(node.nodeId);
        const docUrl = String(node.docUrl ?? "").trim();
        return {
          name: String(node.name ?? "").trim(),
          nodeId,
          url: docUrl ? docUrl.split("?")[0] : `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
          created: toIso(node.createTime),
          updated: toIso(node.updateTime),
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name, "zh-Hans-CN"));
    return {
      at: atIso(),
      folderUrl: `https://alidocs.dingtalk.com/i/nodes/${weekly.folderId}`,
      items,
      hasMore: payload.hasMore === true,
    };
  }

  async function weeklies(listOptions?: { readonly fresh?: boolean }): Promise<ReportWeeklies> {
    const loaded = await config();
    const weekly = loaded?.weekly ?? null;
    if (!weekly) {
      throw new ReportBridgeError("report_unconfigured", loaded?.weeklyNote || weeklyConfigNote());
    }
    const cached = weekliesCache;
    if (!listOptions?.fresh && cached && now() - cached.at < WEEKLIES_TTL_MS) return cached.data;
    try {
      const data = await fetchWeeklies(weekly);
      weekliesCache = { at: now(), data };
      return data;
    } catch (error) {
      if (error instanceof ReportBridgeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReportBridgeError("report_unavailable", redactText(message).slice(0, 300));
    }
  }

  /* ---------------------------- weekly（正文） ---------------------------- */

  async function weekly(nodeId: string, docOptions?: { readonly fresh?: boolean }): Promise<ReportWeeklyDoc> {
    if (!NODE_PATTERN.test(nodeId)) {
      throw new ReportBridgeError(
        "report_unconfigured",
        `node 参数不合法：需为 16–64 位字母数字（收到「${redactText(nodeId).slice(0, 16)}」）。`,
      );
    }
    const list = await weeklies();
    const item = list.items.find((entry) => entry.nodeId === nodeId);
    if (!item) {
      throw new ReportBridgeError("report_unconfigured", "node 不在双周报目录白名单内：只读该目录下的文档。");
    }
    const cached = docCache.get(nodeId);
    if (!docOptions?.fresh && cached && now() - cached.at < WEEKLY_DOC_TTL_MS) return cached.data;
    const payload = await runDws(
      run, dwsBin, ["doc", "read", "--node", nodeId],
      DOC_READ_TIMEOUT_MS, RATE_RETRY_SLEEP_MS, sleep,
    );
    const data = isRecord(payload.data) ? payload.data : {};
    const normalized = String(data.markdown ?? "").replace(/\r\n?/g, "\n");
    const markdown = normalized.slice(0, MD_MAX);
    const doc: ReportWeeklyDoc = {
      at: atIso(),
      nodeId,
      name: item.name,
      url: item.url,
      markdown,
      truncated: normalized.length > MD_MAX,
      contentHash: createHash("sha256").update(markdown, "utf-8").digest("hex"),
    };
    docCache.set(nodeId, { at: now(), data: doc });
    return doc;
  }

  /* ---------------------------- automations（SSH 只读） ---------------------------- */

  /** 配置里的 ~/.ssh/... 按注入 HOME 展开（静态版 expandKey 语义）。 */
  function expandKeyPath(key: string): string {
    const home = String(env.HOME ?? "").replace(/\/$/, "");
    return key.startsWith("~/") && home ? `${home}${key.slice(1)}` : key;
  }

  async function fetchAutomations(remote: NonNullable<ReportConfig["remote"]>): Promise<ReportAutomations> {
    // 远端命令串只在「远端 shell」展开（bin 的 ~ 等）；本地 execFile("ssh", [...]) 单 argv，无本地 shell。
    const remoteCommand = remote.jobs
      .map((job) => `${remote.bin} automation detail --waker-id ${remote.wakerId} --automation-id ${job.trigger} --runs-limit 1`)
      .join(REMOTE_BLOCK_SEP);
    const result = await runSsh(run, {
      host: remote.host,
      keyPath: expandKeyPath(remote.key),
      remoteCommand,
      timeoutMs: AUTOMATIONS_SSH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new ReportBridgeError(
        "report_unavailable",
        `QoderWake SSH 探测失败：${redactText(lastLine(result.stderr || result.stdout)).slice(0, 200) || `exit ${result.code}`}`,
      );
    }
    const byTrigger = new Map<string, Record<string, string>>();
    for (const block of String(result.stdout ?? "").split(REMOTE_BLOCK_MARK)) {
      const parsed = parseAutomationDetail(block);
      if (parsed.TRIGGER_ID) byTrigger.set(parsed.TRIGGER_ID, parsed);
    }
    const jobs: ReportAutomationJob[] = remote.jobs.map((job) => {
      const detail = byTrigger.get(job.trigger) ?? {};
      return {
        key: job.key,
        id: job.trigger,
        name: job.name,
        enabled: detail.ENABLED === "true",
        cond: detail.CONDITION_SUMMARY ?? "",
        lastStatus: detail.LAST_RUN_STATUS ?? "",
        lastAt: detail.LAST_RUN_AT ?? "",
        nextAt: detail.NEXT_RUN_AT ?? "",
      };
    });
    return { configured: true, configNote: "", at: atIso(), jobs };
  }

  async function automations(autoOptions?: { readonly fresh?: boolean }): Promise<ReportAutomations> {
    const loaded = await config();
    const remote = loaded?.remote ?? null;
    if (!remote) {
      throw new ReportBridgeError("report_unconfigured", loaded?.remoteNote || remoteConfigNote());
    }
    const cached = automationsCache;
    if (!autoOptions?.fresh && cached && now() - cached.at < AUTOMATIONS_TTL_MS) return cached.data;
    try {
      const data = await fetchAutomations(remote);
      automationsCache = { at: now(), data };
      return data;
    } catch (error) {
      if (error instanceof ReportBridgeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ReportBridgeError("report_unavailable", redactText(message).slice(0, 300));
    }
  }

  return { state, automations, weeklies, weekly };
}
