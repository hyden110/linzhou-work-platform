import { useState } from "react";
import { Activity, AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import {
  checkHealthGroup,
  fetchHealthSnapshot,
  healthErrorMessage,
  renewHealth,
  type HealthGroupName,
  type HealthRenewResult,
  type HealthRenewRow,
  type HealthSnapshot,
} from "../lib/health-client";
import { StatusBadge } from "./shared";

/**
 * 「环境与健康」面板（F4）：回答一个问题——现在还能不能取到数。
 * 三组分区（数据桥 / CLI / 可选能力），全部只读；凭据只报 set/unset。
 * 体检由用户手动触发：挂载与切换到本视图都不发请求、不探活 CLI，
 * 首次点「运行体检」才跑（避免面板一打开就拖 5 个子进程）。
 * V2 datasource 批次扩展：「现场重检」按组只重跑该组（其余组沿用上轮快照）；
 * 「凭据续期」重跑 CLI 只读登录态子命令（默认全组），结果只报状态、凭据值绝不入面板。
 */

const BRIDGE_LABELS: Record<string, string> = {
  crm: "CRM 客户快照",
  dingtalk: "钉钉待办桥",
  "fbi-metrics": "FBI 指标",
  "ppl-inspection": "PPL 巡检",
  kb: "知识检索",
  cases: "已发布案例",
  ops: "运营摘要",
  maas: "MaaS 候选",
};

const CLI_LABELS: Record<string, string> = {
  a1: "a1 · Aone 内网研发",
  ossutil: "ossutil · OSS",
  qodercli: "qodercli · 本机 AI 通道",
  dws: "dws · 钉钉开放能力",
  aliyun: "aliyun · 阿里云 OpenAPI",
};

type BridgeState = "ok" | "unconfigured" | "error";
type CliState = "ok" | "error" | "missing" | "unknown";

function badgeFor(state: BridgeState | CliState): { label: string; tone: "green" | "amber" | "muted" } {
  if (state === "ok") return { label: "正常", tone: "green" };
  if (state === "unconfigured") return { label: "未配置", tone: "muted" };
  if (state === "missing") return { label: "未安装", tone: "muted" };
  if (state === "unknown") return { label: "未知", tone: "muted" };
  return { label: "异常", tone: "amber" };
}

function renewBadgeFor(state: HealthRenewRow["state"]): { label: string; tone: "green" | "amber" | "muted" } {
  if (state === "ok") return { label: "有效", tone: "green" };
  if (state === "expired") return { label: "已过期", tone: "amber" };
  if (state === "missing") return { label: "未安装", tone: "muted" };
  return { label: "异常", tone: "amber" };
}

function HealthRow({ name, label, badge, meta, note }: {
  name: string;
  label: string;
  badge: { label: string; tone: "green" | "amber" | "muted" };
  meta: string;
  note: string;
}) {
  const showNote = Boolean(note) && badge.tone !== "green";
  return (
    <div className="health-row" data-state={badge.tone}>
      <strong>{label}</strong>
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      <span className="health-row__meta">{meta}</span>
      {showNote && <p className="health-row__note">{note}</p>}
      <span className="health-row__key">{name}</span>
    </div>
  );
}

function HealthSection({ title, hint, checkedAt, rechecking, onRecheck, children }: {
  title: string;
  hint: string;
  checkedAt?: string;
  rechecking?: boolean;
  onRecheck?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="health-section">
      <div className="health-section__head">
        <h3>{title}</h3><span>{hint}</span>
        {onRecheck && (
          <div className="health-section__tools">
            {checkedAt && <span className="health-section__checked">重检于 {checkedAt}</span>}
            <button className="text-button" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
              {rechecking ? "重检中…" : "现场重检"}
            </button>
          </div>
        )}
      </div>
      <div className="health-section__rows">{children}</div>
    </div>
  );
}

/** 凭据续期分区：POST /local/health/renew（keys 缺省=全组），只报状态、不显任何凭据值。 */
function RenewSection({ busy }: { busy: boolean }) {
  const [result, setResult] = useState<HealthRenewResult | null>(null);
  const [error, setError] = useState("");
  const [renewing, setRenewing] = useState(false);

  const runRenew = async () => {
    if (renewing || busy) return;
    setRenewing(true);
    setError("");
    try {
      setResult(await renewHealth(undefined));
    } catch (renewError) {
      setResult(null);
      setError(healthErrorMessage(renewError));
    } finally {
      setRenewing(false);
    }
  };

  return (
    <div className="health-section">
      <div className="health-section__head">
        <h3>凭据续期</h3><span>重跑 CLI 只读登录态子命令（默认全组），凭据 / 身份值绝不入面板</span>
        <div className="health-section__tools">
          {result && <span className="health-section__checked">续期于 {result.renewedAt}</span>}
          <button className="text-button" onClick={runRenew} disabled={renewing || busy}>
            {renewing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {renewing ? "续期中…" : "凭据续期"}
          </button>
        </div>
      </div>
      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
      <div className="health-section__rows">
        {result ? (
          result.results.map((row) => {
            const badge = renewBadgeFor(row.state);
            const meta = row.expiresAt ? `有效期至 ${row.expiresAt}` : badge.label === "有效" ? "登录态在有效期内" : "";
            return <HealthRow key={row.key} name={row.key} label={CLI_LABELS[row.key] ?? row.key} badge={badge} meta={meta} note={row.note} />;
          })
        ) : (
          <p className="health-renew__idle">
            尚未续期。点「凭据续期」重跑只读登录态子命令（默认全组：a1 / aliyun / ossutil / dws / qodercli）；
            结果只报「有效 / 已过期 / 未安装 / 异常」，不显示任何凭据值。
          </p>
        )}
      </div>
    </div>
  );
}

export function HealthPanel() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingGroup, setCheckingGroup] = useState<HealthGroupName | "">("");
  const [groupError, setGroupError] = useState("");
  const [checkedAt, setCheckedAt] = useState<Readonly<Partial<Record<HealthGroupName, string>>>>({});

  const runCheck = async () => {
    if (loading || checkingGroup) return;
    setLoading(true);
    setError("");
    try {
      const fresh = await fetchHealthSnapshot();
      setSnapshot(fresh);
      setCheckedAt({ bridges: fresh.fetchedAt, cli: fresh.fetchedAt, caps: fresh.fetchedAt });
    } catch (checkError) {
      setSnapshot(null);
      setError(healthErrorMessage(checkError));
    } finally {
      setLoading(false);
    }
  };

  /** 现场重检：只重跑该组，其余组沿用上轮持久化快照（桥侧语义），失败保留现有快照。 */
  const runCheckGroup = async (group: HealthGroupName) => {
    if (loading || checkingGroup) return;
    setCheckingGroup(group);
    setGroupError("");
    try {
      const checked = await checkHealthGroup(group);
      setSnapshot(checked);
      setCheckedAt((prev) => ({ ...prev, ...checked.groupCheckedAt }));
    } catch (checkError) {
      setGroupError(healthErrorMessage(checkError));
    } finally {
      setCheckingGroup("");
    }
  };

  return (
    <section className="panel health-panel" aria-label="环境与健康">
      <div className="panel__header">
        <div>
          <span className="eyebrow">ENV HEALTH / F4</span>
          <h2>环境与健康</h2>
        </div>
        <button className="text-button" onClick={runCheck} disabled={loading || Boolean(checkingGroup)}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? "体检中…" : snapshot ? "重新体检" : "运行体检"}
        </button>
      </div>
      <p className="history-panel__note">
        只回答一个问题：现在还能不能取到数。只读体检（桥产物 / CLI 在位与版本 / 配置开关），不写盘、不携带任何凭据；
        首次点「运行体检」才执行，本面板不自动轮询。「现场重检」只重跑该组，其余组沿用上轮快照并保留各自重检时间。
      </p>

      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
      {!snapshot && !error && !loading && (
        <p className="health-panel__idle"><Activity size={16} /> 尚未体检。点右上角「运行体检」获取本机实况（约数秒，含 5 个 CLI 只读版本探测）。</p>
      )}
      {loading && !snapshot && <p className="health-panel__idle">正在本机体检（桥产物读取 + CLI 只读探测）…</p>}

      {snapshot && (
        <>
          <div className="health-meta">
            快照时间 <time>{snapshot.fetchedAt || "—"}</time> · 桥 {snapshot.bridges.length} · CLI {snapshot.cli.length} · 配置 {snapshot.caps.length}
          </div>
          {groupError && <div className="answer-warning"><AlertCircle size={15} /> {groupError}（现有快照保留未动）</div>}
          <HealthSection
            title="数据桥" hint="8 个本地桥的就绪状态（只读产物）"
            checkedAt={checkedAt.bridges} rechecking={checkingGroup === "bridges"} onRecheck={() => runCheckGroup("bridges")}
          >
            {snapshot.bridges.map((row) => {
              const badge = badgeFor(row.state);
              return <HealthRow key={row.name} name={row.name} label={BRIDGE_LABELS[row.name] ?? row.name} badge={badge} meta={row.detail} note="" />;
            })}
          </HealthSection>
          <HealthSection
            title="CLI" hint="presence + 只读版本探测（--version，无副作用）"
            checkedAt={checkedAt.cli} rechecking={checkingGroup === "cli"} onRecheck={() => runCheckGroup("cli")}
          >
            {snapshot.cli.map((row) => {
              const badge = badgeFor(row.state);
              const meta = row.state === "ok" ? `已安装 · 版本 ${row.version}` : row.state === "missing" ? "未安装" : row.state === "unknown" ? "已安装，版本未知" : "探测失败";
              return <HealthRow key={row.name} name={row.name} label={CLI_LABELS[row.name] ?? row.name} badge={badge} meta={meta} note={row.note} />;
            })}
          </HealthSection>
          <HealthSection
            title="可选能力" hint="env 只报 set/unset，值永不出本面板"
            checkedAt={checkedAt.caps} rechecking={checkingGroup === "caps"} onRecheck={() => runCheckGroup("caps")}
          >
            {snapshot.caps.map((row) => {
              const badge = badgeFor(row.state);
              const meta = row.set ? "已设置（值不入快照）" : "未设置";
              return <HealthRow key={row.name} name={row.name} label={row.name} badge={badge} meta={meta} note={row.note} />;
            })}
          </HealthSection>
        </>
      )}
      <RenewSection busy={loading || Boolean(checkingGroup)} />
    </section>
  );
}
