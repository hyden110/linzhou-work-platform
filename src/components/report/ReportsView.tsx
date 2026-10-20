import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  clockCn,
  fetchReportAutomations,
  fetchReportState,
  fetchReportWeeklyDoc,
  fetchReportWeeklies,
  fetchReportWrites,
  reportErrorMessage,
  saveReportDraftConfirm,
  saveReportDraftDry,
  submitReportConfirm,
  submitReportDry,
  ReportClientError,
  REPORT_MAX_TEXT,
  type ReportAutomations,
  type ReportSaveCells,
  type ReportSaveDry,
  type ReportState,
  type ReportSubmitDry,
  type ReportTodayRecord,
  type ReportWeeklyDoc,
  type ReportWeeklies,
  type ReportWritableField,
  type ReportWrites,
} from "../../lib/report-client";
import { ViewHeading } from "../shared";
import { WorklogPanel } from "./WorklogPanel";

/**
 * 「日周报」视图（F6）：当日草稿 + outbox 提交状态 + 双周报目录/正文 + QoderWake 定时任务镜像。
 * F6-P1 追加日报回写：当日草稿的白名单字段（topic/followup/opportunity/risk/other）可在本台
 * 编辑，经两步 dry→confirm 保存 / 提交；dept/工作状态由 19:00 初稿任务写入，仍只读。
 * 红线：confirm 闸门、5 分钟冷却、审计留痕、recordId 冲突拒绝全在服务端；本台绝不代改只读字段、
 * 不绕过确认、无自动轮询。双周报与定时任务面板保持只读镜像。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 可编辑白名单字段（与服务端 REPORT_WRITABLE_FIELDS 一致；dept/workStatus 只读）。 */
const EDITABLE_FIELDS: ReadonlyArray<{ readonly key: ReportWritableField; readonly label: string }> = [
  { key: "topic", label: "今日主题" },
  { key: "followup", label: "跟进事项" },
  { key: "opportunity", label: "商机线索" },
  { key: "risk", label: "风险" },
  { key: "other", label: "其他" },
];

const READONLY_FIELDS: ReadonlyArray<{ readonly key: "dept" | "workStatus"; readonly label: string }> = [
  { key: "dept", label: "所属部门" },
  { key: "workStatus", label: "工作状态" },
];

const FIELD_LABEL: Record<ReportWritableField, string> = {
  topic: "今日主题",
  followup: "跟进事项",
  opportunity: "商机线索",
  risk: "风险",
  other: "其他",
};

const PHASE_LABEL: Record<string, string> = { update: "回写", run: "触发", verify: "回读" };

type Draft = Record<ReportWritableField, string>;

const EMPTY_DRAFT: Draft = { topic: "", followup: "", opportunity: "", risk: "", other: "" };

function draftOf(record: ReportTodayRecord): Draft {
  return {
    topic: record.topic,
    followup: record.followup,
    opportunity: record.opportunity,
    risk: record.risk,
    other: record.other,
  };
}

/** 只上行「与线上有实际差异（trim 比较）」的白名单字段；空串 = 清空该字段（服务端允许）。 */
function buildCells(record: ReportTodayRecord, draft: Draft): ReportSaveCells {
  const cells: Record<string, string> = {};
  for (const { key } of EDITABLE_FIELDS) {
    if (draft[key].trim() !== record[key].trim()) cells[key] = draft[key];
  }
  return cells as ReportSaveCells;
}

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

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

/* ---------------------------------------------------------------------------
 * 保存草稿确认弹窗（第二步）：逐字段展示 before→after diff，勾选后回写钉钉 AI 表格。
 * ------------------------------------------------------------------------- */

