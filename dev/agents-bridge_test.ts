import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENTLOOP_CONSOLE,
  AgentsBridgeError,
  createAgentsBridge,
  maskAk,
  WAKE_ENTRY_PATHS,
  WAKE_PROBE_TIMEOUT_MS,
  type AgentLoopStatusView,
  type AgentsBridge,
  type AgentsWakeState,
  type WechatSnapshotView,
} from "./agents-bridge.ts";
import {
  DEFAULT_AGENTS_CONFIG_PATH,
  DEFAULT_WAKE_PORT_PATH,
  sanitizeAgentsConfig,
} from "./agents/agents-config.ts";
import { createLocalRouter } from "./local-router.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：数字员工 / 端点 / 凭据字段 全为合成值（ecs-syn.example /
// wxid_syn_0001 / proj-syn-001），企业只出现「甲科技/乙股份」；HTTP 全程 fake
// fetch、文件读取全走注入，绝不触网、绝不读真实凭据文件、绝不写任何东西。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");
const NOW_ISO = "2026-10-20T02:30:00.000Z";
const HOME_SYN = "/home/syn";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agents-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir: string, config: unknown): Promise<string> {
  const path = join(dir, "agents.json");
  await writeFile(path, JSON.stringify(config), "utf-8");
  return path;
}

/** 注入式文件读取表：path → 内容（未命中 = null，模拟文件缺失）。 */
function fakeReader(files: Record<string, string | null> = {}) {
  return async (path: string): Promise<string | null> =>
    Object.prototype.hasOwnProperty.call(files, path) ? files[path]! : null;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly signal: unknown;
}

function fakeFetch(reply: () => Response | Promise<Response>, calls: FetchCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method ?? "GET"), signal: init?.signal });
    return reply();
  }) as unknown as typeof fetch;
}

interface BridgeOptions {
  readonly configPath?: string;
  readonly omitConfig?: boolean;
  readonly files?: Record<string, string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function makeBridge(dir: string, options: BridgeOptions = {}): AgentsBridge {
  return createAgentsBridge({
    configPath: options.configPath ?? join(dir, "agents.json"),
    files: options.files ?? {},
    fetchImpl: options.fetchImpl ?? fakeFetch(() => new Response("{}", { status: 404 })),
    home: HOME_SYN,
    now: options.now ?? (() => FIXED_NOW),
    statMtime: async () => "2026-10-19T20:00:00.000Z",
  });
}

const PORT_FILE = `${HOME_SYN}/.qoderwake/run/daemon.port`;

// ---------------------------------------------------------------------------
// 1. 配置 sanitize：缺省 / 形态校验 / ~ 展开 / 端点无凭据
// ---------------------------------------------------------------------------

test("sanitize degrades to honest defaults: wake default port path, no endpoints, no sources", () => {
  const config = sanitizeAgentsConfig({});
  assert.equal(config.wake.daemonPortPath, DEFAULT_WAKE_PORT_PATH);
  assert.deepEqual(config.wake.endpoints, []);
  assert.equal(config.agentloop.source, null, "statusSource 未配置 = null，绝不猜默认凭据路径");
  assert.deepEqual(config.agentloop.views, []);
  assert.equal(config.wechat.snapshotPath, "");
});

test("sanitize expands ~ via the injected home and keeps a valid endpoints list", () => {
  const config = sanitizeAgentsConfig({
    wake: {
      daemonPortPath: "~/custom/port",
      endpoints: [
        { id: "ecs", t: "ECS 云端（合成）", url: "https://ecs-syn.example/console" },
        { id: "", t: "缺 id（丢弃）", url: "https://ecs-syn.example/x" },
        { id: "bad-scheme", t: "ftp（丢弃）", url: "ftp://ecs-syn.example" },
        { id: "userinfo", t: "带凭据（丢弃）", url: "https://user:pass@ecs-syn.example" },
        { id: "query", t: "带 query（丢弃）", url: "https://ecs-syn.example/c?token=abcdef0123456789" },
      ],
    },
  }, HOME_SYN);
  assert.equal(config.wake.daemonPortPath, `${HOME_SYN}/custom/port`);
  assert.equal(config.wake.endpoints.length, 1);
  assert.equal(config.wake.endpoints[0]?.id, "ecs");
  assert.equal(config.wake.endpoints[0]?.url, "https://ecs-syn.example/console");
});

test("sanitize caps endpoints at eight and rejects oversized text", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `ep${index}`, t: `端点${index}`, url: `https://ep-syn-${index}.example/console`,
  }));
  const config = sanitizeAgentsConfig({ wake: { endpoints: many } }, HOME_SYN);
  assert.equal(config.wake.endpoints.length, 8, "端点表上限 8，防配置膨胀");
});

