import { useEffect, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, Search, Terminal } from "lucide-react";
import "../datasource.css";
import { formatDateTime } from "./crm/crm-shared";
import { StatusBadge, ViewHeading } from "./shared";
import {
  dataSourceErrorMessage,
  fetchDataSourceRegistry,
  refreshDataSourceGroup,
  type DataSourceRefreshView,
  type DataSourceRegistryView,
  type DataSourceState,
  type DataSourceStatusView,
  type SourceRefreshState,
} from "../lib/datasource-client";
import {
  GuidesClientError,
  actGuideStep,
  checkGuideStep,
  fetchGuides,
  guidesErrorMessage,
  type GuideActView,
  type GuideCheckView,
  type GuideStepFixView,
  type GuideStepView,
  type GuideView,
  type ProvisionView,
} from "../lib/guides-client";
import { guides as staticGuides } from "../lib/guides-model";
import {
  channelOf,
  channels,
  envPresence,
  envSections,
  groups as refreshGroups,
  registrySummary,
  sources,
  sourcesOfGroup,
  type ChannelId,
  type EnvPresence,
  type PresenceRowLike,
} from "../lib/datasource-model";
import { fetchHealthSnapshot, healthErrorMessage } from "../lib/health-client";

/**
 * 「数据源管理 / 接入向导」视图（V2 datasource 批次）——四块：
 *   ① 源总表：静态目录（随包发布）＋ 桥侧动态状态合并；通道筛选 + 计数
 *   ② 刷新组卡片：supported 组可点刷新（逐源结果如实呈现）；unsupported 组只回诚实原因
 *   ③ env 五组折叠区：只报配置存在性「已设置/未设置」，任何凭据值不入本页
 *   ④ 接入向导分步面板：逐步检测/动作；terminal 步只回显命令（绝不代为执行）；
 *      aitable-provision 必经勾选确认才启用按钮
 * 桥离线时诚实降级：静态目录照常展示，动态部分明示「未获取」，绝不放假数据。
 * 接线说明（本批次禁改 App/types/Sidebar）：挂载方式同 F8 先例——
 *   ViewId 增补 "datasource" 后 `<DataSourceView />` 无必填 props 直接可用。
 */

type BadgeTone = "green" | "amber" | "blue" | "muted";

const STATE_BADGE: Record<DataSourceState, { label: string; tone: BadgeTone }> = {
  ok: { label: "正常", tone: "green" },
  stale: { label: "过期", tone: "amber" },
  error: { label: "异常", tone: "amber" },
  missing: { label: "未接入", tone: "muted" },
  static: { label: "静态", tone: "blue" },
  unknown: { label: "未知", tone: "muted" },
};

const REFRESH_LABEL: Record<SourceRefreshState, { label: string; tone: BadgeTone }> = {
  started: { label: "已启动", tone: "blue" },
  ok: { label: "成功", tone: "green" },
  failed: { label: "失败", tone: "amber" },
  skipped: { label: "已跳过", tone: "muted" },
};

const PRESENCE_LABEL: Record<Exclude<EnvPresence, "no-key">, { label: string; tone: BadgeTone }> = {
  set: { label: "已设置", tone: "green" },
  unset: { label: "未设置", tone: "muted" },
  "probe-error": { label: "探测异常", tone: "amber" },
  unprobed: { label: "未探测", tone: "muted" },
};

const KIND_LABEL: Record<GuideStepView["kind"], string> = {
  check: "检测",
  action: "动作",
  input: "手填",
  done: "完成",
};

const PLAN_ACTION: Record<string, string> = {
  reuse: "复用",
  create: "新建",
  "created-with-base": "随多维表新建",
};

function DsError({ message }: { message: string }) {
  return (
    <p className="ds-error">
      <AlertCircle size={13} /> {message}
    </p>
  );
}

/* ---------------- 动态注册表加载（① 与 ② 共用一次拉取） ---------------- */

interface RegistryLoad {
  readonly view: DataSourceRegistryView | null;
  readonly error: string;
  readonly loading: boolean;
  readonly reload: () => void;
}

