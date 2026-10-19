import assert from "node:assert/strict";
import test from "node:test";

import {
  agentsErrorMessage,
  fetchAgentsAgentloop,
  fetchAgentsState,
  fetchAgentsWechat,
  AgentsClientError,
} from "./agents-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：端点/凭据/微信 全为合成值（ecs-syn.example / wxid_syn_0001 /
// 甲科技·乙股份）；fetch 全程 mock，绝不触网。重点断言：白名单投影（敌意
// 字段不入前端）、离线/未配置/不可用的错误码与文案、无任何 POST 语义。
// ---------------------------------------------------------------------------

const WAKE_STATE = {
  daemon: {
    status: "ok", port: 21121, url: "http://127.0.0.1:21121", http: 200,
    note: "daemon 在线（/api/health 200）", checkedAt: "2026-10-20T02:30:00.000Z",
  },
  entries: [
    { id: "console", t: "Console", path: "/" },
    { id: "wakers", t: "Wakers", path: "/wakers" },
    { id: "knowledge", t: "Knowledge", path: "/knowledge" },
    { id: "conversations", t: "Conversations", path: "/conversations" },
  ],
  endpoints: [{ id: "ecs", t: "ECS 云端（合成）", url: "https://ecs-syn.example/console" }],
  hostile: { sk: "sk-should-never-reach-ui", authorization: "Bearer LTAI9999abcd0123" },
};

const LOOP_STATUS = {
  configured: true, mask: "LTAI****abcd", updatedAt: "2026-10-19T20:00:00.000Z",
  note: "凭据已配置（本台只读掩码，明文不读取、不透出）。",
  console: "https://agentloop.console.aliyun.com/agentloop/home",
  views: [{ id: "agent-event-syn", t: "合成视图", sub: "agent-event-syn", project: "proj-syn-001", logstore: "agent-event-syn", region: "cn-beijing" }],
  writesNote: "凭据管理与出票：待授权，本台未开通",
  accessKeyId: "LTAI0123456789abcd",
};

const WECHAT_VIEW = {
  at: "2026-10-20T02:30:00.000Z", updatedAt: "2026-10-20T01:00:00.000Z",
  me: { wxid: "wxid_syn_0001", name: "甲科技对接人（合成）" },
  source: { dbs: 12, tables: 340, messages: 56000, groups: 109, singles: 42, window: 90 },
  stats: { groups: 109, groupsActive7: 31, groupsActive30: 58, groupsMine7: 17, custBound: 12, atMeAll: 203 },
  groups: [{ name: "真实群名绝不透出" }],
  todos: [{ text: "待办内容绝不透出" }],
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function okData(data: unknown): Response {
  return jsonRes({ ok: true, data });
}

async function expectError(promise: Promise<unknown>): Promise<AgentsClientError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentsClientError;
  }
  throw new Error("expected the promise to reject");
}

test("fetchAgentsState projects the whitelist and drops hostile fields", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData(WAKE_STATE);
  }) as unknown as typeof fetch;
  const state = await fetchAgentsState(fetchImpl);
  assert.equal(requested, "http://localhost/local/agents/state");
  assert.equal(state.daemon.status, "ok");
  assert.equal(state.daemon.port, 21121);
  assert.equal(state.entries.length, 4);
  assert.equal(state.entries[0]?.path, "/");
  assert.equal(state.endpoints[0]?.url, "https://ecs-syn.example/console");
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("sk-should-never-reach-ui"), false, "白名单外字段不得进入前端");
  assert.equal(serialized.includes("LTAI9999abcd0123"), false);
});

test("fetchAgentsState keeps an honest down daemon without faking green", async () => {
  const fetchImpl = (async () => okData({
    daemon: { status: "down", port: 19820, url: "http://127.0.0.1:19820", http: null, note: "daemon 未连通（fetch failed）", checkedAt: "2026-10-20T02:30:00.000Z" },
    entries: [], endpoints: [],
  })) as unknown as typeof fetch;
  const state = await fetchAgentsState(fetchImpl);
  assert.equal(state.daemon.status, "down");
  assert.match(state.daemon.note, /未连通/);
});