test("default config path resolves to the project-root .local-cache/agents.json", () => {
  assert.ok(DEFAULT_AGENTS_CONFIG_PATH.endsWith(join(".local-cache", "agents.json")));
  assert.equal(DEFAULT_WAKE_PORT_PATH, "~/.qoderwake/run/daemon.port");
});

// ---------------------------------------------------------------------------
// 2. QoderWake daemon 探测：端口文件 / HTTP 结果 / 超时口径 / 敌意 note
// ---------------------------------------------------------------------------

test("wake probe falls back to port 19820 when the port file is missing or garbage", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {});
    const calls: FetchCall[] = [];
    const bridge = makeBridge(dir, {
      configPath,
      files: { [PORT_FILE]: null },
      fetchImpl: fakeFetch(() => new Response("{\"ok\":true}", { status: 200 }), calls),
    });
    const state = await bridge.state();
    assert.equal(state.daemon.status, "ok");
    assert.equal(state.daemon.port, 19820);
    assert.equal(state.daemon.url, "http://127.0.0.1:19820");
    assert.equal(calls[0]?.url, "http://127.0.0.1:19820/api/health");

    const garbageBridge = makeBridge(dir, {
      configPath,
      files: { [PORT_FILE]: "not-a-port\n" },
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
    });
    assert.equal((await garbageBridge.state()).daemon.port, 19820, "坏端口文件回退默认端口");
  });
});

test("wake probe reads the port file, probes /api/health GET only, and reports ok", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {
      wake: { daemonPortPath: "~/custom/port", endpoints: [{ id: "ecs", t: "ECS（合成）", url: "https://ecs-syn.example/console" }] },
    });
    const calls: FetchCall[] = [];
    const bridge = createAgentsBridge({
      configPath: join(dir, "agents.json"),
      files: { [`${HOME_SYN}/custom/port`]: "21121\n" },
      fetchImpl: fakeFetch(() => new Response("{\"status\":\"ok\"}", { status: 200 }), calls),
      home: HOME_SYN,
      now: () => FIXED_NOW,
      statMtime: async () => null,
    });
    const state = await bridge.state();
    assert.equal(state.daemon.port, 21121);
    assert.equal(state.daemon.status, "ok");
    assert.match(state.daemon.note, /\/api\/health/);
    assert.equal(state.daemon.http, 200);
    assert.equal(state.daemon.checkedAt, NOW_ISO);
    assert.equal(calls.length, 1, "只探一次 /api/health，不扫其他路径");
    assert.equal(calls[0]?.method, "GET", "健康探测只允许 GET");
    assert.ok(calls[0]?.signal instanceof AbortSignal, "显式超时信号必须传递");
    assert.equal(WAKE_PROBE_TIMEOUT_MS, 5000, "探测超时显式 ≤5s");
    assert.deepEqual(state.entries.map((entry) => entry.id), ["console", "wakers", "knowledge", "conversations"]);
    assert.equal(state.endpoints.length, 1, "ECS 入口只来自配置");
    assert.equal(state.endpoints[0]?.url, "https://ecs-syn.example/console");
  });
});

test("wake probe answers honestly on HTTP 500 (degraded) and network failure (down)", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {});
    const degraded = makeBridge(dir, {
      configPath,
      fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })),
    });
    const degradedState = await degraded.state();
    assert.equal(degradedState.daemon.status, "degraded");
    assert.equal(degradedState.daemon.http, 500);
    assert.match(degradedState.daemon.note, /500/);

    const down = makeBridge(dir, {
      configPath,
      fetchImpl: (async () => { throw new TypeError("fetch failed ECONNREFUSED 127.0.0.1:19820"); }) as unknown as typeof fetch,
    });
    const downState = await down.state();
    assert.equal(downState.daemon.status, "down");
    assert.equal(downState.daemon.http, null);
    assert.match(downState.daemon.note, /未连通/);
    assert.match(downState.daemon.note, /ECONNREFUSED/, "失败原因如实透出（无凭据形态）");
  });
});

