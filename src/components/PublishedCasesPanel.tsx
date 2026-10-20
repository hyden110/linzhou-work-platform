import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronRight, ExternalLink, Library, ShieldAlert } from "lucide-react";
import {
  casesErrorMessage,
  fetchPublishedCases,
  type CasesSnapshot,
  type PublishedCase,
} from "../lib/cases-client";
import {
  caseFacets,
  casePreview,
  caseStats,
  queryCases,
  type CaseFacets,
  type CaseQuery,
  type CaseSort,
} from "../lib/cases-model";

/**
 * 「已发布案例」面板（F3 + 模型增强）：与历史方案并列的只读台账，汇总 Code 平台页面仓库
 * 与 OSS 发布桶里的 HTML-PPT 案例。派生口径全部来自 src/lib/cases-model.ts（纯函数）：
 * 统计行 / 分面筛选（只列出现存值）/ 关键词排序 / 只读预览（casePreview，入口链接再过
 * http(s) 护栏）。未配置 → 引导文案；渠道失败 → last-error 如实展示；绝不造数据。
 * 红线：案例链接对外分享前先确认可对客。
 */

const CHANNEL_LABELS: Record<"code" | "oss", string> = { code: "Code 平台渠道", oss: "OSS 渠道" };

const RED_LINE = "案例链接对外分享前先确认可对客";

const ALL = "";
const DEFAULT_QUERY: CaseQuery = { q: "", src: "", type: "", cust: "", sort: "snapshot" };

const SORT_OPTIONS: ReadonlyArray<{ readonly value: CaseSort; readonly label: string }> = [
  { value: "snapshot", label: "按发布顺序" },
  { value: "title", label: "按标题" },
];

function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("zh-CN", { hour12: false });
}

/* ---------------- 统计行 ---------------- */

function CaseStatsStrip({ cases }: { cases: readonly PublishedCase[] }) {
  const stats = useMemo(() => caseStats(cases, Date.now()), [cases]);
  return (
    <div className="cases-stats" aria-label="案例统计">
      <span className="cases-stat" title={`Code 平台 ${stats.code} · OSS ${stats.oss} · 跨渠道合并 ${stats.crossChannel} 条`}>
        <span className="cases-stat__main"><b>{stats.total}</b>案例总数</span>
        <i>Code {stats.code} · OSS {stats.oss} · 跨渠道 {stats.crossChannel}</i>
      </span>
      <span className="cases-stat" title="Code 平台按仓库最近活跃计，无逐文件时间">
        <span className="cases-stat__main"><b>{stats.recent30}</b>近 30 天更新</span>
      </span>
      <span className="cases-stat" title={`${stats.linkedCases} 条案例已归属客户池`}>
        <span className="cases-stat__main"><b>{stats.customers}</b>关联客户</span>
        <i>{stats.linkedCases} 条已归属</i>
      </span>
      <span className={`cases-stat${stats.noEntry > 0 ? " is-warn" : ""}`} title="台账里没有 http(s) 入口链接的案例数">
        <span className="cases-stat__main"><b>{stats.noEntry}</b>缺入口链接</span>
      </span>
    </div>
  );
}

/* ---------------- 分面筛选 + 关键词排序 ---------------- */

