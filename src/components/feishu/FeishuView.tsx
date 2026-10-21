import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AtSign, Copy, ListTodo, LoaderCircle, MessagesSquare, RefreshCw } from "lucide-react";

import { ViewHeading } from "../shared";
import {
  fetchFeishuLedger,
  fetchFeishuLedgerRefresh,
  feishuErrorMessage,
  type FeishuChatMode,
  type FeishuIdentity,
  type FeishuLedgerView,
  type FeishuTaskView,
  type FeishuTokenStatus,
} from "../../lib/feishu-client";
import "../../feishu.css";

/**
 * 「飞书台账」自包含整页视图（轻量只读）：统计卡 + 群与单聊清单 + @我消息 + 我的待办。
 *
 * 数据全部来自本地桥（GET /local/feishu、/local/feishu/refresh → 本机 lark-cli 聚合）：
 * cli_missing / auth_required 如实展示指引卡（发现顺序、登录命令 + 复制），绝不伪造样例行；
 * 工作台不代跑登录。sectionErrors 在对应分区内以诚实提示行展示（有文案才占位）。
 * 样式只消费 globals.css :root 既有 token（见 src/feishu.css），类名 feishu- 前缀。
 * 挂载：由交付负责人注册 ViewId "feishu"（本视图不改动 App/Sidebar/types）。
 */

const CLI_DISCOVERY_STEPS: readonly string[] = [
  "环境变量 FEISHU_CLI_PATH 指向的可执行文件",
  "~/.qoderwork/bin/lark-cli",
  "~/.qwenworkcn/bin/lark-cli",
  "系统 PATH 中的 lark-cli",
];

const MODE_LABELS: Record<FeishuChatMode, string> = { group: "群", topic: "话题", p2p: "单聊" };
const MODE_TONES: Record<FeishuChatMode, string> = { group: "mint", topic: "amber", p2p: "cyan" };
const TOKEN_LABELS: Record<FeishuTokenStatus, string> = { valid: "有效", expired: "已过期", missing: "缺失" };
const IDENTITY_LABELS: Record<FeishuIdentity, string> = { user: "user", bot: "bot", none: "无" };
const PREVIEW_MAX = 60;

/** 相对时间：<1 分钟 / 分钟 / 小时 / 天；超过 30 天回落 M/D；坏时间戳如实「—」。 */
function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.floor((Date.now() - time) / 1000);
  if (seconds < 60) return "1 分钟内";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function shortDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** preview 桥侧已 ≤60 截断；这里再兜底一次，绝不放行超长正文。 */
function clipPreview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

function dueBadge(task: FeishuTaskView): { readonly tone: "danger" | "amber" | "muted"; readonly label: string } {
  if (task.overdue) return { tone: "danger", label: "已逾期" };
  if (task.dueToday) return { tone: "amber", label: "今日到期" };
  const due = shortDate(task.dueAt);
  return { tone: "muted", label: due ? `到期 ${due}` : "无期限" };
}

type CopyState = "" | "ok" | "fail";