test("wake probe redacts hostile daemon error text and hostile endpoint names", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {
      wake: { endpoints: [{ id: "ecs", t: "ECS access_token=supersecretvalue99", url: "https://ecs-syn.example/console" }] },
    });
    const bridge = makeBridge(dir, {
      configPath,
      fetchImpl: (async () => { throw new TypeError("socket hang up sk-sentinel0123456789 LTAI9999abcd0123"); }) as unknown as typeof fetch,
    });
    const state = await bridge.state();
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes("sk-sentinel0123456789"), false, "daemon note 不得携带裸密钥形态");
    assert.equal(serialized.includes("LTAI9999abcd0123"), false);
    assert.equal(serialized.includes("supersecretvalue99"), false, "端点名中的凭据形态文本必须脱敏");
    assert.match(state.endpoints[0]?.t ?? "", /已脱敏/, "键名与值成对抹除（F6 redact 口径）");
  });
});

// ---------------------------------------------------------------------------
// 3. AgentLoop 观测状态：凭据存在性 + 掩码 + views 投影（绝不透出明文）
// ---------------------------------------------------------------------------

const PILOT_CONFIG = JSON.stringify({
  enabled: true,
  dataDir: "/home/syn/.loongsuite-pilot",
  sls: [{ name: "user-sls", endpoint: "cn-hangzhou.log.aliyuncs.com", project: "proj-syn-001", logstore: "agent-event-syn", mode: "webtracking" }],
  cms: { licenseKey: "db0h-synthetic-license", workspace: "proj-syn-001" },
  credentials: { accessKeyId: "LTAI-forgotten-0099", accessKeySecret: "sk-should-not-surface-0001" },
  accessKeyId: "LTAI0123456789abcd",
});

test("agentloop requires config file and an explicit statusSource before answering", async () => {
  await withTempDir(async (dir) => {
    const noConfig = makeBridge(dir, { omitConfig: true });
    await assert.rejects(() => noConfig.agentloop(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unconfigured" && /agents\.json/.test(error.message));

    const emptySource = makeBridge(dir, { configPath: await writeConfig(dir, {}) });
    await assert.rejects(() => emptySource.agentloop(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unconfigured" && /statusSource/.test(error.message));

    const unknownKind = makeBridge(dir, {
      configPath: await writeConfig(dir, { agentloop: { statusSource: { kind: "keychain", path: "~/.creds", field: "ak" } } }),
    });
    await assert.rejects(() => unknownKind.agentloop(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unconfigured" && /json-file/.test(error.message), "未知探测方式拒绝，绝不静默猜测");
  });
});

test("agentloop reports configured:false honestly when the source file or field is absent", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {
      agentloop: { statusSource: { kind: "json-file", path: "~/.loongsuite-pilot/config.json", field: "accessKeyId" } },
    });
    const missingFile = makeBridge(dir, { configPath, files: {} });
    const missing = await missingFile.agentloop();
    assert.equal(missing.configured, false);
    assert.equal(missing.mask, null);
    assert.match(missing.note, /不可读|未生成/);

    const fieldAbsent = makeBridge(dir, {
      configPath,
      files: { [`${HOME_SYN}/.loongsuite-pilot/config.json`]: JSON.stringify({ enabled: true }) },
    });
    const absent = await fieldAbsent.agentloop();
    assert.equal(absent.configured, false);
    assert.equal(absent.mask, null);
    assert.match(absent.note, /accessKeyId/);
  });
});

test("agentloop masks the access key like the static lib and never leaks the plaintext", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {
      agentloop: { statusSource: { kind: "json-file", path: "~/.loongsuite-pilot/config.json", field: "accessKeyId" } },
    });
    const bridge = makeBridge(dir, {
      configPath,
      files: { [`${HOME_SYN}/.loongsuite-pilot/config.json`]: PILOT_CONFIG },
    });
    const status = await bridge.agentloop();
    assert.equal(status.configured, true);
    assert.equal(status.mask, "LTAI****abcd", "掩码形态照静态台 maskAk：前4 + **** + 后4");
    assert.equal(status.updatedAt, "2026-10-19T20:00:00.000Z");
    assert.equal(status.console, AGENTLOOP_CONSOLE);
    assert.equal(status.writesNote, "凭据管理与出票：待授权，本台未开通");
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("LTAI0123456789abcd"), false, "AK 明文绝不透出");
    assert.equal(serialized.includes("LTAI-forgotten-0099"), false, "嵌套在凭据子树里的 AK 不参与探测");
    assert.equal(serialized.includes("sk-should-not-surface-0001"), false);
    assert.equal(serialized.includes("db0h-synthetic-license"), false, "licenseKey 等非探测字段绝不透出");
  });
});

