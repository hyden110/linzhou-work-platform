export type SourceKey =
  | "agenda"
  | "todos"
  | "groups"
  | "mentions"
  | "unread"
  | "customers"
  | "projects"
  | "overview"
  | "top"
  | "mygroups";
export type SourceState = "ok" | "partial" | "auth_required" | "error" | "missing";

export interface TopChecks {
  gaapMonotonicDesc: boolean;
  countWithinLimit: boolean;
}

export interface SourceStatus {
  status: SourceState;
  error: string | null;
  fetchedAt: string | null;
  lastSuccessAt: string | null;
  count: number;
  complete: boolean;
  stale: boolean;
  /** 鲲鹏列表类数据源的条数元信息（customers/projects/top 等）。 */
  total?: number | null;
  /** 仅 top 段：鲲鹏自带的顺序/条数自检，false 表示口径异常必须上报警告。 */
  checks?: TopChecks;
  /** 仅 todos 段：双桶单页是否触及 200 条上限（complete=false 的成因之一）。 */
  pendingTruncated?: boolean;
  doneTruncated?: boolean;
  /** 仅 todos 段：已完成待办详情读取失败/超出详情上限的条数。 */
  detailsFailed?: number;
  /** 仅 todos 段：dws 单页的条数上限。 */
  listLimit?: number;
  metric?: string | null;
  orderBy?: string | null;
  queriedAt?: string | null;
}

/** MaaS 候选初筛（D4）证据：只记录命中了哪个关键词、在客户名还是项目名上。 */
export interface MaasCandidateEvidence {
  source: "customer" | "project";
  name: string;
  keywords: string[];
}

/** 候选只标「疑似 maas」，不硬判；最终分类以人工覆盖表（maas-overrides）为准。 */
export interface MaasCandidate {
  cid: string;
  customerName: string;
  suggestion: "maas";
  evidence: MaasCandidateEvidence[];
}

export interface MaasCandidatesFile {
  schemaVersion: 1;
  generatedAt: string;
  readOnly: true;
  /** 快照客户总数（覆盖率分母口径），含无 PPL 客户。 */
  totalCustomers: number;
  candidates: MaasCandidate[];
}

export interface AgendaItem {
  id: string;
  title: string;
  start: string;
  end: string;
}

export interface TodoItem {
  id: string;
  title: string;
  priority: number;
  dueAt: number | null;
  /** 完成状态；旧快照没有该字段时按未完成处理。 */
  done?: boolean;
  createdAt?: number | null;
  finishedAt?: number | null;
}

export interface CustomerItem {
  cid: string;
  name: string;
  industry: string | null;
  area: string | null;
  level: string | null;
  formal: string | null;
  opportunity: string | null;
  lastMonthGaap: number | null;
  yesterdayGaap: number | null;
  yesterdayGaapRate: number | null;
  /** 昨日 GAAP 环比涨跌额（元）；旧快照无此字段时为 null，前端按 rate 反推并标「推算值」。 */
  yesterdayGaapDiff?: number | null;
  lastNoteAt: string | null;
  relatedAt: string | null;
}

export interface ProjectItem {
  id: string;
  name: string;
  customerName: string | null;
  cid: string | null;
  stage: string | null;
  stageName: string | null;
  price: number | null;
  cate: string | null;
  state: string | null;
  winRate: number | null;
  expectedContractDate: string | null;
  expectedGaapStartDate: string | null;
  createdAt: string | null;
}

export interface OverviewMetric {
  id: string | null;
  label: string;
  value: number;
  unit: string | null;
  category: string | null;
}

export interface TopCustomerItem {
  rank: number;
  cid: string;
  name: string;
  industry: string | null;
  area: string | null;
  level: string | null;
  lastMonthGaap: number | null;
  yesterdayGaap: number | null;
}

export interface MyGroupView {
  id: string;
  name: string;
  group: string | null;
  count: number;
}

export interface GroupItem {
  id: string;
  name: string;
  type: string | null;
  memberCount: number;
}

export interface MentionItem {
  id: string;
  conversationId: string;
  conversationName: string | null;
  sender: string | null;
  text: string;
  time: string | null;
}

export interface UnreadItem {
  id: string;
  name: string | null;
}

export interface CrmSnapshot {
  schemaVersion: 1;
  generatedAt: string | null;
  sources: Partial<Record<SourceKey, SourceStatus>>;
  agenda: AgendaItem[];
  todos: TodoItem[];
  groups: GroupItem[];
  mentions: MentionItem[];
  unread: UnreadItem[];
  customers: CustomerItem[];
  projects: ProjectItem[];
  overview: OverviewMetric[];
  top: TopCustomerItem[];
  mygroups: MyGroupView[];
}

export interface RefreshStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface InsightRecord {
  cid: string;
  customerName: string;
  state: "running" | "done" | "failed";
  createdAt: string;
  finishedAt: string | null;
  answer: string | null;
  error: string | null;
}

/** FBI 产品拆分行（业绩分成口径；桥已清洗，current/previous 为日 GAAP 元或 null）。 */
export interface AttributionRow {
  level1: string;
  level2: string | null;
  current: number | null;
  previous: number | null;
}

/** GAAP 异动归因记录（FBI 报表问答产物；answerMessageId 已在路由层剥离）。 */
export interface AttributionRecord {
  schemaVersion: 1;
  cid: string;
  state: "running" | "done" | "failed";
  createdAt: string;
  finishedAt: string | null;
  reportResourceId: string;
  currentDate: string | null;
  previousDate: string | null;
  rows: AttributionRow[];
  /** done 且 rows 为空时的数据不足原因（如 no_rows）；其余为 null。 */
  reason: string | null;
  /** 解析时被丢弃的行数（明示，不静默丢）。 */
  droppedRows: number;
  error: string | null;
}

/** 「CRM AI 助理」解读记录（1:1 单聊问答产物；问题由系统模板生成）。 */
export interface CrmAiExplainRecord {
  schemaVersion: 1;
  cid: string;
  state: "running" | "done" | "failed";
  createdAt: string;
  finishedAt: string | null;
  question: string | null;
  askedAt: string | null;
  answer: string | null;
  answerAt: string | null;
  error: string | null;
}