test("fetchAgentsAgentloop projects mask/console/views and never the access key", async () => {
  const fetchImpl = (async () => okData(LOOP_STATUS)) as unknown as typeof fetch;
  const status = await fetchAgentsAgentloop(fetchImpl);
  assert.equal(status.configured, true);
  assert.equal(status.mask, "LTAI****abcd");
  assert.equal(status.console, "https://agentloop.console.aliyun.com/agentloop/home");
  assert.equal(status.views.length, 1);
  assert.equal(status.views[0]?.logstore, "agent-event-syn");
  assert.match(status.writesNote, /待授权，本台未开通/);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("LTAI0123456789abcd"), false, "AK 明文绝不透出");
});

test("fetchAgentsWechat projects stats whitelist and drops message content", async () => {
  const fetchImpl = (async () => okData(WECHAT_VIEW)) as unknown as typeof fetch;
  const view = await fetchAgentsWechat(fetchImpl);
  assert.equal(view.me.wxid, "wxid_syn_0001");
  assert.equal(view.stats?.custBound, 12);
  assert.equal(view.stats?.atMeAll, 203);
  assert.equal(view.source?.window, 90);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("真实群名"), false, "群台账内容不得进入前端");
  assert.equal(serialized.includes("待办内容"), false);
});

test("fetchAgentsWechat tolerates missing stats fields as null", async () => {
  const fetchImpl = (async () => okData({
    at: "2026-10-20T02:30:00.000Z", updatedAt: "",
    me: { wxid: "wxid_syn_0002", name: "" },
    source: { groups: 3 },
    stats: { groups: 3 },
  })) as unknown as typeof fetch;
  const view = await fetchAgentsWechat(fetchImpl);
  assert.equal(view.stats?.groups, 3);
  assert.equal(view.stats?.groupsActive7, null, "缺字段容错为 null，不造 0");
  assert.equal(view.source?.dbs, null);
});

test("error codes map to honest copy: offline, unconfigured, unavailable", async () => {
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const offlineError = await expectError(fetchAgentsState(offline));
  assert.equal(offlineError.code, "unavailable");
  assert.match(agentsErrorMessage(offlineError), /本地桥未启动/);
  assert.match(agentsErrorMessage(offlineError), /npm run dev:function/);

  const unconfigured = (async () => jsonRes({ ok: false, error: "agents_unconfigured", message: "未配置 snapshotPath" }, 400)) as unknown as typeof fetch;
  const unconfiguredError = await expectError(fetchAgentsWechat(unconfigured));
  assert.equal(unconfiguredError.code, "agents_unconfigured");
  assert.equal(unconfiguredError.detail, "未配置 snapshotPath");
  assert.match(agentsErrorMessage(unconfiguredError), /agents\.json/);

  const unavailable = (async () => jsonRes({ ok: false, error: "agents_unavailable", message: "快照不是 JSON" }, 502)) as unknown as typeof fetch;
  const unavailableError = await expectError(fetchAgentsAgentloop(unavailable));
  assert.equal(unavailableError.code, "agents_unavailable");
  assert.match(agentsErrorMessage(unavailableError), /暂不可用/);

  const unknownError = (async () => jsonRes({ ok: false, error: "something_new" }, 500)) as unknown as typeof fetch;
  const unknown = await expectError(fetchAgentsState(unknownError));
  assert.equal(unknown.code, "unavailable", "白名单外错误码一律折叠为 unavailable");

  const badJson = (async () => new Response("{ 不是 JSON", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await expectError(fetchAgentsState(badJson))).code, "unavailable");

  const badShape = (async () => okData({ daemon: "ok" })) as unknown as typeof fetch;
  const shape = await expectError(fetchAgentsState(badShape));
  assert.equal(shape.code, "invalid_response");
  assert.match(agentsErrorMessage(shape), /无法识别/);
});
