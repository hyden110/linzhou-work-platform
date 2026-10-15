import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronRight, Eye, History, Trash2 } from "lucide-react";
import {
  deleteSolutionVersion,
  fetchSolutionSeries,
  fetchSolutionSeriesVersions,
  solutionHistoryErrorMessage,
  type SolutionSeriesSummary,
  type SolutionVersion,
} from "../lib/solution-history-client";
import { StatusBadge } from "./shared";

/**
 * Reviewable archive of every plan this machine generated. Series are grouped by
 * customer + industry + goal, so re-running the same request extends one timeline
 * instead of overwriting it. Reads and deletes go to the local-only endpoints;
 * nothing here exists once the site is deployed without a local runtime.
 */

export interface SolutionHistoryPanelProps {
  readonly available: boolean;
  readonly refreshKey: number;
  readonly disabled?: boolean;
  readonly onOpen: (version: SolutionVersion, series: SolutionSeriesSummary) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}

export function SolutionHistoryPanel({ available, refreshKey, disabled, onOpen }: SolutionHistoryPanelProps) {
  const [series, setSeries] = useState<SolutionSeriesSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<SolutionVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!available) {
      setSeries([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setSeries(await fetchSolutionSeries());
    } catch (loadError) {
      setError(solutionHistoryErrorMessage(loadError));
      setSeries([]);
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!expandedId) {
      setVersions(null);
      return;
    }
    let cancelled = false;
    setVersionsLoading(true);
    fetchSolutionSeriesVersions(expandedId)
      .then((detail) => { if (!cancelled) setVersions(detail.versions); })
      .catch((loadError) => { if (!cancelled) setError(solutionHistoryErrorMessage(loadError)); })
      .finally(() => { if (!cancelled) setVersionsLoading(false); });
    return () => { cancelled = true; };
  }, [expandedId, refreshKey]);

  const toggle = (seriesId: string) => setExpandedId((current) => (current === seriesId ? null : seriesId));

  const remove = async (summary: SolutionSeriesSummary, version: SolutionVersion) => {
    setError("");
    setNotice("");
    try {
      const remaining = await deleteSolutionVersion(summary.seriesId, version.versionId);
      setNotice(remaining
        ? `已删除版本 v${version.version}，该方案序列还保留 ${remaining} 个版本。`
        : `已删除版本 v${version.version}，该方案序列已清空。`);
      if (remaining) {
        setVersions((await fetchSolutionSeriesVersions(summary.seriesId)).versions);
      } else {
        setExpandedId(null);
      }
      await load();
    } catch (deleteError) {
      setError(solutionHistoryErrorMessage(deleteError));
    }
  };

  return (
    <section className="panel history-panel" aria-label="历史方案版本">
      <div className="panel__header">
        <div>
          <span className="eyebrow">SOLUTION HISTORY</span>
          <h2>历史方案版本</h2>
        </div>
        <History size={21} />
      </div>
      <p className="history-panel__note">
        每次生成都会在本机存档为一个版本，并按“客户 + 行业 + 目标”归入同一方案序列；存档只保留受控摘要与引用，不含原始文件。
      </p>

      {!available ? (
        <p className="history-empty">本机服务未启动，历史方案不可用。运行 npm run dev:function 后刷新即可看到存档。</p>
      ) : error ? (
        <div className="answer-warning"><AlertCircle size={15} /> {error}</div>
      ) : loading && !series.length ? (
        <p className="history-empty"><span className="spin-dot" /> 正在读取本机存档…</p>
      ) : !series.length ? (
        <p className="history-empty">还没有历史方案。生成一次架构方案后，它会自动出现在这里。</p>
      ) : (
        <ul className="history-list">
          {series.map((summary) => {
            const expanded = expandedId === summary.seriesId;
            return (
              <li key={summary.seriesId} className="history-item">
                <button
                  className="history-item__head"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(summary.seriesId)}
                  disabled={disabled}
                >
                  <ChevronRight size={15} className={expanded ? "history-item__chevron is-open" : "history-item__chevron"} />
                  <span className="history-item__title">
                    <strong>{summary.customer}</strong>
                    <em>{summary.title || summary.goal}</em>
                  </span>
                  <span className="history-item__meta">
                    {summary.industry && <code>{summary.industry}</code>}
                    <StatusBadge tone={summary.latestEngine === "qoder-cli" ? "green" : "amber"}>
                      {summary.latestEngine === "qoder-cli" ? "Qoder CLI" : "模板"}
                    </StatusBadge>
                    <span className="history-item__count">v{summary.latestVersion} · {summary.versionCount} 个版本</span>
                    <span className="history-item__time">{formatTime(summary.updatedAt)}</span>
                  </span>
                </button>

                {expanded && (
                  <div className="history-versions">
                    {versionsLoading || !versions ? (
                      <p className="history-empty"><span className="spin-dot" /> 正在读取版本…</p>
                    ) : (
                      <ol className="history-versions__list">
                        {versions.map((version) => (
                          <li key={version.versionId} className="history-version">
                            <span className="history-version__tag">v{version.version}</span>
                            <span className="history-version__body">
                              <strong>{version.plan.title}</strong>
                              <span className="history-version__meta">
                                {formatTime(version.createdAt)}
                                {` · ${version.plan.layers.length} 层 / ${version.plan.layers.reduce((total, layer) => total + layer.products.length, 0)} 个产品`}
                                {version.retrieval.status === "results-only"
                                  ? ` · 召回 ${version.retrieval.resultCount} 份`
                                  : " · 未召回受控证据"}
                                {version.degraded ? " · 模板降级" : ""}
                              </span>
                            </span>
                            <span className="history-version__actions">
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={disabled}
                                onClick={() => onOpen(version, summary)}
                              >
                                <Eye size={13} /> 查看
                              </button>
                              <button
                                className="secondary-button history-version__delete"
                                type="button"
                                disabled={disabled}
                                onClick={() => void remove(summary, version)}
                              >
                                <Trash2 size={13} /> 删除
                              </button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {notice && <p className="history-notice">{notice}</p>}
    </section>
  );
}
