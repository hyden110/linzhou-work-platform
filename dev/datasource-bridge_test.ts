import assert from "node:assert/strict";
import test from "node:test";

import {
  DATASOURCE_ROUTES,
  DataSourceBridgeError,
  createDataSourceBridge,
  type DataSourceBridge,
} from "./datasource-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：全部桥产物 / 刷新结果均为合成构造，绝不读取真实 .local-cache，
// 绝不启动真实子进程（probes 与 refreshDeps 全量注入）。
// ---------------------------------------------------------------------------

const FIXED_NOW = () => Date.parse("2026-10-20T08:00:00.000Z");

interface CrmSourceStatus {
  readonly status: "ok" | "partial" | "error" | "auth_required" | "missing";
  readonly stale: boolean;
  readonly fetchedAt: string | null;
  readonly count: number;
}

function crmSource(status: CrmSourceStatus["status"], stale = false): CrmSourceStatus {
  return { status, stale, fetchedAt: "2026-10-20T03:31:28Z", count: 10 };
}

function healthyProbes(overrides: Record<string, () => Promise<unknown>> = {}) {
  return {
    crmSnapshot: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-10-20T03:31:28Z",
      sources: { customers: crmSource("ok"), projects: crmSource("ok") },
    }),
    opsDigest: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-10-20T03:30:32Z",
      sources: {
        blog: { status: "ok", error: null, fetchedAt: "2026-10-20T03:30:32Z", lastSuccessAt: "2026-10-20T03:30:32Z", count: 40, complete: true, stale: false },
        changelog: { status: "ok", error: null, fetchedAt: "2026-10-20T03:30:32Z", lastSuccessAt: "2026-10-20T03:30:32Z", count: 60, complete: true, stale: false },
        announcement: { status: "ok", error: null, fetchedAt: "2026-10-20T03:30:32Z", lastSuccessAt: "2026-10-20T03:30:32Z", count: 5, complete: true, stale: false },
        qianzai: { status: "ok", error: null, fetchedAt: "2026-10-20T03:30:32Z", lastSuccessAt: "2026-10-20T03:30:32Z", count: 3, complete: true, stale: false },
      },
      items: [],
    }),
    pplInspection: async () => ({ reports: [1, 2, 3], recommendations: [] }),
    leadsSnapshot: async () => ({ configured: true, hasData: true, fetchedAt: "2026-10-19T22:00:00Z", total: 42 }),
    kbSources: async () => ([
      { id: "obs-main", type: "obsidian", name: "本地库", ok: true },
      { id: "dt-wiki", type: "dingtalk", name: "钉钉知识库", ok: true },
    ]),
    dingtalkWrites: async () => ([{ taskId: "t-1" }]),
    healthSnapshot: async () => ({
      ok: true,
      fetchedAt: "2026-10-20T07:59:00.000Z",
      bridges: [
        { name: "crm", state: "ok", detail: "客户快照就绪" },
        { name: "dingtalk", state: "ok", detail: "写通道记录 1 条可读" },
        { name: "cases", state: "ok", detail: "案例就绪" },
        { name: "ppl-inspection", state: "ok", detail: "巡检就绪" },
      ],
      cli: [
        { name: "a1", state: "ok", version: "1.2.3", note: "" },
        { name: "dws", state: "ok", version: "2.4.1", note: "" },
        { name: "ossutil", state: "missing", version: "", note: "未安装" },
        { name: "qodercli", state: "ok", version: "1.9.9", note: "" },
        { name: "aliyun", state: "ok", version: "3.1.68", note: "" },
      ],
      caps: [{ name: "DASHSCOPE_API_KEY", state: "ok", set: true, note: "已设置（值不入快照）" }],
    }),
    ontologyGraph: async () => ({ opsCount: 2, uidsCount: 3 }),
    ...overrides,
  };
}

function idleStatus() {
  return { state: "idle", startedAt: null, finishedAt: null, error: null };
}

function fakeRefreshDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = {
    calls,
    crmStatus: () => idleStatus(),
    crmStart: () => { calls.push("crm"); return { state: "running", startedAt: "2026-10-20T08:00:00.000Z", finishedAt: null, error: null }; },
    opsStatus: () => idleStatus(),
    opsStart: () => { calls.push("ops"); return { state: "running", startedAt: "2026-10-20T08:00:00.000Z", finishedAt: null, error: null }; },
    pplStatus: () => idleStatus(),
    pplStart: () => { calls.push("ppl"); return { state: "running", startedAt: "2026-10-20T08:00:00.000Z", finishedAt: null, error: null }; },
    leadsRefresh: async () => { calls.push("leads"); return { summary: { total: 42, open: 7, radarAt: "2026-10-19", fetchedAt: "2026-10-20T08:00:00.000Z" } }; },
    dingtalkStartSummary: async () => { calls.push("dingtalk"); return { ok: true, status: { state: "running" }, reused: false }; },
    ...overrides,
  };
  return deps;
}

