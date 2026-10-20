import type { LeadRow, LeadTier } from "./leads-client";

/**
 * 拓新雷达派生模型（纯函数，无 I/O、无时钟）。
 * 口径搬自 base/sa-workbench assets/pages/leads.js（搬语义不搬代码）：
 * - 判定档与 lead-radar crm.py TIERS 同口径；ME/A/B/B2 = 可 Name，A?/pending = 待确认；
 * - 行动清单 = 可 Name + A?，按建议动作分组，组内优先区域 → 综合分；
 * - 协同机会 = D（直销已占）且 MaaS 或 Agent 潜力为「高」；
 * - 赛道/区域分布按 track / province 聚合，省份缺失计入「未知」（不猜）。
 * 只基于快照已有白名单字段派生；字段为空一律如实为空/「—」，绝不编造。
 */

export type TierTone = "open" | "apply" | "confirm" | "partner" | "pending" | "taken";

export interface TierMeta {
  readonly label: string;
  readonly short: string;
  readonly action: string;
  readonly tone: TierTone;
}

export const LEAD_TIER_ORDER: readonly LeadTier[] = ["ME", "A", "B", "B2", "A?", "C", "pending", "D"];

export const LEAD_TIER_META: Readonly<Record<LeadTier, TierMeta>> = {
  ME: { label: "★ 已在我名下", short: "ME", action: "纳入客户经营", tone: "open" },
  A: { label: "A 可直接 Name", short: "A", action: "鲲鹏发起 Name 申请", tone: "open" },
  B: { label: "B 可申请", short: "B", action: "仅电销 / 挖掘关联，申请关联", tone: "apply" },
  B2: { label: "B2 直销无业绩", short: "B2", action: "直销关联但无 UID，申请关联", tone: "apply" },
  "A?": { label: "A? 待人工确认", short: "A?", action: "鲲鹏人工核实实体后再判定", tone: "confirm" },
  C: { label: "C 伙伴关联", short: "C", action: "评估伙伴协同", tone: "partner" },
  pending: { label: "待雷达扫描", short: "待扫", action: "跑雷达 CRM 扫描补判定", tone: "pending" },
  D: { label: "D 直销已占用", short: "D", action: "联系跟进人做方案协同", tone: "taken" },
};

const OPEN_TIERS: ReadonlySet<LeadTier> = new Set<LeadTier>(["ME", "A", "B", "B2"]);
const CONFIRM_TIERS: ReadonlySet<LeadTier> = new Set<LeadTier>(["A?", "pending"]);
const ACTION_TIERS: readonly LeadTier[] = ["ME", "A", "B", "B2", "A?"];
const HIGH = "高";
const DAY_MS = 86_400_000;
const RECENT_DAYS = 7;
export const EMPTY_VALUE = "—";

export function isOpenLead(row: LeadRow): boolean {
  return OPEN_TIERS.has(row.tier);
}

export function needsConfirm(row: LeadRow): boolean {
  return CONFIRM_TIERS.has(row.tier);
}

function countWhere(rows: readonly LeadRow[], predicate: (row: LeadRow) => boolean): number {
  return rows.reduce((total, row) => (predicate(row) ? total + 1 : total), 0);
}

/** 信号时间距今天数；空串/坏值返回 null（不计入「近 7 天」）。 */
function signalAgeDays(signalAt: string, nowMs: number): number | null {
  const at = Date.parse(signalAt);
  return Number.isFinite(at) ? (nowMs - at) / DAY_MS : null;
}

export interface LeadKpis {
  readonly total: number;
  readonly recent7: number;
  readonly open: number;
  readonly openDirect: number;
  readonly openApply: number;
  readonly confirm: number;
  readonly confirmManual: number;
  readonly confirmPending: number;
  readonly priority: number;
  readonly priorityActionable: number;
}

