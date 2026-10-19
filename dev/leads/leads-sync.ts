import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_LEADS_CONFIG_PATH,
  DEFAULT_LEADS_SNAPSHOT_PATH,
  loadLeadsConfig,
  sanitizeStoredSnapshot,
} from "./leads-config.ts";
import {
  REQUIRED_FIELD_NAMES,
  normalizeLeadCells,
  redact,
  sortLeads,
} from "./leads-model.ts";
import { LeadsSyncError, type LeadRow, type LeadsConfig, type LeadsRefreshSummary } from "./leads-types.ts";

/**
 * Sync engine for the leads radar (F5) — ported from base/sa-workbench
 * tools/sync/aitable_leads_sync.js. dws contract:
 *   dws aitable table  get  --base-id X --table-ids Y --format json   (120s)
 *   dws aitable record query --base-id X --table-id Y --all --page-limit 0 --format json (600s)
 * 只读：绝不回写 AI 表格；裸执行数组 argv、无 shell 管道；dws 自管钉钉凭据，
 * 本模块不读也不落任何 Cookie/Token，自由文本一律过 redact。
 * 四重护栏（原样移植）：①分页未结束/显式 incomplete/残留游标；②表名漂移；
 * ③意外空表；④腰斩。拒绝时如实报错，绝不降级覆盖旧快照。
 */

export const TABLE_GET_TIMEOUT_MS = 120_000;
export const RECORD_QUERY_TIMEOUT_MS = 600_000;