test("maskAk mirrors the static maskAk edge cases", () => {
  assert.equal(maskAk("LTAI0123456789abcd"), "LTAI****abcd");
  assert.equal(maskAk("short12"), "sh****");
  assert.equal(maskAk("12345678"), "12****", "≤8 位照静态台只留前 2 位");
});

test("agentloop views prefer the config override and fall back to a safe pilot scan", async () => {
  await withTempDir(async (dir) => {
    const overridePath = await writeConfig(dir, {
      agentloop: {
        statusSource: { kind: "json-file", path: "~/.loongsuite-pilot/config.json", field: "accessKeyId" },
        views: [{ id: "syn-view", t: "合成视图", sub: "子标题", project: "proj-syn-002", logstore: "store-syn-002", region: "cn-hangzhou" }],
      },
    });
    const override = await makeBridge(dir, {
      configPath: overridePath,
      files: { [`${HOME_SYN}/.loongsuite-pilot/config.json`]: PILOT_CONFIG },
    }).agentloop();
    assert.deepEqual(override.views, [{
      id: "syn-view", t: "合成视图", sub: "子标题",
      project: "proj-syn-002", logstore: "store-syn-002", region: "cn-hangzhou",
    }]);

    const fallback = await makeBridge(dir, {
      configPath: await writeConfig(dir, {
        agentloop: { statusSource: { kind: "json-file", path: "~/.loongsuite-pilot/config.json", field: "accessKeyId" } },
      }),
      files: { [`${HOME_SYN}/.loongsuite-pilot/config.json`]: PILOT_CONFIG },
    }).agentloop();
    assert.equal(fallback.views.length, 1, "只收带 project+logstore 的条目");
    const view = fallback.views[0]!;
    assert.equal(view.project, "proj-syn-001");
    assert.equal(view.logstore, "agent-event-syn");
    assert.equal(view.region, "cn-beijing", "region 缺省照静态台回 cn-beijing");
    assert.equal(JSON.stringify(fallback.views).includes("db0h-synthetic-license"), false, "扫描只投影白名单字段");
    assert.equal(JSON.stringify(fallback.views).includes("LTAI-forgotten-0099"), false, "凭据命名的子树整支跳过");
  });
});

// ---------------------------------------------------------------------------
// 4. 微信办公快照：路径缺失 unconfigured、白名单投影、缺字段容错
// ---------------------------------------------------------------------------

const WECHAT_SNAPSHOT = JSON.stringify({
  version: 1,
  updatedAt: "2026-10-20T01:00:00.000Z",
  me: { wxid: "wxid_syn_0001", name: "甲科技对接人（合成）" },
  source: { decryptedDir: "~/.sa-workbench/wx", dbs: 12, tables: 340, messages: 56000, groups: 109, singles: 42, window: 90 },
  stats: { groups: 109, groupsActive7: 31, groupsActive30: 58, groupsMine7: 17, custBound: 12, atMeAll: 203 },
  groups: [{ name: "真实群名绝不透出", messages: [{ text: "消息内容绝不透出" }] }],
  todos: [{ text: "待办内容绝不透出" }],
  mentions: [{ text: "@我消息绝不透出" }],
  labels: ["标签绝不透出"],
});

