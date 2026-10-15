import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "./handler.ts";
import type { RetrievalBundle } from "./retrieval.ts";

const bundle: RetrievalBundle = {
  schemaVersion: 1,
  mode: "safe-retrieval-bundle",
  generatedAt: "2026-10-08T10:00:00Z",
  documentCount: 1,
  skippedCount: 0,
  documents: [
    {
      id: "doc-1",
      source: "cases",
      sourceLabel: "案例库",
      type: "PDF",
      title: "零售 Agent 方案",
      modifiedAt: "2026-10-08T09:00:00Z",
      topics: ["零售与消费", "AI 与智能体"],
      location: "本地文件 · 相对路径",
      relativePath: "零售/agent.pdf",
      summary: "门店经营智能体方案摘要",
      citations: [{ id: "c1", locator: { kind: "page", value: "2" }, text: "门店试点范围" }],
    },
  ],
};

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("http://127.0.0.1/functions/v1/app", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = { query: "零售 Agent", mode: "search", requestId: "request-1" };

test("serves bounded retrieval responses with defensive headers", async () => {
  const handler = createHandler({ loadBundle: async () => bundle });
  const response = await handler(request(validBody));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(payload.ok, true);
  assert.equal(payload.data.results[0].documentId, "doc-1");
});

test("passes the bundle's embedding model to the configured query embedder", async () => {
  const requested: string[] = [];
  const handler = createHandler({
    loadBundle: async () => ({
      ...bundle,
      embedding: { provider: "bailian", model: "text-embedding-v4", dimensions: 4, encoding: "int8-base64" },
    }),
    queryEmbedderFor: (embedding) => {
      requested.push(`${embedding.model}:${embedding.dimensions}`);
      return async () => { throw new Error("offline"); };
    },
  });
  const payload = await (await handler(request(validBody))).json();

  assert.deepEqual(requested, ["text-embedding-v4:4"]);
  assert.equal(payload.data.vectorSearch, "keyword-only");
  assert.equal(payload.data.results[0].documentId, "doc-1");
});

test("rejects unsupported methods, media types, and oversized bodies", async () => {
  const handler = createHandler({ loadBundle: async () => bundle, maxBodyBytes: 100 });

  const method = await handler(new Request("http://127.0.0.1/functions/v1/app"));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");

  const media = await handler(new Request("http://127.0.0.1/functions/v1/app", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  }));
  assert.equal(media.status, 415);

  const oversized = await handler(request(validBody, { "content-length": "101" }));
  assert.equal(oversized.status, 413);
});

test("rejects browser requests from untrusted origins", async () => {
  const handler = createHandler({
    loadBundle: async () => bundle,
    allowedOrigins: ["http://127.0.0.1:4173"],
  });

  const trusted = await handler(request(validBody, { origin: "http://127.0.0.1:4173" }));
  assert.equal(trusted.status, 200);

  const untrusted = await handler(request(
    { ...validBody, requestId: "request-cross-origin" },
    { origin: "https://untrusted.example" },
  ));
  assert.equal(untrusted.status, 403);
  assert.deepEqual(await untrusted.json(), { ok: false, error: "origin_not_allowed" });
});

test("returns safe errors for malformed and invalid requests", async () => {
  const handler = createHandler({ loadBundle: async () => bundle });
  const malformed = await handler(new Request("http://127.0.0.1/functions/v1/app", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, error: "invalid_json" });

  const invalid = await handler(request({ query: "x", mode: "search", requestId: "request-2" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, error: "invalid_request" });
});

test("rate limits repeated requests without leaking internals", async () => {
  const handler = createHandler({
    loadBundle: async () => bundle,
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  const headers = { "x-forwarded-for": "127.0.0.8" };

  assert.equal((await handler(request(validBody, headers))).status, 200);
  const limited = await handler(request({ ...validBody, requestId: "request-3" }, headers));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { ok: false, error: "rate_limited" });
});

test("returns a safe service error when the retrieval bundle is unavailable", async () => {
  const handler = createHandler({ loadBundle: async () => { throw new Error("/Users/private/token"); } });
  const response = await handler(request(validBody));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "retrieval_unavailable");
  assert.match(payload.diagnosticId, /^ret-/);
  assert.doesNotMatch(JSON.stringify(payload), /Users|private|token/);
});
