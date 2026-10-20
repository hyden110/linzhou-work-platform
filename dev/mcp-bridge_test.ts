import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createKeyStore,
  createMcpBridge,
  MCP_AUDIT_TAIL,
  MCP_KEY_PATTERN,
  MCP_SCOPES,
  sha256Hex,
  type McpBridge,
  type McpBridgeOptions,
  type McpChildHandle,
  type McpSpawnFn,
} from "./mcp-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：连接器一律 synth-* 形态、url 域名 mcp.synth.example、密钥串 synthSecret*；
// spawn/fetch 全注入——零真实子进程、零真实网络；存储全落临时目录（.local-cache 零接触）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");
const SYNTH_SECRET_ENV = "synthSecretEnvValue00000001";
const SYNTH_SECRET_QUERY = "synthSecretQueryValue0001";
const NODE_BIN = process.execPath; // 真实存在的文件路径（存在性判定用）；spawn 仍走注入 stub

interface RouteCall {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function call(bridge: McpBridge, method: string, path: string, body?: unknown): Promise<RouteCall> {
  const request = new Request(`http://127.0.0.1:8787${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await bridge.handle(request);
  assert.ok(response, `${method} ${path} 必须命中本桥路由`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, text };
}

const dataOf = (res: RouteCall): Record<string, unknown> => {
  assert.equal(res.body.ok, true, `期望成功应答，实际 ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body.data as Record<string, unknown>;
};

/** 合成 stdio 子进程：按写入行回放 JSON-RPC 应答（可混入告警噪声行）。 */
function synthChild(plan: { tools?: string[]; failInit?: boolean; silent?: boolean }): McpChildHandle & { readonly written: string[] } {
  const written: string[] = [];
  const dataCbs: ((chunk: string) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];
  const emit = (chunk: string) => { for (const cb of dataCbs) cb(chunk); };
  return {
    written,
    write(line: string) {
      written.push(line);
      if (plan.silent) return;
      setTimeout(() => {
        if (line.includes('"initialize"')) {
          emit("synth warning noise（合成告警行）\n");
          emit(plan.failInit
            ? `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "synth init failed" } })}\n`
            : `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "synth-server" } } })}\n`);
        }
        if (line.includes('"tools/list"')) {
          const tools = (plan.tools ?? ["synth_read_a", "synth_read_b"]).map((name) => ({ name }));
          emit(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } })}\n`);
        }
      }, 0);
    },
    onData(cb) { dataCbs.push(cb); },
    onError() {},
    onClose(cb) { closeCbs.push(cb); },
    kill() { for (const cb of closeCbs) cb(null); },
  };
}

function stubSpawn(plan: { tools?: string[]; failInit?: boolean; silent?: boolean } = {}): { calls: { command: string; args: readonly string[] }[]; child: ReturnType<typeof synthChild>; run: McpSpawnFn } {
  const child = synthChild(plan);
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    child,
    run: (command, args) => { calls.push({ command, args }); return child; },
  };
}

function mockFetch(responder: (url: string, init: RequestInit | undefined) => Response): { urls: string[]; run: typeof fetch } {
  const urls: string[] = [];
  return {
    urls,
    run: (async (input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return responder(url, init);
    }) as typeof fetch,
  };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Harness {
  readonly bridge: McpBridge;
  readonly dir: string;
  readonly spawn: ReturnType<typeof stubSpawn>;
  readonly fetched: { urls: string[] };
  readonly connectorsFile: string;
  readonly hostFile: string;
}

async function makeHarness(dir: string, overrides: Partial<McpBridgeOptions> = {}, spawnPlan: Parameters<typeof stubSpawn>[0] = {}): Promise<Harness> {
  const connectorsFile = join(dir, "connectors.json");
  const hostFile = join(dir, "host-mcp.json");
  await writeFile(connectorsFile, JSON.stringify({
    mcpServers: {
      "synth-stdio": { command: NODE_BIN, args: ["synth-server.js"], env: { SYNTH_TOKEN: SYNTH_SECRET_ENV } },
      "synth-http": { url: `https://mcp.synth.example/sse/abcdefghij0123456789abcdefghij?key=${SYNTH_SECRET_QUERY}`, type: "sse" },
      "synth-broken": {},
    },
  }, null, 2), "utf-8");
  await writeFile(hostFile, JSON.stringify({
    mcpServers: { "synth-host-only": { command: "/synthetic/bin/synth-missing-node", args: [] } },
  }, null, 2), "utf-8");

