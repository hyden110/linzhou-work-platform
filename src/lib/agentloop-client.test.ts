import assert from "node:assert/strict";
import test from "node:test";

import {
  agentloopErrorMessage,
  AgentloopClientError,
  confirmAgentloopTicket,
  deleteAgentloopCreds,
  dryAgentloopTicket,
  fetchAgentloopCreds,
  fetchAgentloopTickets,
  saveAgentloopCreds,
  testAgentloopConnection,
} from "./agentloop-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：AK/SK/票据一律合成串（LTAIsynthAk0001 / synthSk000…1 / synth-ticket-*）；
// fetch 全程 mock，零真实网络。
// ---------------------------------------------------------------------------

const SYNTH_AK = "LTAIsynthAk0001";
const SYNTH_SK = "synthSk0000000000000000000001";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okData = (data: unknown): Response => jsonRes({ ok: true, data });
const errRes = (code: string, message: string, status = 400): Response => jsonRes({ ok: false, error: { code, message } }, status);

interface Seen {
  url: string;
  method: string;
  body: string;
}

function mockFetch(response: Response | (() => Response), seen?: Seen[]): typeof fetch {
  return (async (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    seen?.push({ url: req.url, method: req.method, body: await req.clone().text() });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
}

test("fetchAgentloopCreds projects the masked whitelist view only", async () => {
  const seen: Seen[] = [];
  const view = await fetchAgentloopCreds(mockFetch(okData({
    set: true, mask: "LTAI****0001", updatedAt: "2026-10-20T02:30:00.000Z",
    storage: "file-0600", junk: "dropped",
  }), seen));
  assert.ok(seen[0].url.endsWith("/local/agentloop/creds"));
  assert.equal(seen[0].method, "GET");
  assert.deepEqual(view, { set: true, mask: "LTAI****0001", updatedAt: "2026-10-20T02:30:00.000Z" });

  const unset = await fetchAgentloopCreds(mockFetch(okData({ set: false, mask: null, updatedAt: null })));
  assert.deepEqual(unset, { set: false, mask: null, updatedAt: null });

  const coerced = await fetchAgentloopCreds(mockFetch(okData({ set: "yes", mask: 42 })));
  assert.deepEqual(coerced, { set: false, mask: null, updatedAt: null }, "坏形状回落诚实未设置");
});

test("saveAgentloopCreds uses PUT with a JSON body and surfaces validation errors", async () => {
  const seen: Seen[] = [];
  const view = await saveAgentloopCreds(
    { accessKeyId: SYNTH_AK, accessKeySecret: SYNTH_SK },
    mockFetch(okData({ set: true, mask: "LTAI****0001", updatedAt: "2026-10-20T02:30:00.000Z" }), seen),
  );
  assert.equal(seen[0].method, "PUT");
  assert.deepEqual(JSON.parse(seen[0].body), { accessKeyId: SYNTH_AK, accessKeySecret: SYNTH_SK });
  assert.equal(view.mask, "LTAI****0001");

  await assert.rejects(
    saveAgentloopCreds({ accessKeyId: "x", accessKeySecret: "y" }, mockFetch(errRes("agentloop_invalid_request", "AccessKey ID 不合法。"))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "agentloop_invalid_request" && error.detail.includes("不合法"),
  );
});

test("deleteAgentloopCreds uses DELETE and projects removed", async () => {
  const seen: Seen[] = [];
  const view = await deleteAgentloopCreds(mockFetch(okData({ set: false, mask: null, updatedAt: null, removed: true }), seen));
  assert.equal(seen[0].method, "DELETE");
  assert.deepEqual(view, { set: false, mask: null, updatedAt: null, removed: true });
});

test("testAgentloopConnection keeps the honest tri-state and drops bad targets", async () => {
  const view = await testAgentloopConnection(mockFetch(okData({
    state: "ok",
    note: "全部视图可读",
    checkedAt: "2026-10-20T02:30:00.000Z",
    targets: [
      { id: "v1", t: "合成视图", ok: true, note: "logstore synth-store 可读" },
      { junk: true },
      null,
    ],
  })));
  assert.equal(view.state, "ok");
  assert.equal(view.targets.length, 1, "坏行丢弃");
  assert.equal(view.targets[0].id, "v1");

  const weird = await testAgentloopConnection(mockFetch(okData({ state: "maybe", targets: "nope" })));
  assert.equal(weird.state, "error", "未知状态一律按异常呈现，绝不假绿");
  assert.deepEqual(weird.targets, []);
});

test("dryAgentloopTicket requires a token and projects the masked summary", async () => {
  const dry = await dryAgentloopTicket(mockFetch(okData({
    token: "t".repeat(48),
    expiresAt: "2026-10-20T02:35:00.000Z",
    credsMask: "LTAI****0001",
    request: {
      method: "POST", host: "cn-shanghai.log.aliyuncs.com", resource: "/tickets?expirationTime=86400",
      apiVersion: "0.6.0", signatureMethod: "hmac-sha1", authorizationPreview: "SLS LTAI****0001:<签名于确认时计算>",
      ttlSec: 86400, region: "cn-shanghai", externalWrite: true,
    },
  })));
  assert.equal(dry.token.length, 48);
  assert.equal(dry.request.resource, "/tickets?expirationTime=86400");
  assert.equal(dry.request.externalWrite, true);

  await assert.rejects(
    dryAgentloopTicket(mockFetch(okData({ token: "", request: {} }))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "invalid_response",
  );
  await assert.rejects(
    dryAgentloopTicket(mockFetch(errRes("agentloop_creds_missing", "尚未配置凭据。", 409))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "agentloop_creds_missing",
  );
});

test("confirmAgentloopTicket posts the confirm token and projects the masked outcome", async () => {
  const seen: Seen[] = [];
  const outcome = await confirmAgentloopTicket("t".repeat(48), mockFetch(okData({
    ticketMask: "synt****0001", ttl: 86400, issuedAt: "2026-10-20T02:30:00.000Z",
    expireAt: "2026-10-21T02:30:00.000Z", region: "cn-shanghai", audited: true,
  }), seen));
  assert.equal(seen[0].method, "POST");
  assert.ok(seen[0].url.endsWith("/local/agentloop/ticket-confirm"));
  assert.deepEqual(JSON.parse(seen[0].body), { confirm: "t".repeat(48) });
  assert.equal(outcome.ticketMask, "synt****0001");
  assert.equal(outcome.audited, true);

  await assert.rejects(
    confirmAgentloopTicket("x", mockFetch(errRes("agentloop_confirm_mismatch", "人工确认未完成。", 409))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "agentloop_confirm_mismatch",
  );
});

test("fetchAgentloopTickets projects audits newest-first and keeps total", async () => {
  const view = await fetchAgentloopTickets(mockFetch(okData({
    tickets: [
      { at: "2026-10-20T02:30:00.000Z", action: "ticket", status: "ok", ticketMask: "synt****0001", ttl: 86400, expireAt: "", reason: "" },
      { at: "x" },
    ],
    total: 51,
  })));
  assert.equal(view.tickets.length, 1, "坏行丢弃");
  assert.equal(view.tickets[0].status, "ok");
  assert.equal(view.total, 51);
});

test("network failure and foreign payloads map to unavailable", async () => {
  const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(
    fetchAgentloopCreds(failing),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "unavailable",
  );
  await assert.rejects(
    fetchAgentloopCreds(mockFetch(jsonRes({ ok: true, data: "not-a-record" }))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "invalid_response",
  );
  await assert.rejects(
    fetchAgentloopCreds(mockFetch(jsonRes({ nope: true }, 500))),
    (error: unknown) => error instanceof AgentloopClientError && error.code === "unavailable",
  );
});

test("agentloopErrorMessage gives honest copy per code without repeating detail", () => {
  assert.ok(agentloopErrorMessage(new AgentloopClientError("unavailable")).includes("本地桥未启动"));
  assert.ok(agentloopErrorMessage(new AgentloopClientError("agentloop_creds_missing")).includes("凭据"));
  assert.ok(agentloopErrorMessage(new AgentloopClientError("agentloop_confirm_mismatch")).includes("没有执行出票")
    || agentloopErrorMessage(new AgentloopClientError("agentloop_confirm_mismatch")).includes("未执行"));
  assert.ok(agentloopErrorMessage(new AgentloopClientError("agentloop_upstream_auth")).includes("鉴权")
    || agentloopErrorMessage(new AgentloopClientError("agentloop_upstream_auth")).includes("签名"));
  // detail 与 base 首句相同不复读（composeErrorMessage 口径）
  const composed = agentloopErrorMessage(new AgentloopClientError("agentloop_upstream_error", "SLS 出票失败：上游返回 HTTP 500。"));
  assert.equal(composed.match(/SLS 出票失败/g)?.length, 1, "同首句 detail 不重复拼接");
  assert.ok(agentloopErrorMessage(new Error("whatever")).length > 0, "未知错误也有兜底文案");
});
