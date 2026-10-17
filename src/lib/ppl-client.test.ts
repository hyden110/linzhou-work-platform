import assert from "node:assert/strict";
import test from "node:test";

import {
  PplClientError,
  decidePplRecommendation,
  fetchPplInspection,
  pplErrorMessage,
  pplInspectionStatus,
  startPplRefresh,
  type PplInspection,
} from "./ppl-client.ts";

// 全部为合成数据：不出现真实客户、项目、CID 或 BPID。
const RECOMMENDATION = {
  id: "r001ab12cd34",
  fingerprint: "fp-r001-aa01",
  customerName: "示例客户甲",
  cid: "990000001",
  suggestedProjectName: "FY27-Q3-示例客户甲-智算-通义",
  opportunityType: "智算-通义",
  amountYuan: 500000,
  blocked: false,
  blockReason: null,
  dedupe: { status: "new", evidence: null },
  changeNote: "示例日报摘要",
  state: "pending",
};

const INSPECTION = {
  schemaVersion: 1,
  state: "ok",
  generatedAt: "2026-10-16T09:15:00+08:00",
  snapshotGeneratedAt: "2026-10-15T06:41:13Z",
  snapshotStale: false,
  reportCount: 1,
  recommendations: [RECOMMENDATION],
  summary: { total: 1, pending: 1, exists: 0, suspected: 0, new: 1, blocked: 0 },
  error: null,
};

const DECISION = {
  id: "d1",
  recommendationId: "r001ab12cd34",
  action: "approve" as const,
  decidedAt: "2026-10-16T01:30:00.000Z",
  note: null,
  fingerprint: "fp-r001-aa01",
};

test("fetchPplInspection returns the bundle with decisions and fingerprints", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({ ok: true, data: INSPECTION, decisions: [DECISION], refresh: { state: "idle" } });
  };
  const bundle = await fetchPplInspection(fetchImpl);
  assert.ok(bundle);
  assert.equal(bundle.inspection.reportCount, 1);
  assert.equal(bundle.inspection.recommendations[0]!.customerName, "示例客户甲");
  assert.equal(bundle.inspection.recommendations[0]!.fingerprint, "fp-r001-aa01");
  assert.deepEqual(bundle.decisions, [DECISION]);
  assert.match(requests[0]!, /\/local\/ppl\/inspection$/);
});

test("fetchPplInspection keeps the 404 no-artifact case as null", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: false, error: "inspection_unavailable" }, { status: 404 });
  assert.equal(await fetchPplInspection(fetchImpl), null);
});

test("pplInspectionStatus distinguishes empty/failed/stale/ok", () => {
  assert.equal(pplInspectionStatus(null), "empty");
  assert.equal(pplInspectionStatus(undefined), "empty");
  const failed = { ...INSPECTION, state: "failed", error: "dws_auth" };
  assert.equal(pplInspectionStatus(failed as unknown as PplInspection), "failed");
  const stale = { ...INSPECTION, snapshotStale: true };
  assert.equal(pplInspectionStatus(stale as unknown as PplInspection), "stale");
  assert.equal(pplInspectionStatus(INSPECTION as unknown as PplInspection), "ok");
});

test("failed artifacts pass through with their error and are classified as failed", async () => {
  // 返工 #4：失败产物必须显式透出（state=failed + error），不得当空结果。
  const fetchImpl: typeof fetch = async () => Response.json({
    ok: true,
    data: { ...INSPECTION, state: "failed", error: "dws_auth", reportCount: 0, recommendations: [] },
    decisions: [],
    refresh: { state: "idle" },
  });
  const bundle = await fetchPplInspection(fetchImpl);
  assert.ok(bundle);
  assert.equal(bundle.inspection.state, "failed");
  assert.equal(bundle.inspection.error, "dws_auth");
  assert.deepEqual(bundle.inspection.recommendations, []);
  assert.equal(pplInspectionStatus(bundle.inspection), "failed");
});

test("decide posts the approval payload and returns the decision", async () => {
  const seen: Array<{ method?: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ method: init?.method, body: init?.body ? String(init.body) : undefined });
    if (String(input).endsWith("/local/ppl/approval")) {
      return Response.json({ ok: true, data: DECISION }, { status: 201 });
    }
    return Response.json({ ok: true, data: { state: "running" } }, { status: 202 });
  };
  const decision = await decidePplRecommendation(RECOMMENDATION.id, "approve", "同意创建", fetchImpl);
  assert.deepEqual(decision, DECISION);
  assert.equal(seen[0]!.method, "POST");
  assert.deepEqual(JSON.parse(seen[0]!.body!), { recommendationId: RECOMMENDATION.id, action: "approve", note: "同意创建" });
  await startPplRefresh(fetchImpl);
  assert.equal(seen[1]!.method, "POST");
});

test("client surfaces safe error codes and readable messages", async () => {
  const cases: ReadonlyArray<{ status: number; error: string; expected: string }> = [
    { status: 422, error: "blocked_recommendation", expected: "blocked_recommendation" },
    { status: 409, error: "already_decided", expected: "already_decided" },
    { status: 404, error: "not_found", expected: "not_found" },
    { status: 429, error: "rate_limited", expected: "rate_limited" },
  ];
  for (const { status, error, expected } of cases) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error }, { status });
    await assert.rejects(() => decidePplRecommendation(RECOMMENDATION.id, "approve", undefined, fetchImpl), (thrown: unknown) => {
      assert.ok(thrown instanceof PplClientError);
      assert.equal(thrown.code, expected);
      return true;
    });
  }
  assert.equal(
    pplErrorMessage(new PplClientError("blocked_recommendation")),
    "金额缺失，补齐前不能同意创建。",
  );
  assert.equal(
    pplErrorMessage(new Error("x")),
    "本机服务未响应，请确认已启动 npm run dev:function。",
  );
});

test("client rejects malformed payloads instead of rendering them", async () => {
  const badData: typeof fetch = async () => Response.json({ ok: true, data: { state: "ok" } });
  await assert.rejects(() => fetchPplInspection(badData), /invalid_response/);

  const badDecision: typeof fetch = async () =>
    Response.json({ ok: true, data: { recommendationId: RECOMMENDATION.id, action: "maybe" } }, { status: 201 });
  await assert.rejects(() => decidePplRecommendation(RECOMMENDATION.id, "approve", undefined, badDecision), /invalid_response/);

  const unknownError: typeof fetch = async () =>
    Response.json({ ok: false, error: "leaky_internal_detail" }, { status: 500 });
  await assert.rejects(() => startPplRefresh(unknownError), (thrown: unknown) => {
    assert.ok(thrown instanceof PplClientError);
    assert.equal(thrown.code, "unavailable");
    return true;
  });
});
