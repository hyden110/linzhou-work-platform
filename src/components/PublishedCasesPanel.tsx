import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ExternalLink, Library, ShieldAlert } from "lucide-react";
import {
  casesErrorMessage,
  fetchPublishedCases,
  safeCaseUrl,
  type CasesSnapshot,
} from "../lib/cases-client";

/**
 * 「已发布案例」面板（F3）：与历史方案并列的只读台账，汇总 Code 平台页面仓库
 * 与 OSS 发布桶里的 HTML-PPT 案例。未配置 → 引导文案；渠道失败 → last-error
 * 如实展示；绝不造数据。入口链接只放行 http(s)（safeCaseUrl）。
 */

const CHANNEL_LABELS: Record<"code" | "oss", string> = { code: "Code 平台渠道", oss: "OSS 渠道" };

function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("zh-CN", { hour12: false });
}

const RED_LINE = "案例链接对外分享前先确认可对客";

export function PublishedCasesPanel({ available }: { available: boolean }) {
  const [snapshot, setSnapshot] = useState<CasesSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!available) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setSnapshot(await fetchPublishedCases());
    } catch (loadError) {
      setSnapshot(null);
      setError(casesErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void load();
  }, [load]);

  const channelIssues = snapshot
    ? (["code", "oss"] as const).filter((id) => snapshot.channels[id].state === "error" || snapshot.channels[id].state === "degraded")
    : [];

  return (
    <section className="panel cases-panel" aria-label="已发布案例">
      <div className="panel__header">
        <div>
          <span className="eyebrow">PUBLISHED CASES</span>
          <h2>已发布案例</h2>
        </div>
        <Library size={21} />
      </div>
      <p className="history-panel__note">
        只读台账：汇总 Code 平台页面仓库与 OSS 发布桶里的 HTML-PPT 案例（名称 / 客户别名 / 最近发布 / 入口），配置与凭证只留在本机。
      </p>

      {!available ? (
        <p className="history-empty">本机服务未启动，已发布案例不可用。运行 npm run dev:function 后刷新即可读取台账。</p>
      ) : error ? (
        <div className="answer-warning"><AlertCircle size={15} /> {error}</div>
      ) : loading && !snapshot ? (
        <p className="history-empty"><span className="spin-dot" /> 正在读取案例台账…</p>
      ) : snapshot && !snapshot.configured ? (
        <p className="history-empty">
          尚未配置案例源：复制 <code>config/cases.json.example</code> 到 <code>.local-cache/cases.json</code>
          ，按本人仓库 / 桶填写，并确保本机 <code>a1</code> / <code>ossutil</code> CLI 可用后刷新。
        </p>
      ) : snapshot ? (
        <>
          {channelIssues.map((id) => (
            <div key={id} className="answer-warning cases-panel__channel-note">
              <AlertCircle size={15} /> {CHANNEL_LABELS[id]}：{snapshot.channels[id].note || "部分数据可能缺失"}
            </div>
          ))}
          {!snapshot.cases.length ? (
            <p className="history-empty">渠道已配置，但本次没有返回案例；渠道报错会如实显示在上方。</p>
          ) : (
            <ul className="history-list">
              {snapshot.cases.map((entry) => {
                const url = safeCaseUrl(entry.entryUrl);
                return (
                  <li key={entry.id} className="history-item">
                    {url ? (
                      <a className="history-item__head" href={url} target="_blank" rel="noreferrer noopener" title={url}>
                        <ExternalLink size={15} className="history-item__chevron" />
                        <span className="history-item__title">
                          <strong>{entry.title || entry.name}</strong>
                          <em>{entry.cust || "未关联客户"}</em>
                        </span>
                        <span className="history-item__meta">
                          {entry.srcs.map((src) => <code key={src}>{src === "oss" ? "OSS" : "Code"}</code>)}
                          <span className="history-item__count">{entry.pageCount} 页</span>
                          <span className="history-item__time">{formatTime(entry.updatedAt)}</span>
                        </span>
                      </a>
                    ) : (
                      <div className="history-item__head">
                        <ExternalLink size={15} className="history-item__chevron" />
                        <span className="history-item__title">
                          <strong>{entry.title || entry.name}</strong>
                          <em>{entry.cust || "未关联客户"} · 无可用入口链接</em>
                        </span>
                        <span className="history-item__meta">
                          {entry.srcs.map((src) => <code key={src}>{src === "oss" ? "OSS" : "Code"}</code>)}
                          <span className="history-item__count">{entry.pageCount} 页</span>
                          <span className="history-item__time">{formatTime(entry.updatedAt)}</span>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      <p className="cases-panel__redline"><ShieldAlert size={12} /> {RED_LINE}</p>
    </section>
  );
}
