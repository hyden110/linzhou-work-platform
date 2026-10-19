import { existsSync as nodeExistsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_LEADS_CONFIG_PATH,
  DEFAULT_LEADS_SNAPSHOT_PATH,
  loadLeadsConfig,
  sanitizeStoredSnapshot,
} from "./leads-config.ts";
import { projectLeadRow } from "./leads-model.ts";
import {
  createDefaultLeadsRunner,
  pull,
  resolveDwsBin,
  type LeadsCommandRunner,
} from "./leads-sync.ts";
import { LeadsSyncError, type LeadRow, type LeadsRefreshResult, type LeadsSnapshot } from "./leads-types.ts";

/**
 * Leads radar bridge (F5) — 钉钉 AI 表格「拓新企业清单」只读桥。
 * - snapshot(): 读已有快照（低成本的本地文件读），无 → {configured:false}，坏 → hasData:false
 *   并在 note 如实说明；绝不自动触发 dws 拉取（12h TTL 低成本口径：手动刷新）。
 * - refresh(): 显式跑 pull（四重护栏），护栏错误带稳定错误码如实上抛，绝不降级覆盖旧快照。
 * 只读红线：仅 `aitable table get` / `aitable record query`，绝不回写 AI 表格。
 */

const UNCONFIGURED_NOTE = "未配置 .local-cache/leads.json（参考 config/leads.json.example）：补 baseId / tableId / viewId / tableName / priorityProvinces 五个键，并在启动桥的终端完成 dws auth login。";

export interface LeadsBridgeOptions {
  readonly configPath?: string;
  readonly snapshotPath?: string;
  readonly now?: () => number;
  readonly run?: LeadsCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
}

export interface LeadsBridge {
  readonly snapshot: () => Promise<LeadsSnapshot>;
  readonly refresh: (options?: { readonly allowEmpty?: boolean; readonly allowShrink?: boolean }) => Promise<LeadsRefreshResult>;
}

function emptySnapshot(configured: boolean, configNote: string, note: string): LeadsSnapshot {
  return {
    configured,
    hasData: false,
    configNote,
    note,
    fetchedAt: "",
    tableName: "",
    url: "",
    radarAt: "",
    radarCmd: "",
    priorityProvinces: [],
    total: 0,
    rows: [],
  };
}

export function createLeadsBridge(options: LeadsBridgeOptions = {}): LeadsBridge {
  const configPath = options.configPath ?? DEFAULT_LEADS_CONFIG_PATH;
  const snapshotPath = options.snapshotPath ?? DEFAULT_LEADS_SNAPSHOT_PATH;
  const now = options.now ?? Date.now;
  const run = options.run ?? createDefaultLeadsRunner();
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? nodeExistsSync;

  const readSnapshot = async (): Promise<{ stored: ReturnType<typeof sanitizeStoredSnapshot>; rows: readonly LeadRow[] } | null> => {
    try {
      const stored = sanitizeStoredSnapshot(JSON.parse(await readFile(snapshotPath, "utf-8")));
      if (!stored) return null;
      return { stored, rows: stored.rows.map(projectLeadRow).filter((row): row is LeadRow => row !== null) };
    } catch {
      return null;
    }
  };

  /* 评审 P2-1：refresh 单飞——并发调用共享同一 in-flight promise（不并行
     重复拉取、不互踩 tmp 写）；结束后清空允许下一次。 */
  let refreshInFlight: Promise<LeadsRefreshResult> | null = null;
  const runRefresh = async (refreshOptions: {
    readonly allowEmpty?: boolean;
    readonly allowShrink?: boolean;
  }): Promise<LeadsRefreshResult> => {
    const config = await loadLeadsConfig(configPath);
    if (!config) throw new LeadsSyncError("leads_unconfigured", UNCONFIGURED_NOTE);
    const dwsBin = resolveDwsBin(env, existsSync);
    const result = await pull({
      config,
      run,
      dwsBin,
      snapshotPath,
      now,
      allowEmpty: refreshOptions.allowEmpty === true,
      allowShrink: refreshOptions.allowShrink === true,
    });
    const snapshot = await (async (): Promise<LeadsSnapshot> => {
      const found = await readSnapshot();
      if (!found || !found.stored) {
        throw new LeadsSyncError("leads_unavailable", "拉取完成但快照读回失败，请重试");
      }
      return {
        configured: true,
        hasData: true,
        configNote: "",
        note: "",
        fetchedAt: found.stored.fetchedAt,
        tableName: found.stored.tableName,
        url: found.stored.url,
        radarAt: found.stored.radarAt,
        radarCmd: found.stored.radarCmd,
        priorityProvinces: found.stored.priorityProvinces,
        total: found.rows.length,
        rows: found.rows,
      };
    })();
    return {
      summary: { total: result.total, open: result.open, radarAt: result.radarAt, fetchedAt: result.fetchedAt },
      snapshot,
    };
  };

  return {
    snapshot: async (): Promise<LeadsSnapshot> => {
      const config = await loadLeadsConfig(configPath);
      if (!config) return emptySnapshot(false, UNCONFIGURED_NOTE, "");
      const found = await readSnapshot();
      if (!found || !found.stored) {
        return emptySnapshot(true, "", "配置已就绪，但本机尚无可读快照：点「刷新」做首次拉取（需 dws 已安装并完成 dws auth login）。");
      }
      return {
        configured: true,
        hasData: true,
        configNote: "",
        note: "",
        fetchedAt: found.stored.fetchedAt,
        tableName: found.stored.tableName,
        url: found.stored.url,
        radarAt: found.stored.radarAt,
        radarCmd: found.stored.radarCmd,
        priorityProvinces: found.stored.priorityProvinces,
        total: found.rows.length,
        rows: found.rows,
      };
    },

    refresh: (refreshOptions = {}) => {
      // 评审 P2-1：refresh 单飞——并发调用共享同一 in-flight promise（不并行
      // 重复拉取、不互踩 tmp 写）；结束后清空允许下一次。
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = runRefresh(refreshOptions).finally(() => {
        refreshInFlight = null;
      });
      return refreshInFlight;
    },
  };
}
