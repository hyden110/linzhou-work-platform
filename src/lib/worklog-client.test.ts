import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWorklog,
  fetchWorklogSummary,
  worklogErrorMessage,
  WorklogClientError,
} from "./worklog-client.ts";

// ---------------------------------------------------------------------------
// 全合成数据：会话 id 一律 syn-*、标题带「（合成）」；fetch 全程 mock，零真实请求。
// ---------------------------------------------------------------------------

const ENTRY = {
  sourceKey: "qoder:Qoder:syn-q1",
  instance: "Qoder",
  date: "2026-10-19",
  ts: new Date(2026, 9, 19, 9, 0, 0).getTime(),
  title: "客户环境部署上线与故障排查（合成）",
  stageId: "delivery",
  confidence: "high",
  cluster: "部署与排障",
};

const SOURCE = { instance: "Qoder", kind: "vscdb", status: "ok", count: 1, note: "" };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const okData = (data: unknown): Response => jsonRes({ ok: true, data });
const errRes = (code: string, message: string, status = 400): Response => jsonRes({ ok: false, error: { code, message } }, status);

const FULL_DATA = {
  generatedAt: "2026-10-20T04:00:00.000Z",
  range: { from: "2026-10-14", to: "2026-10-20", days: 7 },
  status: "ok",
  sources: [SOURCE, { instance: "QoderCN", kind: "vscdb", status: "missing", count: 0, note: "未安装或库文件不存在" }],
  total: 1,
  truncated: false,
  missingNote: "",
  entries: [ENTRY],
  counts: { byStage: { delivery: 1 }, byCluster: [{ name: "部署与排障", count: 1 }], unclassified: 0 },
};

test("fetchWorklog builds the query and projects the whitelist", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData(FULL_DATA);
  }) as typeof fetch;

  const view = await fetchWorklog({ days: 30 }, fetchImpl);
  assert.ok(requested.includes("/local/worklog?"), requested);
  assert.ok(requested.includes("days=30"));
  assert.equal(view.status, "ok");
  assert.deepEqual(view.range, { from: "2026-10-14", to: "2026-10-20", days: 7 });
  assert.deepEqual(view.entries[0], ENTRY);
  assert.equal(view.total, 1);
  assert.equal(view.truncated, false);
  assert.deepEqual(view.counts.byStage.delivery, 1);
  assert.deepEqual(view.sources.map((s) => s.status), ["ok", "missing"]);
});

test("fetchWorklog query building: from/to pair, empty default", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: Request | string) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return okData(FULL_DATA);
  }) as typeof fetch;
  await fetchWorklog({ from: "2026-09-01", to: "2026-09-30" }, fetchImpl);
  assert.ok(urls[0].includes("from=2026-09-01") && urls[0].includes("to=2026-09-30"));
  await fetchWorklog(undefined, fetchImpl);
  assert.ok(!urls[1].includes("?"), "缺省不带 query");
});

test("fetchWorklog drops bad rows and coerces unknown enum values honestly", async () => {
  const fetchImpl = (async () => okData({
    ...FULL_DATA,
    entries: [
      ENTRY,
      { junk: true },
      null,
      { ...ENTRY, sourceKey: "" },
      { ...ENTRY, sourceKey: "qoder:Qoder:syn-x", stageId: "not-a-stage", confidence: "ultra", ts: "bad" },
    ],
    counts: { byStage: { delivery: 1, "hacked<script>": 9, reuse: "many" }, byCluster: [{ name: "部署与排障", count: 1 }, null], unclassified: "x" },
  })) as typeof fetch;
  const view = await fetchWorklog(undefined, fetchImpl);
  assert.equal(view.entries.length, 2, "坏行丢弃（junk/null/空 sourceKey）");
  const coerced = view.entries[1];
  assert.equal(coerced.stageId, null, "未知 stageId 一律回落 null（未分类），不猜");
  assert.equal(coerced.confidence, "low");
  assert.equal(coerced.ts, 0);
  assert.deepEqual(view.counts.byStage, { delivery: 1 }, "非白名单键与非数值计数丢弃");
  assert.deepEqual(view.counts.byCluster, [{ name: "部署与排障", count: 1 }]);
  assert.equal(view.counts.unclassified, 0);
});

