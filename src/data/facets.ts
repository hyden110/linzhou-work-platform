import type { CountRow, KnowledgeDocument, ShelfId } from "../types";

export const UNCLASSIFIED_TRACK = "未归类方案";
export const UNCLASSIFIED_CUSTOMER = "未标注客户";
export const NO_EVENT = "非活动材料";
export const YUNQI_EVENT = "云栖大会";

export const ALL_TRACKS = "全部方案";
export const ALL_CUSTOMERS = "全部客户";
export const ALL_SOURCES = "全部来源";
export const ALL_TYPES = "全部类型";

export interface DocumentFilter {
  query: string;
  source: string;
  fileType: string;
  track: string;
  customer: string;
}

/** The dimension whose own chips are being counted, so it cannot filter itself. */
export type FacetSkip = "track" | "customer";

export type FacetKey = "solutionTracks" | "customers" | "events" | "topics";

interface Shelf {
  id: ShelfId;
  label: string;
  key: FacetKey;
  fallback: string;
  hint: string;
  searchPlaceholder: string;
}

export const SHELVES: Shelf[] = [
  {
    id: "solutions",
    label: "解决方案",
    key: "solutionTracks",
    fallback: UNCLASSIFIED_TRACK,
    hint: "按产品线与方案方向归类，一份资料可同时属于多条方案线。",
    searchPlaceholder: "搜索方案线，如 Qoder、千问办公、大数据…",
  },
  {
    id: "customers",
    label: "客户案例",
    key: "customers",
    fallback: UNCLASSIFIED_CUSTOMER,
    hint: "按客户归类；未标注客户的通用材料与测试样例单独成组。",
    searchPlaceholder: "搜索客户，如 海信、海尔、高德…",
  },
  {
    id: "events",
    label: "云栖与活动",
    key: "events",
    fallback: NO_EVENT,
    hint: "按大会与活动归类，云栖大会材料可直接进入专题页阅读重点内容。",
    searchPlaceholder: "搜索活动，如 云栖大会、先锋营…",
  },
  {
    id: "topics",
    label: "主题聚类",
    key: "topics",
    fallback: "待整理",
    hint: "沿用目录与文件名规则聚类的主题视角，用于横向观察覆盖面。",
    searchPlaceholder: "搜索主题，如 开发效能、安全与治理…",
  },
];

export const FACET_FALLBACKS: Record<ShelfId, string> = {
  solutions: UNCLASSIFIED_TRACK,
  customers: UNCLASSIFIED_CUSTOMER,
  events: NO_EVENT,
  topics: "待整理",
};

export function shelfById(id: ShelfId): Shelf {
  return SHELVES.find((shelf) => shelf.id === id) ?? SHELVES[0];
}

/** Mirrors the indexer: an absent facet falls back to an explicit bucket label. */
export function facetValues(document: KnowledgeDocument, key: FacetKey, fallback: string): string[] {
  const values = document[key].filter((value) => value.trim().length > 0);
  return values.length > 0 ? values : [fallback];
}

export function facetCounts(documents: KnowledgeDocument[], key: FacetKey, fallback: string): CountRow[] {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const value of facetValues(document, key, fallback)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

export function matchesFacet(document: KnowledgeDocument, key: FacetKey, name: string, fallback: string): boolean {
  return facetValues(document, key, fallback).includes(name);
}

function matchesQuery(document: KnowledgeDocument, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [
    document.title,
    document.relativePath,
    document.topics.join(" "),
    document.solutionTracks.join(" "),
    document.customers.join(" "),
    document.events.join(" "),
  ].join(" ").toLocaleLowerCase("zh-CN").includes(normalizedQuery);
}

export function matchesTrack(document: KnowledgeDocument, track: string): boolean {
  return track === ALL_TRACKS
    || (track === UNCLASSIFIED_TRACK
      ? document.solutionTracks.length === 0
      : document.solutionTracks.includes(track));
}

export function matchesCustomer(document: KnowledgeDocument, customer: string): boolean {
  return customer === ALL_CUSTOMERS
    || (customer === UNCLASSIFIED_CUSTOMER
      ? document.customers.length === 0
      : document.customers.includes(customer));
}

export function selectDocuments(
  documents: KnowledgeDocument[],
  filter: DocumentFilter,
  skip?: FacetSkip,
): KnowledgeDocument[] {
  const normalizedQuery = filter.query.trim().toLocaleLowerCase("zh-CN");
  return documents.filter((document) => {
    if (filter.source !== ALL_SOURCES && document.sourceLabel !== filter.source) return false;
    if (filter.fileType !== ALL_TYPES && document.type !== filter.fileType) return false;
    if (skip !== "track" && !matchesTrack(document, filter.track)) return false;
    if (skip !== "customer" && !matchesCustomer(document, filter.customer)) return false;
    return matchesQuery(document, normalizedQuery);
  });
}

/** Keeps a chosen group visible after other filters narrow it to zero hits. */
export function withSelectedFacet(rows: CountRow[], selected: string, allLabel: string): CountRow[] {
  if (selected === allLabel || rows.some((row) => row.name === selected)) return rows;
  return [...rows, { name: selected, count: 0 }];
}
