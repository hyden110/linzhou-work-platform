import assert from "node:assert/strict";
import test from "node:test";

import type { PublishedCase } from "./cases-client.ts";
import {
  CASE_TYPES,
  caseFacets,
  casePreview,
  caseStats,
  caseTypeOf,
  inferCaseType,
  queryCases,
} from "./cases-model.ts";

// 合成数据：甲科技 / 乙股份，绝无真实客户、仓库、桶名与资源 ID。

const NOW = Date.parse("2026-10-20T00:00:00.000Z");

function entry(patch: Partial<PublishedCase> & Pick<PublishedCase, "id" | "name">): PublishedCase {
  return { title: "", cust: "", updatedAt: "", entryUrl: "", srcs: [], pageCount: 1, ...patch };
}

const CASES: readonly PublishedCase[] = Object.freeze([
  entry({ id: "c1", name: "jia-store-ai", title: "甲科技 门店 AI 方案", cust: "甲科技", updatedAt: "2026-10-12T10:00:00+08:00", entryUrl: "https://deck.example.com/jia/index.html", srcs: ["oss", "code"], pageCount: 3 }),
  entry({ id: "c2", name: "yi-poc", title: "乙股份 供应链 POC 方案", cust: "乙股份", updatedAt: "2026-08-01T10:00:00+08:00", entryUrl: "https://deck.example.com/yi/index.html", srcs: ["oss"] }),
  entry({ id: "c3", name: "jia-training", title: "", cust: "甲科技", updatedAt: "2026-10-01T00:00:00Z", srcs: ["code"] }),
  entry({ id: "c4", name: "misc-notes", title: "季度杂记", cust: "", updatedAt: "not-a-date", entryUrl: "https://deck.example.com/misc/", srcs: ["code"] }),
]);

test("inferCaseType ports the donor's first-match rules (POC before 方案) and falls back to 其他", () => {
  assert.equal(inferCaseType("乙股份 供应链 POC 方案"), "POC");
  assert.equal(inferCaseType("甲科技 门店 AI 方案"), "方案");
  assert.equal(inferCaseType("jia-training"), "培训");
  assert.equal(inferCaseType("季度杂记"), "其他");
  assert.equal(inferCaseType(""), "其他");
  assert.equal(CASE_TYPES[CASE_TYPES.length - 1], "其他");
  assert.equal(caseTypeOf(CASES[2]!), "培训", "标题为空时按目录名推断");
});

test("caseStats counts channels, cross-channel merges, 30-day updates, customers and missing entries", () => {
  const stats = caseStats(CASES, NOW);
  assert.equal(stats.total, 4);
  assert.equal(stats.code, 3);
  assert.equal(stats.oss, 2);
  assert.equal(stats.crossChannel, 1);
  assert.equal(stats.recent30, 2, "c1 / c3 在 30 天内；坏时间不计");
  assert.equal(stats.customers, 2, "去重客户别名");
  assert.equal(stats.linkedCases, 3);
  assert.equal(stats.noEntry, 1);
  const empty = caseStats([], NOW);
  assert.deepEqual(empty, { total: 0, code: 0, oss: 0, crossChannel: 0, recent30: 0, customers: 0, linkedCases: 0, noEntry: 0 });
});

test("caseFacets lists only present values with counts, types in canonical order", () => {
  const facets = caseFacets(CASES);
  assert.deepEqual(facets.srcs.map((item) => [item.value, item.label, item.count]), [["code", "Code 平台", 3], ["oss", "OSS", 2]]);
  assert.deepEqual(facets.types.map((item) => [item.value, item.count]), [["POC", 1], ["培训", 1], ["方案", 1], ["其他", 1]]);
  assert.deepEqual(facets.custs.map((item) => [item.value, item.count]), [["甲科技", 2], ["乙股份", 1]]);
  assert.deepEqual(caseFacets([]), { srcs: [], types: [], custs: [] });
});

test("queryCases filters by channel / type / customer / keyword and sorts without mutating", () => {
  const before = CASES.map((item) => item.id);
  const base = { q: "", src: "", type: "", cust: "", sort: "snapshot" } as const;
  assert.deepEqual(queryCases(CASES, base).map((item) => item.id), before);
  assert.deepEqual(queryCases(CASES, { ...base, src: "oss" }).map((item) => item.id), ["c1", "c2"]);
  assert.deepEqual(queryCases(CASES, { ...base, type: "POC" }).map((item) => item.id), ["c2"]);
  assert.deepEqual(queryCases(CASES, { ...base, cust: "甲科技", src: "code" }).map((item) => item.id), ["c1", "c3"]);
  assert.deepEqual(queryCases(CASES, { ...base, q: "门店 方案" }).map((item) => item.id), ["c1"]);
  assert.deepEqual(queryCases(CASES, { ...base, q: "TRAINING" }).map((item) => item.id), ["c3"], "大小写不敏感，命中目录名");
  assert.deepEqual(queryCases(CASES, { ...base, q: "培训" }).map((item) => item.id), ["c3"], "命中推断类型");
  assert.equal(queryCases(CASES, { ...base, sort: "title" })[0]!.id, "c3", "无标题按目录名参与排序");
  assert.deepEqual(CASES.map((item) => item.id), before);
});

test("casePreview builds a read-only summary with safe entry link and honest placeholders", () => {
  const preview = casePreview(CASES[0]!);
  assert.equal(preview.title, "甲科技 门店 AI 方案");
  assert.equal(preview.entryUrl, "https://deck.example.com/jia/index.html");
  const fact = (label: string) => preview.facts.find((item) => item.label === label)?.value;
  assert.equal(fact("发布渠道"), "OSS / Code 平台");
  assert.equal(fact("页面数"), "3");
  assert.equal(fact("关联客户"), "甲科技");
  assert.equal(fact("类型"), "方案（按标题推断）");
  assert.equal(fact("目录 / 仓库名"), "jia-store-ai");

  const bare = casePreview(entry({ id: "z", name: "yi-demo", entryUrl: "javascript:alert(1)" }));
  assert.equal(bare.title, "yi-demo");
  assert.equal(bare.entryUrl, "", "非 http(s) 入口不放行");
  assert.equal(bare.facts.find((item) => item.label === "关联客户")?.value, "暂无");
  assert.equal(bare.facts.find((item) => item.label === "最近发布")?.value, "暂无");
  assert.equal(bare.facts.find((item) => item.label === "发布渠道")?.value, "暂无");
});
