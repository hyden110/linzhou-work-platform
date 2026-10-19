import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Bot,
  Cpu,
  ExternalLink,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  agentsErrorMessage,
  clockCn,
  fetchAgentsAgentloop,
  fetchAgentsState,
  fetchAgentsWechat,
  AgentsClientError,
  type AgentLoopStatusView,
  type AgentsWakeState,
  type WechatSnapshotView,
} from "../../lib/agents-client";
import { ViewHeading } from "../shared";

/**
 * 「数字员工」视图（F7，全只读、链接呈现为主）：三块合一——
 * - QoderWake daemon 状态卡：本机只读健康探测（读端口文件 + GET /api/health），
 *   Console / Wakers / Knowledge / Conversations 一律新窗口外链。绝不做 iframe 内嵌：
 *   静态台已记录内嵌 Console 有「401 → 跳登录 → 回跳」死循环问题；
 * - AgentLoop 观测状态卡：凭据只读「存在性与掩码」（绝无 AK/SK 明文）+ console 外链 +
 *   views 列表；凭据配置与出票「待授权，本台未开通」；
 * - 微信办公快照卡：只读统计白名单投影（无消息内容），实时群台账 / @我待办由
 *   静态台本机常驻同步维护，本台仅展示快照。
 * 红线：无任何写入口，无 iframe 内嵌，无轮询 / SSE / 定时器——打开视图拉取 + 显式刷新。
 */

const DAEMON_STATUS_LABEL: Record<AgentsWakeState["daemon"]["status"], string> = {
  ok: "运行中",
  degraded: "异常应答",
  down: "离线",
};

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

function isUnconfigured(error: unknown): boolean {
  return error instanceof AgentsClientError && error.code === "agents_unconfigured";
}

function PanelHeader({
  eyebrow,
  title,
  loading,
  onRefresh,
}: {
  eyebrow: string;
  title: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="panel__header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <button className="text-button" onClick={onRefresh} disabled={loading}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
      </button>
    </div>
  );
}

