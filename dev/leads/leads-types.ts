/**
 * Contracts for the leads radar bridge (F5) — 钉钉 AI 表格「拓新企业清单」只读拉取。
 * Semantics ported from base/sa-workbench tools/sync/aitable_leads_sync.js
 * (搬语义不搬代码): external lead-radar writes the table, the workbench only
 * reads. 联系人字段（电话/邮箱/法定代表人）在 FIELD_MAP 白名单之外，物理不入快照。
 */

export type LeadTier = "ME" | "A" | "B" | "B2" | "A?" | "C" | "D" | "pending";

export interface LeadNews {
  readonly t: string;
  readonly u: string;
}

/** 快照行：与 FIELD_MAP 快照键一一对应；白名单外字段在 normalize 阶段即被丢弃。 */
export interface LeadRow {
  readonly id: string;
  readonly name: string;
  readonly legal: string;
  readonly crmName: string;
  readonly tierLabel: string;
  readonly tier: LeadTier;
  readonly crmState: string;
  readonly score: number | null;
  readonly priority: string;
  readonly province: string;
  readonly city: string;
  readonly track: string;
  readonly trackRaw: string;
  readonly summary: string;
  readonly signal: string;
  readonly round: string;
  readonly amount: string;
  readonly investors: string;
  readonly maas: string;
  readonly maasWhy: string;
  readonly maasProduct: string;
  readonly agent: string;
  readonly agentWhy: string;
  readonly risk: string;
  readonly aliRel: string;
  readonly sales: string;
  readonly team: string;
  readonly uids: number | null;
  readonly cid: string;
  readonly ecid: string;
  readonly mentions: number | null;
  readonly signalAt: string;
  readonly radarAt: string;
  readonly news: LeadNews | null;
  readonly sources: string;
  readonly founded: string;
  readonly regCap: string;
  readonly address: string;
  readonly founder: string;
  readonly website: string;
  readonly entStatus: string;
  readonly isPriority: boolean;
}

export interface LeadsConfig {
  readonly baseId: string;
  readonly tableId: string;
  readonly viewId: string;
  readonly tableName: string;
  readonly priorityProvinces: readonly string[];
  readonly radarCmd: string;
}

/**
 * Bridge snapshot: GET /local/leads 的 data。
 * - configured=false：未配置 .local-cache/leads.json（缺失/坏 JSON/缺 baseId 或 tableId）；
 * - hasData=false：配置在但还没有可读快照（尚未拉取过 / 快照文件损坏），note 如实说明。
 */
export interface LeadsSnapshot {
  readonly configured: boolean;
  readonly hasData: boolean;
  readonly configNote: string;
  readonly note: string;
  readonly fetchedAt: string;
  readonly tableName: string;
  readonly url: string;
  readonly radarAt: string;
  readonly radarCmd: string;
  readonly priorityProvinces: readonly string[];
  readonly total: number;
  readonly rows: readonly LeadRow[];
}

export interface LeadsRefreshSummary {
  readonly total: number;
  readonly open: number;
  readonly radarAt: string;
  readonly fetchedAt: string;
}

export interface LeadsRefreshResult {
  readonly summary: LeadsRefreshSummary;
  readonly snapshot: LeadsSnapshot;
}

export type LeadsSyncErrorCode =
  | "leads_unconfigured"
  | "leads_table_missing"
  | "leads_table_drift"
  | "leads_field_drift"
  | "leads_pagination"
  | "leads_empty"
  | "leads_shrink"
  | "leads_unavailable";

/** 护栏/上游失败的稳定错误码载体：路由按 code 映射 400/409/502，message 已过 redact。 */
export class LeadsSyncError extends Error {
  readonly code: LeadsSyncErrorCode;

  constructor(code: LeadsSyncErrorCode, message: string) {
    super(message);
    this.name = "LeadsSyncError";
    this.code = code;
  }
}
