import { useState } from "react";
import { Activity, AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import {
  fetchHealthSnapshot,
  healthErrorMessage,
  type HealthSnapshot,
} from "../lib/health-client";
import { StatusBadge } from "./shared";

/**
 * 「环境与健康」面板（F4）：回答一个问题——现在还能不能取到数。
 * 三组分区（数据桥 / CLI / 可选能力），全部只读；凭据只报 set/unset。
 * 体检由用户手动触发：挂载与切换到本视图都不发请求、不探活 CLI，
 * 首次点「运行体检」才跑（避免面板一打开就拖 5 个子进程）。
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

function HealthSection({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="health-section">
      <div className="health-section__head"><h3>{title}</h3><span>{hint}</span></div>
      <div className="health-section__rows">{children}</div>
    </div>
  );
}

export function HealthPanel() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const runCheck = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setSnapshot(await fetchHealthSnapshot());
    } catch (checkError) {
      setSnapshot(null);
      setError(healthErrorMessage(checkError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel health-panel" aria-label="环境与健康">
      <div className="panel__header">
        <div>
          <span className="eyebrow">ENV HEALTH / F4</span>
          <h2>环境与健康</h2>
        </div>
        <button className="text-button" onClick={runCheck} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? "体检中…" : snapshot ? "重新体检" : "运行体检"}
        </button>
      </div>
      <p className="history-panel__note">
        只回答一个问题：现在还能不能取到数。只读体检（桥产物 / CLI 在位与版本 / 配置开关），不写盘、不携带任何凭据；
        首次点「运行体检」才执行，本面板不自动轮询。
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
          <HealthSection title="数据桥" hint="8 个本地桥的就绪状态（只读产物）">
            {snapshot.bridges.map((row) => {
              const badge = badgeFor(row.state);
              return <HealthRow key={row.name} name={row.name} label={BRIDGE_LABELS[row.name] ?? row.name} badge={badge} meta={row.detail} note="" />;
            })}
          </HealthSection>
          <HealthSection title="CLI" hint="presence + 只读版本探测（--version，无副作用）">
            {snapshot.cli.map((row) => {
              const badge = badgeFor(row.state);
              const meta = row.state === "ok" ? `已安装 · 版本 ${row.version}` : row.state === "missing" ? "未安装" : row.state === "unknown" ? "已安装，版本未知" : "探测失败";
              return <HealthRow key={row.name} name={row.name} label={CLI_LABELS[row.name] ?? row.name} badge={badge} meta={meta} note={row.note} />;
            })}
          </HealthSection>
          <HealthSection title="可选能力" hint="env 只报 set/unset，值永不出本面板">
            {snapshot.caps.map((row) => {
              const badge = badgeFor(row.state);
              const meta = row.set ? "已设置（值不入快照）" : "未设置";
              return <HealthRow key={row.name} name={row.name} label={row.name} badge={badge} meta={meta} note={row.note} />;
            })}
          </HealthSection>
        </>
      )}
    </section>
  );
}
