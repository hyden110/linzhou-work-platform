import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  clockCn,
  fetchReportAutomations,
  fetchReportState,
  fetchReportWeeklyDoc,
  fetchReportWeeklies,
  reportErrorMessage,
  type ReportAutomations,
  type ReportState,
  type ReportTodayRecord,
  type ReportWeeklyDoc,
  type ReportWeeklies,
} from "../../lib/report-client";
import { ViewHeading } from "../shared";

/**
 * 「日周报」视图（F6，全只读）：当日草稿 + outbox 提交状态 + 双周报目录/正文 +
 * QoderWake 定时任务只读状态。语义对齐静态库 scripts/lib/report：
 * 数据由 19:00 初稿 / 23:15 提交 / 周五双周报三个 QoderWake 任务写入，工作台只看。
 * 红线：编辑 / 发送「待授权，本台未开通」，不提供任何写入口，无自动轮询。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

const RECORD_FIELDS: ReadonlyArray<{ readonly key: keyof Omit<ReportTodayRecord, "recordId" | "modifiedAt">; readonly label: string }> = [
  { key: "topic", label: "今日主题" },
  { key: "dept", label: "所属部门" },
  { key: "workStatus", label: "工作状态" },
  { key: "followup", label: "跟进事项" },
  { key: "opportunity", label: "商机线索" },
  { key: "risk", label: "风险" },
  { key: "other", label: "其他" },
];

function DwsBadge({ state }: { state: ReportState }) {
  if (state.dws.ok) {
    return <span className="reports-dws reports-dws--ok">dws 正常</span>;
  }
  return (
    <span className="reports-dws reports-dws--bad" title={state.dws.note}>
      dws {state.dws.code || "不可用"} · {state.dws.fix}
    </span>
  );
}

function AutomationsPanel() {
  const [autos, setAutos] = useState<ReportAutomations | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback((fresh: boolean) => {
    setLoading(true);
    fetchReportAutomations({ fresh })
      .then((data) => {
        setAutos(data);
        setError("");
      })
      .catch((loadError: unknown) => setError(reportErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  return (
    <section className="panel reports-panel" aria-label="定时任务状态">
      <div className="panel__header">
        <div>
          <span className="eyebrow">QODERWAKE / READ-ONLY</span>
          <h2>定时任务状态</h2>
        </div>
        <button className="text-button" onClick={() => load(true)} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
        </button>
      </div>
      <p className="history-panel__note">
        ECS QoderWake 的只读状态镜像（19:00 日报初稿 / 23:15 日报提交 / 周五 17:00 双周报）；
        本台绝不触发任务（run-now「待授权，本台未开通」），仅展示最近一次与下次计划。
      </p>
      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
      {autos && !autos.configured && <p className="reports-guide__single">{autos.configNote}</p>}
      {autos?.configured && (
        <ul className="reports-jobs">
          {autos.jobs.map((job) => (
            <li key={job.id} className="reports-job" data-status={job.lastStatus || "idle"}>
              <span className="reports-job__name">
                <strong>{job.name}</strong>
                <em>{job.enabled ? "已启用" : "已停用"}</em>
              </span>
              <span className="reports-job__cond">{job.cond || "—"}</span>
              <span className="reports-job__last">上次：{job.lastStatus || "—"}{job.lastAt ? ` · ${clockCn(job.lastAt)}` : ""}</span>
              <span className="reports-job__next">下次：{job.nextAt ? clockCn(job.nextAt) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WeeklyPanel() {
  const [weeklies, setWeeklies] = useState<ReportWeeklies | null>(null);
  const [doc, setDoc] = useState<ReportWeeklyDoc | null>(null);
  const [docLoading, setDocLoading] = useState("");
  const [error, setError] = useState("");
  const [docError, setDocError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback((fresh: boolean) => {
    setLoading(true);
    fetchReportWeeklies({ fresh })
      .then((data) => {
        setWeeklies(data);
        setError("");
      })
      .catch((loadError: unknown) => setError(reportErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const openDoc = useCallback((nodeId: string) => {
    setDocLoading(nodeId);
    setDocError("");
    fetchReportWeeklyDoc(nodeId)
      .then(setDoc)
      .catch((loadError: unknown) => setDocError(reportErrorMessage(loadError)))
      .finally(() => setDocLoading(""));
  }, []);

  return (
    <section className="panel reports-panel" aria-label="双周报">
      <div className="panel__header">
        <div>
          <span className="eyebrow">BIWEEKLY / READ-ONLY</span>
          <h2>双周报</h2>
        </div>
        <button className="text-button" onClick={() => load(true)} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
        </button>
      </div>
      <p className="history-panel__note">
        钉钉文档空间「双周报」文件夹的只读目录与正文（正文 ≤200KB 截断，附 sha256 校验）；
        正文由 QoderWake 周五任务写入，本台不保存 / 不发送（「待授权，本台未开通」）。
      </p>
      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
      {weeklies && (
        <p className="reports-meta">
          {weeklies.items.length} 篇 · 目录更新 {clockCn(weeklies.at) || "—"}
          {safeHref(weeklies.folderUrl) && (
            <a href={weeklies.folderUrl} target="_blank" rel="noreferrer">打开文件夹<ExternalLink size={11} /></a>
          )}
        </p>
      )}
      {weeklies?.items.length === 0 && <p className="reports-guide__single">目录暂无双周报文档。</p>}
      <ul className="reports-weeklies">
        {weeklies?.items.map((item) => (
          <li key={item.nodeId} className="reports-weekly">
            <button className="reports-weekly__open" onClick={() => openDoc(item.nodeId)} disabled={docLoading === item.nodeId}>
              <FileText size={15} />
              <strong>{item.name}</strong>
              <em>{docLoading === item.nodeId ? "读取中…" : item.updated ? `更新 ${clockCn(item.updated)}` : "—"}</em>
            </button>
            {safeHref(item.url) && <a href={item.url} target="_blank" rel="noreferrer" aria-label={`新窗口打开 ${item.name}`}><ExternalLink size={13} /></a>}
          </li>
        ))}
      </ul>
      {docError && <div className="answer-warning"><AlertCircle size={15} /> {docError}</div>}
      {doc && (
        <article className="reports-doc">
          <header>
            <strong>{doc.name}</strong>
            <span>
              {doc.truncated ? "正文超 200KB 已截断 · " : ""}
              sha256 {doc.contentHash.slice(0, 12)}…
            </span>
          </header>
          <pre className="reports-doc__body">{doc.markdown}</pre>
        </article>
      )}
    </section>
  );
}

export function ReportsView() {
  const [state, setState] = useState<ReportState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback((fresh: boolean) => {
    setLoading(true);
    fetchReportState()
      .then((data) => {
        setState(data);
        setError("");
      })
      .catch((loadError: unknown) => setError(reportErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const record = state?.record ?? null;

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / DAILY & BIWEEKLY REPORTS"
        title="日周报"
        description="当日 AI 表格草稿、OA outbox 提交状态、双周报目录/正文与 QoderWake 定时任务的全只读镜像；写入由 QoderWake 定时任务完成，工作台不编辑、不发送。"
        aside={<CalendarDays size={22} strokeWidth={1.6} />}
      />

      <section className="panel reports-panel" aria-label="日报">
        <div className="panel__header">
          <div>
            <span className="eyebrow">DAILY / READ-ONLY</span>
            <h2>今日日报</h2>
          </div>
          <button className="text-button" onClick={() => load(true)} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
          </button>
        </div>
        <p className="history-panel__note">
          <ShieldCheck size={13} /> 全只读：编辑与发送「待授权，本台未开通」——草稿由 19:00 QoderWake 任务写入 AI 表格，提交动作在 OA 完成，本台仅镜像状态、绝不代写代发。
        </p>
        {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}

        {state && (
          <p className="reports-meta">
            北京时间 {state.today}（{WEEKDAYS[state.weekday] ?? "—"}） <DwsBadge state={state} />
          </p>
        )}

        {state && !state.configured && (
          <div className="leads-guide">
            <p><strong>尚未配置日周报。</strong>本机补 <code>.local-cache/report.json</code>（参考 <code>config/report.json.example</code>）：</p>
            <ol>
              <li><code>daily</code>：工作日报 AI 表格的 baseId / tableId 与 8 个字段 ID 映射（topic / dept / workStatus / date / followup / opportunity / risk / other）</li>
              <li><code>weekly</code>：钉钉文档空间「双周报」文件夹 folderId / workspaceId</li>
              <li><code>remote</code>：ECS QoderWake 的 SSH 只读探测参数（host / key / bin / wakerId / jobs 触发器）</li>
            </ol>
            <p>三段相互独立、只配想用的段；并在启动本机桥的终端完成 <code>dws auth login</code> 后刷新。</p>
          </div>
        )}

        {state?.configured && (
          <>
            {record ? (
              <dl className="reports-record">
                {RECORD_FIELDS.map(({ key, label }) => (
                  <div key={key} className="reports-record__item" data-empty={record[key] === "" ? "yes" : "no"}>
                    <dt>{label}</dt>
                    <dd>{record[key] === "" ? "—" : record[key]}</dd>
                  </div>
                ))}
                <div className="reports-record__item" data-empty="no">
                  <dt>最后修改</dt>
                  <dd>{clockCn(record.modifiedAt) || "—"}</dd>
                </div>
              </dl>
            ) : (
              <p className="reports-guide__single">{state.recordNote || "今日暂无记录。"}</p>
            )}

            <div className="reports-outbox">
              <h3>今日提交状态（OA outbox）</h3>
              {state.submitted ? (
                state.submitted.n > 0 ? (
                  <ul>
                    {state.submitted.items.map((item) => (
                      <li key={item.time + item.title}>
                        <strong>{item.title}</strong>
                        <time>{clockCn(item.time)}</time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="reports-guide__single">{state.submittedNote || "今日尚无提交记录。"}</p>
                )
              ) : (
                <p className="reports-guide__single">{state.submittedNote || "outbox 暂不可读。"}</p>
              )}
            </div>
          </>
        )}
      </section>

      <AutomationsPanel />
      <WeeklyPanel />
    </div>
  );
}
