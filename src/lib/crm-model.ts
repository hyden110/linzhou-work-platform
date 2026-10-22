import type {
  CrmSnapshot,
  CustomerItem,
  GroupItem,
  MentionItem,
  OverviewMetric,
  ProjectItem,
  TopChecks,
  TopCustomerItem,
  UnreadItem,
} from "./crm-types";
import { DEFAULT_GAAP_THRESHOLDS, type GaapThresholds } from "./gaap-thresholds.ts";

export type StageId = "A" | "B" | "C" | "D";

export const STAGES: readonly { id: StageId; label: string; hint: string }[] = [
  { id: "A", label: "线索 / 拓展", hint: "潜在商机，或尚无项目与消耗" },
  { id: "B", label: "方案 / POC", hint: "技术方案与验证阶段" },
  { id: "C", label: "商务 / 签约", hint: "签约完成或刚开始上量" },
  { id: "D", label: "已落地运营", hint: "收入确认 / 上量结束，或上月有 GAAP 消耗且无在途项目" },
];

// Codes read back from 鲲鹏 projectStage across all 153 in-flight projects on
// 2026-10-14. Codes 8/9/12 were never observed, so they fall through to the label.
const STAGE_BY_CODE: Readonly<Record<string, StageId>> = {
  "1": "A", "2": "A", "3": "B", "4": "C", "5": "C",
  "6": "C", "7": "C", "10": "D", "11": "D",
};
const STAGE_BY_NAME: Readonly<Record<StageId, readonly string[]>> = {
  D: ["收入确认", "上量结束"],
  C: ["商务", "谈判", "签约", "合同", "赢单", "上量"],
  B: ["技术方案", "方案", "POC", "测试", "验证", "试用"],
  A: ["潜在商机", "商机确认"],
};
const CLOSED_STATE = /COMPLETED|CLOSED|LOST|已完成|已关闭|输单|关闭/i;
const STAGE_RANK: Record<StageId, number> = { A: 1, B: 2, C: 3, D: 4 };

const DAY_MS = 86_400_000;

export function parseLocalTime(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value ?? "");
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isActiveProject(project: ProjectItem): boolean {
  return !CLOSED_STATE.test(project.state ?? "");
}

export function projectStage(project: ProjectItem): StageId {
  const byCode = STAGE_BY_CODE[project.stage ?? ""];
  if (byCode) return byCode;
  const name = (project.stageName ?? "").toUpperCase();
  for (const stage of ["D", "C", "B", "A"] as const) {
    if (STAGE_BY_NAME[stage].some((word) => name.includes(word.toUpperCase()))) return stage;
  }
  const winRate = project.winRate ?? 0;
  if (winRate >= 60) return "C";
  if (winRate >= 20) return "B";
  return "A";
}

export interface CustomerLifecycle {
  customer: CustomerItem;
  stage: StageId;
  leadProject: ProjectItem | null;
  activeProjects: ProjectItem[];
}

export function projectsByCustomer(customers: readonly CustomerItem[], projects: readonly ProjectItem[]) {
  const byName = new Map(customers.map((customer) => [customer.name, customer.cid]));
  const grouped = new Map<string, ProjectItem[]>();
  for (const project of projects) {
    const cid = project.cid ?? (project.customerName ? byName.get(project.customerName) : undefined);
    if (!cid) continue;
    grouped.set(cid, [...(grouped.get(cid) ?? []), project]);
  }
  return grouped;
}

export function customerLifecycle(customer: CustomerItem, projects: readonly ProjectItem[]): CustomerLifecycle {
  const activeProjects = projects.filter(isActiveProject);
  if (activeProjects.length === 0) {
    const stage: StageId = (customer.lastMonthGaap ?? 0) > 0 ? "D" : "A";
    return { customer, stage, leadProject: null, activeProjects };
  }
  const leadProject = activeProjects.reduce((best, project) =>
    STAGE_RANK[projectStage(project)] > STAGE_RANK[projectStage(best)] ? project : best);
  return { customer, stage: projectStage(leadProject), leadProject, activeProjects };
}

export interface StageColumn {
  stage: (typeof STAGES)[number];
  customers: CustomerLifecycle[];
  gaap: number;
}

