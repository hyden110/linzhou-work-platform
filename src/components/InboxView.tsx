import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ExternalLink, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import {
  fetchNotifyItems,
  markNotifyRead,
  NOTIFY_KIND_LABELS,
  NOTIFY_KINDS,
  notifyErrorMessage,
  notifyRelativeTime,
  sendNotifyTest,
  type NotifyKind,
  type NotifyStateView,
} from "../lib/notify-client";
import { ViewHeading } from "./shared";

/**
 * 「消息中心」视图（F6）：收件箱明细页。类型 / 已读状态 / 关键词筛选 + facet 计数，
 * 时间倒序（桥已按最新在前）；已读切换 / 全部已读只动 read 位。
 * 无 SSE、无轮询：进入视图拉取 + 显式刷新；P0 生产者仅「测试」消息。
 */

const READ_FILTERS = ["全部", "未读", "已读"] as const;
type ReadFilter = (typeof READ_FILTERS)[number];

export function InboxView() {
  const [view, setView] = useState<NotifyStateView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<NotifyKind | "全部">("全部");
  const [readFilter, setReadFilter] = useState<ReadFilter>("全部");
  const [keyword, setKeyword] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetchNotifyItems()
      .then((data) => {
        setView(data);
        setError("");
      })
      .catch((loadError: unknown) => setError(notifyErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const kindCounts = useMemo(() => {
    const counts = new Map<NotifyKind, number>(NOTIFY_KINDS.map((kind) => [kind, 0]));
    for (const item of view?.items ?? []) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    return counts;
  }, [view]);

  const rows = useMemo(() => (view?.items ?? []).filter((item) => {
    if (kindFilter !== "全部" && item.kind !== kindFilter) return false;
    if (readFilter === "未读" && item.read) return false;
    if (readFilter === "已读" && !item.read) return false;
    if (keyword) {
      const haystack = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
      if (!haystack.includes(keyword.toLowerCase())) return false;
    }
    return true;
  }), [view, kindFilter, readFilter, keyword]);

  const toggleRead = useCallback(async (id: string, read: boolean) => {
    setBusyId(id);
    try {
      await markNotifyRead({ ids: [id], read });
      load();
    } catch {
      load();
    } finally {
      setBusyId("");
    }
  }, [load]);

  const markAll = useCallback(async () => {
    setBusyId("__all__");
    try {
      await markNotifyRead({ all: true });
      load();
    } catch {
      load();
    } finally {
      setBusyId("");
    }
  }, [load]);

  const sendTest = useCallback(async () => {
    setBusyId("__test__");
    try {
      await sendNotifyTest();
      load();
    } catch {
      load();
    } finally {
      setBusyId("");
    }
  }, [load]);

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / NOTIFY INBOX"
        title="消息中心"
        description="本机收件箱的明细视图：钉钉 / 线索 / 客户 / 提醒 / 待回复等消息在此聚合筛选；收件箱由本机桥唯一写入（0600 原子落盘、上限 200 条丢最旧）。"
        aside={<Inbox size={22} strokeWidth={1.6} />}
      />

      <section className="panel inbox-panel" aria-label="消息收件箱">
        <div className="panel__header">
          <div>
            <span className="eyebrow">INBOX / LOCAL-ONLY</span>
            <h2>收件箱</h2>
          </div>
          <div className="inbox-actions">
            <button className="text-button" onClick={sendTest} disabled={busyId === "__test__"} title="入队一条显式测试消息（不含真实数据）">
              {busyId === "__test__" ? <LoaderCircle className="spin" size={14} /> : null}发送测试消息
            </button>
            <button className="text-button" onClick={markAll} disabled={!view || view.unread === 0 || busyId === "__all__"}>
              全部已读
            </button>
            <button className="text-button" onClick={load} disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
            </button>
          </div>
        </div>
        <p className="history-panel__note">
          当前生产者仅「测试」消息（P0）：钉钉 / aitable 页外事件源待后续批次接入；打开时拉取 + 显式刷新，无 SSE、无自动轮询。
        </p>

        {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}

        <div className="inbox-filters" aria-label="消息筛选">
          <label>类型
            <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as NotifyKind | "全部")}>
              <option value="全部">全部</option>
              {NOTIFY_KINDS.map((kind) => (
                <option key={kind} value={kind}>{NOTIFY_KIND_LABELS[kind]}（{kindCounts.get(kind) ?? 0}）</option>
              ))}
            </select>
          </label>
          <label>已读
            <select value={readFilter} onChange={(event) => setReadFilter(event.target.value as ReadFilter)}>
              {READ_FILTERS.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label>关键词
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="标题 / 摘要 / 来源" />
          </label>
          <strong>{rows.length.toLocaleString("zh-CN")} 条匹配 · 未读 {view?.unread ?? 0}</strong>
        </div>

        <ul className="inbox-list">
          {rows.map((item) => (
            <li key={item.id} className="ntf-item inbox-row" data-read={item.read ? "yes" : "no"}>
              <span className={`ntf-kind ntf-kind--${item.kind}`}>{NOTIFY_KIND_LABELS[item.kind]}</span>
              <span className="ntf-item__main">
                <strong>{item.title}</strong>
                {item.summary && <em>{item.summary}</em>}
                <span className="ntf-item__meta">
                  {item.source && <span>{item.source}</span>}
                  <time>{notifyRelativeTime(item.createdAt, Date.now())}</time>
                  {/^https?:\/\//i.test(item.link) && <a href={item.link} target="_blank" rel="noreferrer"><ExternalLink size={11} /></a>}
                </span>
              </span>
              <button
                className="ntf-item__read"
                onClick={() => toggleRead(item.id, !item.read)}
                disabled={busyId === item.id}
                aria-label={item.read ? "标记未读" : "标记已读"}
              >
                {item.read ? "标未读" : "已读"}
              </button>
            </li>
          ))}
        </ul>
        {view && rows.length === 0 && !error && (
          <p className="ntf-empty">没有匹配的消息：调整筛选，或点「发送测试消息」验证链路。</p>
        )}
      </section>
    </div>
  );
}