test("wechat snapshot requires an explicit configured path and answers unconfigured otherwise", async () => {
  await withTempDir(async (dir) => {
    const empty = makeBridge(dir, { configPath: await writeConfig(dir, {}) });
    await assert.rejects(() => empty.wechat(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unconfigured" && /snapshotPath/.test(error.message));

    const missing = makeBridge(dir, {
      configPath: await writeConfig(dir, { wechat: { snapshotPath: "~/.sa-workbench/wx/wechat.json" } }),
      files: {},
    });
    await assert.rejects(() => missing.wechat(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unconfigured" && /常驻同步|未生成/.test(error.message), "文件未生成 = unconfigured 引导，绝不造数据");
  });
});

test("wechat snapshot projects the stats whitelist and drops message content entirely", async () => {
  await withTempDir(async (dir) => {
    const snapshotPath = `${HOME_SYN}/.sa-workbench/wx/wechat.json`;
    const bridge = makeBridge(dir, {
      configPath: await writeConfig(dir, { wechat: { snapshotPath } }),
      files: { [snapshotPath]: WECHAT_SNAPSHOT },
    });
    const view = await bridge.wechat();
    assert.equal(view.me.wxid, "wxid_syn_0001");
    assert.equal(view.me.name, "甲科技对接人（合成）");
    assert.equal(view.updatedAt, "2026-10-20T01:00:00.000Z");
    assert.equal(view.source?.groups, 109);
    assert.equal(view.source?.window, 90);
    assert.equal(view.stats?.groups, 109);
    assert.equal(view.stats?.groupsActive7, 31);
    assert.equal(view.stats?.groupsActive30, 58);
    assert.equal(view.stats?.groupsMine7, 17);
    assert.equal(view.stats?.custBound, 12);
    assert.equal(view.stats?.atMeAll, 203);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("真实群名"), false, "群台账内容绝不透出");
    assert.equal(serialized.includes("消息内容"), false);
    assert.equal(serialized.includes("待办内容"), false);
    assert.equal(serialized.includes("@我消息"), false);
    assert.equal(serialized.includes("标签绝不透出"), false);
  });
});

test("wechat snapshot tolerates missing stats fields and redacts hostile credential text", async () => {
  await withTempDir(async (dir) => {
    const snapshotPath = `${HOME_SYN}/.sa-workbench/wx/wechat.json`;
    const bridge = makeBridge(dir, {
      configPath: await writeConfig(dir, { wechat: { snapshotPath } }),
      files: {
        [snapshotPath]: JSON.stringify({
          updatedAt: "2026-10-20T01:00:00.000Z",
          me: { wxid: "wxid_syn_0002", name: "乙股份 sk-sentinel0123456789" },
          source: { groups: 3 },
          stats: { groups: 3 },
        }),
      },
    });
    const view = await bridge.wechat();
    assert.equal(view.stats?.groups, 3);
    assert.equal(view.stats?.groupsActive7, null, "缺字段容错为 null，不造 0");
    assert.equal(view.stats?.custBound, null);
    assert.equal(view.source?.dbs, null);
    assert.equal(JSON.stringify(view).includes("sk-sentinel0123456789"), false, "白名单字段同样过脱敏");
  });
});

test("wechat snapshot maps corrupt JSON to agents_unavailable", async () => {
  await withTempDir(async (dir) => {
    const snapshotPath = `${HOME_SYN}/.sa-workbench/wx/wechat.json`;
    const bridge = makeBridge(dir, {
      configPath: await writeConfig(dir, { wechat: { snapshotPath } }),
      files: { [snapshotPath]: "{ 不是 JSON" },
    });
    await assert.rejects(() => bridge.wechat(), (error: unknown) => error instanceof AgentsBridgeError
      && error.code === "agents_unavailable");
  });
});

// ---------------------------------------------------------------------------
// 5. 只读面 + 路由：全 GET、错误码映射、405/400/502
// ---------------------------------------------------------------------------

test("bridge exposes exactly the three read-only getters", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir, { configPath: await writeConfig(dir, {}) });
    assert.deepEqual(Object.keys(bridge).sort(), ["agentloop", "state", "wechat"], "本批只读：无任何写方法");
  });
});

