import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Inbox, LoaderCircle, RefreshCw, Send, Sparkles } from "lucide-react";
import {
  fetchNotifyItems,
  markNotifyRead,
  NOTIFY_KIND_LABELS,
  NOTIFY_KINDS,
  notifyErrorMessage,
  notifyRelativeTime,
  sendNotifyTest,
  type NotifyItem,
  type NotifyKind,
  type NotifyStateView,
} from "../lib/notify-client";
import {
  fetchReplyCandidates,
  fetchReplyHistory,
  fetchReplySends,
  replyErrorMessage,
  sendReply,
  suggestReply,
  type ReplyCandidatesSnapshot,
  type ReplyDraftRow,
  type ReplySendAudit,
} from "../lib/reply-client";
import type { ReplyCandidate } from "../lib/reply-model";
import { useLive } from "../hooks/use-live";
import { ViewHeading } from "./shared";
import "../reply.css";

/**
 * 「消息中心」视图（F6 明细 + F9 待回复）：
 * - 收件箱明细：筛选 + 行内「明细」展开（原文 / 时间 / 来源徽章），只动 read 位；
 * - 待回复分栏：候选（钉钉源未读或未回复）→ 生成建议（只走本机引擎，缺失诚实报错
 *   绝不回落云端）→ 草稿编辑 → 发送弹窗逐条人工确认（confirm === 候选 id，服务端同口径把关）；
 * - 草稿历史 / 发送审计折叠区（只存结论与掩码预览，不含消息原文全文）；
 * - SSE snapshot:inbox 防抖 400ms 重拉（收件箱与候选同源）。
 */

const READ_FILTERS = ["全部", "未读", "已读"] as const;
type ReadFilter = (typeof READ_FILTERS)[number];

const REPLY_MAX_CHARS = 600;

interface ActionStatus {
  readonly kind: "error" | "ok" | "warn";
  readonly text: string;
}

interface DraftMeta {
  readonly tone: string;
  readonly reason: string;
  readonly needReply: boolean;
  readonly ms: number;
  readonly engine: string;
  readonly contextProfile: boolean;
}