export function lifecycleBoard(snapshot: Pick<CrmSnapshot, "customers" | "projects">): StageColumn[] {
  const grouped = projectsByCustomer(snapshot.customers, snapshot.projects);
  const rows = snapshot.customers.map((customer) => customerLifecycle(customer, grouped.get(customer.cid) ?? []));
  return STAGES.map((stage) => {
    const customers = rows
      .filter((row) => row.stage === stage.id)
      .sort((a, b) => (b.customer.lastMonthGaap ?? 0) - (a.customer.lastMonthGaap ?? 0));
    const gaap = customers.reduce((sum, row) => sum + (row.customer.lastMonthGaap ?? 0), 0);
    return { stage, customers, gaap };
  });
}

// ---------------------------------------------------------------------------
// 客户盘面：总览指标 / TOP 榜 / 分层视图
// ---------------------------------------------------------------------------

// Metric ids read back from 鲲鹏 `overview --view-id 186` on 2026-10-15. The real
// number lives in the `data` field; the API's `value` field only mirrors the id.
const CUSTOMER_COUNT_METRIC = "25";
const YESTERDAY_GAAP_METRIC = "26";
const GAAP_DIFF_METRIC = "27";
const GAAP_RATE_METRIC = "28";
const PROJECT_COUNT_METRIC = "47";

export interface OverviewBoard {
  customerCount: number | null;
  /** 总览客户数与客户列表是否一致；不一致时 UI 必须显式标注「口径待确认」。 */
  customerCountMatches: boolean;
  yesterdayGaap: number | null;
  yesterdayGaapDiff: number | null;
  yesterdayGaapRate: number | null;
  projectCount: number | null;
  lastMonthGaapSum: number;
  /** 昨日 GAAP 指标是否由鲲鹏标注为「支付口径」。 */
  payBasis: boolean;
}

export function overviewBoard(snapshot: Pick<CrmSnapshot, "overview" | "customers">): OverviewBoard {
  const byId = new Map<string, OverviewMetric>();
  for (const metric of snapshot.overview) {
    if (metric.id !== null) byId.set(metric.id, metric);
  }
  const value = (id: string) => byId.get(id)?.value ?? null;
  const customerCount = value(CUSTOMER_COUNT_METRIC);
  return {
    customerCount,
    customerCountMatches: customerCount !== null && customerCount === snapshot.customers.length,
    yesterdayGaap: value(YESTERDAY_GAAP_METRIC),
    yesterdayGaapDiff: value(GAAP_DIFF_METRIC),
    yesterdayGaapRate: value(GAAP_RATE_METRIC),
    projectCount: value(PROJECT_COUNT_METRIC),
    lastMonthGaapSum: snapshot.customers.reduce((sum, customer) => sum + (customer.lastMonthGaap ?? 0), 0),
    payBasis: byId.get(YESTERDAY_GAAP_METRIC)?.category === "支付口径",
  };
}

export interface TopBoard {
  items: TopCustomerItem[];
  total: number | null;
  queriedAt: string | null;
  orderBy: string | null;
  checks: TopChecks | null;
  /** 鲲鹏自检未通过（或没有 checks 元信息）时为 false，UI 必须醒目告警。 */
  checksOk: boolean;
}

export function topBoard(snapshot: Pick<CrmSnapshot, "top" | "sources">): TopBoard {
  const source = snapshot.sources.top;
  const checks = source?.checks ?? null;
  return {
    items: snapshot.top,
    total: source?.total ?? null,
    queriedAt: source?.queriedAt ?? null,
    orderBy: source?.orderBy ?? null,
    checks,
    checksOk: checks === null ? true : checks.gaapMonotonicDesc && checks.countWithinLimit,
  };
}

export function customersByGaap(customers: readonly CustomerItem[]): CustomerItem[] {
  return [...customers].sort(
    (a, b) => (b.lastMonthGaap ?? 0) - (a.lastMonthGaap ?? 0) || a.name.localeCompare(b.name, "zh-CN"),
  );
}

// ---------------------------------------------------------------------------
// GAAP 异动分析：昨日环比 / 绝对变动检测（阈值可配，纯函数可测）
// ---------------------------------------------------------------------------

