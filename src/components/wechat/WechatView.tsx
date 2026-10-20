import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";

import { ViewHeading } from "../shared";
import { CustorgImportPanel } from "./CustorgImportPanel";
import {
  deleteWechatBinding,
  fetchWechatBindings,
  fetchWechatSnapshot,
  fetchWechatTree,
  putWechatBinding,
  wechatErrorMessage,
  type WechatBindingView,
  type WechatBindingsSnapshot,
} from "../../lib/wechat-client";
import {
  filterWechatGroups,
  groupWechatTodosByUrgency,
  sortWechatGroups,
  unrepliedWechatSingles,
  wechatCustomerOptions,
  WECHAT_UNBOUND_KEY,
  type WechatGroupSortKey,
  type WechatGroupScope,
  type WechatGroupView,
  type WechatQrTreeView,
  type WechatSnapshotOkView,
  type WechatSnapshotView,
} from "../../lib/wechat-model";
import "../../wechat.css";

/**
 * 「微信办公台账」自包含整页视图：统计卡 + 群台账表（绑定客户徽章 + 本地绑定写）
 * + @我待办清单 + 单聊未回 + 标签筛选 + qr-tree 折叠树。
 *
 * 数据全部来自本地桥（GET /local/wechat、/bindings、/tree）：快照只读、消息正文
 * 只有 ≤24 字掩码、个人 wxid 不出桥；绑定/解绑是本地台账写（桥侧 0600 原子 +
 * 备份 + 单飞 + 审计）。快照缺失如实展示 missing 指引，绝不伪造数据。
 * 样式只消费 globals.css :root 既有 token（见 src/wechat.css），类名 wechat- 前缀。
 * 挂载：由交付负责人注册 ViewId "wechat"（本视图不改动 App/Sidebar/types）。
 */

const SCOPE_LABELS: readonly { readonly id: WechatGroupScope; readonly label: string }[] = [
  { id: "related", label: "客户相关" },
  { id: "active", label: "近30天活跃" },
  { id: "all", label: "全部" },
];

const SORT_LABELS: readonly { readonly id: WechatGroupSortKey; readonly label: string }[] = [
  { id: "at", label: "按 @我未回复" },
  { id: "d30", label: "按近30天消息" },
  { id: "d7", label: "按近7天消息" },
  { id: "last", label: "按最后消息" },
  { id: "atAll", label: "按 @我累计" },
];

const STATUS_BADGE: Record<WechatGroupView["customerStatus"], { tone: "green" | "blue" | "muted"; label: string; tip: string }> = {
  confirmed: { tone: "green", label: "人工绑定", tip: "本地台账人工绑定（PUT /local/wechat/bindings）" },
  matched: { tone: "blue", label: "自动命中", tip: "快照构建时群名自动命中客户名单/别名" },
  pending: { tone: "muted", label: "待确认", tip: "群名未命中客户名单，需人工判定" },
};

