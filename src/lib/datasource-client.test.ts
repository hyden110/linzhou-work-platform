import assert from "node:assert/strict";
import test from "node:test";

import {
  DataSourceClientError,
  dataSourceErrorMessage,
  fetchDataSourceRegistry,
  refreshDataSourceGroup,
} from "./datasource-client.ts";

// 合成数据：源名/组名/计数均为合成值；敌意字段（cookieValue）用于验证白名单投影。

function registryPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      version: "2026-10-18",
      generatedAt: "2026-10-20T08:00:00.000Z",
      channels: [],
      groups: [
        { id: "cust", d: "客户池", supported: true, reason: null, sourceCount: 3 },
        { id: "cases", d: "案例库", supported: false, reason: "v2 未接「cases」组刷新通道", sourceCount: 2 },
      ],
      caps: [],
      envSections: [],
      healthGroups: [],
      sources: [
        {
          sys: "合成源甲", cap: null, ico: "", ch: ["cookie"], grp: "cust", hk: ["devata"],
          auth: "cookie", via: "桥", api: "", snap: "crm-snapshot.json", globals: [], pages: [], cmd: "", note: "",
          status: { state: "ok", evidence: "crm-snapshot.json · 3 段就绪", fetchedAt: "2026-10-20T07:00:00.000Z" },
          cookieValue: "SESSION=hostile-synthetic-value", // 敌意多余字段：必须被投影丢弃
        },
        { sys: "合成源乙", status: { state: "missing", evidence: "无产物", fetchedAt: null } },
      ],
    },
  };
}

test("fetchDataSourceRegistry GETs /local/datasources and projects onto the whitelist", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(registryPayload());
  };
  const view = await fetchDataSourceRegistry(fetchImpl);
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/datasources");
  assert.equal(view.version, "2026-10-18");
  assert.equal(view.groups.length, 2);
  assert.equal(view.groups[0]?.supported, true);
  assert.equal(view.groups[1]?.supported, false);
  assert.match(view.groups[1]?.reason ?? "", /v2 未接/);
  assert.equal(view.statuses.length, 2);
  assert.equal(view.statuses[0]?.sys, "合成源甲");
  assert.equal(view.statuses[0]?.status.state, "ok");
  assert.equal(view.statuses[1]?.status.fetchedAt, null);
  assert.ok(!JSON.stringify(view).includes("hostile-synthetic-value"), "白名单投影必须丢弃多余字段");
});

test("fetchDataSourceRegistry rejects unknown states and offline bridge honestly", async () => {
  const badState: typeof fetch = async () => Response.json({
    ok: true,
    data: { version: "v", generatedAt: "", groups: [], sources: [{ sys: "x", status: { state: "fabulous", evidence: "", fetchedAt: null } }] },
  });
  await assert.rejects(
    () => fetchDataSourceRegistry(badState),
    (error: unknown) => error instanceof DataSourceClientError && error.code === "invalid_response",
  );

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchDataSourceRegistry(offline),
    (error: unknown) => error instanceof DataSourceClientError && error.code === "unavailable",
  );
  assert.match(dataSourceErrorMessage(new DataSourceClientError("unavailable")), /npm run dev:function/);
});

test("refreshDataSourceGroup POSTs {group} and projects per-source results; busy maps to safe code", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: {
        group: "cust", supported: true, reason: null, startedAt: "2026-10-20T08:00:00.000Z",
        results: [
          { sys: "合成源甲", state: "started", detail: "后台刷新已启动" },
          { sys: "合成源乙", state: "skipped", detail: "已有刷新进行中" },
        ],
      },
    });
  };
  const view = await refreshDataSourceGroup("cust", fetchImpl);
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.url, "http://localhost/local/datasources/refresh");
  assert.deepEqual(JSON.parse(await (captured?.text() ?? "{}")) as unknown, { group: "cust" });
  assert.equal(view.supported, true);
  assert.equal(view.results.length, 2);
  assert.equal(view.results[0]?.state, "started");

  const unsupported: typeof fetch = async () => Response.json({
    ok: true,
    data: { group: "cases", supported: false, reason: "v2 未接「cases」组刷新通道", startedAt: "", results: [] },
  });
  const honest = await refreshDataSourceGroup("cases", unsupported);
  assert.equal(honest.supported, false);
  assert.match(honest.reason ?? "", /未接/);
  assert.equal(honest.results.length, 0, "unsupported 组绝不伪造逐源成功");

  const busy: typeof fetch = async () => Response.json(
    { ok: false, error: { code: "datasource_busy", message: "刷新正在进行中" } },
    { status: 409 },
  );
  await assert.rejects(
    () => refreshDataSourceGroup("cust", busy),
    (error: unknown) => error instanceof DataSourceClientError && error.code === "datasource_busy",
  );
  assert.match(dataSourceErrorMessage(new DataSourceClientError("datasource_busy")), /正在进行/);
});