interface ReplyData {
  readonly snapshot: ReplyCandidatesSnapshot | null;
  readonly history: readonly ReplyDraftRow[];
  readonly sends: readonly ReplySendAudit[];
  readonly sendsTotal: number;
  readonly error: string;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** 回复中心数据面：candidates/history/sends 一把拉齐 + SSE 防抖重拉。 */
function useReplyData(): ReplyData {
  const [snapshot, setSnapshot] = useState<ReplyCandidatesSnapshot | null>(null);
  const [history, setHistory] = useState<readonly ReplyDraftRow[]>([]);
  const [sends, setSends] = useState<readonly ReplySendAudit[]>([]);
  const [sendsTotal, setSendsTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([fetchReplyCandidates(), fetchReplyHistory(), fetchReplySends()])
      .then(([cand, hist, sent]) => {
        setSnapshot(cand);
        setHistory(hist);
        setSends(sent.sends);
        setSendsTotal(sent.total);
        setError("");
      })
      .catch((loadError: unknown) => setError(replyErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const timerRef = useRef<number | undefined>(undefined);
  useLive(["snapshot:inbox"], () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(reload, 400);
  });
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return useMemo(
    () => ({ snapshot, history, sends, sendsTotal, error, loading, reload }),
    [snapshot, history, sends, sendsTotal, error, loading, reload],
  );
}

/* -------------------------------------------------------------------------- */
/* 收件箱行：明细展开（原文 / 时间 / 来源徽章）                                  */
/* -------------------------------------------------------------------------- */

interface InboxRowProps {
  readonly item: NotifyItem;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly onToggleRead: () => void;
}

function InboxRow({ item, busy, expanded, onToggleExpand, onToggleRead }: InboxRowProps) {
  return (
    <li className="ntf-item inbox-row" data-read={item.read ? "yes" : "no"}>
      <span className={`ntf-kind ntf-kind--${item.kind}`}>{NOTIFY_KIND_LABELS[item.kind]}</span>
      <span className="ntf-item__main">
        <strong>{item.title}</strong>
        {item.summary && !expanded && <em>{item.summary}</em>}
        <span className="ntf-item__meta">
          {item.source && <span>{item.source}</span>}
          <time>{notifyRelativeTime(item.createdAt, Date.now())}</time>
          {/^https?:\/\//i.test(item.link) && <a href={item.link} target="_blank" rel="noreferrer"><ExternalLink size={11} /></a>}
        </span>
        {expanded && (
          <span className="inbox-row__detail">
            <span className="inbox-row__badges">
              <span className="reply-badge">{NOTIFY_KIND_LABELS[item.kind]}</span>
              <span className="reply-badge">来源：{item.source || "未标注"}</span>
              <span className={`reply-badge${item.read ? "" : " reply-badge--unread"}`}>{item.read ? "已读" : "未读"}</span>
            </span>
            <p>{item.summary || "（该消息没有正文摘要：生产者只写了标题，明细不猜测补全。）"}</p>
            <span className="ntf-item__meta">
              <time>产生于 {item.createdAt || "未知时间"}</time>
              {item.readAt && <time>已读于 {item.readAt}</time>}
            </span>
          </span>
        )}
      </span>
      <button className="inbox-row__toggle" onClick={onToggleExpand} aria-expanded={expanded}>
        {expanded ? "收起" : "明细"}
      </button>
      <button className="ntf-item__read" onClick={onToggleRead} disabled={busy} aria-label={item.read ? "标记未读" : "标记已读"}>
        {item.read ? "标未读" : "已读"}
      </button>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* 待回复分栏：候选列表 / 草稿面板 / 发送确认弹窗 / 折叠区                        */
/* -------------------------------------------------------------------------- */

interface CandidateListProps {
  readonly items: readonly ReplyCandidate[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}

function CandidateList({ items, selectedId, onSelect }: CandidateListProps) {
  if (items.length === 0) {
    return <p className="reply-empty">暂无待回复候选：钉钉源「未读或未回复」的消息会出现在这里（已成功回复且已读的自动退出清单）。</p>;
  }
  return (
    <ul className="reply-candidates">
      {items.map((candidate) => (
        <li key={candidate.id}>
          <button
            type="button"
            className={`reply-candidate${candidate.id === selectedId ? " is-selected" : ""}`}
            onClick={() => onSelect(candidate.id)}
          >
            <strong>{candidate.title || candidate.id}</strong>
            <span className="reply-candidate__meta">
              <span className="reply-badge reply-badge--dingtalk">钉钉</span>
              {!candidate.read && <span className="reply-badge reply-badge--unread">未读</span>}
              {candidate.replied && <span className="reply-badge reply-badge--replied">已回复</span>}
              {!candidate.group && <span className="reply-badge reply-badge--warn">无会话 id · 仅可复制</span>}
              <time>{notifyRelativeTime(candidate.createdAt, Date.now())}</time>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface SendDialogProps {
  readonly candidate: ReplyCandidate;
  readonly text: string;
  readonly busy: boolean;
  readonly checked: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function SendDialog({ candidate, text, busy, checked, onCheck, onCancel, onConfirm }: SendDialogProps) {
  return (
    <div className="reply-dialog__backdrop">
      <div className="reply-dialog" role="dialog" aria-modal="true" aria-label="钉钉发送确认">
        <h3>确认发送到钉钉（逐条人工确认）</h3>
        <div className="reply-dialog__row"><span>目标群</span><span>{candidate.group}</span></div>
        <div className="reply-dialog__row"><span>会话</span><span>{candidate.title || candidate.id}</span></div>
        <div className="reply-dialog__row"><span>正文</span><span>{text.length} / {REPLY_MAX_CHARS} 字（不截断发送）</span></div>
        <pre className="reply-dialog__preview">{text}</pre>
        <label className="reply-dialog__confirm">
          <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} disabled={busy} />
          我已核对以上群名与正文，确认发送这一条（dws chat message send --group {candidate.group}）。
        </label>
        <div className="reply-dialog__actions">
          <button className="text-button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" onClick={onConfirm} disabled={!checked || busy}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}确认发送
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryFold({ rows }: { readonly rows: readonly ReplyDraftRow[] }) {
  return (
    <details className="reply-fold">
      <summary>草稿历史（{rows.length} 条 · 只存结论，不存消息原文上下文）</summary>
      <div className="reply-fold__body">
        {rows.length === 0 ? (
          <p className="reply-empty">暂无草稿：生成建议后自动留档（最近 200 条）。</p>
        ) : (
          <table className="reply-table">
            <thead><tr><th>时间</th><th>会话</th><th>结论</th><th>语气</th><th>正文</th></tr></thead>
            <tbody>
              {rows.slice(0, 50).map((row) => (
                <tr key={row.sid}>
                  <td>{row.at || "—"}</td>
                  <td>{row.convTitle || row.id}</td>
                  <td>{row.needReply ? "需回复" : "无需回复"}</td>
                  <td>{row.tone || "—"}</td>
                  <td>{row.text || "（空）"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

function SendsFold({ sends, total }: { readonly sends: readonly ReplySendAudit[]; readonly total: number }) {
  return (
    <details className="reply-fold">
      <summary>发送审计（最近 {sends.length} 条 / 共 {total} 次真实尝试 · 正文只留掩码预览）</summary>
      <div className="reply-fold__body">
        {sends.length === 0 ? (
          <p className="reply-empty">暂无发送记录：每次真实 dws 尝试（成败都算）都会在这里留痕。</p>
        ) : (
          <table className="reply-table">
            <thead><tr><th>时间</th><th>群</th><th>退出码</th><th>掩码预览</th></tr></thead>
            <tbody>
              {sends.map((row, index) => (
                <tr key={`${row.at}-${row.id}-${index}`}>
                  <td>{row.at || "—"}</td>
                  <td>{row.group || "—"}</td>
                  {row.exitCode === 0
                    ? <td className="is-ok">0 · 已发出</td>
                    : <td className="is-bad">{String(row.exitCode)} · 失败</td>}
                  <td>{row.maskedPreview || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

interface ReplyWorkbenchProps {
  readonly data: ReplyData;
  readonly reloadInbox: () => void;
}

function ReplyWorkbench({ data, reloadInbox }: ReplyWorkbenchProps) {
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState("");
  const [meta, setMeta] = useState<DraftMeta | null>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [dialog, setDialog] = useState(false);
  const [checked, setChecked] = useState(false);

  const candidate = useMemo(
    () => data.snapshot?.items.find((entry) => entry.id === selectedId) ?? null,
    [data.snapshot, selectedId],
  );
  const engineMissing = data.snapshot !== null && !data.snapshot.engine.available;
  const quota = data.snapshot?.quota;

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setDraft("");
    setMeta(null);
    setStatus(null);
    setDialog(false);
    setChecked(false);
  }, []);

  const suggest = useCallback(async () => {
    if (!candidate) return;
    setBusy("suggest");
    setStatus(null);
    try {
      const outcome = await suggestReply(candidate.id);
      setDraft(outcome.text);
      setMeta({ tone: outcome.tone, reason: outcome.reason, needReply: outcome.needReply, ms: outcome.ms, engine: outcome.engine, contextProfile: outcome.contextProfile });
      setStatus(outcome.needReply
        ? { kind: "ok", text: `本机引擎已生成建议（${outcome.ms}ms · 语气「${outcome.tone || "未标注"}」${outcome.contextProfile ? " · 已带入客户画像" : " · 无客户画像上下文"}），请编辑确认后再发送。` }
        : { kind: "warn", text: "引擎判断该消息无需回复：正文为空。如仍需回复请手动撰写（该判断已如实留档）。" });
      data.reload();
    } catch (error: unknown) {
      setStatus({ kind: "error", text: replyErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }, [candidate, data]);

  const copy = useCallback(async () => {
    setBusy("copy");
    try {
      await navigator.clipboard.writeText(draft);
      setStatus({ kind: "ok", text: "正文已复制：请粘贴到目标客户端，由人确认后发送。" });
    } catch {
      setStatus({ kind: "error", text: "复制失败（当前环境剪贴板不可用）：请手动选中正文复制。" });
    } finally {
      setBusy("");
    }
  }, [draft]);

  const openDialog = useCallback(() => {
    if (!candidate) return;
    const text = draft.trim();
    if (!text) {
      setStatus({ kind: "error", text: "没有可发送的正文：请先生成建议或在草稿编辑框输入内容。" });
      return;
    }
    if (text.length > REPLY_MAX_CHARS) {
      setStatus({ kind: "error", text: `正文 ${text.length} 字，超过上限 ${REPLY_MAX_CHARS} 字：不会截断发送，请删减后再试。` });
      return;
    }
    setChecked(false);
    setStatus(null);
    setDialog(true);
  }, [candidate, draft]);

  const confirmSend = useCallback(async () => {
    if (!candidate) return;
    setBusy("send");
    try {
      const outcome = await sendReply({ id: candidate.id, text: draft.trim(), confirm: candidate.id });
      setDialog(false);
      setChecked(false);
      setDraft("");
      setMeta(null);
      setStatus({ kind: "ok", text: `已发送到钉钉群 ${outcome.group}${outcome.audited ? "（审计已落盘）" : "（注意：审计写入失败，发送本身已成功）"}。` });
      await markNotifyRead({ ids: [candidate.id], read: true }).catch(() => {});
      reloadInbox();
      data.reload();
    } catch (error: unknown) {
      setDialog(false);
      setStatus({ kind: "error", text: replyErrorMessage(error) });
      data.reload();
    } finally {
      setBusy("");
    }
  }, [candidate, draft, data, reloadInbox]);

  const noGroupTitle = "未能解析钉钉会话 openConversationId：该条不允许自动发送，请使用「复制正文」人工发送。";

  return (
    <section className="panel reply-panel" aria-label="待回复">
      <div className="panel__header">
        <div>
          <span className="eyebrow">REPLY / DINGTALK CONFIRM-SEND</span>
          <h2>待回复</h2>
        </div>
        <div className="inbox-actions">
          {quota && (
            <span className="reply-quota">今日建议 {quota.used}/{quota.limit} · 单会话上限 {quota.perConvLimit}</span>
          )}
          <button className="text-button" onClick={data.reload} disabled={data.loading}>
            {data.loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
          </button>
        </div>
      </div>
      <p className="history-panel__note">
        候选 = 钉钉源且「未读或未回复」的本机消息；建议生成只走本机引擎（qoder/qodercli，上下文仅 CRM 客户画像 + 该消息原文）；
        发送仅限钉钉，弹窗逐条人工确认（服务端要求 confirm === 候选 id 才执行），微信/未知源只允许复制。
      </p>

      {data.error && <div className="answer-warning"><AlertCircle size={15} /> {data.error}</div>}
      {engineMissing && (
        <p className="reply-status reply-status--warn">
          <AlertCircle size={14} /> 本机未检测到 AI 引擎（qoder/qodercli）：无法生成建议（只走本机引擎，绝不回落云端 API）；仍可手动撰写正文并人工确认发送。
        </p>
      )}

      <div className="reply-layout">
        <CandidateList items={data.snapshot?.items ?? []} selectedId={selectedId} onSelect={select} />
        <div className="reply-draft">
          {!candidate ? (
            <p className="reply-empty">从左侧选择一条候选：生成建议 → 编辑正文 → 弹窗逐条确认后发送。</p>
          ) : (
            <>
              <div className="reply-draft__head">
                <h3>{candidate.title || candidate.id}</h3>
                <span className="reply-draft__meta">
                  <span className="reply-badge reply-badge--dingtalk">钉钉</span>
                  {candidate.group
                    ? <span className="reply-badge">{candidate.group}</span>
                    : <span className="reply-badge reply-badge--warn">无会话 id · 仅可复制</span>}
                </span>
              </div>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="点「生成建议」由本机引擎起草，或直接撰写正文（上限 600 字，超限不截断、如实拒发）。"
                aria-label="回复草稿"
              />
              <div className="reply-draft__actions">
                <span className="reply-quota">{draft.trim().length} / {REPLY_MAX_CHARS} 字</span>
                <button
                  className="text-button"
                  onClick={suggest}
                  disabled={busy !== "" || engineMissing}
                  title={engineMissing
                    ? "本机未检测到 AI 引擎（qoder/qodercli）：只走本机引擎，绝不回落云端 API。"
                    : "本机引擎生成：上下文仅 CRM 客户画像（只读）+ 该消息原文；每会话每日 6 条 / 全局每日 60 条。"}
                >
                  {busy === "suggest" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}生成建议
                </button>
                <button className="text-button" onClick={copy} disabled={busy !== "" || !draft.trim()}>
                  {busy === "copy" ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}复制正文
                </button>
                <button
                  className="text-button"
                  onClick={openDialog}
                  disabled={busy !== "" || !candidate.group}
                  title={candidate.group ? "打开弹窗，逐条人工确认后经 dws 发送到钉钉群。" : noGroupTitle}
                >
                  <Send size={14} />发送…
                </button>
              </div>
              {meta && (
                <p className="reply-draft__reason">
                  引擎理由：{meta.reason || "（未提供）"} · 语气「{meta.tone || "未标注"}」 · {meta.ms}ms · {meta.engine || "本机引擎"}{meta.contextProfile ? " · 已带入客户画像" : " · 无客户画像上下文"}
                </p>
              )}
              {status && (
                <p className={`reply-status reply-status--${status.kind}`}>
                  {status.kind === "ok" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />} {status.text}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {dialog && candidate && (
        <SendDialog
          candidate={candidate}
          text={draft.trim()}
          busy={busy === "send"}
          checked={checked}
          onCheck={setChecked}
          onCancel={() => setDialog(false)}
          onConfirm={confirmSend}
        />
      )}

      <HistoryFold rows={data.history} />
      <SendsFold sends={data.sends} total={data.sendsTotal} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 主视图                                                                      */
/* -------------------------------------------------------------------------- */

export function InboxView() {
  const [view, setView] = useState<NotifyStateView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<NotifyKind | "全部">("全部");
  const [readFilter, setReadFilter] = useState<ReadFilter>("全部");
  const [keyword, setKeyword] = useState("");
  const [busyId, setBusyId] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const replyData = useReplyData();

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
          当前生产者仅「测试」消息（P0）：钉钉 / aitable 页外事件源待后续批次接入；打开时拉取 + SSE 快照事件防抖重拉，无自动轮询。
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
            <InboxRow
              key={item.id}
              item={item}
              busy={busyId === item.id}
              expanded={expandedId === item.id}
              onToggleExpand={() => setExpandedId(expandedId === item.id ? "" : item.id)}
              onToggleRead={() => toggleRead(item.id, !item.read)}
            />
          ))}
        </ul>
        {view && rows.length === 0 && !error && (
          <p className="ntf-empty">没有匹配的消息：调整筛选，或点「发送测试消息」验证链路。</p>
        )}
      </section>

      <ReplyWorkbench data={replyData} reloadInbox={load} />
    </div>
  );
}