  const spawn = stubSpawn(spawnPlan);
  const httpMock = mockFetch(() => jsonRes({ error: "synthetic" }, 401));
  const bridge = createMcpBridge({
    dir,
    home: dir,
    now: () => FIXED_NOW,
    spawnFn: spawn.run,
    fetchImpl: httpMock.run,
    sources: [
      { role: "workbench", label: "工作台登记（合成）", file: connectorsFile, shown: "~/.synth/connectors.json", dot: "mcpServers", effective: true, writable: true },
      { role: "host", label: "宿主 mcp.json（合成）", file: hostFile, shown: "~/.synth/host-mcp.json", dot: "mcpServers", effective: false, writable: false },
    ],
    ...overrides,
  });
  return { bridge, dir, spawn, fetched: httpMock, connectorsFile, hostFile };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 服务状态：默认关 + 全掩码
// ---------------------------------------------------------------------------

test("GET /local/mcp/service reports disabled-by-default state with masked views only", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "GET", "/local/mcp/service");
    assert.equal(res.status, 200);
    const data = dataOf(res);
    assert.equal(data.enabled, false, "服务默认关");
    assert.equal(data.rpcMounted, false, "本批不挂监听端口");
    assert.ok(Number(data.tools) >= 4);
    assert.deepEqual(data.keys, { active: 0, revoked: 0 });
    assert.deepEqual(data.auditTail, []);
    assert.deepEqual(data.scopes, [...MCP_SCOPES]);
    assert.ok(!res.text.includes(dir), "响应绝不含绝对路径");
  });
});

// ---------------------------------------------------------------------------
// 2. API KEY：创建一次性明文 / 落盘只有 sha256 / scope 白名单 / 掩码列表
// ---------------------------------------------------------------------------

test("POST /local/mcp/keys returns one-time plaintext; disk and views only carry sha256", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);

    const created = await call(bridge, "POST", "/local/mcp/keys", { name: "synth-qoder", scope: ["meta", "connectors"] });
    assert.equal(created.status, 200);
    const data = dataOf(created);
    const plain = String(data.key);
    assert.match(plain, MCP_KEY_PATTERN);
    const record = data.record as Record<string, unknown>;
    assert.equal(record.hashPrefix, sha256Hex(plain).slice(0, 8));
    assert.deepEqual(record.scopes, ["connectors", "meta"], "scope 落白名单序（MCP_SCOPES 顺序）");
    assert.ok(!("hash" in record) && !("key" in record), "record 无全 hash / 明文键位");

    const onDisk = await readFile(join(dir, "keys.json"), "utf-8");
    assert.ok(onDisk.includes(sha256Hex(plain)), "落盘只存 sha256");
    assert.ok(!onDisk.includes(plain), "明文绝不落盘");

    const listed = await call(bridge, "GET", "/local/mcp/keys");
    const keys = dataOf(listed).keys as Record<string, unknown>[];
    assert.equal(keys.length, 1);
    assert.equal(keys[0].hashPrefix, sha256Hex(plain).slice(0, 8));
    assert.ok(!listed.text.includes(plain), "列表响应绝无明文");
    assert.ok(!listed.text.includes(sha256Hex(plain)), "列表响应绝不回全 hash（只报前 8 位）");

    const state = dataOf(await call(bridge, "GET", "/local/mcp/service"));
    assert.deepEqual(state.keys, { active: 1, revoked: 0 });
    const keyViews = state.keyViews as Record<string, unknown>[];
    assert.equal(keyViews[0].hashPrefix, sha256Hex(plain).slice(0, 8));
    assert.equal(keyViews[0].createdAt, new Date(FIXED_NOW).toISOString());
  });
});