export function leadKpis(rows: readonly LeadRow[], nowMs: number): LeadKpis {
  const priorityRows = rows.filter((row) => row.isPriority);
  return {
    total: rows.length,
    recent7: countWhere(rows, (row) => {
      const age = signalAgeDays(row.signalAt, nowMs);
      return age !== null && age <= RECENT_DAYS;
    }),
    open: countWhere(rows, isOpenLead),
    openDirect: countWhere(rows, (row) => row.tier === "A"),
    openApply: countWhere(rows, (row) => row.tier === "B" || row.tier === "B2"),
    confirm: countWhere(rows, needsConfirm),
    confirmManual: countWhere(rows, (row) => row.tier === "A?"),
    confirmPending: countWhere(rows, (row) => row.tier === "pending"),
    priority: priorityRows.length,
    priorityActionable: countWhere(priorityRows, (row) => isOpenLead(row) || needsConfirm(row)),
  };
}

export interface TierSlice extends TierMeta {
  readonly tier: LeadTier;
  readonly count: number;
  readonly percent: number;
}

export function tierDistribution(rows: readonly LeadRow[]): TierSlice[] {
  const total = rows.length;
  return LEAD_TIER_ORDER.map((tier) => {
    const count = countWhere(rows, (row) => row.tier === tier);
    return { ...LEAD_TIER_META[tier], tier, count, percent: total ? Math.round((count * 100) / total) : 0 };
  });
}

/** 优先区域在前，再按综合分降序（无分排最后）。 */
function byPriorityThenScore(a: LeadRow, b: LeadRow): number {
  return Number(b.isPriority) - Number(a.isPriority) || (b.score ?? -1) - (a.score ?? -1);
}

export interface ActionGroup extends TierMeta {
  readonly tier: LeadTier;
  readonly total: number;
  readonly items: readonly LeadRow[];
}

export function actionPlan(rows: readonly LeadRow[], perGroup: number): ActionGroup[] {
  const limit = Math.max(0, Math.floor(perGroup));
  return ACTION_TIERS
    .map((tier) => {
      const matched = rows.filter((row) => row.tier === tier);
      return {
        ...LEAD_TIER_META[tier],
        tier,
        total: matched.length,
        items: [...matched].sort(byPriorityThenScore).slice(0, limit),
      };
    })
    .filter((group) => group.total > 0);
}

/** 跟进人字段取第一位并去掉「(已关联)」后缀；为空如实返回空串。 */
export function primaryOwner(sales: string): string {
  const first = String(sales ?? "").split(/[；;]/)[0] ?? "";
  return first.replace(/[(（]已关联[)）]/g, "").trim();
}

export interface CoopLead {
  readonly row: LeadRow;
  readonly owner: string;
}

export interface CoopSummary {
  readonly total: number;
  readonly items: readonly CoopLead[];
}

export function coopOpportunities(rows: readonly LeadRow[], limit: number): CoopSummary {
  const matched = rows.filter((row) => row.tier === "D" && (row.maas === HIGH || row.agent === HIGH));
  const items = [...matched]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((row) => ({ row, owner: primaryOwner(row.sales) }));
  return { total: matched.length, items };
}

export interface DistBucket {
  readonly key: string;
  readonly count: number;
  readonly open: number;
  readonly priority: boolean;
}

export type DistDimension = "track" | "region";

const UNKNOWN_REGION = "未知";
const OTHER_TRACK = "其他";

function distKey(row: LeadRow, by: DistDimension): string {
  return by === "track" ? row.track || OTHER_TRACK : row.province || UNKNOWN_REGION;
}