function makeBridge(probeOverrides: Record<string, () => Promise<unknown>> = {}, refreshOverrides: Record<string, unknown> = {}) {
  const deps = fakeRefreshDeps(refreshOverrides);
  const bridge = createDataSourceBridge({ now: FIXED_NOW, probes: healthyProbes(probeOverrides), refreshDeps: deps });
  return { bridge, deps };
}

const HOST = "127.0.0.1:8000";

async function routed(bridge: DataSourceBridge, method: string, path: string, body?: unknown): Promise<Response | undefined> {
  return bridge.handle(new Request(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

function statusOf(registry: Awaited<ReturnType<DataSourceBridge["registry"]>>, sys: string) {
  const source = registry.sources.find((s) => s.sys === sys);
  assert.ok(source, `source not found: ${sys}`);
  return source.status;
}

/* ============================= registry ============================= */

test("routes constant exposes exactly the two datasource routes", () => {
  assert.deepEqual(
    DATASOURCE_ROUTES.map((r) => `${r.method} ${r.path}`),
    ["GET /local/datasources", "POST /local/datasources/refresh"],
  );
});

test("registry: full 51-source table with per-source derived status", async () => {
  const { bridge } = makeBridge();
  const view = await bridge.registry();
  assert.equal(view.version, "2026-10-18");
  assert.equal(view.generatedAt, "2026-10-20T08:00:00.000Z");
  assert.equal(view.sources.length, 51);
  assert.equal(view.channels.length, 8);
  assert.equal(view.groups.length, 17);
  assert.equal(view.caps.length, 23);
  assert.equal(view.envSections.length, 5);
  assert.equal(view.healthGroups.length, 5);

  // crm 快照存在且 customers ok → cust 组源 ok，带 fetchedAt
  const devata = statusOf(view, "鲲鹏 CRM · devata「我的客户」");
  assert.equal(devata.state, "ok");
  assert.equal(devata.fetchedAt, "2026-10-20T03:31:28Z");

  // leads 快照 configured+hasData → leads 源 ok
  assert.equal(statusOf(view, "钉钉 AI 表格「拓新企业清单」").state, "ok");

  // ops digest 全 ok → ops 组源 ok
  assert.equal(statusOf(view, "钉群消息 → AI 运营概要").state, "ok");

  // static 通道 → static（随代码发布，无运行期状态）
  assert.equal(statusOf(view, "生命周期方法模型").state, "static");

  // 健康快照存在 → 三类健康快照源 ok；Aone 源走 cli.a1=ok
  assert.equal(statusOf(view, "三类健康快照（CLI / MCP / Cookie）").state, "ok");
  assert.equal(statusOf(view, "Aone / 云效 Code 代码库").state, "ok");

  // dingtalk 组 → health 桥 dingtalk 行 ok
  assert.equal(statusOf(view, "钉钉会话与群台账").state, "ok");

  // kb 派生：钉钉知识库（dingtalk 型 kb 源 ok）与 Obsidian（obsidian 型 ok）
  assert.equal(statusOf(view, "钉钉知识库（Wiki）").state, "ok");
  assert.equal(statusOf(view, "Obsidian 本地知识库").state, "ok");

  // LLM 能力：DASHSCOPE_API_KEY set → OKR AI 建议 ok
  assert.equal(statusOf(view, "OKR AI 辅助建议").state, "ok");

  // 本体：ontology 图有 ops → ok
  assert.equal(statusOf(view, "个人本体构建").state, "ok");

  // v2 无对应产物的源：诚实 missing，绝不伪造 ok
  assert.equal(statusOf(view, "CRD 目标管理（读）").state, "missing");
  assert.equal(statusOf(view, "Chrome 标签页").state, "missing");
  // aitable 表在 v2 尚无接入配置（leads 除外）→ missing，evidence 提示可走向导
  const worklog = statusOf(view, "钉钉 AI 表格「历史工作」");
  assert.equal(worklog.state, "missing");
  assert.ok(worklog.evidence.includes("接入"));
});

test("registry: missing artifacts degrade honestly to missing", async () => {
  const { bridge } = makeBridge({
    crmSnapshot: async () => undefined,
    leadsSnapshot: async () => ({ configured: false, hasData: false, fetchedAt: "", total: 0 }),
    healthSnapshot: async () => undefined,
    opsDigest: async () => undefined,
    kbSources: async () => [],
    ontologyGraph: async () => undefined,
    pplInspection: async () => undefined,
  });
  const view = await bridge.registry();
  assert.equal(statusOf(view, "鲲鹏 CRM · devata「我的客户」").state, "missing");
  assert.equal(statusOf(view, "钉钉 AI 表格「拓新企业清单」").state, "missing");
  assert.equal(statusOf(view, "三类健康快照（CLI / MCP / Cookie）").state, "missing");
  assert.equal(statusOf(view, "钉群消息 → AI 运营概要").state, "missing");
  assert.equal(statusOf(view, "钉钉会话与群台账").state, "missing");
  assert.equal(statusOf(view, "个人本体构建").state, "missing");
  // static 源不受产物影响
  assert.equal(statusOf(view, "环境入口目录").state, "static");
});

test("registry: stale and error artifacts map to stale/error states", async () => {
  const { bridge } = makeBridge({
    crmSnapshot: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-10-01T00:00:00Z",
      sources: { customers: crmSource("ok", true), projects: crmSource("ok", true) },
    }),
    opsDigest: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-10-19T00:00:00Z",
      sources: {
        blog: { status: "auth_required", error: "需要重新登录", fetchedAt: null, lastSuccessAt: "2026-10-01T00:00:00Z", count: 0, complete: false, stale: true },
        changelog: { status: "auth_required", error: "需要重新登录", fetchedAt: null, lastSuccessAt: "2026-10-01T00:00:00Z", count: 0, complete: false, stale: true },
        announcement: { status: "auth_required", error: null, fetchedAt: null, lastSuccessAt: null, count: 0, complete: false, stale: true },
        qianzai: { status: "auth_required", error: null, fetchedAt: null, lastSuccessAt: null, count: 0, complete: false, stale: true },
      },
      items: [],
    }),
  });
  const view = await bridge.registry();
  assert.equal(statusOf(view, "鲲鹏 CRM · devata「我的客户」").state, "stale");
  assert.equal(statusOf(view, "钉群消息 → AI 运营概要").state, "error");
});