interface SaveDialogProps {
  readonly dry: ReportSaveDry;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function SaveDialog({ dry, checked, busy, onCheck, onCancel, onConfirm }: SaveDialogProps) {
  const changed = dry.diff.filter((item) => item.changed);
  return (
    <div className="reply-dialog__backdrop">
      <div className="reply-dialog" role="dialog" aria-modal="true" aria-label="保存草稿确认">
        <h3>确认回写到钉钉 AI 表格（两步确认 · 第二步）</h3>
        <div className="reply-dialog__row"><span>记录</span><span>{dry.recordId}</span></div>
        <div className="reply-dialog__row"><span>预检时间</span><span>{clockCn(dry.at) || "—"}</span></div>
        <div className="reply-dialog__row"><span>改动</span><span>{changed.length} 个字段（仅白名单）</span></div>
        <div className="reports-diff">
          {changed.length === 0 ? (
            <p className="reports-guide__single">没有实际改动（仅空白差异），无需保存。</p>
          ) : (
            changed.map((item) => (
              <div className="reports-diff__item" key={item.key}>
                <span className="reports-diff__field">{FIELD_LABEL[item.key]}</span>
                <div className="reports-diff__cols">
                  <pre className="reports-diff__before" aria-label="线上当前值">{item.before || "（空）"}</pre>
                  <pre className="reports-diff__after" aria-label="将保存为">{item.after || "（空）"}</pre>
                </div>
              </div>
            ))
          )}
        </div>
        <label className="reply-dialog__confirm">
          <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} disabled={busy} />
          我已核对以上 {changed.length} 处改动，确认回写到钉钉 AI 表格（dws aitable record update，绝不覆盖 dept/工作状态）。
        </label>
        <div className="reply-dialog__actions">
          <button className="text-button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" onClick={onConfirm} disabled={!checked || busy || changed.length === 0}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}确认保存
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 提交日报确认弹窗（第二步）：展示通道 / 冷却 / 今日已提交预检，blocked 时禁止确认。
 * ------------------------------------------------------------------------- */

interface SubmitDialogProps {
  readonly dry: ReportSubmitDry;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function SubmitDialog({ dry, checked, busy, onCheck, onCancel, onConfirm }: SubmitDialogProps) {
  const blocked = dry.blocked;
  const channel = dry.channel;
  return (
    <div className="reply-dialog__backdrop">
      <div className="reply-dialog" role="dialog" aria-modal="true" aria-label="提交日报确认">
        <h3>确认触发日报提交（ECS QoderWake automation run-now · 第二步）</h3>
        <div className="reply-dialog__row">
          <span>发送通道</span>
          <span>{channel.available ? (channel.enabled ? "可用 · 已启用" : "可用 · 已停用") : "不可用"}</span>
        </div>
        <div className="reply-dialog__row">
          <span>上次 / 下次</span>
          <span>{channel.lastStatus || "—"}{channel.nextAt ? ` · 下次 ${clockCn(channel.nextAt)}` : ""}</span>
        </div>
        {dry.cooldownRemainMs > 0 && (
          <div className="reply-dialog__row"><span>冷却</span><span>剩余约 {Math.ceil(dry.cooldownRemainMs / 1000)} 秒</span></div>
        )}
        {dry.alreadySubmitted && dry.alreadySubmitted.n > 0 && (
          <div className="reply-dialog__row">
            <span>今日已提交</span>
            <span>{dry.alreadySubmitted.n} 次 · {dry.alreadySubmitted.items[0]?.title || "—"}</span>
          </div>
        )}
        {channel.note && <p className="reports-guide__single">{channel.note}</p>}
        <p className={`reports-status reports-status--${blocked ? "warn" : "ok"}`}>
          {blocked ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />} {dry.note}
        </p>
        <label className="reply-dialog__confirm">
          <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} disabled={busy || blocked} />
          我确认触发远端提交任务（工作日判定 / 模板 / 收件人 / 群同步都在远端执行；5 分钟冷却内不重发）。
        </label>
        <div className="reply-dialog__actions">
          <button className="text-button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" onClick={onConfirm} disabled={!checked || busy || blocked}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}确认提交
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 回写审计面板：append-only writes.jsonl 尾 50（最新在前，正文已掩码）。
 * ------------------------------------------------------------------------- */

function WritesPanel() {
  const [writes, setWrites] = useState<ReportWrites | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchReportWrites()
      .then((data) => {
        setWrites(data);
        setError("");
      })
      .catch((loadError: unknown) => setError(reportErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="panel reports-panel" aria-label="回写审计">
      <div className="panel__header">
        <div>
          <span className="eyebrow">AUDIT / APPEND-ONLY</span>
          <h2>回写审计</h2>
        </div>
        <button className="text-button" onClick={load} disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
        </button>
      </div>
      <p className="history-panel__note">
        <ShieldCheck size={13} /> 每次真实外部写尝试（保存 record / 提交 run-now / 回读校验）无论成败都留一行；
        append-only、最新在前，正文只落掩码预览（先脱敏再截断）。共 {writes?.total ?? 0} 条，显示最近 {writes?.writes.length ?? 0} 条。
      </p>
      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
      {writes && writes.writes.length === 0 && (
        <p className="reports-guide__single">暂无回写记录：保存或提交后会在此留痕。</p>
      )}
      {writes && writes.writes.length > 0 && (
        <div className="reports-writes__scroll">
          <table className="reports-writes">
            <thead>
              <tr><th>时间</th><th>操作</th><th>阶段</th><th>目标</th><th>退出</th><th>结果</th><th>预览</th></tr>
            </thead>
            <tbody>
              {writes.writes.map((row, index) => (
                <tr key={`${row.at}-${index}`} data-ok={row.ok ? "yes" : "no"} data-executed={row.executed ? "yes" : "no"}>
                  <td className="reports-writes__at">{clockCn(row.at) || "—"}</td>
                  <td>{row.op === "submit" ? "提交" : "保存"}</td>
                  <td>{PHASE_LABEL[row.phase] ?? row.phase}</td>
                  <td className="reports-writes__target">{row.target || "—"}</td>
                  <td>{row.exitCode === null ? "—" : String(row.exitCode)}</td>
                  <td>{row.verified ? "已回读" : row.ok ? "成功" : row.executed ? "失败" : "未执行"}</td>
                  <td className="reports-writes__preview">{row.maskedPreview || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
        ECS QoderWake 的只读状态镜像（19:00 日报初稿 / 23:15 日报提交 / 周五 17:00 双周报）。
        本面板不触发任何任务；日报「提交」动作可在上方日报面板经两步确认后触发（run-now submit 任务），
        初稿与双周报任务仍不在本台触发。
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
        正文由 QoderWake 周五任务写入，本台不编辑双周报正文。
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
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<"" | "save-dry" | "save-confirm" | "submit-dry" | "submit-confirm">("");
  const [status, setStatus] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [saveDry, setSaveDry] = useState<ReportSaveDry | null>(null);
  const [saveCheck, setSaveCheck] = useState(false);
  const [submitDry, setSubmitDry] = useState<ReportSubmitDry | null>(null);
  const [submitCheck, setSubmitCheck] = useState(false);

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

  /* 每次载入新记录后，把草稿同步为线上值（保存成功 / 冲突刷新后重新对齐）。 */
  useEffect(() => {
    if (record) setDraft(draftOf(record));
  }, [record]);

  const dirty = record != null && EDITABLE_FIELDS.some(({ key }) => draft[key].trim() !== record[key].trim());
  const overLimit = EDITABLE_FIELDS.some(({ key }) => draft[key].length > REPORT_MAX_TEXT);
  const canSave = record != null && dirty && !overLimit && busy === "";
  const canSubmit = record != null && !dirty && busy === "";

  const setField = useCallback((key: ReportWritableField, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const openSaveDry = useCallback(async () => {
    if (!record) return;
    setBusy("save-dry");
    setStatus(null);
    try {
      const dry = await saveReportDraftDry({ recordId: record.recordId, cells: buildCells(record, draft) });
      setSaveDry(dry);
      setSaveCheck(false);
    } catch (dryError: unknown) {
      setStatus({ kind: "err", text: reportErrorMessage(dryError) });
    } finally {
      setBusy("");
    }
  }, [record, draft]);

  const confirmSave = useCallback(async () => {
    if (!saveDry) return;
    setBusy("save-confirm");
    try {
      const done = await saveReportDraftConfirm(saveDry.token);
      setStatus({
        kind: done.verified ? "ok" : "warn",
        text: done.verified
          ? `已保存并回读一致：更新了 ${done.updated.length} 个字段（${done.updated.map((key) => FIELD_LABEL[key]).join(" / ") || "—"}）。`
          : `保存已执行，但回读未确认一致：${done.note}`,
      });
      load(true);
    } catch (confirmError: unknown) {
      const conflict = confirmError instanceof ReportClientError && confirmError.code === "record_conflict";
      setStatus({ kind: conflict ? "warn" : "err", text: reportErrorMessage(confirmError) });
      if (conflict) load(true);
    } finally {
      setSaveDry(null);
      setSaveCheck(false);
      setBusy("");
    }
  }, [saveDry, load]);

  const openSubmitDry = useCallback(async () => {
    setBusy("submit-dry");
    setStatus(null);
    try {
      const dry = await submitReportDry();
      setSubmitDry(dry);
      setSubmitCheck(false);
    } catch (dryError: unknown) {
      setStatus({ kind: "err", text: reportErrorMessage(dryError) });
    } finally {
      setBusy("");
    }
  }, []);

  const confirmSubmit = useCallback(async () => {
    if (!submitDry) return;
    setBusy("submit-confirm");
    try {
      const done = await submitReportConfirm(submitDry.token);
      setStatus({
        kind: done.verified ? "ok" : "warn",
        text: done.verified
          ? `已触发提交并回读到 outbox（今日 ${done.submittedN} 条）。`
          : `已触发提交（runId ${done.runId || "—"}），但 outbox 暂未可见：${done.note}`,
      });
      load(true);
    } catch (confirmError: unknown) {
      setStatus({ kind: "err", text: reportErrorMessage(confirmError) });
    } finally {
      setSubmitDry(null);
      setSubmitCheck(false);
      setBusy("");
    }
  }, [submitDry, load]);

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / DAILY & BIWEEKLY REPORTS"
        title="日周报"
        description="当日 AI 表格草稿可在本台编辑，经两步确认保存 / 提交；OA outbox 提交状态、双周报目录/正文与 QoderWake 定时任务为只读镜像。confirm 闸门、冷却与审计留痕均在服务端。"
        aside={<CalendarDays size={22} strokeWidth={1.6} />}
      />

      <section className="panel reports-panel" aria-label="日报">
        <div className="panel__header">
          <div>
            <span className="eyebrow">DAILY / EDITABLE</span>
            <h2>今日日报</h2>
          </div>
          <button className="text-button" onClick={() => load(true)} disabled={loading || busy !== ""}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
          </button>
        </div>
        <p className="history-panel__note">
          <ShieldCheck size={13} /> 两步确认：保存 / 提交都先 dry 预检、勾选确认后服务端才回写钉钉或触发远端 run-now；
          confirm 闸门、5 分钟冷却、recordId 冲突拒绝、审计留痕都在服务端。dept / 工作状态由 19:00 初稿任务写入，只读不可改。
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
              <li><code>remote</code>：ECS QoderWake 的 SSH 探测与 run-now 参数（host / key / bin / wakerId / jobs 触发器）</li>
            </ol>
            <p>三段相互独立、只配想用的段；并在启动本机桥的终端完成 <code>dws auth login</code> 后刷新。</p>
          </div>
        )}

        {state?.configured && (
          <>
            {record ? (
              <>
                <dl className="reports-record">
                  {READONLY_FIELDS.map(({ key, label }) => (
                    <div key={key} className="reports-record__item" data-empty={record[key] === "" ? "yes" : "no"}>
                      <dt>{label}（只读）</dt>
                      <dd>{record[key] === "" ? "—" : record[key]}</dd>
                    </div>
                  ))}
                  <div className="reports-record__item" data-empty="no">
                    <dt>最后修改</dt>
                    <dd>{clockCn(record.modifiedAt) || "—"}</dd>
                  </div>
                </dl>

                <div className="reports-edit">
                  {EDITABLE_FIELDS.map(({ key, label }) => {
                    const value = draft[key];
                    const over = value.length > REPORT_MAX_TEXT;
                    return (
                      <label className="reports-edit__item" key={key}>
                        <span className="reports-edit__label">
                          {label}
                          <em className="reports-edit__count" data-over={over ? "yes" : "no"}>
                            {value.length} / {REPORT_MAX_TEXT}
                          </em>
                        </span>
                        <textarea
                          className="reports-edit__area"
                          value={value}
                          rows={2}
                          aria-label={label}
                          disabled={busy !== ""}
                          onChange={(event) => setField(key, event.target.value)}
                        />
                      </label>
                    );
                  })}
                </div>
                {overLimit && (
                  <div className="answer-warning"><AlertCircle size={15} /> 有字段超过 {REPORT_MAX_TEXT} 字上限：服务端不截断保存，请删减后再保存。</div>
                )}

                <div className="reports-actions">
                  <span className="reports-actions__hint">
                    {dirty ? "有未保存改动" : overLimit ? "存在超限字段" : "与线上一致"}
                  </span>
                  <button className="text-button" onClick={() => record && setDraft(draftOf(record))} disabled={busy !== "" || !dirty}>
                    撤销改动
                  </button>
                  <button
                    className="text-button"
                    onClick={openSaveDry}
                    disabled={!canSave}
                    title={dirty ? "预检改动并弹窗确认，勾选后回写钉钉 AI 表格。" : "没有可保存的改动（与线上一致或有超限字段）。"}
                  >
                    {busy === "save-dry" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存草稿…
                  </button>
                  <button
                    className="primary-button"
                    onClick={openSubmitDry}
                    disabled={!canSubmit}
                    title={dirty ? "请先保存草稿再提交：提交发送的是线上已保存内容。" : "预检发送通道 / 冷却 / 今日是否已提交，弹窗确认后触发远端 run-now。"}
                  >
                    {busy === "submit-dry" ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}提交日报…
                  </button>
                </div>

                {status && (
                  <p className={`reports-status reports-status--${status.kind}`}>
                    {status.kind === "ok" ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />} {status.text}
                  </p>
                )}
              </>
            ) : (
              <p className="reports-guide__single">{state.recordNote || "今日暂无记录：19:00 初稿任务生成当天记录后即可在此编辑保存。"}</p>
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

      <WritesPanel />
      <AutomationsPanel />
      <WeeklyPanel />
      <WorklogPanel />

      {saveDry && (
        <SaveDialog
          dry={saveDry}
          checked={saveCheck}
          busy={busy === "save-confirm"}
          onCheck={setSaveCheck}
          onCancel={() => { setSaveDry(null); setSaveCheck(false); }}
          onConfirm={confirmSave}
        />
      )}
      {submitDry && (
        <SubmitDialog
          dry={submitDry}
          checked={submitCheck}
          busy={busy === "submit-confirm"}
          onCheck={setSubmitCheck}
          onCancel={() => { setSubmitDry(null); setSubmitCheck(false); }}
          onConfirm={confirmSubmit}
        />
      )}
    </div>
  );
}
