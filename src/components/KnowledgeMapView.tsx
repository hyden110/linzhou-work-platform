import { useMemo, useState } from "react";
import { ArrowRight, ChevronRight, Layers3, Lightbulb, Network, Search, Sparkles } from "lucide-react";
import { YUNQI_EVENT, facetCounts, matchesFacet, shelfById } from "../data/facets";
import type { ShelfId } from "../types";
import { DocumentRow } from "./DocumentRow";
import { StatusBadge, ViewHeading, type ViewProps } from "./shared";

const DETAIL_LIMIT = 40;
const RAIL_LIMIT = 24;

export function KnowledgeMapView({
  documents,
  onNavigate,
  initialShelf = "solutions",
  initialGroup = "",
}: ViewProps & { initialShelf?: ShelfId; initialGroup?: string }) {
  const [shelfId, setShelfId] = useState<ShelfId>(initialShelf);
  const [selected, setSelected] = useState(initialGroup);
  const [filter, setFilter] = useState("");
  const shelf = shelfById(shelfId);

  const rows = useMemo(
    () => facetCounts(documents, shelf.key, shelf.fallback),
    [documents, shelf],
  );
  const rail = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase("zh-CN");
    const matched = query ? rows.filter((row) => row.name.toLocaleLowerCase("zh-CN").includes(query)) : rows;
    return matched.slice(0, RAIL_LIMIT);
  }, [filter, rows]);
  const active = rows.find((row) => row.name === selected) ?? rows[0];
  const max = Math.max(...rows.map((row) => row.count), 1);
  const matched = useMemo(
    () => (active ? documents.filter((document) => matchesFacet(document, shelf.key, active.name, shelf.fallback)) : []),
    [active, documents, shelf],
  );

  const switchShelf = (next: ShelfId) => {
    setShelfId(next);
    setSelected("");
    setFilter("");
  };

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="KNOWLEDGE GRAPH / 03"
        title="知识地图"
        description="同一批本地资料按四个互不排斥的维度归档：解决方案、客户案例、大会活动与主题聚类。"
        aside={<StatusBadge tone="blue">规则归档 · 未做正文语义验证</StatusBadge>}
      />

      <div className="dimension-tabs" role="tablist" aria-label="知识分类维度">
        {(["solutions", "customers", "events", "topics"] as ShelfId[]).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={shelfId === id}
            className={shelfId === id ? "is-active" : ""}
            onClick={() => switchShelf(id)}
          >
            {shelfById(id).label}
          </button>
        ))}
      </div>

      <div className="map-layout">
        <section className="panel facet-rail" aria-label={`${shelf.label}分组`}>
          <div className="facet-rail__head">
            <div><span className="eyebrow">{shelf.label.toUpperCase()}</span><h2>{rows.length} 个分组</h2></div>
            <Layers3 size={19} />
          </div>
          <label className="facet-search">
            <Search size={15} />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={shelf.searchPlaceholder}
              aria-label={`筛选${shelf.label}分组`}
            />
          </label>
          <div className="topic-bars topic-bars--rail">
            {rail.map((row, position) => (
              <button
                key={row.name}
                className={active?.name === row.name ? "is-active" : ""}
                onClick={() => setSelected(row.name)}
                aria-pressed={active?.name === row.name}
              >
                <span className="topic-bars__rank">{String(position + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{row.name}</strong>
                  <i style={{ width: `${Math.max((row.count / max) * 100, 5)}%` }} />
                </div>
                <b>{row.count.toLocaleString("zh-CN")}</b>
              </button>
            ))}
            {rail.length === 0 && <p className="facet-rail__empty">没有匹配的分组，试试更短的关键词。</p>}
          </div>
          {rows.length > rail.length && (
            <p className="facet-rail__more">已显示前 {rail.length} 组 · 共 {rows.length} 组，可用上方搜索继续缩小</p>
          )}
        </section>

        <aside className="panel topic-detail facet-detail">
          <span className="eyebrow">SELECTED GROUP</span>
          <h2>{active?.name ?? "暂无分组"}</h2>
          <p>{shelf.hint}</p>
          <div className="topic-detail__metric"><span>命中资料</span><strong>{active?.count.toLocaleString("zh-CN") ?? 0}</strong></div>
          <div className="topic-detail__metric"><span>归档方式</span><strong>目录与文件名规则</strong></div>

          {active?.name === YUNQI_EVENT && shelfId === "events" && (
            <button className="primary-button facet-detail__cta" onClick={() => onNavigate("yunqi")}>
              <Sparkles size={16} /> 阅读云栖重点内容页
            </button>
          )}

          <div className="topic-detail__section">
            <span>相邻分组</span>
            <div>
              {rows.filter((row) => row.name !== active?.name).slice(0, 4).map((row) => (
                <button key={row.name} onClick={() => setSelected(row.name)}>
                  {row.name}<ChevronRight size={13} />
                </button>
              ))}
            </div>
          </div>

          <div className="answer-warning">
            <Lightbulb size={16} /> 同一份资料可同时出现在多个维度；分组名来自路径与文件名线索，正文实体关系待接入。
          </div>
        </aside>
      </div>

      <section className="panel facet-documents">
        <div className="panel__header">
          <div>
            <span className="eyebrow">MATCHED MATERIAL</span>
            <h2><Network size={16} /> {active?.name ?? "分组"} · 命中资料</h2>
          </div>
          <button className="text-button" onClick={() => onNavigate("documents")}>
            在全部资料中查看 <ArrowRight size={14} />
          </button>
        </div>
        <div className="document-list">
          {matched.slice(0, DETAIL_LIMIT).map((document) => <DocumentRow key={document.id} document={document} />)}
          {matched.length === 0 && (
            <div className="empty-state empty-state--small">
              <Search size={24} />
              <h2>该分组下没有资料</h2>
              <p>清除顶部的来源、类型或关键词筛选后再试。</p>
            </div>
          )}
        </div>
        {matched.length > DETAIL_LIMIT && (
          <div className="list-limit">
            为保持浏览流畅，当前展示前 {DETAIL_LIMIT} 份 · 共 {matched.length.toLocaleString("zh-CN")} 份命中
          </div>
        )}
      </section>
    </div>
  );
}
