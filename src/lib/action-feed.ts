import { actionQueue, isActiveProject, startOfDay, type ActionItem, type Urgency } from "./crm-model.ts";
import type { CrmSnapshot, ProjectItem } from "./crm-types";

// ---------------------------------------------------------------------------
// 统一行动队列：PPL 临近节点入队 + 本机 triage（已处理 / 忽略 / 撤销）。
// 语义权威 = base/sa-workbench/assets/models/action-feed.js（ES5 参考实现，按语义用 TS
// 重写，不搬代码）。纯函数、无 DOM：localStorage 只经 loadTriage/saveTriage，无存储
// 环境（node 测试）安全降级为空表。triage 只存本机（sa.actionQueue.v1），绝不回写钉钉/鲲鹏。
// triage 键是双 FNV-1a 14 字符定长哈希，不含客户名/项目名/消息 ID 原文，跨日稳定。
// 任一来源缺日期 / 畸形输入均按「该条不进队」处理，不抛错。
// ---------------------------------------------------------------------------

export type QueueBucket = "over" | "today" | "week";
export type QueueKind = "todo" | "meeting" | "mention" | "ppl";
export type PplNode = "contract" | "gaap";
export type TriageState = "done" | "ignored";

export interface QueueItem {
  /** 展示用稳定 id（React key）。 */
  id: string;
  /** 本机 triage 键：来源前缀 + 14 字符定长哈希，跨日稳定。 */
  key: string;
  kind: QueueKind;
  title: string;
  detail: string;
  /** 仅 PPL 节点项携带：客户名 / 节点类型 / 距今天数（负 = 已过期）。 */
  customer: string | null;
  node: PplNode | null;
  days: number | null;
  at: number | null;
  urgency: Urgency;
  bucket: QueueBucket;
  state: TriageState | null;
}

export interface ActionFeedCounts {
  open: number;
  done: number;
  ignored: number;
  /** dealt = done + ignored（已处理 + 忽略合计）。 */
  dealt: number;
  todo: number;
  meeting: number;
  mention: number;
  /** ppl = 截断后纳入队列的 PPL 总量（未处理帽内 + 已处理全量），口径同参考实现。 */
  ppl: number;
  openPpl: number;
  /** 三桶的未处理计数（tab 角标口径；已处理不计入）。 */
  over: number;
  today: number;
  week: number;
}

export interface ActionFeed {
  items: QueueItem[];
  buckets: Record<QueueBucket, QueueItem[]>;
  counts: ActionFeedCounts;
}

export interface TriageEntry {
  s: TriageState;
  /** ISO 时间戳：标记时刻，prune 依据。 */
  at: string;
}

export type TriageMap = Record<string, TriageEntry>;

export interface TriageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// FNV-1a 双种子 14 字符定长键（语义同参考实现）
// ---------------------------------------------------------------------------

const FNV_OFFSET_A = 2166136261;
const FNV_OFFSET_B = 1099511628;
const FNV_PRIME = 16777619;
const HASH_CHARS = 7;

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a 双种子各输出 base36 7 字符（padStart 定长）拼接成 14 字符；分段定长避免拼接歧义。 */
export function hashKey(parts: readonly unknown[]): string {
  const text = parts.map((part) => (part == null ? "" : String(part))).join("\u001f");
  const a = fnv1a32(text, FNV_OFFSET_A).toString(36).padStart(HASH_CHARS, "0");
  const b = fnv1a32(text, FNV_OFFSET_B).toString(36).padStart(HASH_CHARS, "0");
  return a + b;
}

