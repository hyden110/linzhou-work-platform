import assert from "node:assert/strict";
import test from "node:test";

import { RetrievalClientError, groupCitationsByDocument, retrieveKnowledge } from "./retrieval-client.ts";

const responseData = {
  status: "answered",
  answer: "建议先试点。[doc-1:c1]",
  citations: [{
    id: "c1",
    referenceId: "doc-1:c1",
    documentId: "doc-1",
    source: "cases",
    sourceLabel: "案例库",
    title: "零售案例",
    locator: { kind: "page", value: "2" },
    text: "试点证据",
  }],
  results: [],
  retrievalMode: "hybrid-local",
};

test("posts a bounded retrieval request to the same-origin Function", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true, data: responseData });
  };

  const result = await retrieveKnowledge({ query: "零售智能体", mode: "qa", requestId: "req-1" }, fetchImpl);

  assert.equal(result.status, "answered");
  assert.equal(captured?.url, "http://localhost/functions/v1/app");
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.headers.get("content-type"), "application/json");
});

test("maps safe Function errors without exposing response internals", async () => {
  const fetchImpl: typeof fetch = async () => Response.json(
    { ok: false, error: "retrieval_unavailable", diagnosticId: "ret-safe" },
    { status: 503 },
  );

  await assert.rejects(
    () => retrieveKnowledge({ query: "零售智能体", mode: "qa", requestId: "req-2" }, fetchImpl),
    (error) => error instanceof RetrievalClientError
      && error.code === "retrieval_unavailable"
      && error.diagnosticId === "ret-safe",
  );
});

test("groups citations per document while keeping answer numbering", () => {
  const citation = (documentId: string, id: string) => ({
    ...responseData.citations[0], id, documentId, referenceId: `${documentId}:${id}`, title: `标题-${documentId}`,
  });
  const groups = groupCitationsByDocument([citation("a", "c1"), citation("b", "c1"), citation("a", "c4")]);

  assert.deepEqual(groups.map((group) => group.documentId), ["a", "b"]);
  assert.deepEqual(groups[0].items.map((item) => item.number), [1, 3]);
  assert.deepEqual(groups[1].items.map((item) => item.number), [2]);
  assert.equal(groups[0].title, "标题-a");
});
