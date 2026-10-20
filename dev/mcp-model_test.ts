import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMcpTools,
  CANONICAL_PROTOCOL_VERSION,
  createRpcEndpoint,
  createSessionStore,
  dispatch,
  errNote,
  isValidScopes,
  keyViewOf,
  maskArg,
  maskDef,
  maskKV,
  maskUrl,
  MCP_CONNECTOR_NAME_RE,
  MCP_KEY_PATTERN,
  MCP_MAX_TEXT,
  MCP_ROUTES,
  MCP_SCOPES,
  mcpTextResult,
  normalizeKeyDoc,
  parseMessage,
  pickMsg,
  redactTail,
  scopesOf,
  secretNames,
  sha256Hex,
  tildePath,
  transportOf,
  type McpKeyRecord,
  type McpKeyStore,
} from "./mcp-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：连接器/工具/key 一律「synth-*」合成值；url 域名用 mcp.synth.example；
// 密钥形态串只用 synthSecret* —— 零真实网络、零真实子进程、零真实凭据。
// ---------------------------------------------------------------------------

const HOME = "/synth/home";

function keyRecord(overrides: Partial<McpKeyRecord> = {}): McpKeyRecord {
  return {
    id: 1,
    name: "synth-key",
    hash: sha256Hex("sak_00000000000000000000000000000000"),
    scopes: ["meta"],
    createdAt: "2026-10-20T02:30:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    note: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 路由表与 scope 白名单（常量口径）
// ---------------------------------------------------------------------------

test("MCP_ROUTES covers the nine contracted routes", () => {
  const paths = MCP_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(paths, [
    "GET /local/mcp/service",
    "POST /local/mcp/keys",
    "POST /local/mcp/keys/revoke",
    "GET /local/mcp/keys",
    "POST /local/mcp/service/toggle",
    "GET /local/mcp/connectors",
    "POST /local/mcp/connectors/check",
    "POST /local/mcp/connectors/dry",
    "POST /local/mcp/connectors/confirm",
  ]);
});

test("isValidScopes enforces the whitelist strictly", () => {
  assert.equal(isValidScopes(["service", "meta"]), true);
  assert.equal(isValidScopes([]), false, "空数组不放行（要么不给走缺省，要么给合法项）");
  assert.equal(isValidScopes(["bogus"]), false, "未知 scope 拒绝");
  assert.equal(isValidScopes("service"), false, "非数组拒绝（字符串拆分归桥层）");
  assert.equal(isValidScopes(null), false);
  for (const scope of MCP_SCOPES) assert.equal(isValidScopes([scope]), true);
});

// ---------------------------------------------------------------------------
// 2. sha256 与 key 视图（落盘/出站只有 hash，视图只有前 8 位 hint）
// ---------------------------------------------------------------------------

test("sha256Hex matches the known vector and key view only exposes 8-char prefix", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const rec = keyRecord();
  const view = keyViewOf(rec);
  assert.equal(view.hashPrefix, rec.hash.slice(0, 8));
  assert.equal(view.hashPrefix.length, 8);
  assert.ok(!("hash" in view), "视图绝不含全 hash");
  assert.ok(!("key" in view), "视图绝不含明文键位");
  assert.equal(view.name, "synth-key");
  assert.deepEqual(view.scopes, ["meta"]);
});

test("MCP_KEY_PATTERN accepts sak_ + 32 hex only", () => {
  assert.equal(MCP_KEY_PATTERN.test("sak_0123456789abcdef0123456789abcdef"), true);
  assert.equal(MCP_KEY_PATTERN.test("sak_0123456789ABCDEF0123456789abcdef"), false);
  assert.equal(MCP_KEY_PATTERN.test("sk_0123456789abcdef0123456789abcdef"), false);
  assert.equal(MCP_KEY_PATTERN.test("sak_0123456789abcdef"), false);
});

test("normalizeKeyDoc drops corrupt records and recomputes nextId", () => {
  const doc = normalizeKeyDoc({
    version: 1,
    nextId: 99,
    keys: [
      { id: 2, name: "b", hash: "a".repeat(64), scopes: ["meta"], createdAt: "x" },
      { id: 1, name: "a", hash: sha256Hex("sak_1"), scopes: ["service", "bogus"], createdAt: "y" },
      { id: "3", name: "bad-id", hash: "b".repeat(64) },
      { id: 4, name: "bad-hash", hash: "short" },
      null,
    ],
  });
  assert.deepEqual(doc.keys.map((k) => k.id), [1, 2], "坏 id / 坏 hash 记录丢弃，按 id 排序");
  assert.deepEqual([...doc.keys[0].scopes], ["service"], "未知 scope 逐项剔除");
  assert.equal(doc.nextId, 3, "nextId 从存活记录重算，绝不信损坏值");
});

// ---------------------------------------------------------------------------
// 3. 掩码纯函数（凭据形态串绝不出站）
// ---------------------------------------------------------------------------

test("maskUrl masks secret query values and long token path segments", () => {
  const masked = maskUrl("https://mcp.synth.example/sse/abcdefghij0123456789abcdefghij?key=synthSecretQuery0001&plain=1");
  assert.ok(masked.includes("***"), "token 路径段抹掉");
  assert.ok(!masked.includes("synthSecretQuery0001"), "key query 值抹掉");
  assert.ok(masked.includes("plain=1"), "非敏感 query 保留");
  assert.ok(!masked.includes("abcdefghij0123456789abcdefghij"));
  assert.equal(maskUrl("not a url"), "not a url", "非法 URL 原样截断兜底（≤120 字）");
  assert.equal(maskUrl("x".repeat(200)).length, 120);
});

test("maskArg masks credential-shaped args and tildes home paths", () => {
  assert.equal(maskArg("synthSecretTokenValue0000000001", HOME), "***");
  assert.equal(maskArg("/synth/home/tools/server.js", HOME), "~/tools/server.js");
  assert.equal(maskArg("--port", HOME), "--port");
});

test("maskKV and secretNames never leak secret-named values", () => {
  const masked = maskKV({ SYNTH_API_KEY: "synthSecret0001", PATH: "/synth/home/bin" }, HOME);
  assert.equal(masked.SYNTH_API_KEY, "***");
  assert.equal(masked.PATH, "~/bin");
  const names = secretNames({ Authorization: "Bearer x", Accept: "json" });
  assert.deepEqual(names, [
    { name: "Authorization", secret: true },
    { name: "Accept", secret: false },
  ]);
});

test("redactTail scrubs k=v credential shapes and keeps only the last line", () => {
  const out = redactTail("first line\ntoken=synthSecretValue0000000001 failed");
  assert.ok(!out.includes("synthSecretValue0000000001"));
  assert.ok(out.includes("token=***"));
  assert.ok(!out.includes("first line"));
});

test("tildePath only rewrites the exact home prefix", () => {
  assert.equal(tildePath("/synth/home/x.json", HOME), "~/x.json");
  assert.equal(tildePath("/other/x.json", HOME), "/other/x.json");
});

test("transportOf infers stdio/http/sse/unknown", () => {
  assert.equal(transportOf({ command: "node" }), "stdio");
  assert.equal(transportOf({ url: "https://x.example" }), "http");
  assert.equal(transportOf({ url: "https://x.example", type: "sse" }), "sse");
  assert.equal(transportOf({}), "unknown");
  assert.equal(transportOf(null), "unknown");
});

test("maskDef projects a shareable definition with credentials masked", () => {
  const masked = maskDef({
    command: "/synth/home/bin/node",
    args: ["server.js", "synthSecretTokenValue0000000001"],
    url: "https://mcp.synth.example/sse?key=synthSecretQuery0001",
    env: { SYNTH_TOKEN: "synthSecret0001" },
    headers: { Authorization: "Bearer synthSecret0002" },
    type: "sse",
  }, HOME);
  assert.equal(masked.command, "~/bin/node");
  assert.deepEqual(masked.args, ["server.js", "***"]);
  assert.ok(!JSON.stringify(masked).includes("synthSecret"));
  assert.deepEqual(masked.env, { SYNTH_TOKEN: "***" });
  assert.deepEqual(masked.headers, { Authorization: "***" });
});

test("MCP_CONNECTOR_NAME_RE rejects quotes and control chars", () => {
  assert.equal(MCP_CONNECTOR_NAME_RE.test("synth-connector"), true);
  assert.equal(MCP_CONNECTOR_NAME_RE.test('bad"name'), false);
  assert.equal(MCP_CONNECTOR_NAME_RE.test("bad\nname"), false);
  assert.equal(MCP_CONNECTOR_NAME_RE.test("x".repeat(81)), false);
});

// ---------------------------------------------------------------------------
// 4. JSON-RPC 协议纯函数（帧解析 / 会话 / dispatch）
// ---------------------------------------------------------------------------

test("parseMessage rejects garbage, batches and invalid requests", () => {
  assert.deepEqual(parseMessage("{oops"), { ok: false, code: -32700, http: 400, note: "Parse error" });
  const batch = parseMessage("[]");
  assert.equal(batch.ok, false);
  const noMethod = parseMessage('{"jsonrpc":"2.0","id":1}');
  assert.equal(noMethod.ok, false);
  if (!noMethod.ok) assert.equal(noMethod.code, -32600);
  const ok = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(ok.ok, true);
});

test("pickMsg skips noise lines and SSE data: prefixes", () => {
  const buf = 'warning: synthetic noise\n{"jsonrpc":"2.0","id":9,"result":{}}\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n';
  assert.deepEqual(pickMsg(buf, 9), { jsonrpc: "2.0", id: 9, result: {} });
  assert.deepEqual(pickMsg(buf, 2), { jsonrpc: "2.0", id: 2, result: { tools: [] } });
  assert.equal(pickMsg(buf, 3), null);
});

test("errNote takes the first line of the error message with a fallback", () => {
  assert.equal(errNote({ error: { message: "boom\nsecond line" } }, "fallback"), "boom");
  assert.equal(errNote({}, "fallback"), "fallback");
  assert.equal(errNote(null, "fallback"), "fallback");
});

test("createSessionStore honours ttl, cap and drop with injected now", () => {
  let t = 1_000;
  let seq = 0;
  const sessions = createSessionStore({
    now: () => t,
    ttlMs: 60_000,
    cap: 1,
    randomHex: () => `synthSid${String(++seq).padStart(2, "0")}`,
  });
  const a = sessions.create();
  t += 61_000;
  assert.equal(sessions.get(a.sid), null, "过期会话不可取");
  const b = sessions.create();
  const c = sessions.create();
  assert.equal(sessions.get(b.sid), null, "超 cap 挤掉最早的");
  assert.ok(sessions.get(c.sid));
  assert.equal(sessions.drop(c.sid), true);
  assert.equal(sessions.drop(c.sid), false);
  assert.equal(sessions.size(), 0);
});

const TOOL_A = {
  name: "mcp_service_state",
  scope: "meta",
  description: "服务状态（合成）",
  inputSchema: { type: "object", properties: {} },
  run: async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
};

function dispatchCtx(overrides: Partial<Parameters<typeof dispatch>[1]> = {}) {
  const sessions = createSessionStore({ now: () => 1_000, ttlMs: 60_000, cap: 8, randomHex: () => "synthSid01" });
  const sess = sessions.create();
  sess.ready = true;
  return {
    sid: sess.sid,
    sessions,
    serverInfo: { name: "synth-workbench", version: "0.1.0" },
    instructions: "只读服务（合成）",
    tools: () => [TOOL_A],
    lookup: (name: string) => (name === TOOL_A.name ? { tool: TOOL_A, allowed: true } : null),
    run: (tool: typeof TOOL_A, args: Record<string, unknown>) => tool.run(args),
    ...overrides,
  };
}

test("dispatch negotiate initialize, requires initialized, filters and guards tools", async () => {
  const ctx = dispatchCtx();
  const init = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "synth" } } },
    { ...ctx, sid: "" },
  );
  assert.equal(init.http, 200);
  const initBody = JSON.parse(init.body ?? "{}");
  assert.equal(initBody.result.protocolVersion, CANONICAL_PROTOCOL_VERSION, "未知版本回落 canonical");
  assert.ok(init.headers?.["Mcp-Session-Id"], "会话头下发");

  const notice = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
  assert.equal(notice.http, 202);
  assert.equal(notice.body, null);

  const noSid = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...ctx, sid: "" });
  assert.equal(noSid.http, 400);
  assert.equal(JSON.parse(noSid.body ?? "{}").error.code, -32002);

  const list = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx);
  assert.deepEqual(JSON.parse(list.body ?? "{}").result.tools, [
    { name: TOOL_A.name, description: TOOL_A.description, inputSchema: TOOL_A.inputSchema },
  ]);

  const unknown = await dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }, ctx);
  assert.equal(JSON.parse(unknown.body ?? "{}").error.code, -32602);

  const denied = await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: TOOL_A.name } }, {
    ...ctx,
    lookup: () => ({ tool: TOOL_A, allowed: false }),
  });
  assert.equal(denied.http, 403);
  assert.equal(JSON.parse(denied.body ?? "{}").error.code, -32003);

  const called = await dispatch({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: TOOL_A.name, arguments: {} } }, ctx);
  assert.equal(JSON.parse(called.body ?? "{}").result.content[0].text, '{"ok":true}');

  const badMethod = await dispatch({ jsonrpc: "2.0", id: 7, method: "tools/write" }, ctx);
  assert.equal(JSON.parse(badMethod.body ?? "{}").error.code, -32601);
});