/**
 * 三档阈值 + 低基数门槛：单一事实源在 gaap-thresholds.ts（工单 #10074 R1 配置化）。
 * 保留既有导出名（特征基线与既有引用沿用）；判定代码不得再持有阈值字面量副本，
 * 一律经 thresholds 参数取值，默认值 = 现状值（判定语义与默认结果零变化）。
 */
export const GAAP_ALERT_THRESHOLDS = DEFAULT_GAAP_THRESHOLDS;

export type GaapAlertTier = "T1" | "T2" | "T3";
export type GaapAlertDirection = "up" | "down";

export interface GaapAlert {
  customer: CustomerItem;
  direction: GaapAlertDirection;
  tier: GaapAlertTier;
  /** 昨日环比（百分点，带符号）。 */
  rate: number;
  /** 昨日涨跌额（元，带符号）；rate ≤ -100% 无法反推时为 null。 */
  diff: number | null;
  /** 上月 GAAP 基数（元）。 */
  basis: number | null;
  /** 上月基数低于门槛：环比命中可信度低，仅作提示。 */
  lowBase: boolean;
  /** diff 由 rate 反推（快照无 extGaapDDiff 投影的旧数据），UI 标「推算值」。 */
  estimatedDiff: boolean;
}

const TIER_RANK: Record<GaapAlertTier, number> = { T1: 1, T2: 2, T3: 3 };

/** 单客户异动判定；无环比 / 环比为 0 / 昨日值缺失 → null（不上报）。阈值可注入（缺省=现状默认）。 */
export function gaapAnomaly(
  customer: CustomerItem,
  thresholds: GaapThresholds = GAAP_ALERT_THRESHOLDS,
): GaapAlert | null {
  const rate = customer.yesterdayGaapRate;
  const yesterday = customer.yesterdayGaap;
  if (rate === null || rate === undefined || rate === 0 || yesterday === null || yesterday === undefined) {
    return null;
  }
  const direction: GaapAlertDirection = rate > 0 ? "up" : "down";
  const basis = customer.lastMonthGaap ?? null;
  const lowBase = (customer.lastMonthGaap ?? 0) < thresholds.lowBaseGaap;

  // diff：优先用鲲鹏自带的涨跌额；旧快照缺失时按 rate 反推（rate > -100% 才有定义）。
  let diff: number | null = customer.yesterdayGaapDiff ?? null;
  let estimatedDiff = false;
  if (diff === null) {
    estimatedDiff = true;
    diff = rate > -100 ? yesterday * (rate / 100) / (1 + rate / 100) : null;
  }

  const tiers: GaapAlertTier[] = [];
  if (Math.abs(rate) >= thresholds.rateSevere) tiers.push("T3");
  // 绝对档受低基数门槛约束：上月基数不足时不报绝对档（避免小客户噪声）。
  if (diff !== null && !lowBase) {
    if (Math.abs(diff) >= thresholds.absoluteWatch) tiers.push("T2");
    else if (Math.abs(diff) >= thresholds.absoluteNotice) tiers.push("T1");
  }
  if (tiers.length === 0) return null;
  const tier = tiers.reduce((best, next) => (TIER_RANK[next] > TIER_RANK[best] ? next : best));

  return { customer, direction, tier, rate, diff, basis, lowBase, estimatedDiff };
}

/** 全量客户异动检测：按档位降序、同档按 |rate| 降序。阈值透传给单客户判定。 */
export function gaapAnomalies(
  customers: readonly CustomerItem[],
  thresholds: GaapThresholds = GAAP_ALERT_THRESHOLDS,
): GaapAlert[] {
  return customers
    .flatMap((customer) => {
      const alert = gaapAnomaly(customer, thresholds);
      return alert ? [alert] : [];
    })
    .sort((a, b) =>
      TIER_RANK[b.tier] - TIER_RANK[a.tier]
      || Math.abs(b.rate) - Math.abs(a.rate)
      || a.customer.name.localeCompare(b.customer.name, "zh-CN"));
}

export type Urgency = "overdue" | "today" | "soon" | "watch";

export interface ActionItem {
  id: string;
  kind: "todo" | "meeting" | "mention";
  title: string;
  detail: string;
  at: number | null;
  urgency: Urgency;
}

const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, today: 1, soon: 2, watch: 3 };
const HIGH_PRIORITY = 30;
const TODO_SOON_MS = 3 * DAY_MS;