function useRegistry(): RegistryLoad {
  const [view, setView] = useState<DataSourceRegistryView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDataSourceRegistry()
      .then((loaded) => { if (!cancelled) { setView(loaded); setError(""); } })
      .catch((loadError) => { if (!cancelled) { setView(null); setError(dataSourceErrorMessage(loadError)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);
  return { view, error, loading, reload: () => setTick((n) => n + 1) };
}

/* ---------------- ① 源总表 ---------------- */

function SourceStatusCell({ status }: { status: DataSourceStatusView | undefined }) {
  if (!status) return <StatusBadge tone="muted">未探测</StatusBadge>;
  const badge = STATE_BADGE[status.state];
  return (
    <span className="ds-status-cell" title={status.evidence || undefined}>
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      {status.fetchedAt && <span className="ds-meta">{formatDateTime(status.fetchedAt)}</span>}
    </span>
  );
}

function SourceTableSection({ load }: { load: RegistryLoad }) {
  const [filter, setFilter] = useState<ChannelId | "all">("all");
  const summary = registrySummary();
  const statusBySys = new Map((load.view?.statuses ?? []).map((entry) => [entry.sys, entry.status]));
  const rows = filter === "all" ? sources : sources.filter((s) => s.ch.includes(filter));
  return (
    <section className="panel ds-block" aria-label="源总表">
      <div className="ds-block__head">
        <h2>源总表</h2><span>SOURCES {summary.sourceCount} · CHANNELS {summary.channelCount}</span>
        <div className="ds-block__tools">
          <select
            className="ds-select" value={filter} aria-label="按通道筛选"
            onChange={(event) => setFilter(event.target.value as ChannelId | "all")}
          >
            <option value="all">全部通道</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>{channel.ico} {channel.short}</option>
            ))}
          </select>
          <button className="text-button" onClick={load.reload} disabled={load.loading}>
            {load.loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {load.loading ? "获取中…" : "重新获取状态"}
          </button>
        </div>
      </div>
      <p className="ds-note">
        静态目录（源/通道/鉴权/快照/命令/备注）随包发布，离线可查；「状态」列来自本地桥动态回传。
        {load.view
          ? <> 动态状态 v{load.view.version}，生成于 <b>{formatDateTime(load.view.generatedAt) || "—"}</b>。</>
          : " 动态状态未获取时一律如实标「未探测」，不猜测、不放假数据。"}
        {filter !== "all" && <> 当前筛选：<b>{rows.length}</b> / {summary.sourceCount} 源。</>}
      </p>
      {load.error && <DsError message={load.error} />}
      <div className="ds-table-scroll">
        <table className="ds-table">
          <thead>
            <tr>
              <th scope="col">源</th><th scope="col">通道</th><th scope="col">鉴权</th>
              <th scope="col">快照</th><th scope="col">命令</th><th scope="col">备注</th><th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((source) => (
              <tr key={source.sys}>
                <td className="ds-table__sys"><i>{source.ico}</i>{source.sys}</td>
                <td className="ds-table__ch">
                  {source.ch.map((id) => <span className="ds-chip" key={id}>{channelOf(id)?.short ?? id}</span>)}
                </td>
                <td>{source.auth}</td>
                <td className="ds-table__mono">{source.snap}</td>
                <td className="ds-table__mono">{source.cmd}</td>
                <td className="ds-table__note">{source.note}</td>
                <td><SourceStatusCell status={statusBySys.get(source.sys)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="ds-empty">该通道下没有登记源。</p>}
    </section>
  );
}

/* ---------------- ② 刷新组卡片 ---------------- */

interface GroupRun {
  readonly busy: boolean;
  readonly view: DataSourceRefreshView | null;
  readonly error: string;
}

const EMPTY_GROUP_RUN: GroupRun = { busy: false, view: null, error: "" };

interface GroupCard {
  readonly id: string;
  readonly d: string;
  /** null = 本地桥未回传，支持度未知（离线静态兜底）。 */
  readonly supported: boolean | null;
  readonly reason: string | null;
  readonly sourceCount: number;
}

function groupCards(view: DataSourceRegistryView | null): readonly GroupCard[] {
  if (view) return view.groups;
  return refreshGroups.map((group) => ({
    id: group.id, d: group.d, supported: null, reason: null, sourceCount: sourcesOfGroup(group.id).length,
  }));
}

function GroupResultRows({ view }: { view: DataSourceRefreshView }) {
  if (view.results.length === 0) {
    return <p className="ds-note">{view.reason ?? "本组刷新没有逐源结果可报。"}</p>;
  }
  return (
    <div className="ds-results">
      {view.results.map((result) => {
        const badge = REFRESH_LABEL[result.state];
        return (
          <div className="ds-results__row" key={result.sys}>
            <span className="ds-results__sys" title={result.sys}>{result.sys}</span>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            <span className="ds-results__detail" title={result.detail}>{result.detail}</span>
          </div>
        );
      })}
    </div>
  );
}

function GroupCardBody({ card, run }: { card: GroupCard; run: GroupRun }) {
  if (card.supported === false) {
    return <p className="ds-group__reason">{card.reason ?? "v2 未接该组刷新通道，不伪造刷新成功。"}</p>;
  }
  return (
    <>
      {card.supported === null && <span className="ds-meta">支持度未知（本地桥未回传）；点击将尝试执行并如实报错。</span>}
      {run.error && <DsError message={run.error} />}
      {run.view && <GroupResultRows view={run.view} />}
    </>
  );
}

function RefreshGroupsSection({ load }: { load: RegistryLoad }) {
  const [runs, setRuns] = useState<Readonly<Record<string, GroupRun>>>({});
  const cards = groupCards(load.view);
  const runRefresh = async (groupId: string) => {
    if ((runs[groupId] ?? EMPTY_GROUP_RUN).busy) return;
    setRuns((prev) => ({ ...prev, [groupId]: { busy: true, view: prev[groupId]?.view ?? null, error: "" } }));
    try {
      const view = await refreshDataSourceGroup(groupId);
      setRuns((prev) => ({ ...prev, [groupId]: { busy: false, view, error: "" } }));
    } catch (error) {
      setRuns((prev) => ({ ...prev, [groupId]: { busy: false, view: prev[groupId]?.view ?? null, error: dataSourceErrorMessage(error) } }));
    }
  };
  return (
    <section className="panel ds-block" aria-label="刷新组">
      <div className="ds-block__head">
        <h2>刷新组</h2><span>REFRESH GROUPS {cards.length}</span>
      </div>
      <p className="ds-note">
        仅 v2 已接通道的组可点刷新（逐源结果如实呈现：后台组只报「已启动」，不冒充完成）；
        未接的组只回诚实原因，绝不伪造刷新成功。
      </p>
      <div className="ds-groups">
        {cards.map((card) => {
          const run = runs[card.id] ?? EMPTY_GROUP_RUN;
          return (
            <div className="ds-group" key={card.id}>
              <div className="ds-group__head">
                <span className="ds-group__id">{card.id}</span>
                <span className="ds-group__count">{card.sourceCount} 源</span>
              </div>
              <p className="ds-group__d">{card.d}</p>
              <GroupCardBody card={card} run={run} />
              {card.supported !== false && (
                <div className="ds-group__foot">
                  <button className="ds-button ds-button--ghost" onClick={() => runRefresh(card.id)} disabled={run.busy}>
                    {run.busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                    {run.busy ? "刷新中…" : "刷新本组"}
                  </button>
                  {run.view?.startedAt && <span className="ds-group__time">最近 {formatDateTime(run.view.startedAt)}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- ③ env 五组折叠区（只报存在性，绝不显值） ---------------- */

function PresenceBadge({ presence }: { presence: EnvPresence }) {
  if (presence === "no-key") return <span className="ds-meta">无独立探测项</span>;
  const badge = PRESENCE_LABEL[presence];
  return <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>;
}

function EnvSectionsSection() {
  const [rows, setRows] = useState<readonly PresenceRowLike[] | null>(null);
  const [probedAt, setProbedAt] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const probe = async () => {
    if (probing) return;
    setProbing(true);
    setError("");
    try {
      const snapshot = await fetchHealthSnapshot();
      setRows([...snapshot.cli, ...snapshot.caps, ...snapshot.bridges]);
      setProbedAt(snapshot.fetchedAt);
    } catch (probeError) {
      setError(healthErrorMessage(probeError));
    } finally {
      setProbing(false);
    }
  };
  return (
    <section className="panel ds-block" aria-label="环境入口五组">
      <div className="ds-block__head">
        <h2>环境入口 · 五组</h2><span>ENV {envSections.length}</span>
        <div className="ds-block__tools">
          {probedAt && <span className="ds-meta">探测于 {formatDateTime(probedAt)}</span>}
          <button className="ds-button ds-button--ghost" onClick={probe} disabled={probing}>
            {probing ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}
            {probing ? "探测中…" : "探测存在性"}
          </button>
        </div>
      </div>
      <p className="ds-note">
        只报配置存在性「已设置 / 未设置」，任何凭据值（Cookie / Token / AK / Key）绝不显示在本页。
        存在性来自本机体检快照（含 CLI 只读探测），首次点「探测存在性」才执行，本页不自动轮询；未探测前一律如实标「未探测」。
      </p>
      {error && <DsError message={error} />}
      <div className="ds-env">
        {envSections.map((section) => (
          <details key={section.g}>
            <summary>
              {section.g}
              <span className="ds-env__summary-d">{section.d}</span>
              <span className="ds-env__summary-n">{section.platforms.length} 平台 · {section.links.length} 入口</span>
            </summary>
            <div className="ds-env__body">
              {section.platforms.map((platform) => (
                <div className="ds-env__platform" key={platform.t}>
                  <span className="ds-env__t"><i>{platform.ico}</i>{platform.t}<em>{platform.auth}</em></span>
                  <PresenceBadge presence={envPresence(platform.hkey, rows)} />
                  <span className="ds-env__d">{platform.d}<em>探测方式：{platform.how}</em></span>
                </div>
              ))}
              {section.platforms.length === 0 && <p className="ds-note">本组没有平台级详卡，只有轻量入口。</p>}
              <div className="ds-env__links">
                {section.links.map((link) => (
                  link.url.startsWith("http")
                    ? <a className="ds-env__link" key={link.t} href={link.url} target="_blank" rel="noreferrer">{link.ico} {link.t}{link.tbd ? "（待接）" : ""}<small>{link.d}</small></a>
                    : <span className="ds-env__link" key={link.t}>{link.ico} {link.t}{link.tbd ? "（待接）" : ""}<small>{link.d}</small></span>
                ))}
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ---------------- ④ 接入向导分步面板 ---------------- */

interface StepRun {
  readonly busy: boolean;
  readonly check: GuideCheckView | null;
  readonly act: GuideActView | null;
  readonly error: string;
  readonly confirmed: boolean;
}

const EMPTY_STEP_RUN: StepRun = { busy: false, check: null, act: null, error: "", confirmed: false };

const runKeyOf = (guideId: string, stepId: string) => `${guideId}:${stepId}`;

function stepState(run: StepRun | undefined): "ok" | "fail" | "none" {
  if (run?.check) return run.check.state === "ok" ? "ok" : "fail";
  if (run?.act) return run.act.ok ? "ok" : "fail";
  return "none";
}

/** 桥离线时的静态兜底：随包指引定义 → client 同形视图（检测/动作仍不可执行）。 */
function staticToGuideView(guide: (typeof staticGuides)[number]): GuideView {
  return {
    id: guide.id, t: guide.t, d: guide.d, kind: guide.kind,
    steps: guide.steps.map((step) => ({
      id: step.id, kind: step.kind, t: step.t, d: step.d ?? "",
      needConfirm: step.needConfirm === true, confirm: step.confirm ?? "",
      check: step.check
        ? { type: step.check.type, name: step.check.name ?? "", path: step.check.path ?? "", id: step.check.id ?? "", schemas: step.check.schemas ?? [] }
        : null,
      action: step.action
        ? { type: step.action.type, cmd: step.action.cmd ?? "", group: step.action.group ?? "", schemas: step.action.schemas ?? [] }
        : null,
      fix: step.fix ? { cmd: step.fix.cmd, terminal: step.fix.terminal, label: step.fix.label } : null,
    })),
  };
}

function TerminalCommand({ act }: { act: GuideActView }) {
  if (!act.terminal || !act.command) return null;
  return (
    <figure className="ds-cmdbox">
      <code>{act.command}</code>
      <figcaption>请到终端手动执行上述命令（交互式登录/扫码浏览器无法安全代劳），本页面绝不代为执行。</figcaption>
    </figure>
  );
}

function FixHint({ fix }: { fix: GuideStepFixView }) {
  if (!fix.cmd) return <p className="ds-note">修复指引：{fix.label}</p>;
  return (
    <figure className="ds-cmdbox">
      <code>{fix.cmd}</code>
      <figcaption>修复指引 · {fix.label}。请到终端手动执行，本页面绝不代为执行。</figcaption>
    </figure>
  );
}

function CheckStepBody({ step, run }: { step: GuideStepView; run: StepRun }) {
  return (
    <>
      {run.check && (
        <p className="ds-check-line">
          <StatusBadge tone={run.check.state === "ok" ? "green" : "amber"}>{run.check.state === "ok" ? "通过" : "未过"}</StatusBadge>
          {run.check.detail}
        </p>
      )}
      {run.check?.results && (
        <div className="ds-check-results">
          {run.check.results.map((result) => (
            <div className="ds-check-results__row" key={result.id}>
              <span className="ds-check-results__id">{result.id}</span>
              <StatusBadge tone={result.ok ? "green" : "amber"}>{result.ok ? "通过" : "未过"}</StatusBadge>
              <span className="ds-check-results__note" title={result.note}>{result.note}</span>
            </div>
          ))}
        </div>
      )}
      {run.check?.state === "fail" && step.fix && <FixHint fix={step.fix} />}
    </>
  );
}

function ProvisionResult({ act }: { act: GuideActView }) {
  const provision: ProvisionView | null = act.provision;
  if (!act.ok) return <DsError message={act.note || "一键建表未成功，详情见提示（输出已脱敏）。"} />;
  if (!provision) return <p className="ds-note">{act.note || "动作已完成。"}</p>;
  return (
    <div className="ds-provision">
      <p className="ds-provision__head">多维表 <b>{provision.baseName || provision.baseId}</b>（baseId {provision.baseId}）· 配置已写入本地 tools/</p>
      {provision.plan.length > 0 && (
        <table>
          <thead><tr><th scope="col">SCHEMA</th><th scope="col">表名</th><th scope="col">动作</th></tr></thead>
          <tbody>
            {provision.plan.map((item) => (
              <tr key={`${item.schemaId}:${item.tableName}`}>
                <td>{item.schemaId}</td><td>{item.tableName}</td><td>{PLAN_ACTION[item.action] ?? item.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {provision.configs.map((config) => (
        <p className="ds-provision__note" key={config.id}>
          {config.id} → <code>{config.file}</code> · {config.tableCount} 张表
          {config.missing.length > 0 ? ` · 缺失必需字段：${config.missing.join("、")}（请重跑校验步）` : " · 必需字段齐备"}
        </p>
      ))}
      {act.note && <p className="ds-provision__note">{act.note}</p>}
    </div>
  );
}

function ActionStepBody({ step, run, onAct, onConfirm }: {
  step: GuideStepView;
  run: StepRun;
  onAct: () => void;
  onConfirm: (confirmed: boolean) => void;
}) {
  const action = step.action;
  if (!action) return <p className="ds-note">该步骤未登记可执行动作。</p>;
  if (action.type === "aitable-provision") {
    return (
      <>
        <label className="ds-confirm">
          <input type="checkbox" checked={run.confirmed} onChange={(event) => onConfirm(event.target.checked)} />
          <span>{step.confirm || "该动作会在你的钉钉创建/复用多维表并写入本地配置，请确认后执行。"}</span>
        </label>
        <div className="ds-step-panel__acts">
          <button className="ds-button" onClick={onAct} disabled={!run.confirmed || run.busy}>
            {run.busy ? <LoaderCircle className="spin" size={13} /> : <Terminal size={13} />}
            {run.busy ? "建表中…（多次 dws 往返，可能需要数分钟）" : "一键建表并写入配置"}
          </button>
          {!run.confirmed && <span className="ds-meta">勾选上方确认后才可执行</span>}
        </div>
        {run.act && <ProvisionResult act={run.act} />}
      </>
    );
  }
  if (action.type === "terminal") {
    return (
      <>
        <div className="ds-step-panel__acts">
          <button className="ds-button ds-button--ghost" onClick={onAct} disabled={run.busy}>
            {run.busy ? <LoaderCircle className="spin" size={13} /> : <Terminal size={13} />}
            {run.busy ? "获取中…" : run.act ? "重新获取命令" : "获取终端命令"}
          </button>
        </div>
        {run.act && <TerminalCommand act={run.act} />}
        {run.act?.note && <p className="ds-note">{run.act.note}</p>}
      </>
    );
  }
  return (
    <>
      <div className="ds-step-panel__acts">
        <button className="ds-button ds-button--ghost" onClick={onAct} disabled={run.busy}>
          {run.busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          {run.busy ? "触发中…" : `触发刷新组「${action.group || "未登记"}」`}
        </button>
        {run.act && <StatusBadge tone={run.act.ok ? "green" : "amber"}>{run.act.ok ? "已触发" : "未成功"}</StatusBadge>}
      </div>
      {run.act?.note && <p className="ds-note">{run.act.note}</p>}
    </>
  );
}

function StepPanel({ guide, step, run, onCheck, onAct, onConfirm }: {
  guide: GuideView;
  step: GuideStepView;
  run: StepRun;
  onCheck: () => void;
  onAct: () => void;
  onConfirm: (confirmed: boolean) => void;
}) {
  return (
    <div className="ds-step-panel">
      <div className="ds-step-panel__head">
        <h4>{step.t}</h4>
        <span className="ds-kind">{KIND_LABEL[step.kind]}</span>
        <span className="ds-meta">{guide.t}</span>
      </div>
      {step.d && <p className="ds-step-panel__d">{step.d}</p>}
      {run.error && <DsError message={run.error} />}
      {step.kind === "check" && (
        <div className="ds-step-panel__acts">
          <button className="ds-button ds-button--ghost" onClick={onCheck} disabled={run.busy}>
            {run.busy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}
            {run.busy ? "检测中…" : run.check ? "重新检测" : "运行检测"}
          </button>
          {!run.check && !run.busy && <span className="ds-meta">未检查</span>}
        </div>
      )}
      {step.kind === "check" && <CheckStepBody step={step} run={run} />}
      {step.kind === "action" && <ActionStepBody step={step} run={run} onAct={onAct} onConfirm={onConfirm} />}
      {step.kind === "input" && <p className="ds-note">手填回退为 P2 备用通道（粘贴既有配置），当前未启用；请用上方检测/动作步骤完成接入。</p>}
      {step.kind === "done" && <p className="ds-note">{step.d || "以上步骤全部通过后，本接入即完成。"}</p>}
    </div>
  );
}

function GuidesSection() {
  const [items, setItems] = useState<readonly GuideView[]>([]);
  const [offline, setOffline] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ guide: string; step: string } | null>(null);
  const [runs, setRuns] = useState<Readonly<Record<string, StepRun>>>({});
  useEffect(() => {
    let cancelled = false;
    fetchGuides()
      .then((loaded) => { if (!cancelled) { setItems(loaded.guides); setOffline(""); setSelected(null); } })
      .catch((error) => {
        if (cancelled) return;
        setItems(staticGuides.map(staticToGuideView));
        setOffline(guidesErrorMessage(error));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const guide = (selected && items.find((item) => item.id === selected.guide)) || items[0] || null;
  const step = (guide && selected && selected.guide === guide.id
    ? guide.steps.find((item) => item.id === selected.step)
    : undefined) ?? guide?.steps[0] ?? null;
  const patchRun = (key: string, patch: Partial<StepRun>) => {
    setRuns((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_STEP_RUN), ...patch } }));
  };
  const runCheck = async (guideId: string, stepId: string) => {
    const key = runKeyOf(guideId, stepId);
    if ((runs[key] ?? EMPTY_STEP_RUN).busy) return;
    patchRun(key, { busy: true, error: "" });
    try {
      patchRun(key, { busy: false, check: await checkGuideStep(guideId, stepId) });
    } catch (error) {
      patchRun(key, { busy: false, error: guidesErrorMessage(error) });
    }
  };
  const runAct = async (guideId: string, target: GuideStepView) => {
    const key = runKeyOf(guideId, target.id);
    const run = runs[key] ?? EMPTY_STEP_RUN;
    if (run.busy || (target.needConfirm && !run.confirmed)) return;
    patchRun(key, { busy: true, error: "" });
    try {
      patchRun(key, { busy: false, act: await actGuideStep(guideId, target.id, target.needConfirm ? { confirm: true } : {}) });
    } catch (error) {
      const confirmText = error instanceof GuidesClientError && error.confirmText ? `确认文案：${error.confirmText}` : "";
      patchRun(key, { busy: false, error: [guidesErrorMessage(error), confirmText].filter(Boolean).join(" ") });
    }
  };
  return (
    <section className="panel ds-block" aria-label="接入向导">
      <div className="ds-block__head">
        <h2>接入向导</h2><span>GUIDES {items.length || "—"}</span>
      </div>
      <p className="ds-note">
        分步引导完成一个产品依赖的接入：检测步只读、动作步显式触发；terminal 命令只回显到只读代码框（绝不代为执行）；
        一键建表（aitable-provision）必经勾选确认才启用按钮。
      </p>
      {offline && <DsError message={`${offline}以下为随包内置指引定义（静态兜底），检测与动作需本地桥在线才可执行。`} />}
      {loading && <p className="ds-empty">正在加载指引定义…</p>}
      {!loading && items.length === 0 && !offline && <p className="ds-empty">暂无指引定义。</p>}
      {guide && step && (
        <div className="ds-guides">
          <div className="ds-guide-list">
            {items.map((item) => (
              <button
                type="button" key={item.id}
                className={`ds-guide-item${item.id === guide.id ? " is-active" : ""}`}
                onClick={() => setSelected({ guide: item.id, step: item.steps[0]?.id ?? "" })}
              >
                <strong>{item.t}</strong><small>{item.d} · {item.steps.length} 步</small>
              </button>
            ))}
          </div>
          <div>
            <div className="ds-steps">
              {guide.steps.map((item, index) => {
                const state = stepState(runs[runKeyOf(guide.id, item.id)]);
                return (
                  <button
                    type="button" key={item.id} data-state={state}
                    className={`ds-step${item.id === step.id ? " is-current" : ""}`}
                    onClick={() => setSelected({ guide: guide.id, step: item.id })}
                    title={state === "ok" ? "通过" : state === "fail" ? "未过" : "未检查"}
                  >
                    <b>{state === "ok" ? "✓" : state === "fail" ? "✕" : index + 1}</b>{item.t}
                  </button>
                );
              })}
            </div>
            <StepPanel
              guide={guide} step={step} run={runs[runKeyOf(guide.id, step.id)] ?? EMPTY_STEP_RUN}
              onCheck={() => runCheck(guide.id, step.id)}
              onAct={() => runAct(guide.id, step)}
              onConfirm={(confirmed) => patchRun(runKeyOf(guide.id, step.id), { confirmed })}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------- 视图入口 ---------------- */

export function DataSourceView() {
  const registry = useRegistry();
  const summary = registrySummary();
  return (
    <div className="ds-view">
      <ViewHeading
        eyebrow="DATASOURCE / V2"
        title="数据源管理"
        description={`取数通道静态目录（随包发布）＋ 本机实况（经本地桥）：${summary.sourceCount} 源 · ${summary.channelCount} 通道 · ${summary.groupCount} 刷新组 · ${summary.capCount} 能力 · 环境五组 · 健康 ${summary.healthGroupCount} 分组。凭据与 env 只报「已设置/未设置」，值永不出现在本页。`}
      />
      <SourceTableSection load={registry} />
      <RefreshGroupsSection load={registry} />
      <EnvSectionsSection />
      <GuidesSection />
    </div>
  );
}
