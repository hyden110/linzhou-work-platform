export type SourceKey = "agenda" | "todos" | "customers" | "projects";
export type SourceState = "ok" | "partial" | "auth_required" | "error" | "missing";

export interface SourceStatus {
  status: SourceState;
  error: string | null;
  fetchedAt: string | null;
  lastSuccessAt: string | null;
  count: number;
  complete: boolean;
  stale: boolean;
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

export interface CrmSnapshot {
  schemaVersion: 1;
  generatedAt: string | null;
  sources: Partial<Record<SourceKey, SourceStatus>>;
  agenda: AgendaItem[];
  todos: TodoItem[];
  customers: CustomerItem[];
  projects: ProjectItem[];
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