export function actionKey(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}:${hashKey(parts)}`;
}

const KEY_PREFIX: Record<QueueKind, string> = { todo: "todo", meeting: "meeting", mention: "mention", ppl: "ppl" };

/** 基础条目 id 形如「todo:t1」，剥掉已知前缀后哈希，保持键只含哈希不含原文。 */
function triageKey(kind: QueueKind, rawId: string): string {
  const bare = rawId.startsWith(`${kind}:`) ? rawId.slice(kind.length + 1) : rawId;
  return actionKey(KEY_PREFIX[kind], [bare]);
}

// ---------------------------------------------------------------------------
// 本机 triage：done / ignored 带时间戳；open（撤销）删键；30 天 prune；畸形不抛错
// ---------------------------------------------------------------------------

export const TRIAGE_STORAGE_KEY = "sa.actionQueue.v1";
export const TRIAGE_PRUNE_DAYS = 30;
const TRIAGE_STATES: readonly TriageState[] = ["done", "ignored"];
const DAY_MS = 86_400_000;

function isTriageState(value: unknown): value is TriageState {
  return typeof value === "string" && (TRIAGE_STATES as readonly string[]).includes(value);
}

/** 只保留合法条目（state 合法且 at 可解析），畸形输入一律丢弃，不抛错。 */
export function normalizeTriage(raw: unknown): TriageMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: TriageMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { s?: unknown; at?: unknown };
    if (!isTriageState(entry.s) || typeof entry.at !== "string") continue;
    if (Number.isNaN(new Date(entry.at).getTime())) continue;
    out[key] = { s: entry.s, at: entry.at };
  }
  return out;
}

export function triageStateOf(map: TriageMap, key: string): TriageState | null {
  const entry = map[key];
  return entry && isTriageState(entry.s) ? entry.s : null;
}

/** state 为 null / "" / "open" 删键（撤销）；非法 state 原样返回新副本，不改内容。 */
export function setTriageState(map: TriageMap, key: string, state: TriageState | "open" | "" | null, now: number): TriageMap {
  const next: TriageMap = { ...map };
  if (typeof key !== "string" || key.length === 0) return next;
  if (state === null || state === "" || state === "open") {
    delete next[key];
    return next;
  }
  if (!isTriageState(state)) return next;
  next[key] = { s: state, at: new Date(now).toISOString() };
  return next;
}

/** 超期清理：只保留 at 在 days 天（默认 30，夹取 1..3650）内的合法条目，畸形条目丢弃。 */
export function pruneTriage(map: TriageMap, now: number, days: number = TRIAGE_PRUNE_DAYS): TriageMap {
  const requested = Number(days);
  const span = (Number.isFinite(requested) ? Math.min(3650, Math.max(1, Math.round(requested))) : TRIAGE_PRUNE_DAYS) * DAY_MS;
  const out: TriageMap = {};
  for (const [key, entry] of Object.entries(map)) {
    const at = entry ? new Date(entry.at ?? "").getTime() : Number.NaN;
    if (Number.isNaN(at)) continue;
    if (now - at > span) continue;
    out[key] = { s: entry.s, at: entry.at };
  }
  return out;
}

function defaultStorage(): TriageStorage | null {
  const storage = (globalThis as { localStorage?: TriageStorage }).localStorage;
  return typeof storage?.getItem === "function" ? storage : null;
}

/** 读取本机 triage：无存储环境或损坏数据安全降级为空表（顺手 prune 过期条目）。 */
export function loadTriage(storage: TriageStorage | null = defaultStorage(), now: number = Date.now()): TriageMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(TRIAGE_STORAGE_KEY);
    if (!raw) return {};
    return pruneTriage(normalizeTriage(JSON.parse(raw) as unknown), now, TRIAGE_PRUNE_DAYS);
  } catch {
    // 本机缓存损坏（手改/旧版本格式）：按空表重新开始，不打断页面。
    return {};
  }
}

/** 写回本机 triage；无存储或写失败（隐私模式/配额）返回 false，由调用方决定提示。 */
export function saveTriage(map: TriageMap, storage: TriageStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PPL 临近节点：签约 / 起量，今天 ±7 天窗口取最近节点；项目+节点+日期去重
// ---------------------------------------------------------------------------

const PPL_WINDOW_DAYS = 7;
const PPL_MAX_ITEMS = 5;
const PPL_NODE_LABEL: Record<PplNode, string> = { contract: "签约", gaap: "起量" };

/** 只认 YYYY-MM-DD（或 ISO 日期前缀）；自然语言/假日期/超范围一律 null，不抛错。 */
export function parseDayOnly(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = new Date(year, month - 1, day).getTime();
  const check = new Date(time);
  const valid = check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day;
  return valid ? time : null;
}

function dayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function pplRelText(days: number): string {
  if (days < 0) return `逾期 ${-days} 天`;
  return days === 0 ? "今天" : `${days} 天后`;
}

interface NearNode {
  node: PplNode;
  ms: number;
  days: number;
}

/** 两个节点里取距今天最近的一个（同 |天数| 取日历更早的）；窗外（今天 ±7 天）不参与。 */
function nearestNode(project: ProjectItem, todayStart: number): NearNode | null {
  const candidates: { node: PplNode; ms: number }[] = [];
  const contract = parseDayOnly(project.expectedContractDate);
  if (contract !== null) candidates.push({ node: "contract", ms: contract });
  const gaap = parseDayOnly(project.expectedGaapStartDate);
  if (gaap !== null) candidates.push({ node: "gaap", ms: gaap });
  const inWindow = candidates
    .map((candidate) => ({ ...candidate, days: Math.round((startOfDay(candidate.ms) - todayStart) / DAY_MS) }))
    .filter((candidate) => candidate.days >= -PPL_WINDOW_DAYS && candidate.days <= PPL_WINDOW_DAYS);
  if (inWindow.length === 0) return null;
  return inWindow.reduce((best, next) =>
    Math.abs(next.days) < Math.abs(best.days) || (Math.abs(next.days) === Math.abs(best.days) && next.ms < best.ms)
      ? next
      : best);
}

/** 客户解析：cid 命中 > 客户名命中 > 项目自带客户名兜底；都拿不到则该行不进队。 */
function resolveCustomer(project: ProjectItem, byCid: Map<string, string>, byName: Map<string, string>): string | null {
  const byCidHit = project.cid ? byCid.get(project.cid) : undefined;
  if (byCidHit) return byCidHit;
  if (project.customerName) return byName.get(project.customerName) ?? project.customerName;
  return null;
}

function pplItem(
  project: ProjectItem,
  ctx: { todayStart: number; byCid: Map<string, string>; byName: Map<string, string> },
  seen: Set<string>,
): QueueItem | null {
  // 已关闭项目（完成/输单等）没有「临近行动」，即使快照里残留预期日期也不进队。
  if (!isActiveProject(project)) return null;
  const customer = resolveCustomer(project, ctx.byCid, ctx.byName);
  if (!customer) return null;
  const near = nearestNode(project, ctx.todayStart);
  if (!near) return null;
  // 去重键 = 项目 + 节点 + 节点日期；同一客户的多项目各有独立键，不互相吞并。
  const dedupe = [project.id || project.name, PPL_NODE_LABEL[near.node], dayKey(near.ms)].join("|");
  if (seen.has(dedupe)) return null;
  seen.add(dedupe);
  const stage = (project.stageName ?? "").trim().slice(0, 20);
  const rel = pplRelText(near.days);
  const name = project.name.trim();
  return {
    id: actionKey("ppl", [dedupe]),
    key: actionKey("ppl", [dedupe]),
    kind: "ppl",
    title: name.length > 0 ? name : "未命名项目",
    detail: `${stage.length > 0 ? `${stage} · ` : ""}${PPL_NODE_LABEL[near.node]} ${rel}`,
    customer,
    node: near.node,
    days: near.days,
    at: startOfDay(near.ms),
    urgency: near.days < 0 ? "overdue" : near.days === 0 ? "today" : "soon",
    bucket: near.days < 0 ? "over" : near.days === 0 ? "today" : "week",
    state: null,
  };
}

function pplQueueItems(snapshot: Pick<CrmSnapshot, "customers" | "projects">, now: number): QueueItem[] {
  const ctx = {
    todayStart: startOfDay(now),
    byCid: new Map(snapshot.customers.map((entry) => [entry.cid, entry.name])),
    byName: new Map(snapshot.customers.map((entry) => [entry.name, entry.name])),
  };
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const project of snapshot.projects) {
    const item = pplItem(project, ctx, seen);
    if (item) items.push(item);
  }
  return items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** 截断必须发生在 triage 之后：已处理不占名额，否则标掉最早一条后第 6 条永不出现。 */
function capPpl(items: QueueItem[], triage: TriageMap, maxPpl: number): QueueItem[] {
  if (!Number.isFinite(maxPpl) || maxPpl <= 0) return [];
  const open: QueueItem[] = [];
  const handled: QueueItem[] = [];
  for (const item of items) {
    (triageStateOf(triage, item.key) === null ? open : handled).push(withState(item, triage));
  }
  return [...open.slice(0, Math.trunc(maxPpl)), ...handled];
}

// ---------------------------------------------------------------------------
// 合并 / 计数 / 分桶
// ---------------------------------------------------------------------------

const BUCKET_BY_URGENCY: Record<Urgency, QueueBucket> = { overdue: "over", today: "today", soon: "week", watch: "week" };
const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, today: 1, soon: 2, watch: 3 };
const KIND_TIER: Record<QueueKind, number> = { meeting: 0, todo: 0, ppl: 0, mention: 1 };

function withState(item: QueueItem, triage: TriageMap): QueueItem {
  const state = triageStateOf(triage, item.key);
  return state === null ? item : { ...item, state };
}

function toQueueItem(item: ActionItem): QueueItem {
  return {
    id: item.id,
    key: triageKey(item.kind, item.id),
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    customer: null,
    node: null,
    days: null,
    at: item.at,
    urgency: item.urgency,
    bucket: BUCKET_BY_URGENCY[item.urgency],
    state: null,
  };
}

function tally(items: readonly QueueItem[]): ActionFeedCounts {
  const counts: ActionFeedCounts = {
    open: 0, done: 0, ignored: 0, dealt: 0,
    todo: 0, meeting: 0, mention: 0, ppl: 0, openPpl: 0,
    over: 0, today: 0, week: 0,
  };
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.state === "done") {
      counts.done += 1;
      counts.dealt += 1;
    } else if (item.state === "ignored") {
      counts.ignored += 1;
      counts.dealt += 1;
    } else {
      counts.open += 1;
      if (item.kind === "ppl") counts.openPpl += 1;
      counts[item.bucket] += 1;
    }
  }
  return counts;
}

/** over 桶最旧的截止排最前（先救最逾期的）；其余按紧急度 → 类别 → 时间（@我 组内最新优先）。 */
function compareWithin(bucket: QueueBucket, a: QueueItem, b: QueueItem): number {
  if (bucket === "over") {
    return (a.at ?? Infinity) - (b.at ?? Infinity) || a.id.localeCompare(b.id);
  }
  const urgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (urgency !== 0) return urgency;
  const tier = KIND_TIER[a.kind] - KIND_TIER[b.kind];
  if (tier !== 0) return tier;
  const atA = a.at ?? (a.kind === "mention" ? -Infinity : Infinity);
  const atB = b.at ?? (b.kind === "mention" ? -Infinity : Infinity);
  const byAt = a.kind === "mention" ? atB - atA : atA - atB;
  return byAt || a.id.localeCompare(b.id);
}

function groupBuckets(items: readonly QueueItem[], showHandled: boolean): Record<QueueBucket, QueueItem[]> {
  const buckets: Record<QueueBucket, QueueItem[]> = { over: [], today: [], week: [] };
  for (const item of items) {
    if (!showHandled && item.state !== null) continue;
    buckets[item.bucket].push(item);
  }
  for (const bucket of ["over", "today", "week"] as const) {
    buckets[bucket].sort((a, b) => compareWithin(bucket, a, b));
  }
  return buckets;
}

export interface ActionFeedInput {
  now: number;
  triage: TriageMap;
  showHandled: boolean;
  /** PPL 未处理上限；0 = 不入队。默认 5。 */
  maxPpl?: number;
}

/**
 * 统一行动队列 = 既有 todo/meeting/mention（全量入队）+ PPL 临近节点（未处理帽内 + 已处理全量）。
 * triage 在截断之前生效；counts 恒为全量口径（含已处理），buckets 按 showHandled 过滤。
 */
export function buildActionFeed(
  snapshot: Pick<CrmSnapshot, "todos" | "agenda" | "mentions" | "customers" | "projects">,
  input: ActionFeedInput,
): ActionFeed {
  const now = Number.isFinite(input.now) && input.now > 0 ? input.now : Date.now();
  const maxPpl = input.maxPpl === undefined ? PPL_MAX_ITEMS : input.maxPpl;
  const triage = normalizeTriage(input.triage);
  const base = actionQueue(snapshot, now).map(toQueueItem).map((item) => withState(item, triage));
  const cappedPpl = capPpl(pplQueueItems(snapshot, now), triage, maxPpl);
  const buckets = groupBuckets([...base, ...cappedPpl], input.showHandled === true);
  return {
    items: [...buckets.over, ...buckets.today, ...buckets.week],
    buckets,
    counts: tally([...base, ...cappedPpl]),
  };
}
