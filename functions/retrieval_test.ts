import assert from "node:assert/strict";
import test from "node:test";

import { retrieve, validateRetrievalRequest, type RetrievalBundle, type RetrievalDocument } from "./retrieval.ts";

const DIMENSIONS = 4;

function int8(values: number[]): string {
  return Buffer.from(Int8Array.from(values).buffer).toString("base64");
}

const bundle: RetrievalBundle = {
  schemaVersion: 2,
  mode: "safe-retrieval-bundle",
  generatedAt: "2026-10-08T00:00:00Z",
  documentCount: 3,
  skippedCount: 0,
  documents: [
    {
      id: "retail-agent",
      source: "cases",
      sourceLabel: "案例库",
      type: "PDF",
      title: "零售门店 Agent 案例",
      modifiedAt: "2026-10-08T00:00:00Z",
      topics: ["零售与消费", "AI 与智能体"],
      location: "本地文件 · 相对路径",
      relativePath: "零售/agent.pdf",
      summary: "门店经营智能体连接库存与导购流程。",
      citations: [{ id: "c1", locator: { kind: "page", value: "3" }, text: "先从库存查询场景试点。" }],
    },
    {
      id: "manufacturing-agent",
      source: "cases",
      sourceLabel: "案例库",
      type: "PPTX",
      title: "制造质检智能体",
      modifiedAt: "2026-10-07T00:00:00Z",
      topics: ["制造与工业", "AI 与智能体"],
      location: "本地文件 · 相对路径",
      relativePath: "制造/质检.pptx",
      summary: "视觉质检智能体识别产线缺陷。",
      citations: [{ id: "c1", locator: { kind: "slide", value: "8" }, text: "产线缺陷识别需要现场数据。" }],
    },
    {
      id: "data-platform",
      source: "scenarios",
      sourceLabel: "场景库",
      type: "MD",
      title: "湖仓数据平台",
      modifiedAt: "2026-10-06T00:00:00Z",
      topics: ["数据智能"],
      location: "本地文件 · 相对路径",
      relativePath: "数据/湖仓.md",
      summary: "统一批流数据治理。",
      citations: [],
    },
  ],
};

test("hybrid retrieval ranks keyword and vector evidence deterministically", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "search", requestId: "request-1" },
    bundle,
  );

  assert.equal(response.status, "results-only");
  assert.equal(response.results[0]?.documentId, "retail-agent");
  assert.equal(response.citations[0]?.documentId, "retail-agent");
  assert.equal(response.citations[0]?.locator.value, "3");
});

test("filters are applied before ranking", async () => {
  const response = await retrieve(
    {
      query: "智能体",
      mode: "search",
      requestId: "request-2",
      filters: { topics: ["制造与工业"], types: ["PPTX"] },
    },
    bundle,
  );

  assert.deepEqual(response.results.map((item) => item.documentId), ["manufacturing-agent"]);
});

test("AI modes return an evidence-bound answer when a generator is available", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "qa", requestId: "request-ai" },
    bundle,
    {
      generateAnswer: async ({ evidence }) => ({
        answer: "建议先从库存查询场景试点。[retail-agent:c1]",
        citationIds: [evidence[0].citations[0].referenceId],
      }),
    },
  );

  assert.equal(response.status, "answered");
  assert.match(response.answer ?? "", /库存查询/);
  assert.deepEqual(response.citations.map((item) => item.referenceId), ["retail-agent:c1"]);
});

test("AI modes degrade explicitly without inventing an answer", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "qa", requestId: "request-3" },
    bundle,
  );

  assert.equal(response.status, "keyword-fallback");
  assert.equal(response.answer, undefined);
  assert.ok(response.results.length > 0);
});

test("AI failures preserve evidence and degrade safely", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "assistant", requestId: "request-failed-ai" },
    bundle,
    { generateAnswer: async () => { throw new Error("secret upstream error"); } },
  );

  assert.equal(response.status, "keyword-fallback");
  assert.equal(response.answer, undefined);
  assert.ok(response.results.length > 0);
  assert.match(response.diagnosticId ?? "", /^ai-/);
});

const semanticBundle: RetrievalBundle = {
  ...bundle,
  embedding: { provider: "bailian", model: "text-embedding-v4", dimensions: DIMENSIONS, encoding: "int8-base64" },
  documents: bundle.documents.map((document, index) => ({
    ...document,
    vector: int8([0, 0, 0, 0].map((_, axis) => (axis === index ? 127 : 0))),
    citations: document.citations.map((citation) => ({
      ...citation,
      vector: int8([0, 0, 0, 0].map((_, axis) => (axis === index ? 127 : 0))),
    })),
  })),
};

test("semantic retrieval finds paraphrased evidence without lexical overlap", async () => {
  const response = await retrieve(
    { query: "货架补货怎么做", mode: "search", requestId: "request-semantic" },
    semanticBundle,
    { embedQuery: async () => Float32Array.from([0.9, 0.1, 0, 0]) },
  );

  assert.equal(response.vectorSearch, "semantic");
  assert.equal(response.status, "results-only");
  assert.equal(response.results[0]?.documentId, "retail-agent");
  assert.equal(response.citations[0]?.referenceId, "retail-agent:c1");
});

test("embedding failures fall back to keyword-only retrieval", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "search", requestId: "request-embed-failed" },
    semanticBundle,
    { embedQuery: async () => { throw new Error("upstream unavailable"); } },
  );

  assert.equal(response.vectorSearch, "keyword-only");
  assert.equal(response.results[0]?.documentId, "retail-agent");
});

