import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Sparkles, X } from "lucide-react";
import { crmErrorMessage, fetchInsight, startInsight } from "../../lib/crm-client";
import { STAGES, projectStage, type CustomerLifecycle } from "../../lib/crm-model";
import type { InsightRecord } from "../../lib/crm-types";
import { StatusBadge } from "../shared";
import { formatDateTime, formatGaap } from "./crm-shared";

const INSIGHT_POLL_MS = 10_000;
const REUSE_MS = 24 * 3_600_000;

function useInsight(cid: string) {
  const [record, setRecord] = useState<InsightRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(cid);

  useEffect(() => {
    active.current = cid;
    setRecord(null);
    setError("");
    fetchInsight(cid)
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
  }, [cid]);

  const running = record?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchInsight(cid)
        .then((value) => active.current === cid && setRecord(value))
        .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
    }, INSIGHT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [cid, running]);

  const start = useCallback(() => {
    setSubmitting(true);
    setError("");
    startInsight(cid)
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)))
      .finally(() => setSubmitting(false));
  }, [cid]);

  return { record, error, submitting, start };
}

function InsightPanel({ cid }: { cid: string }) {
  const { record, error, submitting, start } = useInsight(cid);
  const running = record?.state === "running";
  const fresh = record?.state === "done" && Date.now() - new Date(record.createdAt).getTime() < REUSE_MS;
  const canStart = !submitting && !running && !fresh;
  return (
    <section className="crm-insight">
      <header>
        <div><span className="eyebrow">FBI</span><h3>消耗异动解读</h3></div>
        <button className="primary-button" onClick={start} disabled={!canStart}>
          {submitting || running ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
          {running ? "FBI 分析中" : fresh ? "今日已生成" : record?.state === "done" ? "重新解读" : "生成解读"}
        </button>
      </header>
      <p className="crm-insight__note">由本机 FBI 助手生成，同一客户 24 小时内只分析一次；分析通常需要几分钟，可关闭抽屉稍后再看。</p>
      {error && <p className="crm-insight__error">{error}</p>}
      {record && (
        <div className="crm-insight__body">
          <small>
            {record.state === "running" && `已提交 ${formatDateTime(record.createdAt)}，完成后自动显示`}
            {record.state === "done" && `生成于 ${formatDateTime(record.finishedAt ?? record.createdAt)}`}
            {record.state === "failed" && "上次解读未完成，可以重新提交"}
          </small>
          {record.state === "done" && <div className="crm-insight__answer">{record.answer ?? "FBI 未返回文字结论。"}</div>}
        </div>
      )}
    </section>
  );
}

export function CustomerDrawer({ row, onClose }: { row: CustomerLifecycle; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { customer } = row;
  const stage = STAGES.find((item) => item.id === row.stage);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rate = customer.yesterdayGaapRate;
  const facts: [string, string][] = [
    ["行业", customer.industry ?? "—"],
    ["区域", customer.area ?? "—"],
    ["等级", customer.level ?? "—"],
    ["上月 GAAP", formatGaap(customer.lastMonthGaap)],
    ["昨日 GAAP", `${formatGaap(customer.yesterdayGaap)}${rate === null ? "" : `（${rate > 0 ? "+" : ""}${rate.toFixed(1)}%）`}`],
    ["最近拜访记录", formatDateTime(customer.lastNoteAt)],
  ];

  return createPortal(
    <>
      <button className="crm-drawer__scrim" onClick={onClose} aria-label="关闭客户详情" tabIndex={-1} />
      <aside className="crm-drawer" role="dialog" aria-modal="true" aria-labelledby="crm-drawer-title">
        <header className="crm-drawer__header">
          <div>
            <span className="eyebrow">CID {customer.cid}</span>
            <h2 id="crm-drawer-title">{customer.name}</h2>
            {stage && <StatusBadge>{stage.id} · {stage.label}</StatusBadge>}
          </div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <dl className="crm-facts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>

        <section className="crm-drawer__section">
          <h3>在途项目 <small>{row.activeProjects.length}</small></h3>
          {row.activeProjects.length === 0
            ? <p className="crm-muted">鲲鹏中没有在途项目。</p>
            : (
              <ul className="crm-projects">
                {row.activeProjects.map((project) => (
                  <li key={project.id} className={project.id === row.leadProject?.id ? "is-lead" : undefined}>
                    <strong>{project.name}</strong>
                    <span>
                      {projectStage(project)} · {project.stageName ?? "阶段未知"}
                      {project.winRate !== null && ` · 赢率 ${project.winRate}%`}
                      {project.price !== null && ` · ${formatGaap(project.price)}`}
                    </span>
                    {project.expectedContractDate && <small>预计签约 {formatDateTime(project.expectedContractDate)}</small>}
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className="crm-drawer__section">
          <h3>ECID 画像 <small>鲲鹏企业画像</small></h3>
          <p className="crm-muted">
            本轮不展示画像数值：鲲鹏 CLI 的 customers 行没有 ecid 字段（CID ≠ ECID），
            直接查询会返回「提交的 ecid 不存在」，value 等画像接口对无效 ID 不报错、只返回全空。
            CID → ECID 的取数口径确认后再接入，这里不会用占位数字代替。
          </p>
          <button className="primary-button" disabled title="CID → ECID 口径待定，暂无法取数">
            ECID 画像待接入（CID → ECID 口径待定）
          </button>
        </section>

        <InsightPanel cid={customer.cid} />
      </aside>
    </>,
    document.body,
  );
}