test("registry: refresh group views mark supported groups only", async () => {
  const { bridge } = makeBridge();
  const view = await bridge.registry();
  const supported = view.groups.filter((g) => g.supported).map((g) => g.id).sort();
  assert.deepEqual(supported, ["cust", "dingtalk", "leads", "ops", "ppl"]);
  for (const g of view.groups) {
    if (!g.supported) {
      assert.ok(g.reason && g.reason.length > 0, `unsupported group ${g.id} must carry a reason`);
    } else {
      assert.equal(g.reason, null);
    }
    assert.ok(g.sourceCount >= 0);
  }
  assert.equal(view.groups.find((g) => g.id === "cust")?.sourceCount, 3);
});

test("registry: probes that throw degrade to missing, never crash", async () => {
  const { bridge } = makeBridge({
    crmSnapshot: async () => { throw new Error("synthetic probe failure"); },
    healthSnapshot: async () => { throw new Error("synthetic probe failure"); },
  });
  const view = await bridge.registry();
  assert.equal(view.sources.length, 51);
  assert.equal(statusOf(view, "鲲鹏 CRM · devata「我的客户」").state, "missing");
  assert.equal(statusOf(view, "Aone / 云效 Code 代码库").state, "missing");
});

test("registry response carries no absolute paths and safe headers", async () => {
  const { bridge } = makeBridge();
  const response = await routed(bridge, "GET", "/local/datasources");
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'none'"));
  const text = await response.text();
  assert.ok(!text.includes("/Users/"), "absolute paths must not leave the bridge");
  const payload = JSON.parse(text) as { ok: boolean };
  assert.equal(payload.ok, true);
});

/* ============================= refresh ============================= */

test("refresh cust: delegates to crm startRefresh, per-source started results", async () => {
  const { bridge, deps } = makeBridge();
  const result = await bridge.refresh({ group: "cust" });
  assert.equal(result.supported, true);
  assert.deepEqual(deps.calls, ["crm"]);
  assert.equal(result.results.length, 3);
  for (const r of result.results) assert.equal(r.state, "started");
});

test("refresh ops / ppl delegate to their startRefresh", async () => {
  const { bridge, deps } = makeBridge();
  await bridge.refresh({ group: "ops" });
  await bridge.refresh({ group: "ppl" });
  assert.deepEqual(deps.calls, ["ops", "ppl"]);
});

test("refresh leads: awaited, per-source ok with row count", async () => {
  const { bridge, deps } = makeBridge();
  const result = await bridge.refresh({ group: "leads" });
  assert.deepEqual(deps.calls, ["leads"]);
  assert.equal(result.supported, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.state, "ok");
  assert.ok(result.results[0]?.detail.includes("42"));
});

