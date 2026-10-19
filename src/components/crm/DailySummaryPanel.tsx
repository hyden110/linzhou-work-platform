import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Users,
} from "lucide-react";
import { dingtalkBoard, type GroupLink } from "../../lib/crm-model";
import {
  DingtalkClientError,
  dingtalkErrorMessage,
  fetchDailyMessages,
  fetchDailySummary,
  fetchSummaryStatus,
  startDailySummary,
} from "../../lib/dingtalk-client";
import type {
  DailyChatSummary,
  DailyMessage,
  DailySummary,
  DailyTicket,
  SummaryStatus,
} from "../../lib/dingtalk-types";
import { StatusBadge } from "../shared";
import { useCrm } from "./CrmProvider";
import { formatDateTime } from "./crm-shared";
import { TodoComposeDialog } from "./TodoComposeDialog";

const TICKET_RANK: Record<DailyTicket["status"], number> = {
  unresolved: 0,
  unconfirmed: 1,
  resolved: 2,
};

const TICKET_LABEL: Record<DailyTicket["status"], { text: string; tone: "amber" | "blue" | "green" }> = {
  unresolved: { text: "未解决", tone: "amber" },
  unconfirmed: { text: "待确认", tone: "blue" },
  resolved: { text: "已解决", tone: "green" },
};

const SUMMARY_ERRORS: Record<string, string> = {
  summary_failed: "生成脚本失败，未产出摘要。",
  summary_timeout: "生成超时，未产出摘要。",
  summary_stale: "上次生成进程已中断，状态已重置；可重新发起生成。",
  all_chats_failed: "所有群读取失败，本轮没有可用摘要。",
};

const SUMMARY_WARNINGS: Record<string, string> = {
  isolated_log_chmod_failed: "本地 qodercli 日志权限收紧失败（日志可能含消息正文）",
};

type EvidenceState =
  | { state: "loading" }
  | { state: "ready"; messages: DailyMessage[] }
  | { state: "error"; error: string };