function agoLabel(ts: number): string {
  if (!ts) return "—";
  const seconds = Math.floor(Date.now() / 1000) - Number(ts);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  const d = new Date(Number(ts) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dayLabel(ts: number): string {
  if (!ts) return "—";
  const d = new Date(Number(ts) * 1000);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CustPills({ group }: { group: WechatGroupView }) {
  const badge = STATUS_BADGE[group.customerStatus];
  if (!group.custKeys.length) {
    return <span className="wechat-pill wechat-pill--muted" title={badge.tip}>待确认</span>;
  }
  return (
    <>
      {group.custKeys.map((key) => (
        <span key={key} className={`wechat-pill wechat-pill--${badge.tone}`} title={badge.tip}>{key}</span>
      ))}
    </>
  );
}

interface BindDraft {
  readonly custKeysText: string;
  readonly note: string;
}

function emptyDraftOf(group: WechatGroupView): BindDraft {
  return { custKeysText: group.custKeys.join(", "), note: group.bindNote };
}

export function WechatView() {
  const [snapshot, setSnapshot] = useState<WechatSnapshotView | null>(null);
  const [tree, setTree] = useState<WechatQrTreeView | null>(null);
  const [bindings, setBindings] = useState<WechatBindingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  const [scope, setScope] = useState<WechatGroupScope>("related");
  const [custKey, setCustKey] = useState("");
  const [sortKey, setSortKey] = useState<WechatGroupSortKey>("at");
  const [query, setQuery] = useState("");
  const [labelName, setLabelName] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [treeOpen, setTreeOpen] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Readonly<Record<string, BindDraft>>>({});
  const [actionMsg, setActionMsg] = useState<Readonly<Record<string, string>>>({});
  const [busyGroup, setBusyGroup] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchWechatSnapshot(), fetchWechatTree(), fetchWechatBindings()])
      .then(([snap, treeView, ledger]) => {
        setSnapshot(snap);
        setTree(treeView);
        setBindings(ledger);
        setLoadError("");
      })
      .catch((error: unknown) => setLoadError(wechatErrorMessage(error)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const ok = snapshot && snapshot.status === "ok" ? (snapshot as WechatSnapshotOkView) : null;
  const custOptions = useMemo(() => (ok ? wechatCustomerOptions(ok.groups) : []), [ok]);
  const scopeCount = useCallback(
    (id: WechatGroupScope) => (ok ? filterWechatGroups(ok.groups, { scope: id }).length : 0),
    [ok],
  );

  /* 标签筛选是本地启发式：donor 标签是联系人标签（快照群行不带标签 id），
     这里如实按「标签名命中群名/客户键」过滤，页面上写明口径、不猜关联。 */
  const rows = useMemo(() => {
    if (!ok) return [];
    const filtered = filterWechatGroups(ok.groups, { scope, custKey, query });
    const withLabel = labelName
      ? filtered.filter((group) => group.name.includes(labelName) || group.custKeys.some((key) => key.includes(labelName)))
      : filtered;
    return sortWechatGroups(withLabel, sortKey);
  }, [ok, scope, custKey, query, labelName, sortKey]);

  const todoSections = useMemo(() => (ok ? groupWechatTodosByUrgency(ok.todos) : []), [ok]);
  const singles = useMemo(() => (ok ? unrepliedWechatSingles(ok.singles) : []), [ok]);

  const toggle = (id: string, set: ReadonlySet<string>, apply: (next: ReadonlySet<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const draftOf = (group: WechatGroupView): BindDraft => drafts[group.id] ?? emptyDraftOf(group);

  const saveBinding = (group: WechatGroupView) => {
    const draft = draftOf(group);
    const custKeys = draft.custKeysText.split(/[,，]/).map((key) => key.trim()).filter(Boolean);
    setBusyGroup(group.id);
    setActionMsg({ ...actionMsg, [group.id]: "保存中…" });
    putWechatBinding({ groupId: group.id, custKeys, note: draft.note })
      .then((ledger) => {
        setBindings(ledger);
        setDrafts({ ...drafts, [group.id]: { custKeysText: custKeys.join(", "), note: draft.note } });
        setActionMsg({ ...actionMsg, [group.id]: custKeys.length ? `已绑定 ${custKeys.join(" / ")}` : "已清除人工绑定（回落待确认）" });
        return fetchWechatSnapshot().then(setSnapshot).catch(() => {});
      })
      .catch((error: unknown) => setActionMsg({ ...actionMsg, [group.id]: wechatErrorMessage(error) }))
      .finally(() => setBusyGroup(""));
  };

  const unbind = (group: WechatGroupView) => {
    setBusyGroup(group.id);
    setActionMsg({ ...actionMsg, [group.id]: "解绑中…" });
    deleteWechatBinding(group.id)
      .then((ledger) => {
        setBindings(ledger);
        setActionMsg({ ...actionMsg, [group.id]: "已解绑（快照重建后回落自动推断）" });
        return fetchWechatSnapshot().then(setSnapshot).catch(() => {});
      })
      .catch((error: unknown) => setActionMsg({ ...actionMsg, [group.id]: wechatErrorMessage(error) }))
      .finally(() => setBusyGroup(""));
  };

  const boundGroups = useMemo(() => new Set((bindings?.entries ?? []).map((entry: WechatBindingView) => entry.groupId)), [bindings]);

  const aside = (
    <button type="button" className="wechat-refresh" onClick={load} disabled={loading}>
      {loading ? <LoaderCircle className="wechat-spin" size={13} /> : <RefreshCw size={13} />}
      {loading ? "加载中…" : "刷新"}
    </button>
  );

  if (loadError && !snapshot) {
    return (
      <section className="wechat-view">
        <ViewHeading eyebrow="WECHAT LEDGER" title="微信办公台账" description="只读快照 + 本地绑定写（数据全程本机）。" aside={aside} />
        <div className="wechat-missing wechat-missing--bad"><AlertCircle size={15} /><div><b>本地桥不可用</b><p>{loadError}</p></div></div>
      </section>
    );
  }

  if (snapshot && snapshot.status === "missing") {
    return (
      <section className="wechat-view">
        <ViewHeading eyebrow="WECHAT LEDGER" title="微信办公台账" description="只读快照 + 本地绑定写（数据全程本机）。" aside={aside} />
        <div className="wechat-missing">
          <AlertCircle size={15} />
          <div>
            <b>还没有微信快照</b>
            <p>{snapshot.missingNote}</p>
            <ol>{snapshot.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
        </div>
      </section>
    );
  }

  if (!ok) {
    return (
      <section className="wechat-view">
        <ViewHeading eyebrow="WECHAT LEDGER" title="微信办公台账" description="只读快照 + 本地绑定写（数据全程本机）。" aside={aside} />
        <div className="wechat-missing"><LoaderCircle className="wechat-spin" size={15} /><p>快照加载中…</p></div>
      </section>
    );
  }

  const stats = ok.stats;
  const cards: readonly { readonly label: string; readonly value: number; readonly tip: string }[] = [
    { label: "群", value: stats.groups, tip: "快照窗口内本机群会话数" },
    { label: "近30天活跃", value: stats.groupsActive30, tip: "窗口内有消息的群" },
    { label: "客户群", value: stats.custBound, tip: "已绑定客户（人工 confirmed + 自动 matched）" },
    { label: "@我·30天", value: stats.atMe30, tip: "atuserlist 含我的消息（近30天，免打扰群同样计入）" },
    { label: "待办", value: stats.todos, tip: "@我 后我在该群未发言" },
    { label: "单聊未回", value: stats.singleUnreplied, tip: "最后一条不是我发的单聊" },
    { label: "未读", value: stats.unread, tip: "会话未读合计" },
  ];

  return (
    <section className="wechat-view">
      <ViewHeading
        eyebrow="WECHAT LEDGER"
        title="微信办公台账"
        description={`只读快照 ${ok.updatedAt || "—"} · 统计窗口近 ${ok.source.window} 天 · 消息 ${stats.messages.toLocaleString()} 条 · 正文只有 ≤24 字掩码，个人 wxid 不出桥。`}
        aside={aside}
      />
      {loadError && <p className="wechat-error"><AlertCircle size={13} /> {loadError}</p>}

      <div className="wechat-stats">
        {cards.map((card) => (
          <div key={card.label} className="wechat-stat" title={card.tip}>
            <span>{card.label}</span><b>{card.value}</b>
          </div>
        ))}
      </div>

      <div className="wechat-filters">
        {SCOPE_LABELS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="wechat-chip"
            data-active={scope === item.id}
            onClick={() => setScope(item.id)}
          >
            {item.label}<span className="wechat-chip__c">{scopeCount(item.id)}</span>
          </button>
        ))}
        <select className="wechat-chip" value={custKey} onChange={(event) => setCustKey(event.target.value)}>
          <option value="">全部客户</option>
          {custOptions.map((option) => <option key={option.key} value={option.key}>{option.key}（{option.count}）</option>)}
        </select>
        <select className="wechat-chip" value={sortKey} onChange={(event) => setSortKey(event.target.value as WechatGroupSortKey)}>
          {SORT_LABELS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <input
          className="wechat-chip wechat-chip--search"
          type="search"
          placeholder="搜群名 / 客户 / 群ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="wechat-filters__count">{rows.length} / {ok.groups.length} 个群</span>
      </div>

      {ok.labels.length > 0 && (
        <div className="wechat-labels" title="标签筛选为本地启发式：标签名命中群名/客户键（快照群行不带标签 id，不猜关联）">
          <button type="button" className="wechat-chip" data-active={!labelName} onClick={() => setLabelName("")}>全部标签</button>
          {ok.labels.map((label) => (
            <button
              key={label.id}
              type="button"
              className="wechat-chip"
              data-active={labelName === label.name}
              onClick={() => setLabelName(labelName === label.name ? "" : label.name)}
            >
              {label.name}
            </button>
          ))}
        </div>
      )}

      <div className="wechat-ledger">
        {rows.length === 0 && <div className="wechat-empty">当前筛选没有群——换个范围或清空搜索。</div>}
        {rows.map((group) => {
          const open = expanded.has(group.id);
          const draft = draftOf(group);
          const msg = actionMsg[group.id] ?? "";
          return (
            <div key={group.id} className={`wechat-row${group.atMe.unreplied ? " wechat-row--unreplied" : ""}${open ? " wechat-row--open" : ""}`}>
              <button
                type="button"
                className="wechat-row__head"
                onClick={() => toggle(group.id, expanded, setExpanded)}
                aria-expanded={open}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="wechat-row__name">{group.name || group.id}</span>
                <span className="wechat-row__pills"><CustPills group={group} /></span>
                <span className="wechat-row__meta">
                  成员 {group.memberCount}{group.muted ? " · 免打扰" : ""} · 最后 {agoLabel(group.lastMsgAt)}
                  {group.unread > 0 && <em className="wechat-row__unread">未读 {group.unread}</em>}
                </span>
                <span className="wechat-row__nums">
                  <b title="近7天消息">{group.msg.d7}</b>
                  <b title="近30天消息">{group.msg.d30}</b>
                  {group.atMe.all > 0 && (
                    <span className={`wechat-tag ${group.atMe.unreplied ? "wechat-tag--danger" : "wechat-tag--mint"}`}>
                      @我 {group.atMe.all}{group.atMe.unreplied ? " ·未回" : ""}
                    </span>
                  )}
                </span>
              </button>
              {open && (
                <div className="wechat-detail">
                  <div className="wechat-detail__line">
                    <span>群ID <code>{group.id}</code></span>
                    <span>消息 7天 <b>{group.msg.d7}</b> · 30天 <b>{group.msg.d30}</b> · 窗口 <b>{group.msg.dWin}</b> · 累计 <b>{group.msg.all}</b></span>
                    <span>活跃人数 7天 <b>{group.senders.d7}</b> · 30天 <b>{group.senders.d30}</b></span>
                    <span>我发言 <b>{group.mine.all}</b> · 最后 {group.mine.lastAt ? agoLabel(group.mine.lastAt) : "从未"}</span>
                  </div>
                  {group.lastSummaryMasked && <p className="wechat-detail__summary">最后消息（掩码）：{group.lastSummaryMasked}</p>}
                  {group.recentAtMe.length > 0 && (
                    <ul className="wechat-ats">
                      {group.recentAtMe.slice(0, 8).map((at, index) => (
                        <li key={`${at.t}-${index}`}><span className="wechat-dim">{agoLabel(at.t)}</span><b>{at.name}</b><span>{at.textMasked}</span></li>
                      ))}
                    </ul>
                  )}
                  <div className="wechat-bind">
                    <label>
                      绑定客户（逗号分隔，留空即清除人工绑定）
                      <input
                        type="text"
                        value={draft.custKeysText}
                        placeholder={custOptions.slice(0, 4).map((option) => option.key).join(" / ")}
                        onChange={(event) => setDrafts({ ...drafts, [group.id]: { ...draft, custKeysText: event.target.value } })}
                      />
                    </label>
                    <label>
                      备注
                      <input
                        type="text"
                        value={draft.note}
                        placeholder="群性质，如：项目群/客户+集成商"
                        onChange={(event) => setDrafts({ ...drafts, [group.id]: { ...draft, note: event.target.value } })}
                      />
                    </label>
                    <div className="wechat-bind__act">
                      <button type="button" className="wechat-chip" disabled={busyGroup === group.id} onClick={() => saveBinding(group)}>保存绑定</button>
                      {boundGroups.has(group.id) && (
                        <button type="button" className="wechat-chip wechat-chip--danger" disabled={busyGroup === group.id} onClick={() => unbind(group)}>解绑</button>
                      )}
                      <span className="wechat-dim">{msg || "写入本地台账（0600 原子 + 备份 + 审计），不触碰微信数据"}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="wechat-section">与我有关 · @我待办 <span className="wechat-dim">{ok.todos.length} 条</span></h2>
      {todoSections.length === 0 && <div className="wechat-empty">没有 @我 未回复的待办。</div>}
      {todoSections.map((section) => (
        <div key={section.urgency} className="wechat-todos">
          <h3>
            {section.label} <span className="wechat-dim">{section.items.length} 条</span>
          </h3>
          {section.items.map((todo) => (
            <div key={`${todo.groupId}-${todo.at}`} className="wechat-todo">
              <span className={`wechat-tag wechat-tag--${todo.urgency === "high" ? "danger" : todo.urgency === "mid" ? "amber" : "muted"}`}>
                {todo.urgency === "high" ? "高" : todo.urgency === "mid" ? "中" : todo.urgency === "low" ? "低" : "过期"}
              </span>
              <button
                type="button"
                className="wechat-todo__group"
                onClick={() => { setScope("all"); setQuery(""); setCustKey(""); setExpanded(new Set([...expanded, todo.groupId])); }}
              >
                {todo.groupName || todo.groupId}
              </button>
              <b>{todo.fromName}</b>
              <span className="wechat-todo__text">{todo.textMasked}</span>
              {todo.custKeys.map((key) => <span key={key} className="wechat-pill wechat-pill--green">{key}</span>)}
              <span className="wechat-dim" title={dayLabel(todo.at)}>{todo.daysSince} 天</span>
            </div>
          ))}
        </div>
      ))}

      <h2 className="wechat-section">单聊未回 <span className="wechat-dim">{singles.length} 条</span></h2>
      {singles.length === 0
        ? <div className="wechat-empty">这个窗口内没有未回复的单聊。</div>
        : (
          <div className="wechat-singles">
            {singles.map((single) => (
              <div key={single.idMasked} className="wechat-single">
                <b>{single.name}</b>
                <span className="wechat-dim">{single.idMasked}</span>
                <span className="wechat-single__text">{single.lastSummaryMasked}</span>
                <span className="wechat-dim">7天 {single.msg.d7} · 30天 {single.msg.d30}{single.unread > 0 ? ` · 未读 ${single.unread}` : ""} · {agoLabel(single.lastMsgAt)}</span>
              </div>
            ))}
          </div>
        )}

      <h2 className="wechat-section">
        qr-tree · 客户 → 群
        <span className="wechat-dim">
          {tree && tree.status === "ok" ? `${tree.nodes.length} 个分组（未绑定桶恒排最后）` : tree ? tree.missingNote : "加载中…"}
        </span>
      </h2>
      {tree && tree.status === "ok" && (
        <div className="wechat-tree">
          {tree.nodes.length === 0 && <div className="wechat-empty">快照里没有可分组的群。</div>}
          {tree.nodes.map((node) => {
            const open = treeOpen.has(node.key);
            return (
              <div key={node.key} className={`wechat-tree__node${node.kind === "unbound" ? " wechat-tree__node--unbound" : ""}`}>
                <button type="button" className="wechat-tree__head" onClick={() => toggle(node.key, treeOpen, setTreeOpen)} aria-expanded={open}>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <b>{node.name || (node.key === WECHAT_UNBOUND_KEY ? "未绑定客户" : node.key)}</b>
                  <span className="wechat-dim">{node.groups} 群{node.awaiting > 0 ? ` · @我待回 ${node.awaiting}` : ""} · 30天 {node.msgD30} 条</span>
                </button>
                {open && (
                  <ul className="wechat-tree__leaves">
                    {node.children.map((leaf) => (
                      <li key={`${node.key}-${leaf.groupId}`}>
                        <button
                          type="button"
                          className="wechat-todo__group"
                          onClick={() => { setScope("all"); setQuery(""); setCustKey(""); setExpanded(new Set([...expanded, leaf.groupId])); }}
                        >
                          {leaf.name || leaf.groupId}
                        </button>
                        {leaf.unreplied && <span className="wechat-tag wechat-tag--danger">@我未回</span>}
                        {leaf.muted && <span className="wechat-tag wechat-tag--muted">免打扰</span>}
                        <span className="wechat-dim">30天 {leaf.msgD30} 条</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <CustorgImportPanel onImported={load} />
    </section>
  );
}
