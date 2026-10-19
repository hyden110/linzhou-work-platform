import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, ExternalLink, Inbox, LoaderCircle } from "lucide-react";
import {
  fetchNotifyState,
  markNotifyRead,
  NOTIFY_KIND_LABELS,
  notifyErrorMessage,
  notifyRelativeTime,
  notifyUnreadBadge,
  type NotifyStateView,
} from "../lib/notify-client";

/**
 * 顶栏消息铃铛（F6）：挂载时拉取一次 + 打开面板/显式刷新时拉取，无 SSE、无轮询。
 * 桥离线时保持禁用态（对齐静态 notify.js hidden 语义），不放「空面板假象」。
 * 面板承载最近 50 条（明细筛选在「消息中心」视图）；已读切换只动 read 位。
 */

export function NotifyBell({ onOpenInbox }: { readonly onOpenInbox: () => void }) {
  const [state, setState] = useState<NotifyStateView | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchNotifyState()
      .then((data) => {
        setState(data);
        setOffline(false);
      })
      .catch(() => setOffline(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

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

  const openPanel = useCallback(() => {
    setOpen(true);
    load();
  }, [load]);

  if (offline) {
    return (
      <button className="icon-button notification-button" aria-label="消息中心不可用：本地桥未启动" title="本地桥未启动，请确认已在本机运行 npm run dev:function" disabled>
        <Bell size={18} />
      </button>
    );
  }

  const badge = notifyUnreadBadge(state?.unread ?? 0);

  return (
    <div className="ntf-root" ref={rootRef}>
      <button
        className={`icon-button notification-button ${open ? "is-open" : ""}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={`消息中心${badge ? `，${state?.unread} 条未读` : ""}`}
        aria-expanded={open}
        title="消息中心"
      >
        <Bell size={18} />
        {badge && <i className="ntf-badge">{badge}</i>}
      </button>

      {open && (
        <div className="ntf-panel" role="dialog" aria-label="消息中心面板">
          <header className="ntf-panel__head">
            <strong>消息中心</strong>
            <span>
              {loading ? <LoaderCircle className="spin" size={13} /> : null}
              未读 {state?.unread ?? 0} / 共 {state?.total ?? 0}
            </span>
            <div className="ntf-panel__actions">
              <button onClick={markAll} disabled={!state || state.unread === 0 || busyId === "__all__"} title="全部已读">
                <CheckCheck size={14} />全部已读
              </button>
              <button onClick={() => { setOpen(false); onOpenInbox(); }} title="打开消息中心视图">
                <Inbox size={14} />查看全部
              </button>
            </div>
          </header>
          <p className="ntf-panel__note">
            打开时拉取 + 手动刷新，无自动轮询；P0 仅「测试」生产者，钉钉 / aitable 事件源待后续批次接入。
          </p>
          <ul className="ntf-list">
            {(state?.items ?? []).map((item) => (
              <li key={item.id} className="ntf-item" data-read={item.read ? "yes" : "no"}>
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
          {state && state.items.length === 0 && (
            <p className="ntf-empty">收件箱为空：可先在「消息中心」发送测试消息验证链路。</p>
          )}
        </div>
      )}
    </div>
  );
}