test("POST /local/mcp/keys rejects missing name and non-whitelist scopes without creating anything", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);

    const noName = await call(bridge, "POST", "/local/mcp/keys", { scope: ["meta"] });
    assert.equal(noName.status, 400);
    assert.equal((noName.body.error as Record<string, unknown>).code, "mcp_invalid_request");

    const badScope = await call(bridge, "POST", "/local/mcp/keys", { name: "synth", scope: ["meta", "bogus"] });
    assert.equal(badScope.status, 400);
    assert.ok(String((badScope.body.error as Record<string, unknown>).message).includes("bogus"));

    const emptyScope = await call(bridge, "POST", "/local/mcp/keys", { name: "synth", scope: [] });
    assert.equal(emptyScope.status, 400);

    const state = dataOf(await call(bridge, "GET", "/local/mcp/service"));
    assert.deepEqual(state.keys, { active: 0, revoked: 0 }, "被拒请求不产生 key");

    const defaulted = dataOf(await call(bridge, "POST", "/local/mcp/keys", { name: "synth-default" }));
    assert.deepEqual((defaulted.record as Record<string, unknown>).scopes, [...MCP_SCOPES], "缺省 = 全量白名单");
  });
});

test("POST /local/mcp/keys/revoke requires confirm strictly equal to keyId", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const created = dataOf(await call(bridge, "POST", "/local/mcp/keys", { name: "synth-revoke" }));
    const id = (created.record as Record<string, unknown>).id;

    for (const bad of [undefined, "nope", id, String(id) + " "]) {
      const res = await call(bridge, "POST", "/local/mcp/keys/revoke", { keyId: id, confirm: bad });
      assert.equal(res.status, 409, `confirm=${JSON.stringify(bad)} 必须被拒`);
      assert.equal((res.body.error as Record<string, unknown>).code, "mcp_confirm_mismatch");
    }
    let state = dataOf(await call(bridge, "GET", "/local/mcp/service"));
    assert.deepEqual(state.keys, { active: 1, revoked: 0 }, "确认失败不吊销");

    const ok = await call(bridge, "POST", "/local/mcp/keys/revoke", { keyId: id, confirm: String(id) });
    assert.equal(ok.status, 200);
    assert.ok((dataOf(ok) as Record<string, unknown>).revokedAt, "应答带 revokedAt");
    state = dataOf(await call(bridge, "GET", "/local/mcp/service"));
    assert.deepEqual(state.keys, { active: 0, revoked: 1 });

    const missing = await call(bridge, "POST", "/local/mcp/keys/revoke", { keyId: 99, confirm: "99" });
    assert.equal(missing.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 3. 服务 toggle：confirm 严格 === true（布尔），默认关，跨实例持久
// ---------------------------------------------------------------------------

test("POST /local/mcp/service/toggle needs boolean true confirm and persists", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);

    for (const bad of ["true", 1, undefined, false]) {
      const res = await call(bridge, "POST", "/local/mcp/service/toggle", { op: "enable", confirm: bad });
      assert.equal(res.status, 409, `confirm=${JSON.stringify(bad)} 必须被拒`);
      assert.equal((res.body.error as Record<string, unknown>).code, "mcp_confirm_mismatch");
    }
    assert.equal(dataOf(await call(bridge, "GET", "/local/mcp/service")).enabled, false);

    const badOp = await call(bridge, "POST", "/local/mcp/service/toggle", { op: "restart", confirm: true });
    assert.equal(badOp.status, 400);

    const on = dataOf(await call(bridge, "POST", "/local/mcp/service/toggle", { op: "enable", confirm: true }));
    assert.equal(on.enabled, true);

    // 新实例（同目录）读到持久化的 enabled=true——不是内存态。
    const reopened = await makeHarness(dir);
    assert.equal(dataOf(await call(reopened.bridge, "GET", "/local/mcp/service")).enabled, true);

    const off = dataOf(await call(bridge, "POST", "/local/mcp/service/toggle", { op: "disable", confirm: true }));
    assert.equal(off.enabled, false);

    const fresh = await mkdtemp(join(tmpdir(), "mcp-fresh-"));
    try {
      const { bridge: newBridge } = await makeHarness(fresh);
      assert.equal(dataOf(await call(newBridge, "GET", "/local/mcp/service")).enabled, false, "全新目录默认关");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 连接器发现：来源合并 / 掩码 / summary / 无绝对路径
// ---------------------------------------------------------------------------

test("GET /local/mcp/connectors merges sources and masks every credential shape", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "GET", "/local/mcp/connectors");
    assert.equal(res.status, 200);
    const data = dataOf(res);

    assert.ok(!res.text.includes(dir), "响应绝不含绝对路径");
    assert.ok(!res.text.includes(SYNTH_SECRET_ENV), "env 值绝不出站");
    assert.ok(!res.text.includes(SYNTH_SECRET_QUERY), "url query 凭据绝不出站");
    assert.ok(!res.text.includes("abcdefghij0123456789abcdefghij"), "url token 路径段绝不出站");

    const sources = data.sources as Record<string, unknown>[];
    assert.equal(sources.length, 2);
    assert.equal(sources[0].role, "workbench");
    assert.equal(sources[0].exists, true);

    const servers = data.servers as Record<string, unknown>[];
    const names = servers.map((s) => s.name).sort();
    assert.deepEqual(names, ["synth-broken", "synth-host-only", "synth-http", "synth-stdio"], "四个合成连接器全部发现");
    const http = servers.find((s) => s.name === "synth-http")!;
    assert.equal(http.transport, "sse");
    assert.ok(String(http.url).includes("***"));
    const stdio = servers.find((s) => s.name === "synth-stdio")!;
    assert.equal(stdio.transport, "stdio");
    assert.deepEqual(stdio.env, [{ name: "SYNTH_TOKEN", secret: true }], "env 只出站键名 + secret 标记");
    assert.equal(stdio.exists, true);
    const hostOnly = servers.find((s) => s.name === "synth-host-only")!;
    assert.equal(hostOnly.effective, false, "只在非生效来源注册 → 未被宿主加载");
    assert.equal(hostOnly.exists, false, "命令缺失如实标注 broken");
    const broken = servers.find((s) => s.name === "synth-broken")!;
    assert.equal(broken.valid, false);

    const summary = data.summary as Record<string, unknown>;
    assert.equal(summary.total, 4);
    assert.equal(summary.effective, 3, "生效来源注册的三项（含定义不合法项）");
    assert.equal(summary.notLoaded, 1);
    assert.equal(summary.broken, 1, "命令缺失的 stdio 计入 broken");
  });
});

