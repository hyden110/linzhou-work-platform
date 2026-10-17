import assert from "node:assert/strict";
import test from "node:test";

import {
  FbiMetricsClientError,
  fetchFbiMetrics,
  fbiMetricsErrorMessage,
  startFbiMetrics,
} from "./fbi-metrics-client.ts";

const METRICS = {
  schemaVersion: 1,
  state: "done",
  generatedAt: "2026-10-16T01:00:00.000Z",
  reportResourceId: "123456",
  date: "2026-10-15",
  dailyGaap: 71995.84,
  validCustomers: 13,
  callVolume: 33190861372.25,
  moMRate: 0.1184,
  // 坐席卡已改占位：client 对 seats 只透传 null（在用席位待 2000986 权限），
  // 历史产物若带数值也原样透传（字段不删），渲染层不使用。
  qoderSeats: null,
  qwenworkSeats: null,
  error: null,
};

test("fetchFbiMetrics returns the artifact and keeps the 404 no-artifact case as null", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/local/fbi/metrics") && init?.method !== "POST") {
      return Response.json({ ok: true, data: METRICS });
    }
    return Response.json({ ok: true, data: { state: "running" } }, { status: 202 });
  };
  const metrics = await fetchFbiMetrics(fetchImpl);
  assert.deepEqual(metrics, METRICS);
  await startFbiMetrics(fetchImpl);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /\/local\/fbi\/metrics$/);
  assert.equal(requests[1]!.startsWith("POST "), true);
});

test("fetchFbiMetrics maps the 404 no-artifact response to null without throwing", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({ ok: false, error: "metrics_unavailable" }, { status: 404 });
  assert.equal(await fetchFbiMetrics(fetchImpl), null);
});

test("client surfaces safe error codes and a readable message", async () => {
  const cases: ReadonlyArray<{ status: number; error: string }> = [
    { status: 400, error: "not_configured" },
    { status: 429, error: "busy" },
    { status: 403, error: "origin_not_allowed" },
  ];
  for (const { status, error } of cases) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error }, { status });
    await assert.rejects(() => startFbiMetrics(fetchImpl), (thrown: unknown) => {
      assert.ok(thrown instanceof FbiMetricsClientError);
      assert.equal(thrown.code, error);
      return true;
    });
  }
  assert.equal(fbiMetricsErrorMessage(new FbiMetricsClientError("not_configured")).includes("FBI_REPORT_RESOURCE_ID"), true);
  assert.equal(fbiMetricsErrorMessage(new Error("x")), "本机服务未响应，请确认已启动 npm run dev:function。");
});

test("client rejects malformed payloads instead of rendering them", async () => {
  const bad: typeof fetch = async () => Response.json({ ok: true, data: { state: "done", date: "not-a-date" } });
  await assert.rejects(() => fetchFbiMetrics(bad), /invalid_response/);
  const unreachable: typeof fetch = async () => {
    throw new Error("network down");
  };
  await assert.rejects(() => fetchFbiMetrics(unreachable), /unavailable/);
});

test("null seats stay null through the client (placeholder caliber, never a guessed number)", async () => {
  // 坐席卡占位口径：seats 为 null 的产物原样透传，客户端不编造数字。
  const withNullSeats: typeof fetch = async () =>
    Response.json({ ok: true, data: { ...METRICS, qoderSeats: null, qwenworkSeats: null } });
  const metrics = await fetchFbiMetrics(withNullSeats);
  assert.equal(metrics?.qoderSeats, null);
  assert.equal(metrics?.qwenworkSeats, null);
});