function WakePanel() {
  const [state, setState] = useState<AgentsWakeState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAgentsState()
      .then((data) => { setState(data); setError(null); })
      .catch((loadError: unknown) => setError(loadError))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const daemon = state?.daemon ?? null;
  const daemonHref = safeHref(daemon?.url ?? "");

  return (
    <section className="panel agents-panel" aria-label="QoderWake 数字员工状态">
      <PanelHeader eyebrow="QODERWAKE / READ-ONLY" title="数字员工运行状态" loading={loading} onRefresh={load} />
      <p className="history-panel__note">
        <ShieldCheck size={13} /> 全只读：本机 daemon 健康（端口文件 + /api/health，探测超时 5s）；
        Console 等入口一律新窗口打开——内嵌 Console 存在登录重定向死循环，本台不做 iframe。
      </p>
      {error !== null && (
        <div className="answer-warning"><AlertCircle size={15} /> {agentsErrorMessage(error)}</div>
      )}
      {daemon && (
        <div className="agents-daemon" data-status={daemon.status}>
          <span className="agents-dot" aria-hidden="true" />
          <div className="agents-daemon__main">
            <strong>QoderWake daemon · {DAEMON_STATUS_LABEL[daemon.status]}</strong>
            <span className="agents-daemon__meta">
              :{daemon.port || "—"} · {daemon.note || "—"} · 探测于 {clockCn(daemon.checkedAt) || "—"}
            </span>
          </div>
        </div>
      )}
      {daemon && daemon.status === "ok" && daemonHref && (
        <ul className="agents-links">
          {state?.entries.map((entry) => (
            <li key={entry.id}>
              <a className="agents-link" href={`${daemonHref}${entry.path}`} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                <strong>{entry.t}</strong>
                <em>新窗口打开 {entry.path === "/" ? "首页" : entry.path}</em>
              </a>
            </li>
          ))}
        </ul>
      )}
      {daemon && daemon.status !== "ok" && (
        <div className="leads-guide">
          <p><strong>daemon {DAEMON_STATUS_LABEL[daemon.status]}。</strong>在本机执行 <code>qoderwake start</code>（或 qoderwake CLI 重启 daemon）后点「刷新」重探。</p>
          <p>探测细节：{daemon.note || "—"}（失败如实透出，绝不假绿）。</p>
        </div>
      )}
      {state && state.endpoints.length > 0 && (
        <>
          <h3 className="agents-subtitle">ECS 网关入口（仅配置后呈现，Basic Auth 凭据不落本台）</h3>
          <ul className="agents-links">
            {state.endpoints.map((endpoint) => (
              <li key={endpoint.id}>
                <a className="agents-link" href={safeHref(endpoint.url) || undefined} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  <strong>{endpoint.t}</strong>
                  <em>{safeHref(endpoint.url).replace(/^https?:\/\//, "")}</em>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AgentloopPanel() {
  const [status, setStatus] = useState<AgentLoopStatusView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAgentsAgentloop()
      .then((data) => { setStatus(data); setError(null); })
      .catch((loadError: unknown) => setError(loadError))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const consoleHref = safeHref(status?.console ?? "");

  return (
    <section className="panel agents-panel" aria-label="AgentLoop 观测状态">
      <PanelHeader eyebrow="AGENTLOOP / OBSERVABILITY" title="AgentLoop 观测" loading={loading} onRefresh={load} />
      <p className="history-panel__note">
        <ShieldCheck size={13} /> 只读观测：本台只读凭据「存在性与掩码」（照静态台 maskAk 口径），
        绝不读取 / 透出 AK/SK 明文；<strong>{status?.writesNote || "凭据管理与出票：待授权，本台未开通"}</strong>。
      </p>
      {error !== null && (
        <div className="answer-warning"><AlertCircle size={15} /> {agentsErrorMessage(error)}</div>
      )}
      {error !== null && isUnconfigured(error) && (
        <div className="leads-guide">
          <p><strong>AgentLoop 观测未启用。</strong>在 <code>.local-cache/agents.json</code>（参考 <code>config/agents.json.example</code>）补：</p>
          <ol>
            <li><code>agentloop.statusSource</code>：{"{ kind: \"json-file\", path: \"~/.loongsuite-pilot/config.json\", field: \"accessKeyId\" }"}——本台只探测该字段的存在性并出掩码</li>
            <li>可选 <code>agentloop.views</code>：视图清单（不配则回落扫描 pilot 上报目标，只投影非敏感字段）</li>
          </ol>
        </div>
      )}
      {status && (
        <div className="agents-loop" data-configured={status.configured ? "yes" : "no"}>
          <span className="agents-dot" aria-hidden="true" />
          <div className="agents-daemon__main">
            <strong>{status.configured ? "凭据已配置" : "凭据未配置"}</strong>
            <span className="agents-daemon__meta">
              {status.mask ? `AK 掩码 ${status.mask} · ` : ""}更新于 {clockCn(status.updatedAt ?? "") || "—"} · {status.note}
            </span>
          </div>
          {consoleHref && (
            <a className="agents-link agents-link--single" href={consoleHref} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              <strong>AgentLoop 控制台</strong>
              <em>新窗口打开</em>
            </a>
          )}
        </div>
      )}
      {status && status.views.length > 0 && (
        <ul className="agents-views">
          {status.views.map((view) => (
            <li key={view.id} className="agents-view-row">
              <strong>{view.t}</strong>
              <span>{[view.project, view.logstore, view.region].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
      {status && status.views.length === 0 && (
        <p className="reports-guide__single">暂无观测视图：未配置 agentloop.views 且 pilot 上报目标未生成。</p>
      )}
    </section>
  );
}

const WECHAT_STATS: ReadonlyArray<{ readonly key: keyof NonNullable<WechatSnapshotView["stats"]>; readonly label: string }> = [
  { key: "groups", label: "群" },
  { key: "groupsActive7", label: "近7天活跃" },
  { key: "groupsActive30", label: "近30天活跃" },
  { key: "groupsMine7", label: "近7天我发言" },
  { key: "custBound", label: "客户群" },
  { key: "atMeAll", label: "@我累计" },
];

const WECHAT_SOURCE: ReadonlyArray<{ readonly key: keyof NonNullable<WechatSnapshotView["source"]>; readonly label: string }> = [
  { key: "groups", label: "群会话" },
  { key: "singles", label: "单聊" },
  { key: "messages", label: "消息" },
  { key: "dbs", label: "库" },
  { key: "tables", label: "表" },
  { key: "window", label: "窗口(天)" },
];

function WechatPanel() {
  const [view, setView] = useState<WechatSnapshotView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAgentsWechat()
      .then((data) => { setView(data); setError(null); })
      .catch((loadError: unknown) => setError(loadError))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = view?.stats ?? null;

  return (
    <section className="panel agents-panel" aria-label="微信办公快照">
      <PanelHeader eyebrow="WECHAT / SNAPSHOT" title="微信办公快照" loading={loading} onRefresh={load} />
      <p className="history-panel__note">
        <ShieldCheck size={13} /> 只读快照统计（无任何消息内容）；实时群台账 / @我待办由本机常驻同步维护，本台仅展示快照。
      </p>
      {error !== null && (
        <div className="answer-warning"><AlertCircle size={15} /> {agentsErrorMessage(error)}</div>
      )}
      {error !== null && isUnconfigured(error) && (
        <div className="leads-guide">
          <p><strong>微信办公快照未配置。</strong>本台不读消息表、不做解密 / 同步 / 常驻 worker：</p>
          <ol>
            <li>由静态库本机常驻同步生成其 <code>data/wechat.json</code>（快照含统计与计数器）</li>
            <li>把该文件绝对路径填入 <code>.local-cache/agents.json</code> 的 <code>wechat.snapshotPath</code>（参考 <code>config/agents.json.example</code>）后刷新</li>
          </ol>
        </div>
      )}
      {stats && (
        <dl className="agents-kpis">
          {WECHAT_STATS.map(({ key, label }) => (
            <div key={key} className="agents-kpi">
              <dt>{label}</dt>
              <dd>{stats[key] ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}
      {view && (
        <div className="agents-wx-meta">
          <span>我：{view.me.name || "—"}（{view.me.wxid || "—"}）</span>
          <span>
            数据源：{WECHAT_SOURCE.map(({ key, label }) => `${label} ${view.source[key] ?? "—"}`).join(" · ")}
          </span>
          <span>快照生成：{clockCn(view.updatedAt) || "—"} · 拉取：{clockCn(view.at) || "—"}</span>
        </div>
      )}
    </section>
  );
}

export function AgentsView() {
  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="AGENT OPS / DIGITAL WORKERS"
        title="数字员工"
        description="QoderWake daemon 状态、AgentLoop 观测与微信办公快照的三块合一只读视图；Console 等入口以新窗口外链呈现，本台不做内嵌、不做凭据管理、不出票。"
        aside={<Cpu size={22} strokeWidth={1.6} />}
      />
      <WakePanel />
      <AgentloopPanel />
      <section className="panel agents-panel" aria-label="数字员工边界">
        <div className="panel__header">
          <div>
            <span className="eyebrow">BOUNDARY / READ-ONLY</span>
            <h2>能力边界</h2>
          </div>
        </div>
        <ul className="agents-boundary">
          <li><Bot size={14} /> 凭据管理与 CreateTicket 出票：待授权，本台未开通（不写 keychain、不联网出票）。</li>
          <li><MessagesSquare size={14} /> 微信群-客户绑定管理、消息解密与常驻同步：属静态台重能力，本台未开通。</li>
          <li><Cpu size={14} /> 本台唯一网络动作是本机 daemon 的 GET /api/health 健康探测（≤5s），无任何写命令。</li>
        </ul>
      </section>
    </div>
  );
}