test("GET /local/mcp/connectors surfaces missing and corrupt source files honestly", async () => {
  await withTempDir(async (dir) => {
    const missingFile = join(dir, "missing.json");
    const corruptFile = join(dir, "corrupt.json");
    await writeFile(corruptFile, "{oops", "utf-8");
    const bridge = createMcpBridge({
      dir, home: dir, now: () => FIXED_NOW,
      spawnFn: stubSpawn().run,
      fetchImpl: mockFetch(() => jsonRes({})).run,
      sources: [
        { role: "missing", label: "缺失（合成）", file: missingFile, shown: "~/.synth/missing.json", dot: "mcpServers", effective: false, writable: false },
        { role: "corrupt", label: "损坏（合成）", file: corruptFile, shown: "~/.synth/corrupt.json", dot: "mcpServers", effective: false, writable: false },
      ],
    });
    const data = dataOf(await call(bridge, "GET", "/local/mcp/connectors"));
    const sources = data.sources as Record<string, unknown>[];
    assert.equal(sources[0].exists, false);
    assert.ok(sources[0].error);
    assert.equal(sources[1].exists, true);
    assert.ok(String(sources[1].error).includes("JSON"), "损坏文件如实报错，绝不 clobber");
  });
});

// ---------------------------------------------------------------------------
// 5. 体检：stdio 合成子进程 ok / HTTP 401 → unauthorized / 单飞锁 409
// ---------------------------------------------------------------------------

test("POST /local/mcp/connectors/check handshakes via injected spawn/fetch only", async () => {
  await withTempDir(async (dir) => {
    const { bridge, spawn, fetched } = await makeHarness(dir);
    const res = await call(bridge, "POST", "/local/mcp/connectors/check", {});
    assert.equal(res.status, 200);
    const data = dataOf(res);
    const results = data.results as Record<string, unknown>[];

    const stdio = results.find((r) => r.name === "synth-stdio")!;
    assert.equal(stdio.status, "ok");
    assert.equal(stdio.toolCount, 2);
    assert.deepEqual(stdio.tools, ["synth_read_a", "synth_read_b"]);
    assert.equal(spawn.calls.length, 1, "只对 stdio 起（合成）子进程");
    assert.deepEqual(spawn.calls[0].args, ["synth-server.js"], "数组参数原样传递");

    const http = results.find((r) => r.name === "synth-http")!;
    assert.equal(http.status, "unauthorized");
    assert.ok(String(http.note).includes("401"));
    assert.ok(fetched.urls.some((u) => u.startsWith("https://mcp.synth.example/")), "HTTP 握手走注入 fetch");

    const broken = results.find((r) => r.name === "synth-broken");
    assert.equal(broken, undefined, "定义不合法的项不进体检目标");
    assert.ok(Number(data.attempted) >= 2);
  });
});