function todayInput(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function unresolvedCount(chats: readonly DailyChatSummary[]): number {
  return chats.reduce(
    (sum, chat) => sum + chat.tickets.filter((ticket) => ticket.status === "unresolved").length,
    0,
  );
}

function orderedTickets(chat: DailyChatSummary): DailyTicket[] {
  return [...chat.tickets].sort((left, right) => TICKET_RANK[left.status] - TICKET_RANK[right.status]);
}

export function DailySummaryPanel() {
  const { snapshot } = useCrm();
  const [date, setDate] = useState(todayInput);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});
  const [composeTitle, setComposeTitle] = useState<string | null>(null);

  const load = useCallback(async (target: string | null) => {
    setLoading(true);
    setError("");
    try {
      const found = await fetchDailySummary(target ?? undefined);
      setSummary(found);
      setDate(found.date);
    } catch (caught) {
      if (caught instanceof DingtalkClientError && caught.code === "summary_not_found") {
        setSummary(null);
      } else {
        setError(dingtalkErrorMessage(caught));
      }
    } finally {
      setLoading(false);
    }
    try {
      setStatus(await fetchSummaryStatus());
    } catch {
      // Status is advisory; the artifact (or its absence) is already rendered.
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const running = status?.state === "running";
  const today = todayInput();
  const historical = date !== "" && date !== today;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchSummaryStatus()
        .then(async (next) => {
          setStatus(next);
          if (next.state === "succeeded") await load(next.date ?? date);
          if (next.state === "failed") setError(SUMMARY_ERRORS[next.error ?? ""] ?? "总结生成失败。");
        })
        .catch((caught: unknown) => setError(dingtalkErrorMessage(caught)));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [running, date, load]);

  const generate = useCallback(async () => {
    if (historical) {
      setError("历史日期产物只读，只能查看已有总结；生成从当前水位继续。");
      return;
    }
    setError("");
    try {
      const next = await startDailySummary(date || undefined);
      setStatus(next);
    } catch (caught) {
      setError(dingtalkErrorMessage(caught));
    }
  }, [date, historical]);

  const links = useMemo(() => {
    const map = new Map<string, GroupLink>();
    if (!snapshot) return map;
    for (const link of dingtalkBoard(snapshot).links) map.set(link.group.id, link);
    return map;
  }, [snapshot]);

  const grouped = useMemo(() => {
    if (!summary) return null;
    const customers = new Map<string, { name: string; chats: DailyChatSummary[] }>();
    const unconfirmed: { chat: DailyChatSummary; customerName: string }[] = [];
    const unlinked: DailyChatSummary[] = [];
    for (const chat of summary.chats) {
      const link = links.get(chat.chatId);
      if (!link) {
        unlinked.push(chat);
      } else if (link.status === "unconfirmed") {
        unconfirmed.push({ chat, customerName: link.customer.name });
      } else {
        const bucket = customers.get(link.customer.cid) ?? { name: link.customer.name, chats: [] };
        bucket.chats.push(chat);
        customers.set(link.customer.cid, bucket);
      }
    }
    const byTickets = (chats: readonly DailyChatSummary[]) =>
      [...chats].sort((left, right) =>
        unresolvedCount([right]) - unresolvedCount([left])
        || right.messageCount - left.messageCount
        || left.chatName.localeCompare(right.chatName, "zh-CN"));
    return {
      customers: [...customers.values()]
        .map((bucket) => ({ ...bucket, chats: byTickets(bucket.chats), unresolved: unresolvedCount(bucket.chats) }))
        .sort((left, right) => right.unresolved - left.unresolved || left.name.localeCompare(right.name, "zh-CN")),
      unconfirmed: unconfirmed.sort((left, right) =>
        unresolvedCount([right.chat]) - unresolvedCount([left.chat])
        || left.chat.chatName.localeCompare(right.chat.chatName, "zh-CN")),
      unlinked: byTickets(unlinked),
    };
  }, [summary, links]);

  const toggleEvidence = async (chat: DailyChatSummary, ticketKey: string) => {
    if (!summary) return;
    const key = `${summary.date}:${chat.chatId}`;
    setOpenEvidence((current) => ({ ...current, [ticketKey]: !current[ticketKey] }));
    if (evidence[key]?.state === "ready" || evidence[key]?.state === "loading") return;
    setEvidence((current) => ({ ...current, [key]: { state: "loading" } }));
    try {
      const data = await fetchDailyMessages(summary.date, chat.chatId);
      setEvidence((current) => ({ ...current, [key]: { state: "ready", messages: data.messages } }));
    } catch (caught) {
      setEvidence((current) => ({ ...current, [key]: { state: "error", error: dingtalkErrorMessage(caught) } }));
    }
  };

  const renderChat = (chat: DailyChatSummary, customerName: string | null) => {
    const key = `${summary?.date ?? date}:${chat.chatId}`;
    const proof = evidence[key];
    const tickets = orderedTickets(chat);
    const anchor = chat.chatId.replace(/[^A-Za-z0-9_-]/g, "_");
    return (
      <article className="crm-daily-chat" key={chat.chatId}>
        <header>
          <div>
            <strong>{chat.chatName}</strong>
            <span>
              {chat.messageCount} 条消息 · {formatDateTime(chat.windowStart)} → {formatDateTime(chat.windowEnd)}
              {customerName ? ` · ${customerName}` : ""}
            </span>
          </div>
          <div className="crm-daily-chat__badges">
            {chat.error && <StatusBadge tone="amber">读取失败</StatusBadge>}
            {chat.truncated && <StatusBadge tone="amber">截断 {chat.messageCount} 条</StatusBadge>}
            {chat.windowCapped && <StatusBadge tone="amber">窗口截断 72h</StatusBadge>}
            {chat.partial && !chat.truncated && !chat.error && <StatusBadge tone="amber">分页不完整</StatusBadge>}
            {chat.summaryState === "fallback" && <StatusBadge tone="amber">未生成摘要</StatusBadge>}
            {chat.summaryState === "failed" && <StatusBadge tone="amber">摘要失败</StatusBadge>}
          </div>
        </header>
        {chat.summaryNote && <p className="crm-daily-chat__note">{chat.summaryNote}</p>}
        <p className="crm-daily-chat__summary">{chat.summary}</p>
        {chat.tickets.length > 0 && (
          <ul className="crm-ticket-list">
            {tickets.map((ticket, index) => {
              const label = TICKET_LABEL[ticket.status];
              const ticketKey = `${key}:${index}`;
              const panelId = `ticket-evidence-${summary?.date ?? date}-${anchor}-${index}`;
              const open = openEvidence[ticketKey] === true;
              const messages = proof?.state === "ready"
                ? proof.messages.filter((message) => ticket.evidence.includes(message.messageId))
                : [];
              return (
                <li className={`crm-ticket is-${ticket.status}`} key={`${chat.chatId}-${index}-${ticket.problem}`}>
                  <div className="crm-ticket__head">
                    <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
                    <strong>{ticket.problem}</strong>
                  </div>
                  <span className="crm-ticket__meta">
                    {ticket.firstSeenAt ? `${formatDateTime(ticket.firstSeenAt)} 起` : "时间未知"}
                    {ticket.status === "resolved" && ticket.solution ? ` · ${ticket.solution}` : ""}
                    {ticket.status === "resolved" && !ticket.solution ? " · 有解决表述，未记录方案" : ""}
                  </span>
                  <div className="crm-ticket__actions">
                    {ticket.evidence.length > 0 && (
                      <button
                        className="text-button"
                        aria-expanded={open}
                        aria-controls={open ? panelId : undefined}
                        onClick={() => void toggleEvidence(chat, ticketKey)}
                      >
                        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        {open ? "收起证据" : `证据 ${ticket.evidence.length}`}
                      </button>
                    )}
                    {ticket.status === "unresolved" && (
                      <button
                        className="text-button"
                        onClick={() => setComposeTitle(
                          `${customerName ?? chat.chatName}-${ticket.problem}-跟进`.slice(0, 200),
                        )}
                      >
                        转待办
                      </button>
                    )}
                  </div>
                  {open && ticket.evidence.length > 0 && (
                    <div className="crm-ticket__evidence" id={panelId}>
                      {proof?.state === "loading" && <p>读取证据原文…</p>}
                      {proof?.state === "error" && <p>{proof.error}</p>}
                      {proof?.state === "ready" && messages.length === 0 && <p>证据原文不在本机缓存中。</p>}
                      {proof?.state === "ready" && messages.length > 0 && (
                        <ul>
                          {messages.map((message) => (
                            <li key={message.messageId}>
                              <span>{message.sender || "未知发送人"} · {formatDateTime(message.time)}</span>
                              <p>{message.text || "（空消息）"}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </article>
    );
  };

  const failure = status?.state === "failed" || summary?.state === "failed";

  return (
    <section className="panel crm-daily">
      <header className="panel__header">
        <div><span className="eyebrow">DAILY DIGEST</span><h2>每日群消息总结</h2></div>
        <div className="crm-daily__controls">
          <label className="crm-daily__date">
            <CalendarDays size={14} />
            <input
              type="date"
              value={date}
              aria-label="总结日期"
              onChange={(event) => {
                const value = event.target.value;
                setDate(value);
                if (value) void load(value);
              }}
            />
          </label>
          <button
            className="primary-button"
            onClick={() => void generate()}
            disabled={running || loading || historical}
            title={historical ? "历史产物只读；生成从当前水位继续" : undefined}
          >
            {running ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {running ? "生成中…" : "立即生成"}
          </button>
        </div>
      </header>

      {historical && (
        <p className="crm-daily__readonly">
          历史产物只读；生成从当前水位继续（切换到 {today} 可生成今天的总结）。
        </p>
      )}

      {status?.warnings && status.warnings.length > 0 && (
        <p className="crm-daily__warning" role="status">
          <AlertTriangle size={13} />
          摘要已生成，但{status.warnings.map((code) => SUMMARY_WARNINGS[code] ?? code).join("；")}；建议在终端检查日志目录权限。
        </p>
      )}

      {failure && (
        <div className="crm-daily__alert" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>总结生成失败</strong>
            <p>{SUMMARY_ERRORS[status?.error ?? summary?.error ?? ""] ?? error ?? "本轮未产出摘要，请稍后重试。"}</p>
          </div>
        </div>
      )}
      {error && !failure && <p className="crm-daily__alert-text" role="alert">{error}</p>}

      {loading && !summary ? (
        <p className="crm-daily__loading"><LoaderCircle className="spin" size={15} />读取群消息总结…</p>
      ) : !summary ? (
        <div className="crm-daily__empty">
          <MessageSquare size={20} />
          <p>{date} 还没有群消息总结。生成会读取当天未读群的最近消息（只读，不清红点）。</p>
          <button className="primary-button" onClick={() => void generate()} disabled={running || historical}>
            {running ? "生成中…" : historical ? "历史日期不可生成" : `生成 ${date} 总结`}
          </button>
        </div>
      ) : (
        <>
          <div className="crm-daily__meta">
            <span>生成于 {formatDateTime(summary.generatedAt)}</span>
            <span>{summary.counts.groups} 个群 · {summary.counts.messages} 条消息 · {summary.counts.tickets} 个工单</span>
            <span>{summary.counts.unresolved} 未解决 · {summary.counts.unconfirmed} 待确认</span>
            {summary.counts.singleChats > 0 && <span>单聊 {summary.counts.singleChats} 个仅计数</span>}
            {summary.skippedGroups > 0 && (
              <span className="is-warn">另 {summary.skippedGroups} 个群超过每轮 20 个上限，未读取</span>
            )}
            {summary.model === "fallback" && summary.chats.length > 0 && (
              <span className="is-warn">摘要通道不可用，以下为规则抽取</span>
            )}
          </div>
          {summary.counts.failedChats > 0 && (
            <div className="crm-daily__alert" role="alert">
              <AlertTriangle size={15} />
              <div>
                <strong>{summary.counts.failedChats} 个群读取失败</strong>
                <p>失败的群保留原水位，下一轮会重试；摘要为空不会伪造。</p>
              </div>
            </div>
          )}

          {summary.chats.length === 0 && (
            <p className="crm-muted">当天没有需要总结的未读群。</p>
          )}

          <div className="crm-daily__groups">
            {grouped?.customers.map((bucket) => (
              <section className="crm-daily-group" key={bucket.name}>
                <header>
                  <Users size={14} />
                  <strong>{bucket.name}</strong>
                  <span>{bucket.chats.length} 个群 · {bucket.unresolved} 个未解决</span>
                </header>
                {bucket.chats.map((chat) => renderChat(chat, bucket.name))}
              </section>
            ))}

            {grouped && grouped.unconfirmed.length > 0 && (
              <section className="crm-daily-group">
                <header>
                  <Users size={14} />
                  <strong>待确认匹配的群</strong>
                  <span>{grouped.unconfirmed.length} 个群 · 匹配结果需人工核对</span>
                </header>
                {grouped.unconfirmed.map(({ chat, customerName }) => renderChat(chat, `疑似 ${customerName}`))}
              </section>
            )}

            {grouped && grouped.unlinked.length > 0 && (
              <section className="crm-daily-group">
                <header>
                  <Users size={14} />
                  <strong>未匹配群</strong>
                  <span>{grouped.unlinked.length} 个群</span>
                </header>
                {grouped.unlinked.map((chat) => renderChat(chat, null))}
              </section>
            )}
          </div>
        </>
      )}

      <TodoComposeDialog
        open={composeTitle !== null}
        prefillTitle={composeTitle ?? ""}
        onClose={() => setComposeTitle(null)}
      />
    </section>
  );
}