function todoActions(snapshot: Pick<CrmSnapshot, "todos">, now: number, todayEnd: number): ActionItem[] {
  return snapshot.todos.flatMap((todo): ActionItem[] => {
    // 旧快照没有 done 字段：缺省视为未完成；已完成项不再进入行动队列。
    if (todo.done === true) return [];
    const urgency: Urgency | null = todo.dueAt === null
      ? (todo.priority >= HIGH_PRIORITY ? "watch" : null)
      : todo.dueAt < now ? "overdue"
        : todo.dueAt < todayEnd ? "today"
          : todo.dueAt < now + TODO_SOON_MS ? "soon" : null;
    if (!urgency) return [];
    const detail = todo.priority >= HIGH_PRIORITY ? "高优先级待办" : "待办";
    return [{ id: `todo:${todo.id}`, kind: "todo", title: todo.title, detail, at: todo.dueAt, urgency }];
  });
}

function meetingActions(snapshot: Pick<CrmSnapshot, "agenda">, now: number, todayEnd: number): ActionItem[] {
  return snapshot.agenda.flatMap((event): ActionItem[] => {
    const start = parseLocalTime(event.start);
    const end = parseLocalTime(event.end) ?? start;
    if (start === null || (end ?? start) < now || start >= todayEnd + DAY_MS) return [];
    const urgency: Urgency = start < todayEnd ? "today" : "soon";
    return [{ id: `meeting:${event.id}`, kind: "meeting", title: event.title, detail: "日程", at: start, urgency }];
  });
}

function mentionActions(snapshot: Pick<CrmSnapshot, "mentions">, now: number): ActionItem[] {
  const todayStart = startOfDay(now);
  return snapshot.mentions.flatMap((mention): ActionItem[] => {
    const at = parseLocalTime(mention.time);
    if (at === null || at > now) return [];
    const urgency: Urgency = at >= todayStart ? "today" : at >= todayStart - DAY_MS ? "soon" : "watch";
    const detail = [mention.conversationName, mention.sender].filter(Boolean).join(" · ") || "钉钉 @我";
    return [{ id: `mention:${mention.id}`, kind: "mention", title: mention.text || "（无内容）", detail, at, urgency }];
  });
}

export function actionQueue(
  snapshot: Pick<CrmSnapshot, "todos" | "agenda" | "mentions">,
  now: number,
): ActionItem[] {
  const todayEnd = startOfDay(now) + DAY_MS;
  return [
    ...todoActions(snapshot, now, todayEnd),
    ...meetingActions(snapshot, now, todayEnd),
    ...mentionActions(snapshot, now),
  ].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || byTime(a, b));
}

/** 同档内：时间敏感项（会议/待办）按临近顺序；@我 是响应型动作，组内最新优先。 */
const KIND_TIER: Record<ActionItem["kind"], number> = { meeting: 0, todo: 0, mention: 1 };

function byTime(a: ActionItem, b: ActionItem): number {
  // Most recently overdue first; long-stale items sink instead of crowding the top.
  if (a.urgency === "overdue") return (b.at ?? -Infinity) - (a.at ?? -Infinity);
  const tier = KIND_TIER[a.kind] - KIND_TIER[b.kind];
  if (tier !== 0) return tier;
  if (a.kind === "mention") return (b.at ?? -Infinity) - (a.at ?? -Infinity);
  return (a.at ?? Infinity) - (b.at ?? Infinity);
}

// ---------------------------------------------------------------------------
// PPL 跟进：MaaS 三态泳道（过渡口径 = 关键词初筛 + 人工覆盖，cate 禁止映射）
// ---------------------------------------------------------------------------

export type MaasStatus = "maas" | "non_maas" | "unconfirmed";
export type MaasBasis = "override" | "keyword" | "none";

export interface MaasDecision {
  status: MaasStatus;
  /** 判定来源：override=人工覆盖（可审计）/ keyword=关键词初筛（UI 标「疑似」）/ none=无法判定。 */
  basis: MaasBasis;
}

/**
 * MaaS 关键词初筛表（过渡方案占位词表，待用户确认后替换；不作业务口径）。
 * 仅匹配项目名/客户名；cate（混合云/公有云/国际）与 MaaS 维度无关，禁止映射。
 */