test("POST /local/mcp/connectors/check single-flights: concurrent call gets 409 busy", async () => {
  await withTempDir(async (dir) => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowSpawn: McpSpawnFn = () => {
      const child = synthChild({ silent: true });
      void gate.then(() => {
        // 超时路径不必真等：直接关闭让首个 check 收尾
        child.kill();
      });
      return child;
    };
    const { bridge } = await makeHarness(dir, { spawnFn: slowSpawn, timeoutMs: 250, budgetMs: 5_000 });
    const first = call(bridge, "POST", "/local/mcp/connectors/check", {});
    const second = await call(bridge, "POST", "/local/mcp/connectors/check", {});
    assert.equal(second.status, 409);
    assert.equal((second.body.error as Record<string, unknown>).code, "mcp_busy");
    release?.();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);

    const after = await call(bridge, "POST", "/local/mcp/connectors/check", {});
    assert.equal(after.status, 200, "锁释放后可再次体检");
  });
});

test("stdio handshake reports down when the child never answers and init errors honestly", async () => {
  await withTempDir(async (dir) => {
    const silent = await makeHarness(dir, { spawnFn: () => synthChild({ silent: true }), timeoutMs: 200 });
    const res = await call(silent.bridge, "POST", "/local/mcp/connectors/check", { name: "synth-stdio" });
    const results = dataOf(res).results as Record<string, unknown>[];
    assert.equal(results[0].name, "synth-stdio");
    assert.equal(results[0].status, "down");
    assert.ok(String(results[0].note).includes("超时"));

    const failing = await makeHarness(dir, {}, { failInit: true });
    const res2 = await call(failing.bridge, "POST", "/local/mcp/connectors/check", { name: "synth-stdio" });
    const results2 = dataOf(res2).results as Record<string, unknown>[];
    assert.equal(results2[0].status, "error");
    assert.ok(String(results2[0].note).includes("synth init failed"));
  });
});

// ---------------------------------------------------------------------------
// 6. dry→confirm 两步写：一次性 token / .bak 备份 / 原子写 / 拒写损坏文件 / 回滚
// ---------------------------------------------------------------------------

test("connector write requires dry token; confirm writes with .bak backup and consumes token", async () => {
  await withTempDir(async (dir) => {
    const { bridge, connectorsFile } = await makeHarness(dir);
    const original = await readFile(connectorsFile, "utf-8");

    const dry = await call(bridge, "POST", "/local/mcp/connectors/dry", {
      op: "set", role: "workbench", name: "synth-new",
      def: { command: NODE_BIN, args: ["synth-new.js"], env: { SYNTH_TOKEN: SYNTH_SECRET_ENV } },
    });
    assert.equal(dry.status, 200);
    const dryData = dataOf(dry);
    const token = String(dryData.token);
    assert.ok(token.length >= 32);
    assert.equal(dryData.existed, false);
    assert.equal((dryData.target as Record<string, unknown>).shown, "~/.synth/connectors.json");
    const diff = dryData.diff as Record<string, unknown>;
    assert.equal(diff.before, null, "新增项 before 为 null");
    assert.ok(String(diff.after).includes("synth-new.js"), "after 为掩码后的目标定义摘要");
    assert.ok(!dry.text.includes(SYNTH_SECRET_ENV), "dry 应答的 diff 摘要必须掩码");
    assert.ok(!dry.text.includes(dir), "dry 应答绝不含绝对路径");

    const wrong = await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: "not-the-token" });
    assert.equal(wrong.status, 409);
    assert.equal((wrong.body.error as Record<string, unknown>).code, "mcp_confirm_mismatch");
    assert.equal(await readFile(connectorsFile, "utf-8"), original, "错误 token 绝不写入");

    const confirmed = await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: token });
    assert.equal(confirmed.status, 200);
    const confData = dataOf(confirmed);
    assert.equal(confData.op, "set");
    assert.ok(String(confData.backup).includes("~"), "backup 以 ~ 展示形态回");
    const written = JSON.parse(await readFile(connectorsFile, "utf-8"));
    assert.equal(written.mcpServers["synth-new"].command, NODE_BIN);
    assert.equal(written.mcpServers["synth-new"].env.SYNTH_TOKEN, SYNTH_SECRET_ENV, "真值只落宿主配置（它该在的地方）");
    assert.ok(written.mcpServers["synth-stdio"], "既有键原样保留");

    const backup = await readFile(`${connectorsFile}.bak`, "utf-8");
    assert.equal(backup, original, "写前备份 = 原文");
    const bakMode = (await stat(`${connectorsFile}.bak`)).mode & 0o777;
    assert.equal(bakMode, 0o600, "备份 0600");

    const replay = await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: token });
    assert.equal(replay.status, 409, "token 单次有效，重放拒绝");
  });
});

