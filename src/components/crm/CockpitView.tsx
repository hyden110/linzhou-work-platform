import { useCallback, useEffect, useMemo, useState } from "react";
import { AtSign, Bot, CalendarClock, CircleAlert, CircleDollarSign, ListTodo, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { actionQueue, parseLocalTime, startOfDay, type ActionItem, type Urgency } from "../../lib/crm-model";
import { fetchFbiMetrics, fbiMetricsErrorMessage, startFbiMetrics, type FbiMetrics } from "../../lib/fbi-metrics-client";
import { StatusBadge, ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CrmGate, RefreshControl, SourceBanner, formatClock, formatDateTime, formatGaap } from "./crm-shared";

const DAY_MS = 86_400_000;
const QUEUE_PREVIEW = 12;

const URGENCY: Record<Urgency, { label: string; tone: "amber" | "green" | "blue" | "muted" }> = {
  overdue: { label: "已逾期", tone: "amber" },
  today: { label: "今天", tone: "green" },
  soon: { label: "近 3 天", tone: "blue" },
  watch: { label: "关注", tone: "muted" },
};

const KIND_ICON: Record<ActionItem["kind"], LucideIcon> = {
  todo: ListTodo,
  meeting: CalendarClock,
  mention: AtSign,
};

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

function ActionRow({ item }: { item: ActionItem }) {
  const Icon = KIND_ICON[item.kind];
  const urgency = URGENCY[item.urgency];
  return (
    <li className="crm-action">
      <Icon size={15} />
      <div>
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
      </div>
      <time>{item.at === null ? "无截止" : formatDateTime(item.at)}</time>
      <StatusBadge tone={urgency.tone}>{urgency.label}</StatusBadge>
    </li>
  );
}

export function CockpitView() {
  const { snapshot } = useCrm();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
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
    return {
      todayAgenda,
      queue,
      overdue: queue.filter((item) => item.urgency === "overdue" && item.kind === "todo").length,
      gaap: snapshot.customers.reduce((sum, customer) => sum + (customer.lastMonthGaap ?? 0), 0),
    };
  }, [snapshot, now]);

  const customersReady = snapshot?.sources.customers?.status === "ok";
  const visibleQueue = model ? (expanded ? model.queue : model.queue.slice(0, QUEUE_PREVIEW)) : [];

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
            <SourceBanner keys={["agenda", "todos", "mentions", "customers"]} />
            <section className="metric-grid crm-metrics crm-metrics--five" aria-label="关键指标">
              <Metric icon={CalendarClock} label="今日日程" value={String(model.todayAgenda.length)} note={`剩余 ${model.todayAgenda.filter((row) => (row.end ?? row.start ?? 0) >= now).length} 场`} primary />
              <Metric icon={CircleAlert} label="逾期待办" value={String(model.overdue)} note={`共 ${snapshot.todos.length} 条未完成`} />
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
            </section>
            {!fbiDone && (
              <div className="crm-fbi-fetch">
                <button className="text-button" onClick={() => void fbi.start()} disabled={fbiFetching}>
                  {fbiFetching ? "FBI 指标拉取中…" : fbi.metrics?.state === "failed" ? "重试 FBI 指标拉取" : "拉取 FBI 报表指标"}
                </button>
              </div>
            )}

            <div className="crm-cockpit">
              <section className="panel">
                <header className="panel__header">
                  <div><span className="eyebrow">ACTION QUEUE</span><h2>行动队列</h2></div>
                  <span>{model.queue.length} 项</span>
                </header>
                {model.queue.length === 0
                  ? <p className="crm-muted">暂无需要处理的待办、会议或 @。</p>
                  : (
                    <>
                      <ul className="crm-list">{visibleQueue.map((item) => <ActionRow key={item.id} item={item} />)}</ul>
                      {model.queue.length > QUEUE_PREVIEW && (
                        <button className="text-button crm-more" onClick={() => setExpanded((value) => !value)}>
                          {expanded ? "收起" : `展开全部 ${model.queue.length} 项`}
                        </button>
                      )}
                    </>
                  )}
              </section>

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
          </>
        )}
      </CrmGate>
    </div>
  );
}