// ---------------------------------------------------------------------------
// 5. 只读工具目录（写操作绝不进目录）
// ---------------------------------------------------------------------------

test("buildMcpTools exposes read-only tools within the scope whitelist", async () => {
  const tools = buildMcpTools({
    serviceState: async () => ({ ok: true, enabled: false }),
    keyList: async () => ({ ok: true, keys: [] }),
    connectorList: async () => ({ ok: true, servers: [] }),
    auditTail: async () => ({ ok: true, rows: [] }),
  });
  assert.ok(tools.length >= 4);
  for (const tool of tools) {
    assert.match(tool.name, /^mcp_[a-z_]+$/);
    assert.ok(!/create|revoke|toggle|write|remove|send/.test(tool.name), `只读目录不含写工具：${tool.name}`);
    assert.ok((MCP_SCOPES as readonly string[]).includes(tool.scope));
  }
  assert.deepEqual(scopesOf(tools), [...MCP_SCOPES]);
  const state = tools.find((t) => t.name === "mcp_service_state");
  const res = await state?.run({});
  assert.equal(JSON.parse(res?.content[0].text ?? "{}").ok, true);
});

test("mcpTextResult truncates beyond the text budget", () => {
  const big = mcpTextResult({ blob: "x".repeat(MCP_MAX_TEXT + 100) });
  assert.ok(big.content[0].text.length <= MCP_MAX_TEXT);
  const small = mcpTextResult({ ok: true });
  assert.equal(small.content[0].text, '{"ok":true}');
  const err = mcpTextResult({ ok: false }, true);
  assert.equal(err.isError, true);
});

