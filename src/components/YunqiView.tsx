import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CalendarDays, Cloud, ExternalLink, Layers3, MessageSquareQuote, ShieldCheck, Sparkles, TerminalSquare, TrendingUp } from "lucide-react";
import { formatBytes, formatDate } from "../data/format";
import { fetchYunqiHighlights, localErrorMessage } from "../lib/local-client";
import type { YunqiHighlights } from "../types";
import { DocumentRow } from "./DocumentRow";
import { LocalOpenButton } from "./LocalRuntimeProvider";
import { ForumCard, MethodPanel, SynthesisCard, TrendCard } from "./YunqiPanels";
import { StatusBadge, ViewHeading, type ViewProps } from "./shared";

const FLASH_MS = 1_800;

function useJumpToTalk() {
  return useCallback((anchor: string) => {
    const target = document.getElementById(anchor);
    if (!target) return;
    for (const details of Array.from(document.querySelectorAll("details"))) {
      if (details.contains(target)) details.open = true;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-flash");
    setTimeout(() => target.classList.remove("is-flash"), FLASH_MS);
  }, []);
}

function ThesisCard({ thesis }: { thesis: YunqiHighlights["thesis"] }) {
  return (
    <section className="panel yunqi-thesis">
      <span className="eyebrow">{thesis.tag}</span>
      <h2>{thesis.statement}</h2>
      <p>{thesis.note}</p>
    </section>
  );
}

function SourceStrip({ highlights }: { highlights: YunqiHighlights }) {
  const { source } = highlights;
  return (
    <section className="panel yunqi-source">
      <div className="yunqi-source__icon"><Cloud size={19} /></div>
      <div className="yunqi-source__main">
        <strong title={source.title}>{source.title}</strong>
        <span>{source.relativePath} · {source.type} · {formatBytes(source.bytes)} · 整理于 {formatDate(source.modifiedAt)}</span>
        <span className="yunqi-source__digest">指纹 {source.digest.slice(0, 12)} · 原文只留在本机，工作台读取的是脱敏重点内容</span>
      </div>
      <LocalOpenButton id={source.id} title={source.title} extension={source.type} />
    </section>
  );
}

function StatsStrip({ highlights }: { highlights: YunqiHighlights }) {
  const { stats } = highlights;
  const cells = [
    { label: "分析层级", value: stats.layers, icon: Layers3 },
    { label: "趋势判断", value: stats.trends, icon: TrendingUp },
    { label: "综合判断", value: stats.synthesis, icon: Sparkles },
    { label: "论坛", value: stats.forums, icon: CalendarDays },
    { label: "发言卡", value: stats.talks, icon: MessageSquareQuote },
    { label: "已知缺口", value: stats.gaps, icon: AlertCircle },
  ];
  return (
    <section className="yunqi-stats" aria-label="云栖重点内容规模">
      {cells.map((cell) => (
        <div key={cell.label}>
          <cell.icon size={15} />
          <strong>{cell.value}</strong>
          <span>{cell.label}</span>
        </div>
      ))}
    </section>
  );
}

function UnavailablePanel({ message }: { message: string }) {
  return (
    <section className="panel yunqi-unavailable">
      <div><Cloud size={26} /></div>
      <h2>云栖重点内容未就绪</h2>
      <p>{message}</p>
      <p className="yunqi-unavailable__hint">
        重点内容从本机 HTML 原文提炼，只保存在本机私有缓存，不进入 public 目录、不随站点发布。生成命令：
      </p>
      <div className="command-notice">
        <TerminalSquare size={16} />
        <code>python3 sync/yunqi_highlights.py</code>
      </div>
    </section>
  );
}

export function YunqiView({ index }: ViewProps) {
  const [highlights, setHighlights] = useState<YunqiHighlights | null>(null);
  const [error, setError] = useState("");
  const [activeLayer, setActiveLayer] = useState("");
  const jumpToTalk = useJumpToTalk();

  useEffect(() => {
    let cancelled = false;
    fetchYunqiHighlights()
      .then((data) => { if (!cancelled) { setHighlights(data); setError(""); setActiveLayer(data.layers[0]?.id ?? ""); } })
      .catch((failure: unknown) => { if (!cancelled) { setHighlights(null); setError(localErrorMessage(failure)); } });
    return () => { cancelled = true; };
  }, []);

  const localDocuments = useMemo(
    () => index.documents.filter((document) => document.events.includes("云栖大会")).slice(0, 10),
    [index.documents],
  );
  const layer = highlights?.layers.find((item) => item.id === activeLayer) ?? highlights?.layers[0];
  const layerTrends = useMemo(
    () => (layer ? highlights?.trends.filter((trend) => trend.layerId === layer.id) ?? [] : []),
    [highlights, layer],
  );
  const layerForums = useMemo(
    () => (layer ? highlights?.forums.filter((forum) => forum.layerId === layer.id) ?? [] : []),
    [highlights, layer],
  );

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="YUNQI INTELLIGENCE / 06"
        title="云栖大会重点内容"
        description="从本机云栖整理稿提炼的六层趋势、综合判断、论坛与发言卡；内容为分析视角与转述归纳，不是现场逐字原话。"
        aside={highlights
          ? <StatusBadge tone="blue">本机提炼 · {formatDate(highlights.generatedAt)}</StatusBadge>
          : <StatusBadge tone="amber">等待本机数据</StatusBadge>}
      />

      {!highlights && (error
        ? <UnavailablePanel message={error} />
        : <section className="panel yunqi-loading"><i /><span>正在读取本机云栖重点内容…</span></section>)}

      {highlights && (
        <>
          <ThesisCard thesis={highlights.thesis} />
          <SourceStrip highlights={highlights} />
          <StatsStrip highlights={highlights} />

          <section className="panel yunqi-block">
            <div className="panel__header">
              <div><span className="eyebrow">SYNTHESIS</span><h2>五条综合判断</h2></div>
              <StatusBadge tone="muted">跨论坛归纳 · 非大会统一结论</StatusBadge>
            </div>
            <div className="yunqi-synthesis-grid">
              {highlights.synthesis.map((item) => <SynthesisCard key={item.index} item={item} onJump={jumpToTalk} />)}
            </div>
          </section>

          <section className="panel yunqi-block">
            <div className="panel__header">
              <div><span className="eyebrow">SIX LAYERS</span><h2>六层结构与论坛</h2></div>
              <StatusBadge tone="blue">阅读视角 · 非技术依赖栈</StatusBadge>
            </div>
            <div className="yunqi-layer-rail" role="tablist" aria-label="云栖六层">
              {highlights.layers.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={layer?.id === item.id}
                  className={layer?.id === item.id ? "is-active" : ""}
                  onClick={() => setActiveLayer(item.id)}
                >
                  <span>L{item.order}</span><strong>{item.title.split("：")[0].replace(/^第.层 · /, "")}</strong>
                  <small>{item.forumIds.length} 场论坛</small>
                </button>
              ))}
            </div>

            {layer && (
              <div className="yunqi-layer">
                <header>
                  <span className="eyebrow">{layer.label}</span>
                  <h3>{layer.title}</h3>
                  <p>{layer.summary}</p>
                </header>
                <div className="yunqi-trend-grid">
                  {layerTrends.map((trend) => <TrendCard key={trend.id} trend={trend} onJump={jumpToTalk} />)}
                </div>
                <div className="yunqi-forum-table">
                  <span className="eyebrow">本层论坛议程概览</span>
                  <table>
                    <thead><tr><th>论坛</th><th>时间</th><th>地点</th><th>定位</th><th>发布与状态</th></tr></thead>
                    <tbody>
                      {layer.forums.map((row) => (
                        <tr key={row.id}>
                          <td><strong>{row.title}</strong><small>{row.agenda}</small></td>
                          <td>{row.when}</td>
                          <td>{row.where}</td>
                          <td>{row.positioning}</td>
                          <td>{row.releases}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="yunqi-forum-list">
                  {layerForums.map((forum) => <ForumCard key={forum.id} forum={forum} />)}
                </div>
              </div>
            )}
          </section>

          <section className="panel yunqi-block">
            <div className="panel__header">
              <div><span className="eyebrow">METHOD & CREDIBILITY</span><h2>整理方法与可信度规则</h2></div>
              <StatusBadge tone="amber">{highlights.stats.gaps} 项已知缺口</StatusBadge>
            </div>
            <MethodPanel method={highlights.method} />
          </section>
        </>
      )}

      <section className="panel yunqi-block">
        <div className="panel__header">
          <div><span className="eyebrow">LOCAL MATCHES</span><h2>本机云栖资料</h2></div>
          <div className="yunqi-local-hint"><ShieldCheck size={14} /> 可直接用本机应用打开</div>
        </div>
        <div className="document-list">
          {localDocuments.map((document) => <DocumentRow key={document.id} document={document} compact />)}
          {localDocuments.length === 0 && (
            <div className="empty-state empty-state--small">
              <div><ExternalLink size={24} /></div>
              <h2>索引里还没有云栖资料</h2>
              <p>运行一次本机同步后，命中「云栖大会」的资料会出现在这里，并可一键用本机应用打开。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