export const MAAS_KEYWORDS: readonly string[] = ["MaaS", "大模型", "模型服务", "百炼", "推理"];

/** 人工覆盖表（CID → maas/non_maas），优先级最高。 */
export type MaasOverrides = Readonly<Record<string, "maas" | "non_maas">>;

export function classifyMaas(
  customer: CustomerItem,
  projects: readonly ProjectItem[],
  overrides: MaasOverrides = {},
): MaasDecision {
  const override = overrides[customer.cid];
  if (override === "maas" || override === "non_maas") return { status: override, basis: "override" };
  const haystack = [customer.name, ...projects.map((project) => project.name)].join(" ").toLowerCase();
  if (MAAS_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return { status: "maas", basis: "keyword" };
  }
  // 不硬二分：无法判定一律「未分类」，不静默归入非 MaaS。
  return { status: "unconfirmed", basis: "none" };
}

export interface PplFollowupCustomer {
  customer: CustomerItem;
  maas: MaasDecision;
  /** 该客户的全部快照项目（--state normal 口径）。 */
  projects: ProjectItem[];
}

export interface PplFollowupBoard {
  lanes: Readonly<Record<MaasStatus, PplFollowupCustomer[]>>;
  /** cid/customerName 均匹配不上客户的项目：显式列出，绝不静默丢弃。 */
  unmatched: ProjectItem[];
  counts: {
    customers: number;
    maas: number;
    nonMaas: number;
    unconfirmed: number;
    projects: number;
    unmatched: number;
  };
}

const FOLLOWUP_LANES: readonly MaasStatus[] = ["maas", "non_maas", "unconfirmed"];

export function pplFollowupBoard(
  snapshot: Pick<CrmSnapshot, "customers" | "projects">,
  overrides: MaasOverrides = {},
): PplFollowupBoard {
  const byCid = new Map(snapshot.customers.map((customer) => [customer.cid, customer]));
  const byName = new Map(snapshot.customers.map((customer) => [customer.name, customer]));
  const grouped = new Map<string, ProjectItem[]>();
  const unmatched: ProjectItem[] = [];
  for (const project of snapshot.projects) {
    const cid = project.cid && byCid.has(project.cid)
      ? project.cid
      : project.customerName ? byName.get(project.customerName)?.cid : undefined;
    if (!cid) {
      unmatched.push(project);
      continue;
    }
    grouped.set(cid, [...(grouped.get(cid) ?? []), project]);
  }
  const lanes: Record<MaasStatus, PplFollowupCustomer[]> = { maas: [], non_maas: [], unconfirmed: [] };
  for (const customer of snapshot.customers) {
    const projects = grouped.get(customer.cid) ?? [];
    const decision = classifyMaas(customer, projects, overrides);
    lanes[decision.status].push({ customer, maas: decision, projects });
  }
  for (const lane of FOLLOWUP_LANES) {
    lanes[lane].sort((a, b) =>
      (b.customer.lastMonthGaap ?? 0) - (a.customer.lastMonthGaap ?? 0)
      || a.customer.name.localeCompare(b.customer.name, "zh-CN"));
  }
  return {
    lanes,
    unmatched,
    counts: {
      customers: snapshot.customers.length,
      maas: lanes.maas.length,
      nonMaas: lanes.non_maas.length,
      unconfirmed: lanes.unconfirmed.length,
      projects: snapshot.projects.length,
      unmatched: unmatched.length,
    },
  };
}

/**
 * 阶段筛选（stageName 精确匹配，null = 全部）：无命中项目的客户隐藏，
 * 项目计数守恒——各泳道可见项目 + 未匹配 = 该阶段的项目总数。
 */