// ---------------------------------------------------------------------------
// 6. JSON-RPC 入口纯函数（Bearer key 鉴权 + scope 过滤；零监听零网络）
// ---------------------------------------------------------------------------

function fakeKeyStore(record: McpKeyRecord | null): McpKeyStore {
  return {
    add: async () => { throw new Error("not used"); },
    revoke: async () => null,
    verify: async () => record,
    list: async () => [],
    records: async () => (record ? [record] : []),
    state: async () => ({ total: record ? 1 : 0, active: record ? 1 : 0, revoked: 0, file: "synth" }),
    touch: async () => {},
  };
}

test("createRpcEndpoint gates on Bearer key and filters tools by scope", async () => {
  const tools = buildMcpTools({
    serviceState: async () => ({ ok: true, enabled: true, tools: 4 }),
    keyList: async () => ({ ok: true, keys: [] }),
    connectorList: async () => ({ ok: true, servers: [] }),
    auditTail: async () => ({ ok: true, rows: [] }),
  });
  const endpoint = createRpcEndpoint({
    keyStore: fakeKeyStore(keyRecord({ scopes: ["meta"] })),
    tools,
    randomHex: () => "synthSidRpc1",
  });

  const noKey = await endpoint.handleText('{"jsonrpc":"2.0","id":1,"method":"ping"}', {});
  assert.equal(noKey.http, 401);
  assert.equal(JSON.parse(noKey.body ?? "{}").error.code, -32004);

  const init = await endpoint.handleText(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"synth"}}}',
    { rawKey: "sak_0123456789abcdef0123456789abcdef" },
  );
  assert.equal(init.http, 200);
  const sid = init.headers?.["Mcp-Session-Id"] ?? "";
  assert.ok(sid);

  await endpoint.handleText('{"jsonrpc":"2.0","method":"notifications/initialized"}', { rawKey: "sak_0123456789abcdef0123456789abcdef", sid });
  const list = await endpoint.handleText('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', { rawKey: "sak_0123456789abcdef0123456789abcdef", sid });
  const names = JSON.parse(list.body ?? "{}").result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ["mcp_service_state"], "meta scope 只见 meta 工具");

  const denied = await endpoint.handleText(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mcp_key_list"}}',
    { rawKey: "sak_0123456789abcdef0123456789abcdef", sid },
  );
  assert.equal(denied.http, 403);

  const called = await endpoint.handleText(
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mcp_service_state","arguments":{}}}',
    { rawKey: "sak_0123456789abcdef0123456789abcdef", sid },
  );
  assert.equal(called.http, 200);
  assert.equal(JSON.parse(JSON.parse(called.body ?? "{}").result.content[0].text).ok, true);
  assert.equal(endpoint.state().tools, tools.length);
});
