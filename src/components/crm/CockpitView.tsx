import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, CheckCircle2, CircleAlert, CircleDollarSign, ListTodo, Plus, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { actionQueue, parseLocalTime, startOfDay } from "../../lib/crm-model";
import type { TodoItem } from "../../lib/crm-types";
import { fetchFbiMetrics, fbiMetricsErrorMessage, startFbiMetrics, type FbiMetrics } from "../../lib/fbi-metrics-client";
import { StatusBadge, ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CrmGate, RefreshControl, SourceBanner, formatClock, formatDateTime, formatGaap } from "./crm-shared";
import { ActionQueuePanel } from "./ActionQueuePanel";
import { PplInspectionPanel } from "./PplInspectionPanel";
import { TodoComposeDialog } from "./TodoComposeDialog";

const DAY_MS = 86_400_000;

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * FBI 报表指标（「公共云事业部大模型专项看板」）：拉取是显式动作，未拉取/失败/进行中
 * 都如实展示，不会伪造数字。产物新鲜度由本机服务控制（24 小时）。
 */
function useFbiMetrics() {
  const [metrics, setMetrics] = useState<FbiMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMetrics(await fetchFbiMetrics());
      setError(null);
    } catch (cause) {
      setError(fbiMetricsErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (metrics?.state !== "running") return;
    const timer = window.setTimeout(() => void load(), 5_000);
    return () => window.clearTimeout(timer);
  }, [metrics, load]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      await startFbiMetrics();
      setError(null);
    } catch (cause) {
      setError(fbiMetricsErrorMessage(cause));
    } finally {
      setBusy(false);
      await load();
    }
  }, [load]);

  return { metrics, error, busy, start };
}