export function leadDistribution(rows: readonly LeadRow[], by: DistDimension): DistBucket[] {
  const buckets = rows.reduce<ReadonlyMap<string, DistBucket>>((acc, row) => {
    const key = distKey(row, by);
    const prev = acc.get(key) ?? { key, count: 0, open: 0, priority: false };
    const next: DistBucket = {
      key,
      count: prev.count + 1,
      open: prev.open + (isOpenLead(row) ? 1 : 0),
      priority: by === "region" && (prev.priority || row.isPriority),
    };
    return new Map(acc).set(key, next);
  }, new Map());
  /* 同数量保持首次出现顺序（Array.prototype.sort 稳定）。 */
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

export type LeadTierFilter = "all" | "open" | "confirm" | LeadTier;
export type LeadSort = "snapshot" | "score" | "signal";

export interface LeadQuery {
  readonly tier: LeadTierFilter;
  readonly track: string;
  readonly province: string;
  readonly crmState: string;
  readonly q: string;
  readonly sort: LeadSort;
}

function matchesTier(row: LeadRow, tier: LeadTierFilter): boolean {
  if (tier === "all") return true;
  if (tier === "open") return isOpenLead(row);
  if (tier === "confirm") return needsConfirm(row);
  return row.tier === tier;
}

function haystack(row: LeadRow): string {
  return [row.name, row.legal, row.crmName, row.summary, row.track, row.trackRaw, row.city, row.province, row.investors]
    .join(" ")
    .toLowerCase();
}

function matchesKeyword(row: LeadRow, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = haystack(row);
  return words.every((word) => hay.includes(word));
}

function sortRows(rows: readonly LeadRow[], sort: LeadSort): LeadRow[] {
  if (sort === "score") return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (sort === "signal") {
    return [...rows].sort((a, b) => {
      if (!a.signalAt || !b.signalAt) return Number(Boolean(b.signalAt)) - Number(Boolean(a.signalAt));
      return b.signalAt.localeCompare(a.signalAt);
    });
  }
  return [...rows];
}

export function filterLeads(rows: readonly LeadRow[], query: LeadQuery): LeadRow[] {
  const matched = rows.filter((row) =>
    matchesTier(row, query.tier)
    && (!query.track || row.track === query.track)
    && (!query.province || row.province === query.province)
    && (!query.crmState || row.crmState === query.crmState)
    && matchesKeyword(row, query.q));
  return sortRows(matched, query.sort);
}

export interface DrawerFact {
  readonly label: string;
  readonly value: string;
}

export interface LeadDrawerSection {
  readonly title: string;
  readonly facts: readonly DrawerFact[];
  readonly notes: readonly DrawerFact[];
}

function orDash(value: string | number | null): string {
  if (value === null || value === "") return EMPTY_VALUE;
  return String(value);
}

function clockText(value: string): string {
  return value.length >= 16 ? value.slice(0, 16).replace("T", " ") : value;
}

function toNotes(pairs: ReadonlyArray<readonly [string, string]>): DrawerFact[] {
  return pairs.filter(([, value]) => value !== "").map(([label, value]) => ({ label, value }));
}

function toFacts(pairs: ReadonlyArray<readonly [string, string | number | null]>): DrawerFact[] {
  return pairs.map(([label, value]) => ({ label, value: orDash(value) }));
}

/** 抽屉分节：只读白名单字段；空值统一「—」，空的长文本备注不出现。链接字段由视图按 http(s) 护栏渲染。 */
export function leadDrawerSections(row: LeadRow): LeadDrawerSection[] {
  const meta = LEAD_TIER_META[row.tier];
  return [
    {
      title: "Name 判定与行动",
      facts: toFacts([
        ["判定", row.tierLabel || meta.label], ["建议动作", meta.action], ["CRM 状态", row.crmState],
        ["CRM 客户名", row.crmName], ["关联 UID 数", row.uids], ["CID", row.cid], ["ECID", row.ecid],
      ]),
      notes: toNotes([["跟进人", row.sales], ["跟进团队", row.team], ["阿里关联", row.aliRel]]),
    },
    {
      title: "价值判断",
      facts: toFacts([["MaaS 匹配", row.maas], ["Agent 席位潜力", row.agent], ["MaaS 产品", row.maasProduct]]),
      notes: toNotes([["MaaS 分析", row.maasWhy], ["Agent 分析", row.agentWhy], ["竞争风险", row.risk]]),
    },
    {
      title: "拓新信号",
      facts: toFacts([
        ["信号类型", row.signal], ["融资阶段", row.round], ["最新融资额", row.amount],
        ["近 14 天提及", row.mentions === null ? null : `${row.mentions} 次`],
        ["最新信号", clockText(row.signalAt)], ["信源", row.sources],
      ]),
      notes: toNotes([["投资方", row.investors], ["原始赛道", row.trackRaw]]),
    },
    {
      title: "企业信息",
      facts: toFacts([
        ["法律实体", row.legal], ["区域", [row.province, row.city].filter(Boolean).join(" · ")],
        ["成立日期", row.founded], ["注册资本", row.regCap], ["创始人", row.founder], ["登记状态", row.entStatus],
      ]),
      notes: toNotes([["注册地址", row.address]]),
    },
  ];
}