export function filterFollowupByStage(board: PplFollowupBoard, stageName: string | null): PplFollowupBoard {
  if (stageName === null) return board;
  const keep = (project: ProjectItem) => (project.stageName ?? "") === stageName;
  const lanes = { maas: [], non_maas: [], unconfirmed: [] } as Record<MaasStatus, PplFollowupCustomer[]>;
  for (const lane of FOLLOWUP_LANES) {
    lanes[lane] = board.lanes[lane]
      .map((row) => ({ ...row, projects: row.projects.filter(keep) }))
      .filter((row) => row.projects.length > 0);
  }
  const unmatched = board.unmatched.filter(keep);
  const visibleProjects = FOLLOWUP_LANES.reduce(
    (sum, lane) => sum + lanes[lane].reduce((count, row) => count + row.projects.length, 0),
    0,
  ) + unmatched.length;
  return {
    lanes,
    unmatched,
    counts: {
      customers: FOLLOWUP_LANES.reduce((sum, lane) => sum + lanes[lane].length, 0),
      maas: lanes.maas.length,
      nonMaas: lanes.non_maas.length,
      unconfirmed: lanes.unconfirmed.length,
      projects: visibleProjects,
      unmatched: unmatched.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 钉群盘面：群 ↔ 客户匹配 / @我 / 未读
// ---------------------------------------------------------------------------

/** 归一化群/客户名再做匹配：去空白、去装饰性括号与连接符、统一小写。 */
export function normalizeGroupName(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[「」【】\[\]（）()《》<>]/g, "")
    .replace(/[-_·—–|/+&]/g, "")
    .toLowerCase();
}

/** 模糊匹配时较短一方的最小长度：低于此长度的重叠（如「云」）视为噪声。 */
const MIN_FUZZY_LENGTH = 4;

export type GroupLinkStatus = "linked" | "unconfirmed";

export interface GroupLink {
  group: GroupItem;
  customer: CustomerItem;
  status: GroupLinkStatus;
}

interface NameEntry {
  customer: CustomerItem;
  norm: string;
}

/** 匹配分级：精确或客户名完整前后缀 → 已关联；仅中缀互相包含 → 待确认。 */
function matchGroup(norm: string, entries: readonly NameEntry[]): { customer: CustomerItem; status: GroupLinkStatus } | null {
  if (norm.length === 0) return null;
  const exact = entries.find((entry) => entry.norm === norm);
  if (exact) return { customer: exact.customer, status: "linked" };
  const longest = (candidates: readonly NameEntry[]) =>
    [...candidates].sort((a, b) =>
      b.norm.length - a.norm.length || a.customer.name.localeCompare(b.customer.name, "zh-CN"))[0]!;
  const strong = entries.filter((entry) =>
    entry.norm.length >= MIN_FUZZY_LENGTH && (norm.startsWith(entry.norm) || norm.endsWith(entry.norm)));
  if (strong.length > 0) return { customer: longest(strong).customer, status: "linked" };
  const weak = entries.filter((entry) => {
    const shorter = Math.min(entry.norm.length, norm.length);
    return shorter >= MIN_FUZZY_LENGTH && (entry.norm.includes(norm) || norm.includes(entry.norm));
  });
  if (weak.length > 0) return { customer: longest(weak).customer, status: "unconfirmed" };
  return null;
}

export interface DingtalkBoard {
  /** 每个群的匹配结果（精确=linked，疑似=unconfirmed），保持快照顺序。 */
  links: GroupLink[];
  /** 没有匹配到任何客户的群。 */
  unlinked: GroupItem[];
  /** 没有任何已关联或疑似群指向的客户（按上月 GAAP 降序）。 */
  missingCustomers: CustomerItem[];
  /** @我 消息，最新在前。 */
  mentions: MentionItem[];
  unread: UnreadItem[];
}

export function dingtalkBoard(
  snapshot: Pick<CrmSnapshot, "groups" | "mentions" | "unread" | "customers">,
): DingtalkBoard {
  const entries: NameEntry[] = snapshot.customers.map((customer) => ({ customer, norm: normalizeGroupName(customer.name) }));
  const links: GroupLink[] = [];
  const unlinked: GroupItem[] = [];
  const covered = new Set<string>();

  for (const group of snapshot.groups) {
    const matched = matchGroup(normalizeGroupName(group.name), entries);
    if (matched) {
      links.push({ group, customer: matched.customer, status: matched.status });
      covered.add(matched.customer.cid);
    } else {
      unlinked.push(group);
    }
  }

  const mentions = [...snapshot.mentions].sort(
    (a, b) => (parseLocalTime(b.time) ?? 0) - (parseLocalTime(a.time) ?? 0),
  );

  return {
    links,
    unlinked,
    missingCustomers: customersByGaap(snapshot.customers.filter((customer) => !covered.has(customer.cid))),
    mentions,
    unread: snapshot.unread,
  };
}