function CaseFilterBar({
  facets,
  query,
  total,
  shown,
  onChange,
}: {
  facets: CaseFacets;
  query: CaseQuery;
  total: number;
  shown: number;
  onChange: (patch: Partial<CaseQuery>) => void;
}) {
  const dirty = query.q !== "" || query.src !== "" || query.type !== "" || query.cust !== "" || query.sort !== DEFAULT_QUERY.sort;
  return (
    <div className="cases-filters" aria-label="案例筛选">
      <label>渠道
        <select value={query.src} onChange={(event) => onChange({ src: event.target.value })}>
          <option value={ALL}>全部渠道</option>
          {facets.srcs.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
        </select>
      </label>
      <label>类型
        <select value={query.type} onChange={(event) => onChange({ type: event.target.value })}>
          <option value={ALL}>全部类型</option>
          {facets.types.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
        </select>
      </label>
      <label>客户
        <select value={query.cust} onChange={(event) => onChange({ cust: event.target.value })}>
          <option value={ALL}>全部客户</option>
          {facets.custs.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
        </select>
      </label>
      <label>排序
        <select value={query.sort} onChange={(event) => onChange({ sort: event.target.value as CaseSort })}>
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="cases-filters__search">关键词
        <input
          value={query.q}
          onChange={(event) => onChange({ q: event.target.value })}
          placeholder="搜索标题 / 客户 / 页面名 / 仓库…"
        />
      </label>
      {dirty && <button type="button" className="text-button" onClick={() => onChange(DEFAULT_QUERY)}>清除筛选</button>}
      <span className="cases-filters__count">{shown} / {total} 条</span>
    </div>
  );
}

/* ---------------- 案例行 + 只读预览 ---------------- */

function CaseItem({ entry, open, onToggle }: { entry: PublishedCase; open: boolean; onToggle: () => void }) {
  const preview = useMemo(() => casePreview(entry), [entry]);
  return (
    <li className="history-item cases-item">
      <button className="history-item__head" type="button" onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={15} className={open ? "history-item__chevron is-open" : "history-item__chevron"} />
        <span className="history-item__title">
          <strong>{preview.title}</strong>
          <em>{entry.cust || "未关联客户"}</em>
        </span>
        <span className="history-item__meta">
          {entry.srcs.map((src) => <code key={src}>{src === "oss" ? "OSS" : "Code"}</code>)}
          <span className="history-item__count">{entry.pageCount} 页</span>
          <span className="history-item__time">{formatTime(entry.updatedAt)}</span>
        </span>
      </button>
      {open && (
        <div className="cases-preview">
          <dl>
            {preview.facts.map((fact) => (
              <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
            ))}
          </dl>
          {preview.entryUrl ? (
            <a className="cases-preview__link" href={preview.entryUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={12} /> 打开案例
            </a>
          ) : (
            <p className="cases-preview__nolink">台账未提供 http(s) 入口链接，不展示可点入口。</p>
          )}
        </div>
      )}
    </li>
  );
}

function CasesBody({
  cases,
  facets,
  list,
  query,
  openId,
  onQuery,
  onToggle,
}: {
  cases: readonly PublishedCase[];
  facets: CaseFacets;
  list: readonly PublishedCase[];
  query: CaseQuery;
  openId: string;
  onQuery: (patch: Partial<CaseQuery>) => void;
  onToggle: (id: string) => void;
}) {
  if (cases.length === 0) {
    return <p className="history-empty">渠道已配置，但本次没有返回案例；渠道报错会如实显示在上方。</p>;
  }
  return (
    <>
      <CaseStatsStrip cases={cases} />
      <CaseFilterBar facets={facets} query={query} total={cases.length} shown={list.length} onChange={onQuery} />
      <ul className="history-list cases-list">
        {list.map((entry) => (
          <CaseItem
            key={entry.id}
            entry={entry}
            open={openId === entry.id}
            onToggle={() => onToggle(entry.id)}
          />
        ))}
        {list.length === 0 && (
          <li className="history-empty cases-list__empty">
            没有匹配的案例：清空筛选或换个关键词（标题 / 客户 / 页面名 / 仓库名均可搜）。
          </li>
        )}
      </ul>
    </>
  );
}

export function PublishedCasesPanel({ available }: { available: boolean }) {
  const [snapshot, setSnapshot] = useState<CasesSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<CaseQuery>(DEFAULT_QUERY);
  const [openId, setOpenId] = useState("");

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
  const cases = useMemo(() => snapshot?.cases ?? [], [snapshot]);
  const facets = useMemo(() => caseFacets(cases), [cases]);
  const list = useMemo(() => queryCases(cases, query), [cases, query]);
  const patchQuery = useCallback((patch: Partial<CaseQuery>) => setQuery((current) => ({ ...current, ...patch })), []);
  const toggleCase = useCallback(
    (id: string) => setOpenId((current) => (current === id ? "" : id)),
    [],
  );

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
          <CasesBody
            cases={cases}
            facets={facets}
            list={list}
            query={query}
            openId={openId}
            onQuery={patchQuery}
            onToggle={toggleCase}
          />
        </>
      ) : null}

      <p className="cases-panel__redline"><ShieldAlert size={12} /> {RED_LINE}</p>
    </section>
  );
}