test("red-line sentinel: no iframe, no polling, no SSE in the agents view and client sources", async () => {
  const { readFile: readSource } = await import("node:fs/promises");
  const webRoot = join(import.meta.dirname, "..", "src");
  const sources = [
    join(webRoot, "components", "agents", "AgentsView.tsx"),
    join(webRoot, "lib", "agents-client.ts"),
  ];
  for (const source of sources) {
    const text = await readSource(source, "utf-8");
    assert.equal(/<iframe|setInterval|EventSource|new\s+WebSocket|requestAnimationFrame/.test(text), false,
      `${source} 不得包含 iframe 内嵌 / 轮询 / SSE 语义`);
    assert.equal(/method:\s*"POST"/.test(text), false, `${source} 只发 GET 请求`);
  }
});

const TRUSTED = { host: "127.0.0.1:8000" };

function request(path: string, method: "GET" | "POST"): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method, headers: TRUSTED });
}

test("router serves GET /local/agents/* read-only, maps codes, POST falls to 405", async () => {
  await withTempDir(async (dir) => {
    const configPath = await writeConfig(dir, {
      wake: { endpoints: [{ id: "ecs", t: "ECS（合成）", url: "https://ecs-syn.example/console" }] },
      agentloop: { statusSource: { kind: "json-file", path: "~/.loongsuite-pilot/config.json", field: "accessKeyId" } },
      wechat: { snapshotPath: "~/.sa-workbench/wx/wechat.json" },
    });
    const bridge = createAgentsBridge({
      configPath,
      files: {
        [PORT_FILE]: "19820\n",
        [`${HOME_SYN}/.loongsuite-pilot/config.json`]: PILOT_CONFIG,
        [`${HOME_SYN}/.sa-workbench/wx/wechat.json`]: WECHAT_SNAPSHOT,
      },
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
      home: HOME_SYN,
      now: () => FIXED_NOW,
      statMtime: async () => "2026-10-19T20:00:00.000Z",
    });
    const router = createLocalRouter({ port: 8000, agentsBridge: bridge });

    const state = await router(request("/local/agents/state", "GET"));
    assert.equal(state.status, 200);
    const stateBody = await state.json() as { ok: boolean; data: AgentsWakeState };
    assert.equal(stateBody.ok, true);
    assert.equal(stateBody.data.daemon.status, "ok");
    assert.equal(stateBody.data.entries.length, 4);
    assert.equal(stateBody.data.endpoints.length, 1);

    const loop = await router(request("/local/agents/agentloop", "GET"));
    assert.equal(loop.status, 200);
    const loopBody = await loop.json() as { data: AgentLoopStatusView };
    assert.equal(loopBody.data.configured, true);
    assert.equal(loopBody.data.mask, "LTAI****abcd");

    const wechat = await router(request("/local/agents/wechat", "GET"));
    assert.equal(wechat.status, 200);
    const wechatBody = await wechat.json() as { data: WechatSnapshotView };
    assert.equal(wechatBody.data.stats?.custBound, 12);

    for (const route of ["/local/agents/state", "/local/agents/agentloop", "/local/agents/wechat"]) {
      const notAllowed = await router(request(route, "POST"));
      assert.equal(notAllowed.status, 405, "写动作不存在：POST 由既有 method_not_allowed 兜底");
    }

    const unconfiguredRouter = createLocalRouter({ port: 8000, agentsBridge: makeBridge(dir, { configPath: await writeConfig(dir, {}) }) });
    const loopUnset = await unconfiguredRouter(request("/local/agents/agentloop", "GET"));
    assert.equal(loopUnset.status, 400);
    assert.equal(((await loopUnset.json()) as { error: string }).error, "agents_unconfigured");
    const wechatUnset = await unconfiguredRouter(request("/local/agents/wechat", "GET"));
    assert.equal(wechatUnset.status, 400);
    assert.equal(((await wechatUnset.json()) as { error: string }).error, "agents_unconfigured");

    const brokenRouter = createLocalRouter({
      port: 8000,
      agentsBridge: {
        state: async () => { throw new Error("boom"); },
        agentloop: async () => { throw new Error("boom"); },
        wechat: async () => { throw new Error("boom"); },
      },
    });
    for (const route of ["/local/agents/state", "/local/agents/agentloop", "/local/agents/wechat"]) {
      const upstream = await brokenRouter(request(route, "GET"));
      assert.equal(upstream.status, 502, "未知异常兜底 502（对齐 F5 P3-1 口径）");
      assert.equal(((await upstream.json()) as { error: string }).error, "agents_unavailable");
    }
  });
});
