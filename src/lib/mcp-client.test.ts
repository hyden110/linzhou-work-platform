import assert from "node:assert/strict";
import test from "node:test";

import {
  checkMcpConnectors,
  confirmMcpConnector,
  createMcpKey,
  dryMcpConnector,
  fetchMcpConnectors,
  fetchMcpKeys,
  fetchMcpService,
  mcpErrorMessage,
  McpClientError,
  revokeMcpKey,
  toggleMcpService,
} from "./mcp-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：key 一律 synth-*、hashPrefix 合成十六进制、明文只用 sak_0123…合成形态；
// fetch 全程 mock——零真实网络。url 域名 mcp.synth.example。
// ---------------------------------------------------------------------------

const SYNTH_PLAIN_KEY = "sak_0123456789abcdef0123456789abcdef";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okData = (data: unknown): Response => jsonRes({ ok: true, data });

function errRes(code: string, message: string, status = 400): Response {
  return jsonRes({ ok: false, error: { code, message } }, status);
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function capture(responder: (req: CapturedRequest) => Response): { calls: CapturedRequest[]; run: typeof fetch } {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    run: (async (input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const raw = typeof init?.body === "string"
        ? init.body
        : (input instanceof Request ? await input.clone().text() : "");
      calls.push({ url, method, body: raw ? JSON.parse(raw) : undefined });
      return responder(calls[calls.length - 1]);
    }) as typeof fetch,
  };
}

const KEY_VIEW = {
  id: 3,
  name: "synth-qoder",
  hashPrefix: "0123abcd",
  scopes: ["connectors", "meta"],
  createdAt: "2026-10-20T02:30:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  note: "synth note",
};

test("fetchMcpService projects the whitelist and drops bad rows", async () => {
  const mock = capture(() => okData({
    enabled: true,
    tools: 4,
    toolNames: ["mcp_service_state", "mcp_key_list", "mcp_connector_list", "mcp_audit_tail"],
    scopes: ["service", "keys", "connectors", "meta", "bogus"],
    keys: { active: 1, revoked: 0 },
    keyViews: [KEY_VIEW, { junk: true }, null, { ...KEY_VIEW, id: "bad" }],
    auditTail: [{ at: "2026-10-20T02:31:00.000Z", action: "key_created", keyId: 3, target: "synth-qoder", ok: true, note: "hashPrefix 0123abcd" }, { noAction: true }],
    rpcMounted: false,
  }));
  const view = await fetchMcpService(mock.run);
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/service"));
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(view.enabled, true);
  assert.equal(view.rpcMounted, false);
  assert.deepEqual([...view.scopes], ["service", "keys", "connectors", "meta"], "未知 scope 剔除");
  assert.equal(view.keyViews.length, 1, "坏行丢弃");
  assert.deepEqual(view.keyViews[0], KEY_VIEW);
  assert.equal(view.auditTail.length, 1, "无 action 的坏审计行丢弃");
  assert.deepEqual(view.keys, { active: 1, revoked: 0 });
});

test("fetchMcpService rejects malformed payloads as invalid_response", async () => {
  const notRecord = capture(() => okData("synth-string"));
  await assert.rejects(() => fetchMcpService(notRecord.run), (e: unknown) => {
    assert.ok(e instanceof McpClientError);
    assert.equal(e.code, "invalid_response");
    return true;
  });

  const badKeys = capture(() => okData({ enabled: true, keys: { active: "x" }, keyViews: [], auditTail: [], toolNames: [], scopes: [] }));
  await assert.rejects(() => fetchMcpService(badKeys.run), (e: unknown) => e instanceof McpClientError && e.code === "invalid_response");
});

test("fetchMcpKeys projects counts and masked rows only", async () => {
  const mock = capture(() => okData({ keys: [KEY_VIEW, { junk: 1 }], active: 1, revoked: 2, scopes: ["meta"] }));
  const view = await fetchMcpKeys(mock.run);
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/keys"));
  assert.equal(view.keys.length, 1);
  assert.deepEqual(view.keys[0], KEY_VIEW);
  assert.deepEqual({ active: view.active, revoked: view.revoked }, { active: 1, revoked: 2 });
});