test("dry→confirm covers enable/disable/remove and refuses hostile targets", async () => {
  await withTempDir(async (dir) => {
    const { bridge, connectorsFile } = await makeHarness(dir);

    // disable → disabled:true
    let dry = dataOf(await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "disable", role: "workbench", name: "synth-stdio" }));
    assert.equal(dry.existed, true);
    await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: String(dry.token) });
    assert.equal(JSON.parse(await readFile(connectorsFile, "utf-8")).mcpServers["synth-stdio"].disabled, true);

    // enable → 移除 disabled 位
    dry = dataOf(await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "enable", role: "workbench", name: "synth-stdio" }));
    await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: String(dry.token) });
    assert.ok(!("disabled" in JSON.parse(await readFile(connectorsFile, "utf-8")).mcpServers["synth-stdio"]));

    // remove
    dry = dataOf(await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "remove", role: "workbench", name: "synth-broken" }));
    assert.equal((dry.diff as Record<string, unknown>).after, null, "remove 的 after 为 null");
    await call(bridge, "POST", "/local/mcp/connectors/confirm", { confirm: String(dry.token) });
    assert.ok(!("synth-broken" in JSON.parse(await readFile(connectorsFile, "utf-8")).mcpServers));

    // 拒绝面：未知 op / 未知 role / 不可写来源 / 不存在的 remove 目标 / 非法名 / set 缺定义
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "bogus", role: "workbench", name: "x" })).status, 400);
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "set", role: "nope", name: "x", def: { command: "n" } })).status, 400);
    const hostWrite = await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "disable", role: "host", name: "synth-host-only" });
    assert.equal(hostWrite.status, 400);
    assert.ok(String((hostWrite.body.error as Record<string, unknown>).message).includes("hostWrite"));
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "remove", role: "workbench", name: "ghost" })).status, 404);
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "set", role: "workbench", name: 'bad"name', def: { command: "n" } })).status, 400);
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "set", role: "workbench", name: "no-def" })).status, 400);

    // confirm 无 token 体 → 409（不是 400：确认闸门优先）
    assert.equal((await call(bridge, "POST", "/local/mcp/connectors/confirm", {})).status, 409);
  });
});

test("corrupt target file refuses the write and never clobbers", async () => {
  await withTempDir(async (dir) => {
    const { bridge, connectorsFile } = await makeHarness(dir);
    await writeFile(connectorsFile, "{oops not json", "utf-8");
    const dry = await call(bridge, "POST", "/local/mcp/connectors/dry", { op: "disable", role: "workbench", name: "synth-stdio" });
    assert.equal(dry.status, 400);
    assert.ok(String((dry.body.error as Record<string, unknown>).message).includes("JSON"));
    assert.equal(await readFile(connectorsFile, "utf-8"), "{oops not json", "损坏原文原样保留");
  });
});

