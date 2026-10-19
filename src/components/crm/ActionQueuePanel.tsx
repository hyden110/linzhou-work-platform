import { useCallback, useEffect, useMemo, useState } from "react";
import { AtSign, CalendarClock, Flag, ListTodo } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  buildActionFeed,
  loadTriage,
  pruneTriage,
  saveTriage,
  setTriageState,
  type QueueBucket,
  type QueueItem,
  type TriageMap,
  type TriageState,
} from "../../lib/action-feed";
import type { CrmSnapshot } from "../../lib/crm-types";
import { StatusBadge } from "../shared";
import { formatDateTime } from "./crm-shared";

/**
 * 驾驶舱统一行动队列：over/today/week 三桶 + 本机 triage（已处理/忽略/撤销，存 localStorage）。
 * 只做本机状态，不回写钉钉/鲲鹏；PPL 只展示临近节点，本批次不提供任何创建入口。
 */

const KIND_ICON: Record<QueueItem["kind"], LucideIcon> = {
  todo: ListTodo,
  meeting: CalendarClock,
  mention: AtSign,
  ppl: Flag,
};

const BUCKETS: readonly { id: QueueBucket; label: string }[] = [
  { id: "over", label: "已逾期" },
  { id: "today", label: "今天" },
  { id: "week", label: "7 天内" },
];

type BadgeTone = "amber" | "green" | "blue" | "muted";

const URGENCY_BADGE: Record<QueueItem["urgency"], { label: string; tone: BadgeTone }> = {
  overdue: { label: "已逾期", tone: "amber" },
  today: { label: "今天", tone: "green" },
  soon: { label: "近 3 天", tone: "blue" },
  watch: { label: "关注", tone: "muted" },
};

const STATE_BADGE: Record<TriageState, { label: string; tone: BadgeTone }> = {
  done: { label: "已处理", tone: "muted" },
  ignored: { label: "已忽略", tone: "muted" },
};

function pplBadge(days: number): { label: string; tone: BadgeTone } {
  if (days < 0) return { label: `逾期 ${-days} 天`, tone: "amber" };
  if (days === 0) return { label: "今天", tone: "green" };
  return { label: `${days} 天后`, tone: "blue" };
}

function shortDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function QueueRow({ item, onTriage }: { item: QueueItem; onTriage: (key: string, state: TriageState | null) => void }) {
  const Icon = KIND_ICON[item.kind];
  const badge = item.state
    ? STATE_BADGE[item.state]
    : item.kind === "ppl" && item.days !== null
      ? pplBadge(item.days)
      : URGENCY_BADGE[item.urgency];
  return (
    <li className={`crm-action ${item.state ? "is-handled" : ""}`}>
      <Icon size={15} />
      <div>
        <strong>{item.customer ? `${item.customer} · ${item.title}` : item.title}</strong>
        <span>{item.detail}</span>
      </div>
      <time>{item.at === null ? "无日期" : item.kind === "ppl" ? shortDay(item.at) : formatDateTime(item.at)}</time>
      <div className="crm-queue__ops">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {item.state === null ? (
          <>
            <button className="text-button" onClick={() => onTriage(item.key, "done")}>已处理</button>
            <button className="text-button" onClick={() => onTriage(item.key, "ignored")}>忽略</button>
          </>
        ) : (
          <button className="text-button" onClick={() => onTriage(item.key, null)}>撤销</button>
        )}
      </div>
    </li>
  );
}

export function ActionQueuePanel({ snapshot, now }: { snapshot: CrmSnapshot; now: number }) {
  const [triage, setTriage] = useState<TriageMap>(() => loadTriage());
  const [showHandled, setShowHandled] = useState(false);
  const [active, setActive] = useState<QueueBucket>("over");

  // 本机持久化：状态一变即写回（顺手 prune 过期条目）；写失败静默降级为会话内状态。
  useEffect(() => {
    saveTriage(pruneTriage(triage, Date.now()));
  }, [triage]);

  const onTriage = useCallback((key: string, state: TriageState | null) => {
    setTriage((prev) => pruneTriage(setTriageState(prev, key, state, Date.now()), Date.now()));
  }, []);

  const feed = useMemo(
    () => buildActionFeed(snapshot, { now, triage, showHandled }),
    [snapshot, now, triage, showHandled],
  );

  const rows = feed.buckets[active];
  const emptyHint = feed.counts.open === 0 && feed.counts.dealt === 0
    ? "暂无需要行动的待办、会议、@ 或 PPL 临近节点。"
    : showHandled ? "本桶暂无项目。" : "本桶没有未处理项目，可切换时间桶或展开已处理。";

  return (
    <section className="panel">
      <header className="panel__header">
        <div><span className="eyebrow">ACTION QUEUE</span><h2>行动队列</h2></div>
        <div className="crm-queue__tools">
          <span>{feed.counts.open} 项待行动</span>
          <button className="text-button" onClick={() => setShowHandled((value) => !value)}>
            {showHandled ? "隐藏已处理" : `显示已处理 ${feed.counts.dealt}`}
          </button>
        </div>
      </header>
      <div className="dimension-tabs crm-queue__tabs" role="tablist" aria-label="行动队列时间桶">
        {BUCKETS.map((bucket) => (
          <button
            key={bucket.id}
            role="tab"
            aria-selected={active === bucket.id}
            className={active === bucket.id ? "is-active" : undefined}
            onClick={() => setActive(bucket.id)}
          >
            {bucket.label} {feed.counts[bucket.id]}
          </button>
        ))}
      </div>
      {rows.length === 0
        ? <p className="crm-muted">{emptyHint}</p>
        : (
          <ul className="crm-list">
            {rows.map((item) => <QueueRow key={item.id} item={item} onTriage={onTriage} />)}
          </ul>
        )}
    </section>
  );
}
