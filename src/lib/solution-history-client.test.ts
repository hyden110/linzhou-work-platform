import assert from "node:assert/strict";
import test from "node:test";

import {
  SolutionHistoryError,
  deleteSolutionVersion,
  fetchSolutionSeries,
  fetchSolutionSeriesVersions,
  solutionHistoryErrorMessage,
} from "./solution-history-client.ts";

const PLAN = {
  engine: "qoder-cli",
  title: "门店 AI 助手方案",
  summary: "六层阿里云架构，回答绑定受控引用。",
  layers: [
    { name: "接入层", purpose: "统一入口", products: [{ name: "API 网关", role: "鉴权限流" }] },
    { name: "模型层", purpose: "生成能力", products: [{ name: "阿里云百炼", role: "检索增强问答" }] },
  ],
  flows: [{ name: "问答链路", steps: ["提问", "检索", "生成"] }],
  mapping: [{ need: "可核验", product: "阿里云百炼", reason: "回答绑定引用" }],
  risks: [{ risk: "幻觉", mitigation: "阈值不足即拒答" }],
  nextSteps: ["确认验收指标"],
  evidence: [],
  generatedAt: "2026-10-13T02:00:00.000Z",
};

const RETRIEVAL = { status: "results-only", vectorSearch: "keyword-only", resultCount: 12, queries: ["门店经营 AI 助手"] };

const SUMMARY = {
  seriesId: "a1b2c3d4e5f60718",
  customer: "某区域零售集团",
  industry: "零售与消费",
  goal: "建设面向门店经营的 AI 助手",
  title: "门店 AI 助手方案",
  versionCount: 2,
  latestVersion: 2,
  updatedAt: "2026-10-13T02:05:00.000Z",
  latestEngine: "qoder-cli",
};

const VERSION = {
  versionId: "6f1c1d5e-1111-2222-3333-444455556666",
  version: 2,
  createdAt: "2026-10-13T02:05:00.000Z",
  requestId: "req-2",
  engine: "qoder-cli",
  retrieval: RETRIEVAL,
  plan: PLAN,
};

test("reads the series list newest-first and drops unusable rows", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: {
        series: [
          { ...SUMMARY, updatedAt: "2026-10-13T01:00:00.000Z" },
          { ...SUMMARY, seriesId: "ffffffffffffffff", customer: "某制造集团", updatedAt: "2026-10-13T03:00:00.000Z", latestEngine: "template", latestDegraded: "cli-timeout" },
          { ...SUMMARY, seriesId: "" },
          { ...SUMMARY, seriesId: "0000000000000000", latestEngine: "gpt" },
          null,
        ],
      },
    });
  };

  const series = await fetchSolutionSeries(fetchImpl);

  assert.equal(captured?.url, "http://localhost/local/solutions");
  assert.equal(captured?.method, "GET");
  assert.deepEqual(series.map((item) => item.customer), ["某制造集团", "某区域零售集团"]);
  assert.equal(series[0]!.latestDegraded, "cli-timeout");
  assert.equal(series[0]!.latestEngine, "template");
});

test("clamps a version payload before it is rendered", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: {
        seriesId: SUMMARY.seriesId,
        key: { customer: SUMMARY.customer, industry: SUMMARY.industry, goal: SUMMARY.goal, constraints: "数据不出域" },
        versions: [
          { ...VERSION, version: 1, plan: { ...PLAN, title: `标${"题".repeat(200)}` } },
          { ...VERSION, retrieval: { ...RETRIEVAL, resultCount: 12.7, queries: ["门店经营 AI 助手", 42, null] } },
          { ...VERSION, engine: "gpt", plan: PLAN },
          { ...VERSION, plan: { ...PLAN, layers: [PLAN.layers[0]] } },
          { ...VERSION, createdAt: "不是时间", plan: PLAN },
        ],
      },
    });
  };

  const detail = await fetchSolutionSeriesVersions(SUMMARY.seriesId, fetchImpl);

  assert.equal(captured?.url, `http://localhost/local/solutions?series=${SUMMARY.seriesId}`);
  assert.equal(detail.seriesId, SUMMARY.seriesId);
  assert.equal(detail.customer, SUMMARY.customer);
  assert.equal(detail.versions.length, 2, "invalid versions are dropped, not rendered");
  assert.deepEqual(detail.versions.map((version) => version.version), [2, 1], "newest version first");
  assert.equal(Array.from(detail.versions[1]!.plan.title).length, 90);
  assert.deepEqual(detail.versions[0]!.retrieval, {
    status: "results-only",
    vectorSearch: "keyword-only",
    resultCount: 12,
    queries: ["门店经营 AI 助手"],
  });
});

test("reports an empty or unknown series as not found", async () => {
  const empty: typeof fetch = async () => Response.json({ ok: true, data: { seriesId: "x", key: {}, versions: [] } });
  await assert.rejects(
    () => fetchSolutionSeriesVersions("a1b2c3d4e5f60718", empty),
    (error) => error instanceof SolutionHistoryError && error.code === "not_found",
  );

  const missing: typeof fetch = async () => Response.json({ ok: false, error: "not_found" }, { status: 404 });
  await assert.rejects(
    () => fetchSolutionSeriesVersions("a1b2c3d4e5f60718", missing),
    (error) => error instanceof SolutionHistoryError && error.code === "not_found",
  );
});

test("deletes a version by its ids and returns what remains", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true, data: { remaining: 1 } });
  };

  const remaining = await deleteSolutionVersion(SUMMARY.seriesId, VERSION.versionId, fetchImpl);

  assert.equal(remaining, 1);
  assert.equal(captured?.method, "DELETE");
  assert.equal(captured?.url, `http://localhost/local/solutions/${SUMMARY.seriesId}/${VERSION.versionId}`);
});

test("maps safe error codes and keeps unknown ones generic", async () => {
  const cases: Array<[string, number, string]> = [
    ["not_found", 404, "not_found"],
    ["invalid_request", 400, "invalid_request"],
    ["rate_limited", 429, "rate_limited"],
    ["内部错误：/Users/linzhou/.qoder", 500, "unavailable"],
  ];
  for (const [error, status, code] of cases) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error }, { status });
    await assert.rejects(
      () => fetchSolutionSeries(fetchImpl),
      (thrown) => thrown instanceof SolutionHistoryError && thrown.code === code,
      error,
    );
  }

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchSolutionSeries(offline),
    (thrown) => thrown instanceof SolutionHistoryError && thrown.code === "unavailable",
  );
  assert.match(solutionHistoryErrorMessage(new SolutionHistoryError("unavailable")), /npm run dev:function/);

  const timedOut: typeof fetch = async () => {
    throw new DOMException("timed out", "TimeoutError");
  };
  await assert.rejects(
    () => fetchSolutionSeries(timedOut),
    (thrown) => thrown instanceof SolutionHistoryError && thrown.code === "request_timeout",
  );
  assert.match(solutionHistoryErrorMessage(new SolutionHistoryError("request_timeout")), /超时/);
  assert.match(solutionHistoryErrorMessage(new Error("boom")), /读取失败/);

  const malformed: typeof fetch = async () => Response.json({ ok: true, data: {} });
  await assert.rejects(
    () => fetchSolutionSeries(malformed),
    (thrown) => thrown instanceof SolutionHistoryError && thrown.code === "invalid_response",
  );
});
