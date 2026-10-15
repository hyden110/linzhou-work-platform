import assert from "node:assert/strict";
import test from "node:test";

import { queryTerms, rankPassages, type RankableDocument } from "./ranking.ts";

function weightOf(query: string, token: string): number | undefined {
  return queryTerms(query).find((term) => term.token === token)?.weight;
}

test("query terms drop request words and bigrams spanning particles", () => {
  const tokens = queryTerms("云栖大会的starops材料").map((term) => term.token);

  assert.deepEqual(tokens.sort(), ["starops", "云栖", "大会", "栖大"].sort());
  assert.equal(queryTerms("今天上海的天气怎么样").some((term) => term.token === "么样" || term.token === "样"), false);
});

test("a multi-character word weighs about one unit, like a single product name", () => {
  assert.equal(weightOf("starops", "starops"), 1);
  assert.equal(weightOf("云栖大会", "云栖"), 0.5);
  assert.equal(weightOf("监控", "监控"), 1);
  assert.equal(queryTerms("云").length, 1, "a standalone single character is still searchable");
});

function document(title: string, text: string): RankableDocument {
  return { title, topics: [], relativePath: `${title}.md`, summary: "", citations: [{ id: "c1", text }] };
}

test("a rare product name outranks documents that only match the generic event name", () => {
  const generic = Array.from({ length: 6 }, (_, index) => document(`云栖大会议程 ${index}`, "云栖大会 主论坛 议程 安排"));
  const corpus = [...generic, document("全域智能运维平台 STAROps 产品介绍", "STAROps 智能运维 告警诊断 根因定位")];

  const ranked = rankPassages(corpus, corpus.map(() => true), "云栖大会的starops材料", undefined, 0);

  assert.equal(ranked[0]?.documentIndex, corpus.length - 1);
  assert.ok(ranked[0]!.coverage > 0.5, `coverage ${ranked[0]!.coverage}`);
});