function formatCallVolume(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function formatMoMRate(rate: number | null): string {
  return rate === null ? "环比 —" : `环比 ${(rate * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

// formatSeats 已随坐席卡占位停用：在用席位源（席位看板 2000986）接入后再恢复。

function shortDate(date: string | null): string {
  return date ? date.slice(5).replace("-", "/") : "";
}

function Metric({ icon: Icon, label, value, note, primary }: { icon: LucideIcon; label: string; value: string; note: string; primary?: boolean }) {
  return (
    <article className={`metric-card ${primary ? "metric-card--primary" : ""}`}>
      <Icon className="metric-card__icon" size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function todoBadge(todo: TodoItem, now: number, todayEnd: number): { label: string; tone: "amber" | "green" | "blue" | "muted" } {
  if (todo.done === true) return { label: "已完成", tone: "muted" };
  if (todo.dueAt === null) return { label: todo.priority >= 30 ? "高优先级 · 无截止" : "无截止", tone: "muted" };
  if (todo.dueAt < now) return { label: "已逾期", tone: "amber" };
  if (todo.dueAt < todayEnd) return { label: `今天 ${formatClock(todo.dueAt)}`, tone: "green" };
  return { label: formatDateTime(todo.dueAt), tone: "blue" };
}

function TodoRow({ todo, now, todayEnd }: { todo: TodoItem; now: number; todayEnd: number }) {
  const badge = todoBadge(todo, now, todayEnd);
  const detail = [
    todo.priority >= 30 ? "高优先级" : "普通优先级",
    todo.done === true && todo.finishedAt ? `完成于 ${formatDateTime(todo.finishedAt)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className={`crm-todo ${todo.done === true ? "is-done" : ""}`}>
      <ListTodo size={15} />
      <div>
        <strong>{todo.title}</strong>
        <span>{detail}</span>
      </div>
      <time>{todo.dueAt === null ? "无截止" : formatDateTime(todo.dueAt)}</time>
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
    </li>
  );
}

export function CockpitView() {
  const { snapshot } = useCrm();
  const now = useNow();
  const [composeOpen, setComposeOpen] = useState(false);
  const fbi = useFbiMetrics();

  const model = useMemo(() => {
    if (!snapshot) return null;
    const todayStart = startOfDay(now);
    const todayEnd = todayStart + DAY_MS;
    const todayAgenda = snapshot.agenda
      .map((event) => ({ event, start: parseLocalTime(event.start), end: parseLocalTime(event.end) }))
      .filter((row) => row.start !== null && row.start >= todayStart && row.start < todayEnd)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const queue = actionQueue(snapshot, now);
    const pendingTodos = snapshot.todos
      .filter((todo) => todo.done !== true)
      .sort((a, b) =>
        (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
        || b.priority - a.priority
        || a.title.localeCompare(b.title, "zh-CN"));
    const doneTodos = snapshot.todos
      .filter((todo) => todo.done === true)
      .sort((a, b) =>
        (b.finishedAt ?? b.dueAt ?? 0) - (a.finishedAt ?? a.dueAt ?? 0)
        || a.title.localeCompare(b.title, "zh-CN"));
    return {
      todayStart,
      todayEnd,
      todayAgenda,
      queue,
      pendingTodos,
      doneTodos,
      overdue: queue.filter((item) => item.urgency === "overdue" && item.kind === "todo").length,
      gaap: snapshot.customers.reduce((sum, customer) => sum + (customer.lastMonthGaap ?? 0), 0),
    };
  }, [snapshot, now]);

  const customersReady = snapshot?.sources.customers?.status === "ok";
  const todoSource = snapshot?.sources.todos;
  const todoWarning = todoSource?.complete === false
    ? (todoSource.pendingTruncated || todoSource.doneTruncated
      ? `待办列表可能不完整：单页 ${todoSource.listLimit ?? 200} 条已达上限，仅展示已读取部分。`
      : (todoSource.detailsFailed ?? 0) > 0
        ? `有 ${todoSource.detailsFailed} 条已完成待办的详情读取失败，完成状态可能缺失；下次刷新会重试。`
        : "待办列表可能不完整，仅展示已读取部分。")
    : null;

  // FBI 卡如实态：报表里没有「客户维度 Agent 数量」和「MaaS 归因收入」，
  // 这里按报表真实指标展示（有效客户数 / 日 GAAP 环比），差异在交付报告里说明。
  const fbiDone = fbi.metrics?.state === "done";
  const fbiFetching = fbi.busy || fbi.metrics?.state === "running";
  const fbiStatusNote = fbiDone
    ? `FBI 报表 · ${shortDate(fbi.metrics?.date ?? null)}`
    : fbi.metrics?.state === "running"
      ? "FBI 报表 · 拉取中"
      : fbi.metrics?.state === "failed"
        ? "FBI 报表 · 拉取失败，可重试"
        : fbi.error ?? "FBI 报表 · 未拉取";

  return (
    <div className="view-stack">
      <ViewHeading eyebrow="CUSTOMER OPS / COCKPIT" title="驾驶舱" description="今天要处理的待办和会议，按紧急程度排好；客户经营数字来自鲲鹏快照。" aside={<RefreshControl />} />
      <CrmGate>
        {snapshot && model && (
          <>
            <SourceBanner keys={["agenda", "todos", "mentions", "customers", "projects"]} />
            <section className="metric-grid crm-metrics crm-metrics--seven" aria-label="关键指标">
              <Metric icon={CalendarClock} label="今日日程" value={String(model.todayAgenda.length)} note={`剩余 ${model.todayAgenda.filter((row) => (row.end ?? row.start ?? 0) >= now).length} 场`} primary />
              <Metric icon={CircleAlert} label="逾期待办" value={String(model.overdue)} note={`共 ${model.pendingTodos.length} 条未完成 · ${model.doneTodos.length} 条已完成`} />
              <Metric icon={Users} label="客户 / 上月 GAAP" value={customersReady ? String(snapshot.customers.length) : "—"} note={customersReady ? `GAAP ${formatGaap(model.gaap)}` : "等待鲲鹏登录"} />
              <Metric
                icon={Bot}
                label="有效客户数"
                value={fbiDone && fbi.metrics?.validCustomers !== null && fbi.metrics?.validCustomers !== undefined ? String(fbi.metrics.validCustomers) : "—"}
                note={fbiDone ? `FBI · 调用量 ${formatCallVolume(fbi.metrics?.callVolume ?? null)}` : fbiStatusNote}
              />
              <Metric
                icon={CircleDollarSign}
                label="日 GAAP"
                value={fbiDone ? formatGaap(fbi.metrics?.dailyGaap ?? null) : "—"}
                note={fbiDone ? `FBI · ${formatMoMRate(fbi.metrics?.moMRate ?? null)}` : fbiStatusNote}
              />
              {/* 坐席卡：商机预估口径已被用户否定（量级差一个数量级），在用席位源（席位看板 2000986）
                  ACL 未批——不显示任何预估值，只显示诚实占位，权限通过后换源接入。 */}
              <Metric
                icon={Bot}
                label="Qoder 坐席数"
                value="—"
                note="实时坐席待 FBI 权限（申请中）· 源：席位看板 2000986 在用席位数"
              />
              <Metric
                icon={Users}
                label="千问办公坐席数"
                value="—"
                note="实时坐席待 FBI 权限（申请中）· 源：席位看板 2000986 在用席位数"
              />
            </section>
            {!fbiDone && (
              <div className="crm-fbi-fetch">
                <button className="text-button" onClick={() => void fbi.start()} disabled={fbiFetching}>
                  {fbiFetching ? "FBI 指标拉取中…" : fbi.metrics?.state === "failed" ? "重试 FBI 指标拉取" : "拉取 FBI 报表指标"}
                </button>
              </div>
            )}

            <div className="crm-cockpit">
              <ActionQueuePanel snapshot={snapshot} now={now} />

              <div className="crm-side">
                <section className="panel">
                  <header className="panel__header">
                    <div><span className="eyebrow">TODAY</span><h2>今日日程</h2></div>
                    <span>{model.todayAgenda.length} 场</span>
                  </header>
                  {model.todayAgenda.length === 0
                    ? <p className="crm-muted">今天没有日程。</p>
                    : (
                      <ol className="crm-agenda">
                        {model.todayAgenda.map(({ event, start, end }) => (
                          <li key={event.id} className={(end ?? start ?? 0) < now ? "is-past" : undefined}>
                            <time>{formatClock(start)}</time>
                            <strong>{event.title}</strong>
                          </li>
                        ))}
                      </ol>
                    )}
                </section>
              </div>
            </div>

            <section className="panel crm-todos">
              <header className="panel__header">
                <div><span className="eyebrow">TODOS</span><h2>待办</h2></div>
                <div className="crm-todos__tools">
                  <span>{model.pendingTodos.length} 条未完成 · {model.doneTodos.length} 条已完成</span>
                  <button className="primary-button" onClick={() => setComposeOpen(true)}>
                    <Plus size={14} />新建待办
                  </button>
                </div>
              </header>
              {todoWarning && (
                <p className="crm-todos__warning" role="status">
                  <CircleAlert size={13} />
                  {todoWarning}
                </p>
              )}
              {model.pendingTodos.length === 0
                ? <p className="crm-muted">没有未完成的待办。</p>
                : (
                  <ul className="crm-list">
                    {model.pendingTodos.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} now={now} todayEnd={model.todayEnd} />
                    ))}
                  </ul>
                )}
              {model.doneTodos.length > 0 && (
                <details className="crm-todos__done">
                  <summary><CheckCircle2 size={13} />已完成 {model.doneTodos.length} 条</summary>
                  <ul className="crm-list">
                    {model.doneTodos.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} now={now} todayEnd={model.todayEnd} />
                    ))}
                  </ul>
                </details>
              )}
            </section>

            <PplInspectionPanel />
          </>
        )}
      </CrmGate>
      <TodoComposeDialog open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}