test("semantic retrieval refuses queries far from every passage", async () => {
  const response = await retrieve(
    { query: "红烧肉怎么做", mode: "qa", requestId: "request-semantic-oos" },
    semanticBundle,
    { embedQuery: async () => Float32Array.from([0, 0, 0, 1]) },
  );

  assert.equal(response.status, "insufficient-evidence");
});

function agentDocument(index: number): RetrievalDocument {
  return {
    id: `agent-${index}`,
    source: "cases",
    sourceLabel: "案例库",
    type: "MD",
    title: `智能体方案 ${index}`,
    modifiedAt: `2026-10-0${index}T00:00:00Z`,
    topics: ["AI 与智能体"],
    location: "本地文件 · 相对路径",
    relativePath: `agent-${index}.md`,
    summary: "智能体方案摘要。",
    citations: [{ id: "c1", locator: { kind: "section", value: "1" }, text: `智能体方案第 ${index} 号要点。` }],
  };
}

test("every evidence document beyond the top three remains citable", async () => {
  const wideBundle: RetrievalBundle = { ...bundle, documents: [1, 2, 3, 4, 5].map(agentDocument) };
  const response = await retrieve(
    { query: "智能体方案", mode: "qa", requestId: "request-wide" },
    wideBundle,
    {
      generateAnswer: async ({ evidence }) => {
        const fourth = evidence[3].citations[0].referenceId;
        return { answer: `第四份方案给出要点。[${fourth}]`, citationIds: [fourth] };
      },
    },
  );

  assert.equal(response.status, "answered");
  assert.equal(response.citations.length, 1);
  assert.notEqual(response.citations[0].documentId, response.results[0].documentId);
});

test("answers citing unavailable references degrade instead of being shown", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "qa", requestId: "request-bad-cite" },
    bundle,
    { generateAnswer: async () => ({ answer: "编造结论。[other:c9]", citationIds: ["other:c9"] }) },
  );

  assert.equal(response.status, "keyword-fallback");
  assert.equal(response.answer, undefined);
});

test("semantic mode does not accept keyword coverage without semantic support", async () => {
  const response = await retrieve(
    { query: "零售门店智能体", mode: "qa", requestId: "request-coverage-only" },
    semanticBundle,
    { embedQuery: async () => Float32Array.from([0, 0, 0, 1]) },
  );

  assert.equal(response.vectorSearch, "semantic");
  assert.equal(response.status, "insufficient-evidence");
});

test("copies of the same document occupy one result slot", async () => {
  const original = agentDocument(1);
  const copyBundle: RetrievalBundle = {
    ...bundle,
    documents: [original, { ...original, id: "agent-1-copy", title: `${original.title}_副本` }, agentDocument(2)],
  };
  const response = await retrieve({ query: "智能体方案", mode: "search", requestId: "request-copy" }, copyBundle);

  const titles = response.results.map((item) => item.title);
  assert.equal(titles.filter((title) => title.startsWith("智能体方案 1")).length, 1);
  assert.equal(new Set(response.citations.map((item) => item.documentId)).size, response.citations.length);
});

test("snippets drop markdown table syntax and emphasis", async () => {
  const markdownBundle: RetrievalBundle = {
    ...bundle,
    documents: [{
      ...agentDocument(1),
      citations: [{
        id: "c1",
        locator: { kind: "section", value: "1" },
        text: "## 智能体方案页面 | # | 页面 | 布局 | |---|---|---| | 1 | **封面** | 居中 |",
      }],
    }],
  };
  const response = await retrieve({ query: "智能体方案页面", mode: "search", requestId: "request-md" }, markdownBundle);

  const text = response.citations[0]?.text ?? "";
  assert.doesNotMatch(text, /\||---|\*\*|##/);
  assert.match(text, /页面 · 布局/);
  assert.match(text, /封面 · 居中/);
});

test("returns insufficient evidence for unrelated queries", async () => {
  const response = await retrieve(
    { query: "量子卫星密码", mode: "qa", requestId: "request-4" },
    bundle,
  );

  assert.equal(response.status, "insufficient-evidence");
  assert.deepEqual(response.results, []);
  assert.deepEqual(response.citations, []);
});

test("validates the public request boundary", () => {
  assert.throws(() => validateRetrievalRequest({ query: "", mode: "qa", requestId: "r" }));
  assert.throws(() => validateRetrievalRequest({ query: "ok", mode: "unknown", requestId: "r" }));
  assert.throws(() => validateRetrievalRequest({ query: "ok", mode: "qa", requestId: "bad request" }));
  assert.deepEqual(
    validateRetrievalRequest({ query: "  零售 Agent  ", mode: "assistant", requestId: "req-5" }),
    { query: "零售 Agent", mode: "assistant", requestId: "req-5", filters: undefined, context: undefined },
  );
});

test("renamed deck versions sharing cover and matched passage cite only once", async () => {
  const cover = "从单点工具到任务闭环 海信AI原生开发实践 云栖大会主论坛分享材料";
  const deck = (id: string, title: string): RetrievalDocument => ({
    ...agentDocument(1),
    id,
    title,
    citations: [{ id: "c1", locator: { kind: "slide", value: "1" }, text: cover }],
  });
  const variantBundle: RetrievalBundle = {
    ...bundle,
    documents: [deck("deck-a", "云栖大会-Qoder_助力海信研发全链路提效"), deck("deck-b", "云栖大会-从单点工具到任务闭环-海信AI原生开发实践"), agentDocument(2)],
  };
  const response = await retrieve({ query: "海信AI原生开发实践", mode: "qa", requestId: "request-variants" }, variantBundle);

  assert.equal(response.results.length, 2);
  assert.deepEqual(new Set(response.citations.map((item) => item.documentId)).size, 1);
});