/** dws 定位：QODERWAKE_DWS_CLI_PATH / DWS_BIN 展望路径 / PATH 裸命令，照静态版口径。 */
export function resolveDwsBin(env: NodeJS.ProcessEnv, existsSync: (path: string) => boolean): string {
  const fromEnv = String(env.QODERWAKE_DWS_CLI_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  const binEnv = String(env.DWS_BIN ?? "").trim();
  if (binEnv) return binEnv;
  const home = String(env.HOME ?? "");
  const candidates = home
    ? [`${home}/.qoderwork/bin/dws`, `${home}/.qoder/bin/dws`, "/usr/local/bin/dws"]
    : ["/usr/local/bin/dws"];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? "dws";
}

export type LeadsCommandResult = {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export interface LeadsCommandOptions {
  readonly timeoutMs: number;
}

export type LeadsCommandRunner = (
  file: string,
  args: readonly string[],
  options: LeadsCommandOptions,
) => Promise<LeadsCommandResult>;

/** 默认 runner：execFile 数组参数、无 shell、硬超时、有界输出（与 cases/kb 桥同口径）。 */
export function createDefaultLeadsRunner(): LeadsCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: options.timeoutMs, shell: false, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

/** CLI 输出常在 JSON 前后带告警行：取首个 { 到最后一个 } 宽容解析（照静态版口径）。 */
export function parseDwsJson(rawText: string): unknown {
  const s = String(rawText ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new LeadsSyncError("leads_unavailable", "DWS 未返回 JSON");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LeadsSyncError("leads_unavailable", `DWS JSON 解析失败：${reason}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 跑一条 dws 只读命令并解 JSON：ENOENT/非零退出/解析失败 → leads_unavailable（照 runDws）。 */
async function runDws(
  run: LeadsCommandRunner,
  dwsBin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const fullArgs = [...args, "--format", "json"];
  const result = await run(dwsBin, fullArgs, { timeoutMs });
  if (result.code === "ENOENT") {
    throw new LeadsSyncError("leads_unavailable", "未找到 dws CLI；修法：安装 dws 后 dws auth login 完成钉钉授权");
  }
  let payload: Record<string, unknown> | null = null;
  let lastReason = "";
  for (const stream of [result.stdout, result.stderr]) {
    try {
      payload = asRecord(parseDwsJson(stream));
      break;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!payload) {
    throw new LeadsSyncError("leads_unavailable", `DWS JSON 解析失败：${lastReason}`);
  }
  const payloadError = asRecord(payload.error);
  const errorMessage = String(payloadError.message ?? payloadError.reason ?? "");
  if (result.code !== 0 && result.code !== null) {
    throw new LeadsSyncError("leads_unavailable", redact(errorMessage || `DWS 退出码 ${result.code}`));
  }
  if (payload.success === false || Object.keys(payloadError).length > 0) {
    throw new LeadsSyncError("leads_unavailable", redact(errorMessage || "DWS 返回 success=false"));
  }
  return payload;
}

interface RemoteQuery {
  readonly tableName: string;
  readonly nameOf: Readonly<Record<string, string>>;
  readonly viewId: string;
  readonly records: readonly Record<string, unknown>[];
}

/** 双命令 + 护栏①②：schema 读取（表名漂移/必需字段缺失即拒绝）→ 全量记录（分页必须完整结束）。 */
export async function queryRemote(config: LeadsConfig, run: LeadsCommandRunner, dwsBin: string): Promise<RemoteQuery> {
  const meta = await runDws(
    run,
    dwsBin,
    ["aitable", "table", "get", "--base-id", config.baseId, "--table-ids", config.tableId],
    TABLE_GET_TIMEOUT_MS,
  );
  const tables = Array.isArray(asRecord(meta.data).tables) ? (asRecord(meta.data).tables as unknown[]) : [];
  const table = asRecord(tables[0]);
  if (!table || table.tableId !== config.tableId) {
    throw new LeadsSyncError("leads_table_missing", "无法读回目标数据表，请核对 baseId/tableId");
  }
  const tableName = typeof table.tableName === "string" ? table.tableName : "";
  if (config.tableName && tableName !== config.tableName) {
    throw new LeadsSyncError("leads_table_drift", `数据表漂移：期望 ${config.tableName}，实到 ${tableName}`);
  }
  const fields = Array.isArray(table.fields) ? (table.fields as unknown[]) : [];
  const nameOf: Record<string, string> = {};
  for (const field of fields) {
    const record = asRecord(field);
    const fieldId = String(record.fieldId ?? "");
    const fieldName = String(record.fieldName ?? "");
    if (fieldId && fieldName) nameOf[fieldId] = fieldName;
  }
  const names = new Set(Object.values(nameOf));
  const missing = REQUIRED_FIELD_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new LeadsSyncError("leads_field_drift", `字段漂移：缺少 ${missing.join("、")}`);
  }

  const payload = await runDws(
    run,
    dwsBin,
    ["aitable", "record", "query", "--base-id", config.baseId, "--table-id", config.tableId, "--all", "--page-limit", "0"],
    RECORD_QUERY_TIMEOUT_MS,
  );
  const data = asRecord(payload.data);
  /* complete 字段仅新版 dws 返回；显式不完整或残留游标才拒绝（照静态版注释口径）。 */
  if (data.complete === false || data.hasMore === true || data.cursor || data.nextCursor) {
    throw new LeadsSyncError("leads_pagination", "AI 表格分页未完整结束，拒绝覆盖快照");
  }
  const records = (Array.isArray(data.records) ? data.records : []) as Record<string, unknown>[];
  if (data.fetchedCount != null && Number(data.fetchedCount) !== records.length) {
    throw new LeadsSyncError("leads_pagination", "AI 表格 fetchedCount 与记录数不一致");
  }
  const views = Array.isArray(table.views) ? (table.views as unknown[]) : [];
  const view = views
    .map((entry) => asRecord(entry))
    .find((entry) => typeof entry.viewId === "string" && (config.viewId ? entry.viewId === config.viewId : false));
  return {
    tableName,
    nameOf,
    viewId: typeof view?.viewId === "string" ? view.viewId : "",
    records,
  };
}

export interface PullOptions {
  readonly allowEmpty?: boolean;
  readonly allowShrink?: boolean;
}

export interface PullResult extends LeadsRefreshSummary {
  readonly snapshotRows: readonly LeadRow[];
  readonly tableName: string;
  readonly url: string;
  readonly priorityProvinces: readonly string[];
  readonly radarCmd: string;
}

async function readSnapshotFile(path: string): Promise<{ total: number; fetchedAt: string } | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8"));
    const stored = sanitizeStoredSnapshot(raw);
    return stored ? { total: stored.total, fetchedAt: stored.fetchedAt } : null;
  } catch {
    return null;
  }
}

/** 0600 原子写（唯一 tmp + rename），屋内 crm-bridge/maas-bridge 同口径（本仓无共享 secureWrite 工具）。
 * tmp 名带唯一后缀（评审 P2-1）：即便出现并发写也不会互踩同一临时文件。 */
async function secureWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, content, { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, path);
}

/** 拉取主流程：双命令 + 四重护栏③④ + 白名单映射 + 排序 → 原子写快照。护栏拒绝时旧快照原样保留。 */
export async function pull(options: {
  readonly config: LeadsConfig;
  readonly run: LeadsCommandRunner;
  readonly dwsBin: string;
  readonly snapshotPath: string;
  readonly now: () => number;
  readonly allowEmpty?: boolean;
  readonly allowShrink?: boolean;
}): Promise<PullResult> {
  const { config, run, dwsBin, snapshotPath, now } = options;
  const { tableName, nameOf, viewId, records } = await queryRemote(config, run, dwsBin);

  const previous = await readSnapshotFile(snapshotPath);
  const prevN = previous?.total ?? 0;
  if (!options.allowEmpty && prevN > 0 && records.length === 0) {
    throw new LeadsSyncError("leads_empty", "AI 表格意外为空，拒绝覆盖旧快照");
  }
  if (!options.allowShrink && prevN >= 10 && records.length < prevN * 0.5) {
    throw new LeadsSyncError("leads_shrink", `AI 表格记录数由 ${prevN} 降至 ${records.length}，拒绝覆盖旧快照`);
  }

  const rows = sortLeads(
    records
      .map((record) => {
        const id = typeof record.recordId === "string" ? record.recordId : "";
        return { id, ...normalizeLeadCells(record.cells, nameOf, config.priorityProvinces) };
      })
      .filter((row): row is LeadRow => row.name.length > 0 && row.id.length > 0),
  );
  const radarAt = rows.reduce((max, row) => (row.radarAt && row.radarAt > max ? row.radarAt : max), "");
  const viewSuffix = viewId ? `&viewId=${viewId}` : "";
  const url = `https://alidocs.dingtalk.com/i/nodes/${config.baseId}?entrance=data&sheetId=${config.tableId}${viewSuffix}`;
  const fetchedAt = new Date(now()).toISOString();
  const open = rows.filter((row) => ["ME", "A", "B", "B2"].includes(row.tier)).length;

  const snapshot = {
    fetchedAt,
    status: "ok",
    source: "dingtalk-aitable",
    tableName,
    url,
    radarAt,
    priorityProvinces: config.priorityProvinces,
    radarCmd: config.radarCmd,
    total: rows.length,
    rows,
  };
  await secureWrite(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  return {
    total: rows.length,
    open,
    radarAt,
    fetchedAt,
    snapshotRows: rows,
    tableName,
    url,
    priorityProvinces: config.priorityProvinces,
    radarCmd: config.radarCmd,
  };
}

export { DEFAULT_LEADS_CONFIG_PATH, DEFAULT_LEADS_SNAPSHOT_PATH, loadLeadsConfig };