test("fetchWorklog rejects malformed envelopes honestly", async () => {
  const badStatus = (async () => okData({ ...FULL_DATA, status: "great" })) as typeof fetch;
  await assert.rejects(() => fetchWorklog(undefined, badStatus),
    (e: unknown) => e instanceof WorklogClientError && e.code === "invalid_response");
  const noEntries = (async () => okData({ ...FULL_DATA, entries: "nope" })) as typeof fetch;
  await assert.rejects(() => fetchWorklog(undefined, noEntries),
    (e: unknown) => e instanceof WorklogClientError && e.code === "invalid_response");
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(() => fetchWorklog(undefined, offline),
    (e: unknown) => e instanceof WorklogClientError && e.code === "unavailable");
});

test("bridge error codes surface as WorklogClientError with detail", async () => {
  const cases: Array<[string, number]> = [
    ["worklog_invalid_request", 400],
    ["worklog_sqlite_unavailable", 503],
    ["worklog_scan_failed", 502],
    ["worklog_unavailable", 502],
  ];
  for (const [code, status] of cases) {
    const fetchImpl = (async () => errRes(code, `桥侧说明：${code}`, status)) as typeof fetch;
    await assert.rejects(() => fetchWorklog(undefined, fetchImpl), (e: unknown) => {
      assert.ok(e instanceof WorklogClientError);
      assert.equal(e.code, code);
      assert.equal(e.detail, `桥侧说明：${code}`);
      return true;
    }, code);
  }
  const unknown = (async () => errRes("totally_unknown", "x", 500)) as typeof fetch;
  await assert.rejects(() => fetchWorklog(undefined, unknown),
    (e: unknown) => e instanceof WorklogClientError && e.code === "unavailable");
});

test("fetchWorklogSummary projects byDay/byStage/byCluster and drops bad rows", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData({
      generatedAt: "2026-10-20T04:00:00.000Z",
      range: { from: "2026-09-21", to: "2026-10-20", days: 30 },
      status: "partial",
      sources: [SOURCE],
      total: 3,
      unclassified: 1,
      byDay: [{ date: "2026-10-18", count: 2 }, { date: "坏行" }, null],
      byStage: [{ id: "delivery", name: "交付与上线", count: 2, highConfidence: 1 }, { id: "nope", count: 1 }],
      byCluster: [{ name: "部署与排障", count: 2 }, { count: "x" }],
    });
  }) as typeof fetch;
  const view = await fetchWorklogSummary({ days: 30 }, fetchImpl);
  assert.ok(requested.includes("/local/worklog/summary?days=30"));
  assert.equal(view.status, "partial");
  assert.equal(view.total, 3);
  assert.equal(view.unclassified, 1);
  assert.deepEqual(view.byDay, [{ date: "2026-10-18", count: 2 }]);
  assert.deepEqual(view.byStage, [{ id: "delivery", name: "交付与上线", count: 2, highConfidence: 1 }]);
  assert.deepEqual(view.byCluster, [{ name: "部署与排障", count: 2 }]);
});

test("fetchWorklogSummary propagates the honest missing status", async () => {
  const fetchImpl = (async () => okData({
    generatedAt: "", range: { from: "2026-10-14", to: "2026-10-20", days: 7 }, status: "missing",
    sources: [], total: 0, unclassified: 0, byDay: [], byStage: [], byCluster: [],
  })) as typeof fetch;
  const view = await fetchWorklogSummary(undefined, fetchImpl);
  assert.equal(view.status, "missing");
  assert.equal(view.total, 0);
});

test("worklogErrorMessage gives honest CN copy per code and dedups via composeErrorMessage", () => {
  const sqlite = new WorklogClientError("worklog_sqlite_unavailable", "本机 Node 版本过低（需 ≥22.5）。");
  assert.match(worklogErrorMessage(sqlite), /node:sqlite/);
  assert.match(worklogErrorMessage(sqlite), /22\.5/, "桥侧具体原因不丢");
  const invalid = new WorklogClientError("worklog_invalid_request", "请求参数不合法：请检查时间范围。");
  assert.equal(worklogErrorMessage(invalid), "请求参数不合法：请检查时间范围。", "首句相同不复读");
  const scan = new WorklogClientError("worklog_scan_failed", "");
  assert.ok(worklogErrorMessage(scan).length > 0);
  assert.match(worklogErrorMessage(new Error("whatever")), /本地桥未启动/);
  assert.match(worklogErrorMessage(undefined), /本地桥未启动/);
});