test("failed atomic write rolls back: original stays and error is honest", async () => {
  await withTempDir(async (dir) => {
    const { bridge, connectorsFile } = await makeHarness(dir);
    const original = await readFile(connectorsFile, "utf-8");
    const failingBridge = createMcpBridge({
      dir, home: dir, now: () => FIXED_NOW,
      spawnFn: stubSpawn().run,
      fetchImpl: mockFetch(() => jsonRes({})).run,
      sources: [
        { role: "workbench", label: "工作台登记（合成）", file: connectorsFile, shown: "~/.synth/connectors.json", dot: "mcpServers", effective: true, writable: true },
      ],
      writeFileAtomic: async () => { throw new Error("synthetic disk failure"); },
    });
    const dry = dataOf(await call(failingBridge, "POST", "/local/mcp/connectors/dry", { op: "disable", role: "workbench", name: "synth-stdio" }));
    const res = await call(failingBridge, "POST", "/local/mcp/connectors/confirm", { confirm: String(dry.token) });
    assert.equal(res.status, 503);
    assert.equal((res.body.error as Record<string, unknown>).code, "mcp_store_unavailable");
    assert.equal(await readFile(connectorsFile, "utf-8"), original, "写失败 → 原文不动");
    await stat(`${connectorsFile}.bak`); // 备份已在写前落好（可手工恢复）
  });
});

// ---------------------------------------------------------------------------
// 7. 审计：append-only 0600、绝无明文、尾行进服务状态
// ---------------------------------------------------------------------------

test("audit log is append-only 0600 and never contains plaintext key material", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const created = dataOf(await call(bridge, "POST", "/local/mcp/keys", { name: "synth-audit" }));
    const plain = String(created.key);
    const id = (created.record as Record<string, unknown>).id;
    await call(bridge, "POST", "/local/mcp/keys/revoke", { keyId: id, confirm: String(id) });
    await call(bridge, "POST", "/local/mcp/service/toggle", { op: "enable", confirm: true });

    const auditFile = join(dir, "audit.jsonl");
    const raw = await readFile(auditFile, "utf-8");
    assert.ok(!raw.includes(plain), "审计绝无 key 明文");
    assert.ok(!raw.includes(sha256Hex(plain)), "审计连全 hash 也不落（只允许前 8 位）");
    const mode = (await stat(auditFile)).mode & 0o777;
    assert.equal(mode, 0o600, "审计文件 0600");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= 3);
    assert.ok(lines.some((l) => l.action === "key_created" && l.keyId === id));
    assert.ok(lines.some((l) => l.action === "key_revoked"));
    assert.ok(lines.some((l) => l.action === "service_toggle" && l.ok === true));

    const state = dataOf(await call(bridge, "GET", "/local/mcp/service"));
    const tail = state.auditTail as Record<string, unknown>[];
    assert.ok(tail.length >= 3 && tail.length <= MCP_AUDIT_TAIL);
    assert.equal(tail[0].action, "service_toggle", "最新在前");
  });
});

// ---------------------------------------------------------------------------
// 8. 路由纪律：非本桥路径 undefined / 方法不符 405 / 请求体护栏
// ---------------------------------------------------------------------------

test("handle returns undefined for foreign paths and 405 for method mismatch", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    assert.equal(await bridge.handle(new Request("http://127.0.0.1:8787/local/reply/candidates")), undefined);
    assert.equal(await bridge.handle(new Request("http://127.0.0.1:8787/local/mcp/bogus")), undefined);

    const wrongMethod = await call(bridge, "GET", "/local/mcp/service/toggle");
    assert.equal(wrongMethod.status, 405);
    assert.equal((wrongMethod.body.error as Record<string, unknown>).code, "method_not_allowed");

    const badJson = await bridge.handle(new Request("http://127.0.0.1:8787/local/mcp/keys", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    }));
    assert.equal(badJson?.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 9. keystore 独立面：verify 只认未吊销的 sak_ 全 key
// ---------------------------------------------------------------------------

test("key store verify accepts only live sak_ keys and touch updates lastUsedAt", async () => {
  await withTempDir(async (dir) => {
    const store = createKeyStore({ file: join(dir, "keys.json"), now: () => FIXED_NOW });
    const created = await store.add("synth-verify", { scopes: ["meta"] });
    assert.match(created.key, MCP_KEY_PATTERN);

    assert.equal(await store.verify("bogus"), null, "非 sak_ 形态直接拒");
    const rec = await store.verify(created.key);
    assert.ok(rec);
    assert.equal(rec?.id, created.record.id);
    assert.ok(rec?.lastUsedAt, "verify 落 lastUsedAt");

    await store.revoke(created.record.id);
    assert.equal(await store.verify(created.key), null, "吊销后下一请求即失效");
    const state = await store.state();
    assert.deepEqual({ total: state.total, active: state.active, revoked: state.revoked }, { total: 1, active: 0, revoked: 1 });
  });
});
