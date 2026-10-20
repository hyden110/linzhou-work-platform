/**
 * Wechat model — 微信办公台账的纯派生层（浏览器视图与本地桥共用同一口径）。
 * donor: base/sa-workbench assets/pages/wechat.js（台账排序/筛选/客户列表）、
 * tools/wxkey/build.js（todos 排序 urgencyRank、快照形状）——搬语义不搬代码。
 * 零依赖、零 I/O、零时钟：一切排序/分组只吃投影后的只读视图对象。
 *
 * 口径：
 * - @我待办排序：urgency rank（high→mid→low→overdue）内按 daysSince 降序（donor build.js 同口径）；
 * - 群台账排序五键：at（@我未回复优先）/ d30 / d7 / last / atAll（donor ledgerRows 同口径）；
 * - 范围筛选：related（有客户绑定）/ active（近30天有消息或有绑定）/ all（donor inScope）；
 * - qr-tree：客户 → 群 两层折叠树，未绑定群落「未绑定」桶且恒排最后；
 * - 所有函数不改动输入（不可变），坏行按白名单语义在投影层已丢弃、这里只做纯计算。
 */

/* ---------------- 视图类型（桥投影产物 = 前端消费契约） ---------------- */

export type WechatSnapshotStatus = "ok" | "missing";
export type WechatCustomerStatus = "confirmed" | "matched" | "pending";
export type WechatUrgency = "high" | "mid" | "low" | "overdue";
export type WechatMentionKind = "at" | "single";
export type WechatGroupSortKey = "at" | "d30" | "d7" | "last" | "atAll";
export type WechatGroupScope = "related" | "active" | "all";
export type WechatGroupActivity = "hot" | "active" | "quiet";

export interface WechatStatsView {
  readonly groups: number;
  readonly groupsActive7: number;
  readonly groupsActive30: number;
  readonly groupsMine7: number;
  readonly custBound: number;
  readonly atMeAll: number;
  readonly atMe30: number;
  readonly todos: number;
  readonly todosHigh: number;
  readonly unread: number;
  readonly singleUnreplied: number;
  readonly messages: number;
}

export interface WechatSourceView {
  readonly dbs: number;
  readonly tables: number;
  readonly messages: number;
  readonly groups: number;
  readonly singles: number;
  readonly window: number;
}

export interface WechatRecentAtView {
  readonly t: number;
  readonly name: string;
  readonly textMasked: string;
}

export interface WechatGroupView {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly muted: boolean;
  readonly unread: number;
  readonly lastMsgAt: number;
  readonly lastSummaryMasked: string;
  readonly custKeys: readonly string[];
  readonly customerStatus: WechatCustomerStatus;
  readonly bindNote: string;
  readonly msg: { readonly d7: number; readonly d30: number; readonly dWin: number; readonly all: number };
  readonly senders: { readonly d7: number; readonly d30: number; readonly all: number };
  readonly mine: { readonly d7: number; readonly d30: number; readonly all: number; readonly lastAt: number };
  readonly atMe: { readonly all: number; readonly lastAt: number; readonly daysSince: number | null; readonly unreplied: boolean };
  readonly recentAtMe: readonly WechatRecentAtView[];
}

export interface WechatTodoView {
  readonly groupId: string;
  readonly groupName: string;
  readonly custKeys: readonly string[];
  readonly urgency: WechatUrgency;
  readonly daysSince: number;
  readonly at: number;
  readonly fromName: string;
  readonly textMasked: string;
}

export interface WechatMentionView {
  readonly kind: WechatMentionKind;
  readonly t: number;
  readonly convId: string;
  readonly convName: string;
  readonly group: boolean;
  readonly custKeys: readonly string[];
  readonly fromName: string;
  readonly textMasked: string;
  readonly unread: boolean;
}

export interface WechatSingleView {
  readonly idMasked: string;
  readonly name: string;
  readonly muted: boolean;
  readonly msg: { readonly d7: number; readonly d30: number; readonly all: number };
  readonly lastMsgAt: number;
  readonly unread: number;
  readonly lastSummaryMasked: string;
  readonly unreplied: boolean;
}

export interface WechatLabelView {
  readonly id: number;
  readonly name: string;
}

/** 快照缺失时的修复指引（donor「给修复指引而非空白」口径）。 */
export interface WechatMissingView {
  readonly status: "missing";
  readonly missingNote: string;
  readonly steps: readonly string[];
}

