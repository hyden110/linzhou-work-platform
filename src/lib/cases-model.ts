import { safeCaseUrl, type PublishedCase } from "./cases-client.ts";

/**
 * 已发布案例派生模型（纯函数，无 I/O、无时钟）。
 * 口径搬自 base/sa-workbench assets/models/cases-model.js（搬语义不搬代码）：
 * - 类型按标题 / 目录名首个命中规则推断（POC 优先于「方案」），兜底「其他」；
 * - 统计：渠道分布、跨渠道合并、近 30 天更新、关联客户、缺入口；
 * - 查询：渠道 / 类型 / 客户 / 关键词（多词全命中，大小写不敏感）。
 * 台账只有元数据（无描述 / 行业 / 可见范围字段），缺什么就如实「暂无」，绝不编造。
 */

const TYPE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POC", /\bpoc\b/i],
  ["技术沙龙", /技术交流|沙龙|salon|tech-exchange|keynote/i],
  ["谈参", /谈参|会前|meeting-prep|call\s*-?high/i],
  ["培训", /培训|training|教程|handbook|手册|workshop/i],
  ["汇报", /汇报|复盘|述职|成果|briefing|report|deck/i],
  ["调研", /调研|研究|research|选型/i],
  ["方案", /方案|架构|solution|architecture|规划|蓝图|roadmap|参考/i],
  ["Demo", /demo|原型|prototype|演示|示例/i],
  ["实践分享", /实践|案例|分享|指南|启发|经验|范式/i],
];

const OTHER_TYPE = "其他";
export const CASE_TYPES: readonly string[] = [...TYPE_RULES.map(([type]) => type), OTHER_TYPE];

const SRC_LABELS: Readonly<Record<string, string>> = { oss: "OSS", code: "Code 平台" };
const SRC_ORDER: readonly string[] = ["code", "oss"];
const DAY_MS = 86_400_000;
const RECENT_DAYS = 30;
export const CASE_EMPTY = "暂无";

export function inferCaseType(text: string): string {
  const source = String(text ?? "");
  return TYPE_RULES.find(([, pattern]) => pattern.test(source))?.[0] ?? OTHER_TYPE;
}

export function caseTypeOf(entry: PublishedCase): string {
  return inferCaseType(`${entry.title} ${entry.name}`);
}

export function caseSrcLabel(src: string): string {
  return SRC_LABELS[src] ?? src;
}

export function caseDisplayTitle(entry: PublishedCase): string {
  return entry.title || entry.name;
}

export interface CaseStats {
  readonly total: number;
  readonly code: number;
  readonly oss: number;
  readonly crossChannel: number;
  readonly recent30: number;
  readonly customers: number;
  readonly linkedCases: number;
  readonly noEntry: number;
}

function countWhere(cases: readonly PublishedCase[], predicate: (entry: PublishedCase) => boolean): number {
  return cases.reduce((total, entry) => (predicate(entry) ? total + 1 : total), 0);
}

export function caseStats(cases: readonly PublishedCase[], nowMs: number): CaseStats {
  const since = nowMs - RECENT_DAYS * DAY_MS;
  return {
    total: cases.length,
    code: countWhere(cases, (entry) => entry.srcs.includes("code")),
    oss: countWhere(cases, (entry) => entry.srcs.includes("oss")),
    crossChannel: countWhere(cases, (entry) => new Set(entry.srcs).size > 1),
    recent30: countWhere(cases, (entry) => {
      const at = Date.parse(entry.updatedAt);
      return Number.isFinite(at) && at >= since;
    }),
    customers: new Set(cases.map((entry) => entry.cust).filter(Boolean)).size,
    linkedCases: countWhere(cases, (entry) => Boolean(entry.cust)),
    noEntry: countWhere(cases, (entry) => !safeCaseUrl(entry.entryUrl)),
  };
}

export interface FacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface CaseFacets {
  readonly srcs: readonly FacetOption[];
  readonly types: readonly FacetOption[];
  readonly custs: readonly FacetOption[];
}

function tally(values: readonly string[]): ReadonlyMap<string, number> {
  return values.reduce<ReadonlyMap<string, number>>(
    (acc, value) => new Map(acc).set(value, (acc.get(value) ?? 0) + 1),
    new Map(),
  );
}

export function caseFacets(cases: readonly PublishedCase[]): CaseFacets {
  const srcCounts = tally(cases.flatMap((entry) => Array.from(new Set(entry.srcs))));
  const typeCounts = tally(cases.map(caseTypeOf));
  const custCounts = tally(cases.map((entry) => entry.cust).filter(Boolean));
  const knownSrcs = [...SRC_ORDER, ...Array.from(srcCounts.keys()).filter((src) => !SRC_ORDER.includes(src))];
  return {
    srcs: knownSrcs
      .filter((src) => srcCounts.has(src))
      .map((src) => ({ value: src, label: caseSrcLabel(src), count: srcCounts.get(src) ?? 0 })),
    types: CASE_TYPES
      .filter((type) => typeCounts.has(type))
      .map((type) => ({ value: type, label: type, count: typeCounts.get(type) ?? 0 })),
    custs: Array.from(custCounts.entries())
      .map(([cust, count]) => ({ value: cust, label: cust, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-CN")),
  };
}

export type CaseSort = "snapshot" | "title";

export interface CaseQuery {
  readonly q: string;
  readonly src: string;
  readonly type: string;
  readonly cust: string;
  readonly sort: CaseSort;
}

function haystack(entry: PublishedCase): string {
  return [entry.title, entry.name, entry.cust, caseTypeOf(entry)].join(" ").toLowerCase();
}

function matchesKeyword(entry: PublishedCase, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = haystack(entry);
  return words.every((word) => hay.includes(word));
}

/** 默认保留快照顺序（桥侧已按最近发布倒序）；title 按标题中文排序（与供体口径一致，无标题的空串稳定排最前）。返回新数组。 */
export function queryCases(cases: readonly PublishedCase[], query: CaseQuery): PublishedCase[] {
  const matched = cases.filter((entry) =>
    (!query.src || entry.srcs.includes(query.src))
    && (!query.type || caseTypeOf(entry) === query.type)
    && (!query.cust || entry.cust === query.cust)
    && matchesKeyword(entry, query.q));
  if (query.sort === "title") {
    return [...matched].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }
  return [...matched];
}

export interface CasePreviewFact {
  readonly label: string;
  readonly value: string;
}

export interface CasePreview {
  readonly title: string;
  readonly entryUrl: string;
  readonly facts: readonly CasePreviewFact[];
}

function dayText(iso: string): string {
  if (!iso) return CASE_EMPTY;
  return Number.isFinite(Date.parse(iso)) ? iso.slice(0, 10) : iso;
}

/** 只读预览摘要：只用台账已有字段；入口链接再过一次 http(s) 护栏。 */
export function casePreview(entry: PublishedCase): CasePreview {
  const srcs = Array.from(new Set(entry.srcs)).map(caseSrcLabel).join(" / ");
  return {
    title: caseDisplayTitle(entry),
    entryUrl: safeCaseUrl(entry.entryUrl),
    facts: [
      { label: "类型", value: `${caseTypeOf(entry)}（按标题推断）` },
      { label: "关联客户", value: entry.cust || CASE_EMPTY },
      { label: "发布渠道", value: srcs || CASE_EMPTY },
      { label: "页面数", value: String(entry.pageCount) },
      { label: "最近发布", value: dayText(entry.updatedAt) },
      { label: "目录 / 仓库名", value: entry.name || CASE_EMPTY },
    ],
  };
}