test("refresh dingtalk: startSummary failure surfaces honestly as failed", async () => {
  const { bridge } = makeBridge({}, {
    dingtalkStartSummary: async () => ({ ok: false, error: "historical_read_only", status: { state: "idle" }, reused: false }),
  });
  const result = await bridge.refresh({ group: "dingtalk" });
  assert.equal(result.supported, true);
  assert.ok(result.results.length >= 1);
  assert.ok(result.results.every((r) => r.state === "failed"));
  assert.ok(result.results[0]?.detail.includes("historical_read_only"));
});

test("refresh already-running group → datasource_busy (409 semantics)", async () => {
  const { bridge } = makeBridge({}, { crmStatus: () => ({ state: "running", startedAt: "x", finishedAt: null, error: null }) });
  await assert.rejects(
    () => bridge.refresh({ group: "cust" }),
    (error: unknown) => error instanceof DataSourceBridgeError && error.code === "datasource_busy",
  );
});

test("refresh single-flight: concurrent same-group refresh → busy", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { bridge } = makeBridge({}, {
    leadsRefresh: async () => { await gate; return { summary: { total: 1, open: 1, radarAt: "", fetchedAt: "" } }; },
  });
  const first = bridge.refresh({ group: "leads" });
  await assert.rejects(
    () => bridge.refresh({ group: "leads" }),
    (error: unknown) => error instanceof DataSourceBridgeError && error.code === "datasource_busy",
  );
  release();
  await first;
});

test("refresh upstream failure → datasource_refresh_failed with redacted message", async () => {
  const { bridge } = makeBridge({}, {
    leadsRefresh: async () => {
      throw Object.assign(new Error("AccessKeyId=LTAI5tSyntheticSyntheticValue01 拉取失败"), { code: "leads_unavailable" });
    },
  });
  await assert.rejects(
    () => bridge.refresh({ group: "leads" }),
    (error: unknown) => {
      assert.ok(error instanceof DataSourceBridgeError);
      assert.equal(error.code, "datasource_refresh_failed");
      assert.ok(!error.message.includes("LTAI5tSyntheticSyntheticValue01"), "credential-shaped text must be redacted");
      return true;
    },
  );
});

test("refresh unsupported group → supported:false with reason, never fakes success", async () => {
  const { bridge, deps } = makeBridge();
  const result = await bridge.refresh({ group: "okr" });
  assert.equal(result.supported, false);
  assert.ok(result.reason && result.reason.length > 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(deps.calls, []);
});

test("refresh invalid body → datasource_invalid_request", async () => {
  const { bridge } = makeBridge();
  for (const body of [undefined, {}, { group: 42 }, { group: "" }, { group: "nope" }]) {
    await assert.rejects(
      () => bridge.refresh(body),
      (error: unknown) => error instanceof DataSourceBridgeError && error.code === "datasource_invalid_request",
    );
  }
});

/* ============================= handle ============================= */

test("handle: POST refresh route returns envelope and 405 on wrong method", async () => {
  const { bridge } = makeBridge();
  const response = await routed(bridge, "POST", "/local/datasources/refresh", { group: "cust" });
  assert.ok(response);
  assert.equal(response.status, 200);
  const payload = JSON.parse(await response.text()) as { ok: boolean; data: { group: string; supported: boolean } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.group, "cust");
  assert.equal(payload.data.supported, true);

  const wrong = await routed(bridge, "POST", "/local/datasources");
  assert.ok(wrong);
  assert.equal(wrong.status, 405);

  const unrelated = await routed(bridge, "GET", "/local/health");
  assert.equal(unrelated, undefined);
});

test("handle: error envelope maps codes to 400/409/502", async () => {
  const { bridge } = makeBridge();
  const bad = await routed(bridge, "POST", "/local/datasources/refresh", { group: "nope" });
  assert.ok(bad);
  assert.equal(bad.status, 400);
  const badPayload = JSON.parse(await bad.text()) as { ok: boolean; error: { code: string } };
  assert.equal(badPayload.ok, false);
  assert.equal(badPayload.error.code, "datasource_invalid_request");

  const busyBridge = makeBridge({}, { crmStatus: () => ({ state: "running" }) }).bridge;
  const busy = await routed(busyBridge, "POST", "/local/datasources/refresh", { group: "cust" });
  assert.ok(busy);
  assert.equal(busy.status, 409);

  const failBridge = makeBridge({}, { leadsRefresh: async () => { throw new Error("synthetic"); } }).bridge;
  const failed = await routed(failBridge, "POST", "/local/datasources/refresh", { group: "leads" });
  assert.ok(failed);
  assert.equal(failed.status, 502);
});

test("handle: oversized or non-JSON body → datasource_invalid_request (400)", async () => {
  const { bridge } = makeBridge();
  const response = await bridge.handle(new Request(`http://${HOST}/local/datasources/refresh`, {
    method: "POST",
    headers: { host: HOST, "content-type": "application/json" },
    body: "not-json",
  }));
  assert.ok(response);
  assert.equal(response.status, 400);
});