export function FeishuView() {
  const [ledger, setLedger] = useState<FeishuLedgerView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("");

  const load = useCallback((refresh: boolean) => {
    setLoading(true);
    const request = refresh ? fetchFeishuLedgerRefresh() : fetchFeishuLedger();
    request
      .then((view) => { setLedger(view); setLoadError(""); })
      .catch((error: unknown) => setLoadError(feishuErrorMessage(error)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const copyLoginCommand = (command: string) => {
    navigator.clipboard.writeText(command)
      .then(() => setCopyState("ok"))
      .catch(() => setCopyState("fail"));
    // 一次性提示：2s 后自动收回（失败提示同样收回，不常驻）
    window.setTimeout(() => setCopyState((current) => (current === "" ? current : "")), 2000);
  };

  const aside = (
    <button type="button" className="feishu-refresh" onClick={() => load(true)} disabled={loading}>
      {loading ? <LoaderCircle className="feishu-spin" size={13} /> : <RefreshCw size={13} />}
      {loading ? "加载中…" : "刷新"}
    </button>
  );

  if (loadError && !ledger) {
    return (
      <section className="feishu-view">
        <ViewHeading eyebrow="FEISHU LEDGER" title="飞书台账" description="只读聚合：群与单聊、@我消息、我的待办（数据来自本机 lark-cli，全程本机）。" aside={aside} />
        <div className="feishu-missing feishu-missing--bad">
          <AlertCircle size={15} />
          <div><b>本地桥不可用</b><p>{loadError}</p></div>
        </div>
      </section>
    );
  }

  if (!ledger) {
    return (
      <section className="feishu-view">
        <ViewHeading eyebrow="FEISHU LEDGER" title="飞书台账" description="只读聚合：群与单聊、@我消息、我的待办（数据来自本机 lark-cli，全程本机）。" aside={aside} />
        <div className="feishu-missing"><LoaderCircle className="feishu-spin" size={15} /><p>台账加载中…（桥侧聚合 lark-cli 调用可能较慢）</p></div>
      </section>
    );
  }

  if (ledger.status === "cli_missing") {
    return (
      <section className="feishu-view">
        <ViewHeading eyebrow="FEISHU LEDGER" title="飞书台账" description="只读聚合：群与单聊、@我消息、我的待办（数据来自本机 lark-cli，全程本机）。" aside={aside} />
        {loadError && <p className="feishu-error"><AlertCircle size={13} /> {loadError}</p>}
        <div className="feishu-missing">
          <AlertCircle size={15} />
          <div>
            <b>未找到 lark-cli</b>
            <p>飞书台账无法聚合：桥按以下顺序发现 CLI，均未找到可执行的 lark-cli。</p>
            <ol>{CLI_DISCOVERY_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
            <p className="feishu-dim">安装 lark-cli（或用 FEISHU_CLI_PATH 指定路径）后，点右上角「刷新」。</p>
          </div>
        </div>
      </section>
    );
  }

  if (ledger.status === "auth_required") {
    return (
      <section className="feishu-view">
        <ViewHeading eyebrow="FEISHU LEDGER" title="飞书台账" description="只读聚合：群与单聊、@我消息、我的待办（数据来自本机 lark-cli，全程本机）。" aside={aside} />
        {loadError && <p className="feishu-error"><AlertCircle size={13} /> {loadError}</p>}
        <div className="feishu-missing">
          <AlertCircle size={15} />
          <div className="feishu-guide">
            <b>飞书 user 身份未授权或已过期</b>
            <p>
              当前身份：{IDENTITY_LABELS[ledger.auth.identity]}
              {ledger.auth.userName ? `（${ledger.auth.userName}）` : ""}
              　·　token 状态：{TOKEN_LABELS[ledger.auth.tokenStatus]}
            </p>
            {ledger.auth.note && <p>{ledger.auth.note}</p>}
            {ledger.auth.loginCommand ? (
              <div className="feishu-guide__cmd">
                <code>{ledger.auth.loginCommand}</code>
                <button type="button" className="feishu-chip" onClick={() => copyLoginCommand(ledger.auth.loginCommand)}>
                  <Copy size={12} /> 复制命令
                </button>
                {copyState === "ok" && <span className="feishu-guide__copied">已复制到剪贴板</span>}
                {copyState === "fail" && <span className="feishu-guide__copyfail">复制失败：请手动选中上方命令复制</span>}
              </div>
            ) : (
              <p className="feishu-dim">桥未给出登录命令：请查看桥侧日志确认 lark-cli 登录方式。</p>
            )}
            <p>工作台不会代跑登录；终端完成授权后点右上角「刷新」。</p>
          </div>
        </div>
      </section>
    );
  }

  const s = ledger.summary;
  const cards: readonly { readonly label: string; readonly value: number; readonly tone?: "amber" | "danger"; readonly tip: string }[] = [
    { label: "群", value: s.groups, tip: "lark-cli 返回的群聊会话（含话题群）" },
    { label: "单聊", value: s.p2p, tip: "p2p 单聊会话数" },
    { label: "外部群", value: s.external, tip: "含外部租户的群聊" },
    { label: "@我", value: s.atMe, tip: "@我 消息条数" },
    { label: "待办", value: s.tasksOpen, tip: "未完成的飞书任务" },
    { label: "今日到期", value: s.tasksDueToday, tone: "amber", tip: "今天到期的任务" },
    { label: "已逾期", value: s.tasksOverdue, tone: "danger", tip: "已过到期时间仍未完成的任务" },
  ];

  return (
    <section className="feishu-view">
      <ViewHeading
        eyebrow="FEISHU LEDGER"
        title="飞书台账"
        description={`台账 ${ledger.updatedAt || "—"} · 只读聚合：群与单聊、@我消息、我的待办（数据来自本机 lark-cli，全程本机）。`}
        aside={aside}
      />
      {loadError && <p className="feishu-error"><AlertCircle size={13} /> {loadError}</p>}

      <div className="feishu-stats">
        {cards.map((card) => (
          <div key={card.label} className="feishu-stat" data-tone={card.tone ?? ""} title={card.tip}>
            <span>{card.label}</span><b>{card.value}</b>
          </div>
        ))}
      </div>

      <h2 className="feishu-section">
        <MessagesSquare size={14} /> 群与单聊 <span className="feishu-dim">{ledger.chats.length} 个会话</span>
      </h2>
      {ledger.sectionErrors.chats && <p className="feishu-section-error"><AlertCircle size={12} /> {ledger.sectionErrors.chats}</p>}
      {ledger.chats.length === 0
        ? <div className="feishu-empty">本机 lark-cli 没有返回群或单聊会话。</div>
        : (
          <div className="feishu-chats">
            {ledger.chats.map((chat) => (
              <div key={chat.chatId} className="feishu-chat">
                <span className="feishu-chat__name">{chat.name || chat.chatId}</span>
                <span className={`feishu-tag feishu-tag--${MODE_TONES[chat.mode]}`}>{MODE_LABELS[chat.mode]}</span>
                {chat.external && <span className="feishu-tag feishu-tag--danger">外部</span>}
                {chat.status && <span className="feishu-dim">{chat.status}</span>}
                <span className="feishu-chat__meta feishu-dim">
                  {[chat.peerName, chat.ownerIdMasked].filter(Boolean).join(" · ") || "—"}
                </span>
              </div>
            ))}
          </div>
        )}

      <h2 className="feishu-section">
        <AtSign size={14} /> @我消息 <span className="feishu-dim">{ledger.atMe.length} 条</span>
      </h2>
      {ledger.sectionErrors.atMe && <p className="feishu-section-error"><AlertCircle size={12} /> {ledger.sectionErrors.atMe}</p>}
      {ledger.atMe.length === 0
        ? <div className="feishu-empty">这个窗口内没有 @我 的消息。</div>
        : (
          <div className="feishu-ats">
            {ledger.atMe.map((msg) => (
              <div key={msg.messageId} className="feishu-at">
                <b className="feishu-at__chat">{msg.chatName || msg.chatId}</b>
                <span className="feishu-dim">{msg.senderName || msg.senderIdMasked || "—"}</span>
                <span className="feishu-dim" title={msg.createdAt}>{relativeTime(msg.createdAt)}</span>
                <span className="feishu-at__preview">{clipPreview(msg.preview)}</span>
                {msg.deleted && <span className="feishu-tag feishu-tag--muted">已撤回</span>}
              </div>
            ))}
          </div>
        )}

      <h2 className="feishu-section">
        <ListTodo size={14} /> 我的待办 <span className="feishu-dim">{ledger.tasks.length} 条</span>
      </h2>
      {ledger.sectionErrors.tasks && <p className="feishu-section-error"><AlertCircle size={12} /> {ledger.sectionErrors.tasks}</p>}
      {ledger.tasks.length === 0
        ? <div className="feishu-empty">没有未完成的飞书任务。</div>
        : (
          <div className="feishu-tasks">
            {ledger.tasks.map((task) => {
              const due = dueBadge(task);
              return (
                <div key={task.guid} className="feishu-task">
                  <span className={`feishu-tag feishu-tag--${due.tone}`}>{due.label}</span>
                  <span className="feishu-task__summary">{task.summary || task.guid}</span>
                  <span className="feishu-dim" title={task.createdAt}>创建 {relativeTime(task.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}
