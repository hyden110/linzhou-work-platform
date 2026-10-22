import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, LoaderCircle, MessageSquareText, Sparkles, X } from "lucide-react";
import {
  crmErrorMessage,
  fetchAttribution,
  fetchExplain,
  startAttribution,
  startExplain,
} from "../../lib/crm-client";
import {
  buildGaapAttribution,
  reconcileGaapTotals,
  type GaapAttribution as GaapAttributionSplit,
  type GaapReconciliation,
} from "../../lib/gaap-attribution";
import { STAGES, projectStage, type CustomerLifecycle } from "../../lib/crm-model";
import type { AttributionRecord, CrmAiExplainRecord } from "../../lib/crm-types";
import { StatusBadge } from "../shared";
import { formatDateTime, formatGaap } from "./crm-shared";

const ATTRIBUTION_POLL_MS = 10_000;
const EXPLAIN_POLL_MS = 20_000;

const ATTRIBUTION_ERROR_MESSAGES: Record<string, string> = {
  fbi_create_failed: "FBI 会话创建失败：本次未产出归因，可重新分析。",
  fbi_parse_failed: "FBI 返回内容无法解析为产品拆分：本次未产出归因，可重新分析。",
  fbi_poll_failed: "FBI 结果轮询失败：本次未产出归因，可重新分析。",
};

const EXPLAIN_ERROR_MESSAGES: Record<string, string> = {
  dws_missing: "未找到 dws CLI：消息未发送或无法读取回复。",
  dws_send_failed: "发送失败：本次未发出，可重新发起。",
  dws_read_failed: "连续读取回复失败：结果不确定，可到钉钉会话核对。",
  crm_ai_timeout: "等待回复超时（5 分钟）：结果不确定，可到钉钉会话核对后重试。",
};

function signedGaap(value: number): string {
  return `${value > 0 ? "+" : ""}${formatGaap(value)}`;
}

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function useAttribution(cid: string) {
  const [record, setRecord] = useState<AttributionRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(cid);

  useEffect(() => {
    active.current = cid;
    setRecord(null);
    setError("");
    fetchAttribution(cid)
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
  }, [cid]);

  const running = record?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchAttribution(cid)
        .then((value) => active.current === cid && setRecord(value))
        .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
    }, ATTRIBUTION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [cid, running]);

  const start = useCallback((force = false) => {
    setSubmitting(true);
    setError("");
    startAttribution(cid, { force })
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)))
      .finally(() => setSubmitting(false));
  }, [cid]);

  return { record, error, submitting, start };
}

function useExplain(cid: string) {
  const [record, setRecord] = useState<CrmAiExplainRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(cid);

  useEffect(() => {
    active.current = cid;
    setRecord(null);
    setError("");
    fetchExplain(cid)
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
  }, [cid]);

  const running = record?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchExplain(cid)
        .then((value) => active.current === cid && setRecord(value))
        .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)));
    }, EXPLAIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [cid, running]);

  const start = useCallback((force = false) => {
    setSubmitting(true);
    setError("");
    startExplain(cid, { force })
      .then((value) => active.current === cid && setRecord(value))
      .catch((caught: unknown) => active.current === cid && setError(crmErrorMessage(caught)))
      .finally(() => setSubmitting(false));
  }, [cid]);

  return { record, error, submitting, start };
}

