import { ArrowRight, CalendarDays, Layers3, Network, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NO_EVENT, UNCLASSIFIED_CUSTOMER, UNCLASSIFIED_TRACK } from "../data/facets";
import type { CountRow, KnowledgeIndex, ShelfId } from "../types";
import type { ViewProps } from "./shared";

interface ShelfCard {
  id: ShelfId;
  label: string;
  icon: LucideIcon;
  rows: CountRow[];
  fallback: string;
  unit: string;
}

function buildCards(index: KnowledgeIndex): ShelfCard[] {
  return [
    { id: "solutions", label: "解决方案", icon: Layers3, rows: index.stats.bySolutionTrack, fallback: UNCLASSIFIED_TRACK, unit: "条方案线" },
    { id: "customers", label: "客户案例", icon: Users, rows: index.stats.byCustomer, fallback: UNCLASSIFIED_CUSTOMER, unit: "个客户" },
    { id: "events", label: "云栖与活动", icon: CalendarDays, rows: index.stats.byEvent, fallback: NO_EVENT, unit: "场活动" },
    { id: "topics", label: "主题聚类", icon: Network, rows: index.stats.byTopic, fallback: "待整理", unit: "个主题" },
  ];
}

export function ShelfGrid({ index, onNavigate }: { index: KnowledgeIndex; onNavigate: ViewProps["onNavigate"] }) {
  return (
    <section className="shelf-grid" aria-label="知识分类">
      {buildCards(index).map((card) => {
        const groups = card.rows.filter((row) => row.name !== card.fallback);
        const unfiled = card.rows.find((row) => row.name === card.fallback)?.count ?? 0;
        const Icon = card.icon;
        return (
          <article className="panel shelf-card" key={card.id}>
            <button className="shelf-card__head" onClick={() => onNavigate("map", card.id)}>
              <Icon size={17} />
              <div>
                <span>{card.label}</span>
                <strong>{groups.length} <small>{card.unit}</small></strong>
              </div>
              <ArrowRight size={15} />
            </button>
            <div className="shelf-card__chips">
              {groups.slice(0, 4).map((row) => (
                <button key={row.name} onClick={() => onNavigate("map", card.id, row.name)} title={`${row.name} · ${row.count} 份`}>
                  <i>{row.name}</i><b>{row.count}</b>
                </button>
              ))}
            </div>
            <footer>{unfiled > 0 ? `另有 ${unfiled.toLocaleString("zh-CN")} 份${card.fallback}` : "全部资料均已归入分组"}</footer>
          </article>
        );
      })}
    </section>
  );
}
