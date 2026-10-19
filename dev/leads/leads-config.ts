import { readFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { DEFAULT_PRIORITY } from "./leads-model.ts";
import type { LeadsConfig } from "./leads-types.ts";

/**
 * Config for the leads radar bridge (F5). Shape mirrors base/sa-workbench
 * tools/aitable_leads.json.example; the real config lives at
 * .local-cache/leads.json (gitignored, personal-only).
 * Same contract as the cases/kb bridges: a missing or corrupt config means
 * "unconfigured" and answers honestly with configured:false — never throws,
 * never fabricates. 拉取快照写在 .local-cache/leads-snapshot.json，与配置分离：
 * 同一个文件既当配置又当快照会在首次 pull 时自毁 baseId/tableId。
 */

/* dev/leads/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_LEADS_CONFIG_PATH = joinPath(PROJECT_ROOT, ".local-cache", "leads.json");
export const DEFAULT_LEADS_SNAPSHOT_PATH = joinPath(PROJECT_ROOT, ".local-cache", "leads-snapshot.json");

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const NAME_PATTERN = /^[^<>{}\\]{1,60}$/;
const COMMAND_PATTERN = /^[^<>{}\\`|;&$]{0,120}$/;

const MAX_PRIORITY_PROVINCES = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 配置缺失/坏 JSON 之外的形态校验：ID/表名/省份/radarCmd 有界且无控制字符。 */
export function sanitizeLeadsConfig(raw: unknown): LeadsConfig | null {
  if (!isRecord(raw)) return null;
  const baseId = raw.baseId;
  const tableId = raw.tableId;
  if (typeof baseId !== "string" || !ID_PATTERN.test(baseId)) return null;
  if (typeof tableId !== "string" || !ID_PATTERN.test(tableId)) return null;
  const viewId = typeof raw.viewId === "string" && ID_PATTERN.test(raw.viewId) ? raw.viewId : "";
  const tableName = typeof raw.tableName === "string" && NAME_PATTERN.test(raw.tableName) ? raw.tableName : "拓新企业清单";
  const radarCmd = typeof raw.radarCmd === "string" && COMMAND_PATTERN.test(raw.radarCmd) ? raw.radarCmd.trim() : "";
  const priorityProvinces = (Array.isArray(raw.priorityProvinces) ? raw.priorityProvinces : [])
    .filter((item): item is string => typeof item === "string" && NAME_PATTERN.test(item.trim()) && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, MAX_PRIORITY_PROVINCES);
  return {
    baseId,
    tableId,
    viewId,
    tableName,
    priorityProvinces: priorityProvinces.length > 0 ? priorityProvinces : [...DEFAULT_PRIORITY],
    radarCmd,
  };
}

/** Missing / corrupt / 形态不符 → null（未配置），如实降级，绝不抛错、绝不造数据。 */
export async function loadLeadsConfig(configPath: string): Promise<LeadsConfig | null> {
  let raw: unknown;
  try {
    const text = await readFile(configPath, "utf-8");
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return sanitizeLeadsConfig(raw);
}

/** 快照文件只信白名单：读入时逐行投影（见 leads-model.projectLeadRow），坏行丢弃。 */
export interface StoredSnapshot {
  readonly fetchedAt: string;
  readonly tableName: string;
  readonly url: string;
  readonly radarAt: string;
  readonly radarCmd: string;
  readonly priorityProvinces: readonly string[];
  readonly total: number;
  readonly rows: readonly unknown[];
}

export function sanitizeStoredSnapshot(raw: unknown): StoredSnapshot | null {
  if (!isRecord(raw)) return null;
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    fetchedAt: text(raw.fetchedAt),
    tableName: text(raw.tableName),
    url: /^https?:\/\//i.test(text(raw.url)) ? text(raw.url) : "",
    radarAt: text(raw.radarAt),
    radarCmd: text(raw.radarCmd),
    priorityProvinces: (Array.isArray(raw.priorityProvinces) ? raw.priorityProvinces : [])
      .filter((item): item is string => typeof item === "string"),
    total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : rows.length,
    rows,
  };
}