function AttributionSplitTable({ split }: { split: GaapAttributionSplit }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div className="crm-table-wrap crm-attribution__table">
      <table className="crm-table">
        <thead>
          <tr>
            <th>产品</th><th>当日 GAAP</th><th>前一日 GAAP</th><th>变化额</th><th>变化率</th><th>贡献度</th>
          </tr>
        </thead>
        <tbody>
          {split.level1Rows.map((row) => (
            <Fragment key={row.level1}>
              <tr>
                <td>
                  {row.children.length > 0 && (
                    <button
                      className="crm-attribution__expand"
                      aria-expanded={Boolean(expanded[row.level1])}
                      aria-label={`${expanded[row.level1] ? "收起" : "展开"} ${row.level1} 的二级产品`}
                      onClick={() => setExpanded({ ...expanded, [row.level1]: !expanded[row.level1] })}
                    >
                      <ChevronRight size={11} className={expanded[row.level1] ? "is-open" : ""} />
                    </button>
                  )}
                  <strong>{row.level1}</strong>
                </td>
                <td data-demo-field="amount">{formatGaap(row.current)}</td>
                <td data-demo-field="amount">{formatGaap(row.previous)}</td>
                <td className={row.diff > 0 ? "is-up" : "is-down"} data-demo-field="amount">{signedGaap(row.diff)}</td>
                <td>{row.rate === null ? "—" : signedPercent(row.rate)}</td>
                <td>{row.share === null ? "—" : signedPercent(row.share * 100)}</td>
              </tr>
              {expanded[row.level1] && row.children.map((child) => (
                <tr key={`${row.level1}:${child.level2}`} className="crm-attribution__child">
                  <td>└ {child.level2}</td>
                  <td data-demo-field="amount">{formatGaap(child.current)}</td>
                  <td data-demo-field="amount">{formatGaap(child.previous)}</td>
                  <td className={child.diff > 0 ? "is-up" : "is-down"} data-demo-field="amount">{signedGaap(child.diff)}</td>
                  <td>{child.rate === null ? "—" : signedPercent(child.rate)}</td>
                  <td>{child.share === null ? "—" : signedPercent(child.share * 100)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReconciliationView({ recon }: { recon: GaapReconciliation }) {
  return (
    <div className={`crm-attribution__recon${recon.mismatch ? " is-mismatch" : ""}`}>
      <span>FBI 客户总变化（业绩分成口径）</span>
      <b data-demo-field="amount">{recon.fbiTotalDiff === null ? "不可得" : signedGaap(recon.fbiTotalDiff)}</b>
      <span>鲲鹏异动卡涨跌额（主关联人归属口径）</span>
      <b data-demo-field="amount">{recon.kunpengDiff === null ? "不可得" : signedGaap(recon.kunpengDiff)}</b>
      {recon.gap === null
        ? <small>鲲鹏异动卡涨跌额缺失，无法对账；两侧口径本就不同，不强行对齐。</small>
        : (
          <small>
            绝对差 {formatGaap(Math.abs(recon.gap))}，容差 {formatGaap(recon.tolerance ?? 0)}：
            {recon.mismatch ? "超出容差，属口径差异，以鲲鹏数据为准" : "在容差内"}。
          </small>
        )}
    </div>
  );
}

function CrmAiExplainPanel({ cid, attributionDone }: { cid: string; attributionDone: boolean }) {
  const { record, error, submitting, start } = useExplain(cid);
  const running = record?.state === "running";
  const recordError = record?.state === "failed" && record.error
    ? EXPLAIN_ERROR_MESSAGES[record.error] ?? `解释未完成（${record.error}）。`
    : "";
  return (
    <section className="crm-attribution__explain" aria-label="CRM AI 助理解释">
      <header>
        <div><span className="eyebrow">CRM AI</span><h4>CRM AI 助理解释</h4></div>
        <button className="primary-button" onClick={() => start()} disabled={!attributionDone || submitting || running}>
          {submitting || running ? <LoaderCircle className="spin" size={14} /> : <MessageSquareText size={14} />}
          {running ? "等待回复" : record?.state === "done" ? "重新解释" : "请 CRM AI 助理解释"}
        </button>
      </header>
      <p className="crm-insight__note">
        点击后通过钉钉 1:1 单聊向「CRM AI 助理」发送模板问题（含鲲鹏异动卡与 FBI 产品变化摘要，不携带凭据）；
        回复可能需要几分钟，失败会如实提示，不影响上方表格。
      </p>
      {error && <p className="crm-insight__error">{error}</p>}
      {recordError && <p className="crm-insight__error">{recordError}</p>}
      {record && (
        <div className="crm-insight__body">
          <small>
            {record.state === "running" && `已发送 ${formatDateTime(record.askedAt ?? record.createdAt)}，等待助理回复`}
            {record.state === "done" && `CRM AI 助理回答 · 回复于 ${formatDateTime(record.answerAt ?? record.finishedAt ?? record.createdAt)}`}
            {record.state === "failed" && "上次解释未完成"}
          </small>
          {record.state === "done" && (
            <>
              <div className="crm-insight__answer">{record.answer ?? "CRM AI 助理未返回文字。"}</div>
              <small>业绩分成口径 · 仅供参考，以鲲鹏数据为准。</small>
            </>
          )}
        </div>
      )}
      {!attributionDone && <p className="crm-insight__note">先完成 FBI 产品拆分，再请 CRM AI 助理解释。</p>}
    </section>
  );
}

function GaapAttributionPanel({ cid, kunpengDiff }: { cid: string; kunpengDiff: number | null }) {
  const { record, error, submitting, start } = useAttribution(cid);
  const running = record?.state === "running";
  const split = useMemo(
    () => (record?.state === "done" ? buildGaapAttribution(record.rows) : null),
    [record],
  );
  const recon = useMemo(
    () => (record?.state === "done" ? reconcileGaapTotals(split?.totalDiff ?? null, kunpengDiff) : null),
    [kunpengDiff, record, split],
  );
  const recordError = record?.state === "failed" && record.error
    ? ATTRIBUTION_ERROR_MESSAGES[record.error] ?? `归因未完成（${record.error}）。`
    : "";
  const dataNotes = useMemo(() => {
    if (!record || record.state !== "done" || !split) return [];
    const notes: string[] = [];
    if (record.reason === "no_rows") notes.push("FBI 报表未返回该客户的产品拆分：数据不足，未生成产品行。");
    if (record.droppedRows > 0) notes.push(`另有 ${record.droppedRows} 行报表数据未通过校验，未计入拆分。`);
    if (split.incompleteRows > 0) notes.push(`${split.incompleteRows} 个产品行缺少单侧数据，未计入拆分。`);
    if (split.unchangedRows > 0) notes.push(`${split.unchangedRows} 个产品无变化，未进主表。`);
    if (split.totalDiff === 0) notes.push("客户总变化为 0：各产品贡献度不可计算。");
    return notes;
  }, [record, split]);

  return (
    <section className="crm-insight crm-attribution">
      <header>
        <div><span className="eyebrow">FBI</span><h3>GAAP 异动归因</h3></div>
        <button className="primary-button" onClick={() => start(record?.state === "done")} disabled={submitting || running}>
          {submitting || running ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
          {running ? "FBI 分析中" : record?.state === "done" ? "重新分析" : "开始归因"}
        </button>
      </header>
      <p className="crm-insight__note">
        按需向本机 FBI 助手提问「客户 × 产品」的日 GAAP 拆分（最近两个有数据日），失败如实提示，不推测产品行。
      </p>
      {error && <p className="crm-insight__error">{error}</p>}
      {recordError && <p className="crm-insight__error">{recordError}</p>}
      {record && (
        <div className="crm-insight__body">
          <small>
            {record.state === "running" && `已提交 ${formatDateTime(record.createdAt)}，完成后自动显示`}
            {record.state === "done"
              ? `数据日期 ${record.currentDate}${record.previousDate ? ` vs ${record.previousDate}` : " vs 前一日"}`
                + ` · 生成于 ${formatDateTime(record.finishedAt ?? record.createdAt)}`
                + ` · 数据来源 FBI 报表 ${record.reportResourceId}`
              : null}
            {record.state === "failed" && "上次归因未完成，可以重新分析"}
          </small>
          {split && split.level1Rows.length > 0 && (
            <>
              {recon && <ReconciliationView recon={recon} />}
              <AttributionSplitTable split={split} />
            </>
          )}
          {dataNotes.length > 0 && (
            <ul className="crm-attribution__notes">
              {dataNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
        </div>
      )}
      <CrmAiExplainPanel cid={cid} attributionDone={record?.state === "done" && Boolean(split && split.level1Rows.length > 0)} />
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

        <GaapAttributionPanel cid={customer.cid} kunpengDiff={customer.yesterdayGaapDiff ?? null} />
      </aside>
    </>,
    document.body,
  );
}