export interface WechatSnapshotOkView {
  readonly status: "ok";
  readonly version: number;
  readonly updatedAt: string;
  readonly meName: string;
  readonly source: WechatSourceView;
  readonly stats: WechatStatsView;
  readonly groups: readonly WechatGroupView[];
  readonly todos: readonly WechatTodoView[];
  readonly mentions: readonly WechatMentionView[];
  readonly singles: readonly WechatSingleView[];
  readonly labels: readonly WechatLabelView[];
}

export type WechatSnapshotView = WechatSnapshotOkView | WechatMissingView;

/** PUT /local/wechat/bindings 的台账行（本地文件，人工绑定）。 */
export interface WechatBindingEntry {
  readonly groupId: string;
  readonly custKeys: readonly string[];
  readonly note: string;
  readonly updatedAt: string;
}

/* ---------------- qr-tree（客户 → 群 两层折叠树） ---------------- */

export interface WechatQrTreeLeaf {
  readonly groupId: string;
  readonly name: string;
  readonly custKeys: readonly string[];
  readonly unreplied: boolean;
  readonly atMeAll: number;
  readonly msgD30: number;
  readonly muted: boolean;
}

export interface WechatQrTreeNode {
  readonly key: string;
  readonly name: string;
  readonly kind: "cust" | "unbound";
  readonly groups: number;
  readonly awaiting: number;
  readonly msgD30: number;
  readonly children: readonly WechatQrTreeLeaf[];
}

export interface WechatQrTreeView {
  readonly status: WechatSnapshotStatus;
  readonly missingNote: string;
  readonly steps: readonly string[];
  readonly nodes: readonly WechatQrTreeNode[];
}

/* ---------------- 常量 ---------------- */

export const WECHAT_URGENCY_ORDER: readonly WechatUrgency[] = ["high", "mid", "low", "overdue"];

export const WECHAT_URGENCY_LABELS: Readonly<Record<WechatUrgency, string>> = {
  high: "高（≤2天）",
  mid: "中（≤7天）",
  low: "低（≤30天）",
  overdue: "过期（>30天，多已线下处理）",
};

export const WECHAT_GROUP_SORT_KEYS: readonly WechatGroupSortKey[] = ["at", "d30", "d7", "last", "atAll"];

export const WECHAT_UNBOUND_KEY = "__unbound";
export const WECHAT_UNBOUND_NAME = "未绑定客户";

/* ---------------- 纯派生 ---------------- */

const URGENCY_RANK: Readonly<Record<WechatUrgency, number>> = { high: 0, mid: 1, low: 2, overdue: 3 };

const byNameAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** @我待办排序：urgency rank 内按 daysSince 降序（donor build.js todos.sort 同口径）。 */
export function sortWechatTodos(todos: readonly WechatTodoView[]): readonly WechatTodoView[] {
  return [...todos].sort(
    (a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || b.daysSince - a.daysSince,
  );
}

/** 按紧急度分组（视图分区用）：空的紧急度段直接省略。 */
export function groupWechatTodosByUrgency(
  todos: readonly WechatTodoView[],
): readonly { readonly urgency: WechatUrgency; readonly label: string; readonly items: readonly WechatTodoView[] }[] {
  const sorted = sortWechatTodos(todos);
  const sections: { readonly urgency: WechatUrgency; readonly label: string; readonly items: readonly WechatTodoView[] }[] = [];
  for (const urgency of WECHAT_URGENCY_ORDER) {
    const items = sorted.filter((todo) => todo.urgency === urgency);
    if (items.length > 0) sections.push({ urgency, label: WECHAT_URGENCY_LABELS[urgency], items });
  }
  return sections;
}

/** 单聊未回：过滤 unreplied，lastMsgAt 降序（最近的最需要看一眼）。 */
export function unrepliedWechatSingles(singles: readonly WechatSingleView[]): readonly WechatSingleView[] {
  return singles.filter((single) => single.unreplied).sort((a, b) => b.lastMsgAt - a.lastMsgAt);
}

/** 群活跃度：近7天有消息 hot / 近30天有消息 active / 其余 quiet。 */
export function wechatGroupActivity(group: WechatGroupView): WechatGroupActivity {
  if (group.msg.d7 > 0) return "hot";
  if (group.msg.d30 > 0) return "active";
  return "quiet";
}

const GROUP_COMPARATORS: Readonly<Record<WechatGroupSortKey, (a: WechatGroupView, b: WechatGroupView) => number>> = {
  at: (a, b) =>
    Number(b.atMe.unreplied) - Number(a.atMe.unreplied)
    || b.atMe.all - a.atMe.all
    || b.lastMsgAt - a.lastMsgAt,
  d30: (a, b) => b.msg.d30 - a.msg.d30,
  d7: (a, b) => b.msg.d7 - a.msg.d7,
  last: (a, b) => b.lastMsgAt - a.lastMsgAt,
  atAll: (a, b) => b.atMe.all - a.atMe.all,
};

/** 台账排序（donor ledgerRows by 五键，同键稳定回落）。 */
export function sortWechatGroups(
  groups: readonly WechatGroupView[],
  key: WechatGroupSortKey,
): readonly WechatGroupView[] {
  return [...groups].sort(GROUP_COMPARATORS[key] ?? GROUP_COMPARATORS.at);
}

const isRelated = (group: WechatGroupView): boolean => group.custKeys.length > 0;
const isActive30 = (group: WechatGroupView): boolean => group.msg.d30 > 0 || isRelated(group);

function inScope(group: WechatGroupView, scope: WechatGroupScope): boolean {
  if (scope === "all") return true;
  if (scope === "active") return isActive30(group);
  return isRelated(group);
}

/** 台账筛选：范围（related/active/all）+ 客户键 + 大小写不敏感搜索（群名/群ID/客户键）。 */
export function filterWechatGroups(
  groups: readonly WechatGroupView[],
  filter: { readonly scope?: WechatGroupScope; readonly custKey?: string; readonly query?: string },
): readonly WechatGroupView[] {
  const scope = filter.scope ?? "all";
  const custKey = (filter.custKey ?? "").trim();
  const query = (filter.query ?? "").trim().toLowerCase();
  return groups.filter((group) => {
    if (!inScope(group, scope)) return false;
    if (custKey && !group.custKeys.includes(custKey)) return false;
    if (!query) return true;
    return (
      group.name.toLowerCase().includes(query)
      || group.id.toLowerCase().includes(query)
      || group.custKeys.some((key) => key.toLowerCase().includes(query))
    );
  });
}

/** 客户下拉选项（donor custList）：按群数降序、同数按键名升序。 */
export function wechatCustomerOptions(
  groups: readonly WechatGroupView[],
): readonly { readonly key: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const key of group.custKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || byNameAsc(a.key, b.key));
}

/** qr-tree：客户 → 群两层树；多客户群在每个客户下都出现；未绑定桶恒排最后。 */
export function buildWechatQrTree(groups: readonly WechatGroupView[]): readonly WechatQrTreeNode[] {
  const buckets = new Map<string, WechatQrTreeLeaf[]>();
  for (const group of groups) {
    const leaf: WechatQrTreeLeaf = {
      groupId: group.id,
      name: group.name,
      custKeys: group.custKeys,
      unreplied: group.atMe.unreplied,
      atMeAll: group.atMe.all,
      msgD30: group.msg.d30,
      muted: group.muted,
    };
    const keys = group.custKeys.length > 0 ? group.custKeys : [WECHAT_UNBOUND_KEY];
    for (const key of keys) buckets.set(key, [...(buckets.get(key) ?? []), leaf]);
  }
  const nodes: WechatQrTreeNode[] = [...buckets.entries()].map(([key, leaves]) => {
    const children = [...leaves].sort(
      (a, b) => Number(b.unreplied) - Number(a.unreplied) || b.msgD30 - a.msgD30 || byNameAsc(a.name, b.name),
    );
    return {
      key,
      name: key === WECHAT_UNBOUND_KEY ? WECHAT_UNBOUND_NAME : key,
      kind: key === WECHAT_UNBOUND_KEY ? "unbound" : "cust",
      groups: children.length,
      awaiting: children.filter((leaf) => leaf.unreplied).length,
      msgD30: children.reduce((sum, leaf) => sum + leaf.msgD30, 0),
      children,
    };
  });
  return nodes.sort(
    (a, b) =>
      (a.kind === "unbound" ? 1 : 0) - (b.kind === "unbound" ? 1 : 0)
      || b.groups - a.groups
      || b.msgD30 - a.msgD30
      || byNameAsc(a.name, b.name),
  );
}
