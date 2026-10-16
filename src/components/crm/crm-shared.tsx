import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import type { RefreshStatus, SourceKey, SourceStatus } from "../../lib/crm-types";
import { useCrm } from "./CrmProvider";

export const SOURCE_LABELS: Record<SourceKey, string> = {
  agenda: "钉钉日程",
  todos: "钉钉待办",
  groups: "钉钉群列表",
  mentions: "钉钉 @我",
  unread: "钉钉未读",
  customers: "鲲鹏客户",
  projects: "鲲鹏项目",
  overview: "鲲鹏总览",
  top: "鲲鹏 TOP 榜",
  mygroups: "鲲鹏分层视图",
};

const SOURCE_ERRORS: Record<string, string> = {
  kunpeng_login_required: "鲲鹏登录失效",
  kunpeng_missing: "鲲鹏 skill 未安装",
  dws_missing: "dws 未安装",
};

export const REFRESH_ERRORS: Record<string, string> = {
  all_sources_failed: "全部数据源读取失败",
  refresh_timeout: "刷新超时",
  refresh_failed: "刷新失败",
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const dateOnly = typeof value === "string" ? DATE_ONLY.exec(value) : null;
  const date = typeof value === "number"
    ? new Date(value)
    : dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  const withTime = !(typeof value === "string" && DATE_ONLY.test(value));
  return date.toLocaleString("zh-CN", withTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatClock(value: number | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatGaap(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export function MetricCard({
  label,
  value,
  note,
  warning = false,
  primary = false,
}: {
  label: string;
  value: string;
  note: string;
  warning?: boolean;
  primary?: boolean;
}) {
  return (
    <article className={`metric-card ${primary ? "metric-card--primary" : ""} ${warning ? "metric-card--warning" : ""}`}>
      {warning && <AlertTriangle className="metric-card__icon" size={17} />}
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function sourceProblem(status: SourceStatus): string {
  return SOURCE_ERRORS[status.error ?? ""] ?? (status.status === "partial" ? "数据不完整" : "读取失败");
}

export function SourceBanner({ keys }: { keys: readonly SourceKey[] }) {
  const { snapshot } = useCrm();
  if (!snapshot) return null;
  const problems = keys.flatMap((key) => {
    const status = snapshot.sources[key];
    if (!status) return [{ key, text: "未同步", since: null as string | null }];
    if (status.status === "ok" && !status.stale) return [];
    return [{ key, text: status.stale ? "数据已过期" : sourceProblem(status), since: status.lastSuccessAt }];
  });
  if (problems.length === 0) return null;
  return (
    <div className="crm-banner" role="status">
      <AlertTriangle size={15} />
      <div>
        {problems.map((problem) => (
          <p key={problem.key}>
            <strong>{SOURCE_LABELS[problem.key]}</strong>：{problem.text}
            <span>{problem.since ? `，展示 ${formatDateTime(problem.since)} 的快照` : "，暂无可用数据"}</span>
          </p>
        ))}
        {problems.some((problem) => problem.text === "鲲鹏登录失效") && (
          <small>请在本机重新登录鲲鹏后点击“刷新数据”；页面不会用示例数据替代。</small>
        )}
      </div>
    </div>
  );
}

function refreshLabel(refresh: RefreshStatus | null, generatedAt: string | null): string {
  if (refresh?.state === "running") return "正在刷新…";
  if (refresh?.state === "failed") return REFRESH_ERRORS[refresh.error ?? ""] ?? "刷新失败";
  return generatedAt ? `快照 ${formatDateTime(generatedAt)}` : "尚无快照";
}

export function RefreshControl() {
  const { snapshot, refresh, refreshNow } = useCrm();
  const running = refresh?.state === "running";
  return (
    <div className="crm-refresh">
      <span className={refresh?.state === "failed" ? "is-failed" : undefined}>{refreshLabel(refresh, snapshot?.generatedAt ?? null)}</span>
      <button className="primary-button" onClick={refreshNow} disabled={running}>
        {running ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新数据
      </button>
    </div>
  );
}

export function CrmGate({ children }: { children: React.ReactNode }) {
  const { snapshot, loading, error, missing } = useCrm();
  if (snapshot) return <>{children}</>;
  if (loading) return <div className="panel crm-empty"><LoaderCircle className="spin" size={18} /><p>读取本机客户快照…</p></div>;
  return (
    <div className="panel crm-empty">
      <AlertTriangle size={18} />
      <p>{missing ? "还没有客户快照，点击右上角“刷新数据”生成第一份。" : error}</p>
    </div>
  );
}