test("createMcpKey posts the whitelisted body and returns the one-time plaintext", async () => {
  const mock = capture(() => okData({ key: SYNTH_PLAIN_KEY, record: KEY_VIEW, note: "只显示一次" }));
  const out = await createMcpKey({ name: "synth-qoder", scope: ["meta", "connectors"], note: "synth note" }, mock.run);
  assert.equal(mock.calls[0].method, "POST");
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/keys"));
  assert.deepEqual(mock.calls[0].body, { name: "synth-qoder", scope: ["meta", "connectors"], note: "synth note" });
  assert.equal(out.key, SYNTH_PLAIN_KEY, "明文只经此一次应答透传（客户端不缓存）");
  assert.deepEqual(out.record, KEY_VIEW);
  assert.ok(out.note.includes("只显示一次"));

  const noScope = capture(() => okData({ key: SYNTH_PLAIN_KEY, record: KEY_VIEW, note: "" }));
  await createMcpKey({ name: "synth-default" }, noScope.run);
  assert.deepEqual(noScope.calls[0].body, { name: "synth-default" }, "缺省 scope 不下发字段（桥侧走全量白名单）");

  const badName = capture(() => okData({}));
  await assert.rejects(() => createMcpKey({ name: "  " }, badName.run), (e: unknown) => e instanceof McpClientError && e.code === "mcp_invalid_request");
  assert.equal(badName.calls.length, 0, "空名客户端即拒，不发请求");
});

test("revokeMcpKey requires confirm === String(keyId) client-side and maps 409 honestly", async () => {
  const mismatch = capture(() => errRes("mcp_confirm_mismatch", "吊销需要 body.confirm 严格等于字符串 \"3\"。", 409));
  await assert.rejects(() => revokeMcpKey({ keyId: 3, confirm: "nope" }, mismatch.run), (e: unknown) => {
    assert.ok(e instanceof McpClientError);
    assert.equal(e.code, "mcp_confirm_mismatch");
    assert.ok(e.detail.includes("confirm"));
    return true;
  });

  const mock = capture(() => okData({ ...KEY_VIEW, revokedAt: "2026-10-20T03:00:00.000Z" }));
  const out = await revokeMcpKey({ keyId: 3, confirm: "3" }, mock.run);
  assert.deepEqual(mock.calls[0].body, { keyId: 3, confirm: "3" });
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/keys/revoke"));
  assert.equal(out.revokedAt, "2026-10-20T03:00:00.000Z");

  const ghost = capture(() => errRes("mcp_not_found", "没有这个可吊销的 key", 404));
  await assert.rejects(() => revokeMcpKey({ keyId: 99, confirm: "99" }, ghost.run), (e: unknown) => e instanceof McpClientError && e.code === "mcp_not_found");
});

test("toggleMcpService sends boolean true confirm and projects the result", async () => {
  const mock = capture(() => okData({ enabled: true, at: "2026-10-20T02:30:00.000Z" }));
  const out = await toggleMcpService({ op: "enable", confirm: true }, mock.run);
  assert.deepEqual(mock.calls[0].body, { op: "enable", confirm: true }, "confirm 必须是布尔 true（不是字符串）");
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/service/toggle"));
  assert.deepEqual(out, { enabled: true, at: "2026-10-20T02:30:00.000Z" });

  const bad = capture(() => okData({}));
  await assert.rejects(
    () => toggleMcpService({ op: "enable", confirm: "true" as unknown as true }, bad.run),
    (e: unknown) => e instanceof McpClientError && e.code === "mcp_invalid_request",
  );
  assert.equal(bad.calls.length, 0, "非布尔 true 客户端即拒（桥侧 confirm 闸门的前置护栏）");
  await assert.rejects(
    () => toggleMcpService({ op: "restart" as unknown as "enable", confirm: true }, bad.run),
    (e: unknown) => e instanceof McpClientError && e.code === "mcp_invalid_request",
  );
});

test("fetchMcpConnectors projects sources, servers and summary", async () => {
  const server = {
    name: "synth-http",
    transport: "sse",
    disabled: false,
    valid: true,
    effective: true,
    sources: ["workbench"],
    url: "https://mcp.synth.example/sse/***?key=***",
    headers: ["Authorization"],
  };
  const mock = capture(() => okData({
    sources: [{ role: "workbench", label: "工作台登记", shown: "~/.synth/connectors.json", effective: true, writable: true, exists: true, count: 1, error: null }, { junk: 1 }],
    servers: [server, { name: "" }, null],
    summary: { total: 1, effective: 1, notLoaded: 0, disabled: 0, broken: 0, junk: true },
  }));
  const view = await fetchMcpConnectors(mock.run);
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/connectors"));
  assert.equal(view.sources.length, 1, "坏来源行丢弃");
  assert.equal(view.servers.length, 1, "无名/坏行丢弃");
  assert.deepEqual(view.servers[0], server);
  assert.deepEqual(view.summary, { total: 1, effective: 1, notLoaded: 0, disabled: 0, broken: 0 }, "summary 只取白名单五数");
});

