import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertCircle, CalendarDays, LoaderCircle, RefreshCw } from "lucide-react";

import {
  fetchWorklog,
  fetchWorklogSummary,
  worklogErrorMessage,
  type WorklogQuery,
  type WorklogSnapshot,
  type WorklogSummarySnapshot,
} from "../../lib/worklog-client";
import { WORKLOG_STAGES } from "../../lib/worklog-model";
import "../../worklog.css";

/**
 * 「工作清单」自包含面板（只读）：时间范围选择 + 每环节计数 + 按日聚合 + 分类条目列表。
 * 数据来自本地桥 GET /local/worklog 与 /local/worklog/summary（本机 Qoder 系工作库
 * 只读扫描）；源库缺失时如实展示 missing 诚实态，绝不伪造条目。
 * 样式只消费 globals.css :root 既有 token（见 src/worklog.css），类名 worklog- 前缀。
 * 挂载：由交付负责人接入 ReportsView（本面板不改动任何既有视图文件）。
 */

const DAY_PRESETS = [7, 14, 30] as const;
const CONFIDENCE_LABEL: Record<string, string> = { high: "高置信", medium: "中置信", low: "待复核" };

function stageName(stageId: string | null): string {
  if (stageId === null) return "未分类";
  return WORKLOG_STAGES.find((s) => s.id === stageId)?.name ?? "未分类";
}

function daysAgoLocal(days: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface WorklogPanelProps {
  /** 自定义范围模式下的初始回看天数（仅用于预填 from 输入，缺省 30）。 */
  readonly initialLookbackDays?: number;
}

export function WorklogPanel({ initialLookbackDays = 30 }: WorklogPanelProps) {
  const [days, setDays] = useState<number | null>(DAY_PRESETS[0]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [snapshot, setSnapshot] = useState<WorklogSnapshot | null>(null);
  const [summary, setSummary] = useState<WorklogSummarySnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const query: WorklogQuery | undefined = useMemo(() => {
    if (days !== null) return { days };
    if (from && to) return { from, to };
    return undefined; // 自定义范围没填全：不发请求（面板给出提示）
  }, [days, from, to]);

  const load = useCallback(() => {
    if (!query) {
      setSnapshot(null);
      setSummary(null);
      setError("");
      return;
    }
    setLoading(true);
    Promise.all([fetchWorklog(query), fetchWorklogSummary(query)])
      .then(([list, sum]) => {
        setSnapshot(list);
        setSummary(sum);
        setError("");
      })
      .catch((loadError: unknown) => {
        setSnapshot(null);
        setSummary(null);
        setError(worklogErrorMessage(loadError));
      })
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const customIncomplete = days === null && !(from && to);
  const stageCounts = snapshot ? WORKLOG_STAGES.filter((s) => (snapshot.counts.byStage[s.id] ?? 0) > 0) : [];

  return (
    <section className="panel worklog-panel" aria-label="工作清单（只读）">
      <div className="panel__header">
        <div>
          <span className="eyebrow">WORKLOG / READ-ONLY</span>
          <h2>工作清单采集与分类</h2>
        </div>
        <button className="text-button" onClick={load} disabled={loading || !query}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新
        </button>
      </div>
      <p className="worklog-panel__note">
        本机 Qoder / QoderCN / QoderWork / QwenWorkCN 工作库的只读扫描（源库零写入），
        按九环节规则打分分类；打不出环节的条目如实标「未分类」，不猜。
      </p>

      <div className="worklog-range" role="group" aria-label="时间范围">
        {DAY_PRESETS.map((preset) => (
          <button
            key={preset}
            className="worklog-range__chip"
            data-active={days === preset}
            onClick={() => { setDays(preset); setFrom(""); setTo(""); }}
          >
            近 {preset} 天
          </button>
        ))}
        <button
          className="worklog-range__chip"
          data-active={days === null}
          onClick={() => { setDays(null); if (!from) setFrom(daysAgoLocal(initialLookbackDays)); if (!to) setTo(daysAgoLocal(0)); }}
        >
          <CalendarDays size={12} />自定义
        </button>
        {days === null && (
          <span className="worklog-range__custom">
            <input type="date" aria-label="开始日期" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span aria-hidden="true">→</span>
            <input type="date" aria-label="结束日期" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </span>
        )}
      </div>
      {customIncomplete && <p className="worklog-range__hint">请填写完整的开始与结束日期（YYYY-MM-DD，跨度 ≤366 天）。</p>}

      {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}

      {snapshot?.status === "missing" && (
        <div className="worklog-missing" role="status">
          <AlertCircle size={15} />
          <span>{snapshot.missingNote || "未检测到本机工作库：暂无可采集的工作记录源。"}</span>
        </div>
      )}

      {snapshot && snapshot.status !== "missing" && (
        <>
          {snapshot.status === "partial" && (
            <div className="answer-warning">
              <AlertCircle size={15} />
              部分工作库打开失败：{snapshot.sources.filter((s) => s.status === "error").map((s) => s.instance).join("、")}（详见来源状态），其余源已照常采集。
            </div>
          )}

          <div className="worklog-counts" aria-label="每环节计数">
            {stageCounts.map((stage) => (
              <span key={stage.id} className="worklog-count" data-stage={stage.id}>
                {stage.name}<strong>{snapshot.counts.byStage[stage.id] ?? 0}</strong>
              </span>
            ))}
            {snapshot.counts.unclassified > 0 && (
              <span className="worklog-count" data-stage="unclassified">未分类<strong>{snapshot.counts.unclassified}</strong></span>
            )}
            {stageCounts.length === 0 && snapshot.counts.unclassified === 0 && (
              <span className="worklog-counts__empty">该时间范围内没有采集到工作记录。</span>
            )}
          </div>

          {summary && summary.byDay.length > 0 && (
            <ul className="worklog-days" aria-label="按日聚合">
              {summary.byDay.map((day) => (
                <li key={day.date} className="worklog-day">
                  <span>{day.date}</span>
                  <i style={{ "--ratio": Math.min(1, day.count / Math.max(...summary.byDay.map((d) => d.count))) } as CSSProperties} />
                  <strong>{day.count}</strong>
                </li>
              ))}
            </ul>
          )}

          <ul className="worklog-entries">
            {snapshot.entries.map((entry) => (
              <li key={entry.sourceKey} className="worklog-entry">
                <span className="worklog-entry__date">{entry.date}</span>
                <span className="worklog-entry__title" title={entry.title}>{entry.title}</span>
                <span className="worklog-entry__stage" data-stage={entry.stageId ?? "unclassified"}>{stageName(entry.stageId)}</span>
                <span className="worklog-entry__conf" data-conf={entry.confidence}>{CONFIDENCE_LABEL[entry.confidence] ?? entry.confidence}</span>
                <span className="worklog-entry__meta">{entry.instance} · {entry.cluster || "其他模式"}</span>
              </li>
            ))}
          </ul>
          {snapshot.truncated && (
            <p className="worklog-range__hint">条目过多，仅展示最近 {snapshot.entries.length} 条（按最近活跃倒序）。</p>
          )}

          <footer className="worklog-sources">
            {snapshot.sources.map((source) => (
              <span key={source.instance} className="worklog-source" data-status={source.status} title={source.note || undefined}>
                {source.instance} · {source.status === "ok" ? `${source.count} 条` : source.status === "missing" ? "未安装" : "打开失败"}
              </span>
            ))}
            {snapshot.generatedAt && <span className="worklog-source__at">采集于 {new Date(snapshot.generatedAt).toLocaleString("zh-CN")}</span>}
          </footer>
        </>
      )}
    </section>
  );
}

export default WorklogPanel;
