import type { CrmSnapshot, CustomerItem, ProjectItem } from "./crm-types";

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

export type Urgency = "overdue" | "today" | "soon" | "watch";

export interface ActionItem {
  id: string;
  kind: "todo" | "meeting";
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

export function actionQueue(
  snapshot: Pick<CrmSnapshot, "todos" | "agenda">,
  now: number,
): ActionItem[] {
  const todayEnd = startOfDay(now) + DAY_MS;
  return [
    ...todoActions(snapshot, now, todayEnd),
    ...meetingActions(snapshot, now, todayEnd),
  ].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || byTime(a, b));
}

function byTime(a: ActionItem, b: ActionItem): number {
  // Most recently overdue first; long-stale items sink instead of crowding the top.
  if (a.urgency === "overdue") return (b.at ?? -Infinity) - (a.at ?? -Infinity);
  return (a.at ?? Infinity) - (b.at ?? Infinity);
}
