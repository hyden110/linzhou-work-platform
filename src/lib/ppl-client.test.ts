import assert from "node:assert/strict";
import test from "node:test";

import {
  PplClientError,
  decidePplRecommendation,
  fetchMaasCandidates,
  fetchMaasOverrides,
  fetchMaasOverridesState,
  fetchPplInspection,
  maasReviewChoice,
  maasReviewSelection,
  pplErrorMessage,
  pplInspectionStatus,
  saveMaasOverride,
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

// ---------------------------------------------------------------------------
// MaaS 候选复核（D4）
// ---------------------------------------------------------------------------

const CANDIDATES = {
  schemaVersion: 1,
  generatedAt: "2026-10-18T04:00:00.000Z",
  readOnly: true,
  totalCustomers: 3,
  candidates: [
    {
      cid: "990000001",
      customerName: "示例客户甲",
      suggestion: "maas",
      evidence: [
        { source: "customer", name: "示例客户甲", keywords: ["大模型"] },
        { source: "project", name: "FY27-Q3-示例客户甲-智算-通义", keywords: ["模型服务"] },
      ],
    },
  ],
};

test("fetchMaasCandidates returns the derived candidates file", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({ ok: true, data: CANDIDATES });
  };
  const file = await fetchMaasCandidates(fetchImpl);
  assert.equal(file.totalCustomers, 3);
  assert.equal(file.candidates[0]!.suggestion, "maas");
  assert.equal(file.candidates[0]!.evidence.length, 2);
  assert.match(requests[0]!, /\/local\/crm\/maas-candidates$/);
});

test("fetchMaasCandidates surfaces snapshot_unavailable as a safe error", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: false, error: "snapshot_unavailable" }, { status: 404 });
  await assert.rejects(() => fetchMaasCandidates(fetchImpl), (thrown: unknown) => {
    assert.ok(thrown instanceof PplClientError);
    assert.equal(thrown.code, "snapshot_unavailable");
    assert.match(pplErrorMessage(thrown), /候选生成不可用/);
    return true;
  });
});

test("maas overrides: local map wins, invalid values are dropped", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: true, data: { overrides: { "990000001": "maas", "990000002": "nonsense" } } });
  assert.deepEqual(await fetchMaasOverrides(fetchImpl), { "990000001": "maas" });

  const empty: typeof fetch = async () => Response.json({ ok: true, data: { overrides: null } });
  assert.deepEqual(await fetchMaasOverrides(empty), {});
});

test("saveMaasOverride posts cid+status and returns the refreshed map", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), body: String(init?.body) });
    return Response.json({ ok: true, data: { overrides: { "990000001": "non_maas" } } });
  };
  const overrides = await saveMaasOverride("990000001", "non_maas", fetchImpl);
  assert.deepEqual(overrides, { "990000001": "non_maas" });
  assert.match(seen[0]!.url, /\/local\/crm\/maas-overrides$/);
  assert.deepEqual(JSON.parse(seen[0]!.body), { cid: "990000001", status: "non_maas" });

  // unconfirmed = 清除覆盖：请求体同样合法，服务端返回清空后的表。
  await saveMaasOverride("990000001", "unconfirmed", fetchImpl);
  assert.deepEqual(JSON.parse(seen[1]!.body), { cid: "990000001", status: "unconfirmed" });
});

test("saveMaasOverride maps invalid_request to a readable error", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  await assert.rejects(() => saveMaasOverride("990000001", "maas", fetchImpl), (thrown: unknown) => {
    assert.ok(thrown instanceof PplClientError);
    assert.equal(thrown.code, "invalid_request");
    return true;
  });
});

// ---------------------------------------------------------------------------
// 返工（独立评审 P1-2 / P2-1）：损坏覆盖表可识别；初筛「疑似」行可确认为 MaaS
// ---------------------------------------------------------------------------

test("fetchMaasOverridesState exposes the corrupt source instead of a silent empty map", async () => {
  const corrupt: typeof fetch = async () => Response.json({ ok: true, data: { overrides: {}, source: "corrupt" } });
  assert.deepEqual(await fetchMaasOverridesState(corrupt), { overrides: {}, source: "corrupt" });

  const local: typeof fetch = async () =>
    Response.json({ ok: true, data: { overrides: { "9900000001": "maas", "9900000002": "bogus" }, source: "local" } });
  assert.deepEqual(await fetchMaasOverridesState(local), { overrides: { "9900000001": "maas" }, source: "local" });

  // 旧服务端无 source 字段 / 未知值 → null（不臆造来源）。
  const legacy: typeof fetch = async () => Response.json({ ok: true, data: { overrides: {}, source: "weird" } });
  assert.deepEqual(await fetchMaasOverridesState(legacy), { overrides: {}, source: null });
});

test("saveMaasOverride maps overrides_corrupt (409) to a fix-first message", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: false, error: "overrides_corrupt" }, { status: 409 });
  await assert.rejects(() => saveMaasOverride("9900000001", "maas", fetchImpl), (thrown: unknown) => {
    assert.ok(thrown instanceof PplClientError);
    assert.equal(thrown.code, "overrides_corrupt");
    assert.match(pplErrorMessage(thrown), /本机覆盖表损坏，请先修复/);
    return true;
  });
});

test("review select: non-override rows show a screening placeholder so choosing MaaS is a real change", () => {
  const keyword = maasReviewSelection({ status: "maas", basis: "keyword" });
  assert.deepEqual(keyword, { value: "screen", placeholder: "初筛：疑似" });
  assert.deepEqual(maasReviewSelection({ status: "unconfirmed", basis: "none" }), { value: "screen", placeholder: "初筛：未分类" });
  assert.deepEqual(maasReviewSelection({ status: "non_maas", basis: "override" }), { value: "non_maas", placeholder: null });

  // 从占位值切到 MaaS 才触发保存；占位值本身不是可保存状态。
  assert.notEqual(keyword.value, "maas");
  assert.equal(maasReviewChoice("maas"), "maas");
  assert.equal(maasReviewChoice("non_maas"), "non_maas");
  assert.equal(maasReviewChoice("unconfirmed"), "unconfirmed");
  assert.equal(maasReviewChoice("screen"), null);
  assert.equal(maasReviewChoice("anything"), null);
});
