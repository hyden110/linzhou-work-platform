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
  metric?: string | null;
  orderBy?: string | null;
  queriedAt?: string | null;
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
