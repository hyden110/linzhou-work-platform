import assert from "node:assert/strict";
import test from "node:test";

import { createBailianAnswerGenerator, createBailianQueryEmbedder } from "./bailian.ts";
import type { AnswerGenerationRequest } from "./retrieval.ts";

const API_KEY = "sk-test.0123456789abcdef";

function jsonFetch(payload: unknown, calls: Array<{ url: string; body: Record<string, unknown> }>, status = 200) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(payload, { status });
  }) as typeof fetch;
}

const answerRequest: AnswerGenerationRequest = {
  query: "门店智能体如何试点",
  mode: "qa",
  requestId: "req-1",
  evidence: [{
    documentId: "doc-1",
    sourceLabel: "案例库",
    title: "零售 Agent 方案",
    summary: "门店经营智能体方案摘要",
    citations: [{ id: "c1", referenceId: "doc-1:c1", locator: { kind: "page", value: "2" }, text: "先从库存查询试点" }],
  }],
};

test("query embedder requests the bundle model and dimensions", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const embed = createBailianQueryEmbedder({
    apiKey: API_KEY,
    model: "text-embedding-v4",
    dimensions: 64,
    fetchImpl: jsonFetch({ data: [{ embedding: Array.from({ length: 64 }, () => 0.1) }] }, calls),
  });
  const vector = await embed("门店智能体");

  assert.equal(vector.length, 64);
  assert.match(calls[0].url, /\/embeddings$/);
  assert.deepEqual(calls[0].body.input, ["门店智能体"]);
  assert.equal(calls[0].body.dimensions, 64);
});

test("query embedder rejects responses with the wrong dimensions", async () => {
  const embed = createBailianQueryEmbedder({
    apiKey: API_KEY,
    model: "text-embedding-v4",
    dimensions: 64,
    fetchImpl: jsonFetch({ data: [{ embedding: [0.1, 0.2] }] }, []),
  });

  await assert.rejects(embed("门店"), /invalid/);
});

test("answer generator sends only controlled evidence and keeps valid citations", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const generate = createBailianAnswerGenerator({
    apiKey: API_KEY,
    model: "qwen-plus",
    fetchImpl: jsonFetch({ choices: [{ message: { content: "先从库存查询试点。[doc-1:c1][doc-9:c1]" } }] }, calls),
  });
  const generated = await generate(answerRequest);
  const serialized = JSON.stringify(calls[0].body);

  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.deepEqual(generated.citationIds, ["doc-1:c1"]);
  assert.match(serialized, /先从库存查询试点/);
  assert.doesNotMatch(serialized, new RegExp(API_KEY));
});

test("answer generator normalizes merged and prefixed citation marks", async () => {
  const request: AnswerGenerationRequest = {
    ...answerRequest,
    evidence: [{
      ...answerRequest.evidence[0],
      citations: [
        ...answerRequest.evidence[0].citations,
        { id: "c2", referenceId: "doc-1:c2", locator: { kind: "page", value: "3" }, text: "再扩展到导购" },
      ],
    }],
  };
  const generate = createBailianAnswerGenerator({
    apiKey: API_KEY,
    model: "qwen-plus",
    fetchImpl: jsonFetch({ choices: [{ message: { content: "先试点 [doc-1:c1, doc-1:c2]，再扩展【documentId:doc-1:c2】。保留 [备注]" } }] }, []),
  });
  const generated = await generate(request);

  assert.equal(generated.answer, "先试点 [doc-1:c1][doc-1:c2]，再扩展[doc-1:c2]。保留 [备注]");
  assert.deepEqual(generated.citationIds, ["doc-1:c1", "doc-1:c2"]);
});

test("answer generator rejects uncited output and upstream errors without leaking the key", async () => {
  const uncited = createBailianAnswerGenerator({
    apiKey: API_KEY,
    model: "qwen-plus",
    fetchImpl: jsonFetch({ choices: [{ message: { content: "没有引用的回答" } }] }, []),
  });
  await assert.rejects(uncited(answerRequest), /no valid citation/);

  const failing = createBailianAnswerGenerator({
    apiKey: API_KEY,
    model: "qwen-plus",
    fetchImpl: jsonFetch({ error: "denied" }, [], 401),
  });
  await assert.rejects(failing(answerRequest), (error: Error) => (
    /HTTP 401/.test(error.message) && !error.message.includes(API_KEY)
  ));
});

test("rejects malformed API keys before any request", () => {
  assert.throws(() => createBailianAnswerGenerator({ apiKey: "not-a-key", model: "qwen-plus" }));
  assert.throws(() => createBailianQueryEmbedder({ apiKey: "sk-short", model: "m", dimensions: 64 }));
});