test("checkMcpConnectors posts optional filters and projects per-connector results", async () => {
  const result = { name: "synth-stdio", status: "ok", note: "2 个工具", toolCount: 2, tools: ["synth_read_a", "synth_read_b"], ms: 120, checkedAt: "2026-10-20T02:30:00.000Z" };
  const mock = capture(() => okData({ checkedAt: "2026-10-20T02:30:00.000Z", ms: 130, attempted: 1, skipped: 0, results: [result, { name: "", status: "ok" }] }));
  const view = await checkMcpConnectors({ name: "synth-stdio" }, mock.run);
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/connectors/check"));
  assert.deepEqual(mock.calls[0].body, { name: "synth-stdio" });
  assert.equal(view.results.length, 1, "无名坏行丢弃");
  assert.deepEqual(view.results[0], result);
  assert.deepEqual({ attempted: view.attempted, skipped: view.skipped }, { attempted: 1, skipped: 0 });

  const all = capture(() => okData({ checkedAt: "", ms: 0, attempted: 0, skipped: 0, results: [] }));
  await checkMcpConnectors({}, all.run);
  assert.deepEqual(all.calls[0].body, {}, "无过滤条件不下发多余字段");

  const busy = capture(() => errRes("mcp_busy", "已有一轮体检在跑", 409));
  await assert.rejects(() => checkMcpConnectors({}, busy.run), (e: unknown) => e instanceof McpClientError && e.code === "mcp_busy");
});

test("dryMcpConnector and confirmMcpConnector carry the one-time token through", async () => {
  const dryData = {
    token: "a".repeat(48),
    expiresAt: "2026-10-20T02:35:00.000Z",
    op: "set",
    role: "workbench",
    name: "synth-new",
    existed: false,
    target: { shown: "~/.synth/connectors.json", role: "workbench", dot: "mcpServers" },
    diff: { before: null, after: '{"command":"~/bin/synth-node"}' },
    note: "dry-run 未写入任何文件",
  };
  const mock = capture(() => okData(dryData));
  const dry = await dryMcpConnector({ op: "set", role: "workbench", name: "synth-new", def: { command: "~/bin/synth-node" } }, mock.run);
  assert.ok(mock.calls[0].url.endsWith("/local/mcp/connectors/dry"));
  assert.deepEqual(mock.calls[0].body, { op: "set", role: "workbench", name: "synth-new", def: { command: "~/bin/synth-node" } });
  assert.deepEqual(dry, dryData);
  assert.equal(dry.token.length, 48);

  const confirmMock = capture(() => okData({ op: "set", role: "workbench", name: "synth-new", existed: false, backup: "~/connectors.json.bak", note: "已新增", server: null }));
  const confirmed = await confirmMcpConnector({ confirm: dry.token }, confirmMock.run);
  assert.ok(confirmMock.calls[0].url.endsWith("/local/mcp/connectors/confirm"));
  assert.deepEqual(confirmMock.calls[0].body, { confirm: "a".repeat(48) });
  assert.equal(confirmed.backup, "~/connectors.json.bak");
  assert.equal(confirmed.server, null);

  const replay = capture(() => errRes("mcp_confirm_mismatch", "token 已消费", 409));
  await assert.rejects(() => confirmMcpConnector({ confirm: dry.token }, replay.run), (e: unknown) => e instanceof McpClientError && e.code === "mcp_confirm_mismatch");

  const badToken = capture(() => okData({}));
  await assert.rejects(() => confirmMcpConnector({ confirm: "" }, badToken.run), (e: unknown) => e instanceof McpClientError && e.code === "mcp_invalid_request");
  assert.equal(badToken.calls.length, 0, "空 token 客户端即拒");
});

test("transport failures and unknown codes map to honest client errors", async () => {
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(() => fetchMcpService(offline), (e: unknown) => e instanceof McpClientError && e.code === "unavailable");

  const unknownCode = capture(() => errRes("synth_bogus_code", "boom", 500));
  await assert.rejects(() => fetchMcpKeys(unknownCode.run), (e: unknown) => e instanceof McpClientError && e.code === "unavailable");

  const notOkNoBody = (async () => new Response("gateway down", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchMcpKeys(notOkNoBody), (e: unknown) => e instanceof McpClientError && e.code === "unavailable");
});

test("mcpErrorMessage gives displayable honest copy per code", () => {
  assert.ok(mcpErrorMessage(new McpClientError("unavailable")).includes("本地桥"));
  assert.ok(mcpErrorMessage(new McpClientError("mcp_busy", "已有一轮体检在跑")).includes("已有一轮体检在跑"), "detail 如实拼接");
  assert.ok(mcpErrorMessage(new McpClientError("mcp_confirm_mismatch")).includes("确认"));
  assert.ok(mcpErrorMessage(new McpClientError("mcp_store_unavailable")).includes("存储"));
  assert.ok(mcpErrorMessage(new McpClientError("mcp_not_found")).length > 0);
  assert.ok(mcpErrorMessage(new Error("synthetic")).includes("本地桥"), "非客户端错误按 unavailable 兜底");
  const same = mcpErrorMessage(new McpClientError("mcp_busy", "已有一轮体检在跑：等它结束再试"));
  assert.equal(same.split("已有一轮体检在跑").length, 2, "同句不复读（composeErrorMessage 去重）");
});
