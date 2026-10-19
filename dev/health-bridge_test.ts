import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHealthBridge, type HealthBridge, type HealthSnapshot } from "./health-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import type { HealthCommandRunner } from "./health/health-cli.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：CLI 输出、env 值全部为合成构造（含刻意敌意的凭据样文本），
// 绝不使用真实凭据；真实 CLI 进程一个都不碰（runner 全量注入）。
// ---------------------------------------------------------------------------

interface CliReply {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

function fakeRunner(handler: (file: string, args: readonly string[]) => CliReply): HealthCommandRunner {
  return async (file, args) => {
    const reply = handler(file, args);
    return {
      code: reply && "code" in reply ? (reply.code as number | string | null) : 0,
      stdout: reply?.stdout ?? "",
      stderr: reply?.stderr ?? "",
    };
  };
}

const okRunner: HealthCommandRunner = fakeRunner((file) =>
  file === "aliyun"
    ? { stdout: "aliyun CLI version 3.1.68, Python-3.9\n" }
    : { stdout: `${file} version 2.4.1 (synthetic)\n` });

/** 敌意合成输出：集中各类凭据样式，用于验证 redact 后快照干净。 */
const HOSTILE_STDERR = [
  "warn: AccessKeyId=LTAI5tSyntheticSyntheticValue01",
  "warn: login_token=AbCdEf0123456789AbCdEf0123456789",
  "warn: password=hunter2-master-key-2026",
  "warn: Set-Cookie: SESSION=8f14e45fceea167a5a36dedd4bea2543",
  "warn: sk-synthetic0123456789abcdef",
  "普通告警行保留",
].join("\n");

const hostileRunner: HealthCommandRunner = fakeRunner((file) =>
  file === "qodercli" ? { code: 1, stdout: "qodercli 1.9.9\n", stderr: HOSTILE_STDERR } : { stdout: `${file} version 2.4.1\n` });

const missingRunner: HealthCommandRunner = fakeRunner((file) =>
  file === "a1" ? { code: "ENOENT" } : { stdout: `${file} version 2.4.1 (synthetic)\n` });

const missingDwsRunner: HealthCommandRunner = fakeRunner((file) =>
  file === "dws" ? { code: "ENOENT" } : { stdout: `${file} version 2.4.1 (synthetic)\n` });

const timeoutRunner: HealthCommandRunner = fakeRunner((file) =>
  file === "dws" ? { code: null } : { stdout: `${file} version 2.4.1\n` });

interface BridgeFakes {
  readonly crmSnapshot?: () => Promise<unknown>;
  readonly dingtalkWrites?: () => Promise<readonly unknown[]>;
  readonly fbiMetrics?: () => Promise<unknown>;
  readonly pplInspection?: () => Promise<unknown>;
  readonly kbConfig?: () => Promise<unknown>;
  readonly opsDigest?: () => Promise<unknown>;
}

function healthyBridgeFakes(overrides: BridgeFakes = {}) {
  return {
    crmSnapshot: async () => ({ schemaVersion: 1 }),
    dingtalkWrites: async () => [{ taskId: "t-1" }],
    fbiMetrics: async () => ({ state: "done" }),
    pplInspection: async () => ({ reportCount: 3, recommendations: [{}, {}] }),
    kbConfig: async () => ({ sources: [{ enabled: true, type: "obsidian" }, { enabled: false, type: "dingtalk" }] }),
    opsDigest: async () => ({ items: [1, 2, 3] }),
    ...overrides,
  } as Required<BridgeFakes>;
}

interface HealthOptions {
  readonly run?: HealthCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly cacheDir?: string;
  readonly casesConfigPath?: string;
  readonly bridges?: BridgeFakes;
}

function createTestBridge(options: HealthOptions = {}): HealthBridge {
  const fakes = healthyBridgeFakes(options.bridges);
  return createHealthBridge({
    now: () => Date.parse("2026-10-20T02:00:00.000Z"),
    env: options.env ?? {},
    run: options.run ?? okRunner,
    cacheDir: options.cacheDir,
    casesConfigPath: options.casesConfigPath,
    crmSnapshot: fakes.crmSnapshot,
    dingtalkWrites: fakes.dingtalkWrites,
    fbiMetrics: fakes.fbiMetrics,
    pplInspection: fakes.pplInspection,
    kbConfig: fakes.kbConfig as never,
    opsDigest: fakes.opsDigest,
  });
}

function rowOf(snapshot: HealthSnapshot, group: "bridges" | "cli" | "caps", name: string) {
  const row = snapshot[group].find((entry) => entry.name === name);
  assert.ok(row, `${group} 组应包含 ${name} 行`);
  return row;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "health-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. CLI 组：缺失 / 报错 / 超时各自降级，绝不拖垮整体
// ---------------------------------------------------------------------------

test("a missing CLI degrades to its own row with a fix hint and never breaks the snapshot", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({
      run: missingRunner,
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
    });
    const snapshot = await bridge.snapshot();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.cli.length, 5, "五个 CLI 一行不少");
    const a1 = rowOf(snapshot, "cli", "a1");
    assert.equal(a1.state, "missing");
    assert.equal(a1.version, "");
    assert.match(a1.note, /未安装/);
    assert.match(a1.note, /a1 auth login/);
    assert.equal(rowOf(snapshot, "cli", "ossutil").state, "ok");
    assert.equal(rowOf(snapshot, "cli", "ossutil").version, "2.4.1");
    assert.equal(rowOf(snapshot, "cli", "aliyun").version, "2.4.1");
    assert.equal(rowOf(snapshot, "cli", "dws").state, "ok");
    assert.ok(snapshot.bridges.length === 8, "CLI 缺失不影响 bridges 组");
  });
});

test("a failing CLI becomes an error row with redacted note while other rows stay ok", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({ run: hostileRunner, casesConfigPath: join(dir, "absent-cases.json"), cacheDir: dir });
    const snapshot = await bridge.snapshot();
    const qodercli = rowOf(snapshot, "cli", "qodercli");
    assert.equal(qodercli.state, "error");
    assert.match(qodercli.note, /失败/);
    assert.match(qodercli.note, /已脱敏/, "凭据行整行抹除并留痕");
    assert.doesNotMatch(qodercli.note, /AbCdEf0123456789/);
    assert.equal(rowOf(snapshot, "cli", "a1").state, "ok", "单行失败不影响其余 CLI");
    assert.equal(rowOf(snapshot, "cli", "dws").state, "ok");
  });
});

test("a timed-out CLI reports an honest timeout row and the rest of the snapshot is unaffected", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({ run: timeoutRunner, casesConfigPath: join(dir, "absent-cases.json"), cacheDir: dir });
    const snapshot = await bridge.snapshot();
    const dws = rowOf(snapshot, "cli", "dws");
    assert.equal(dws.state, "error");
    assert.match(dws.note, /超时/);
    assert.equal(rowOf(snapshot, "cli", "aliyun").state, "ok");
    assert.equal(rowOf(snapshot, "cli", "qodercli").state, "ok");
  });
});

test("an installed CLI whose version cannot be parsed answers unknown instead of guessing", async () => {
  await withTempDir(async (dir) => {
    const runner: HealthCommandRunner = fakeRunner((file) =>
      file === "dws" ? { stdout: "ready (no version banner)\n" } : { stdout: `${file} version 2.4.1\n` });
    const bridge = createTestBridge({ run: runner, casesConfigPath: join(dir, "absent-cases.json"), cacheDir: dir });
    const snapshot = await bridge.snapshot();
    const dws = rowOf(snapshot, "cli", "dws");
    assert.equal(dws.state, "unknown");
    assert.equal(dws.version, "");
    assert.match(dws.note, /未取得版本号/);
  });
});

// ---------------------------------------------------------------------------
// 2. redact 哨兵：整份快照序列化后不含任何凭据模式
// ---------------------------------------------------------------------------

test("sentinel: the serialized snapshot never contains credential patterns from hostile CLI output", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({
      run: hostileRunner,
      env: { DASHSCOPE_API_KEY: "sk-injected-synthetic-secret", OPS_TOKEN: "AbCdEf0123456789AbCd" },
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
    });
    const snapshot = await bridge.snapshot();
    const serialized = JSON.stringify(snapshot);
    for (const pattern of [
      /sk-/i,
      /LTAI/i,
      /token\s*=/i,
      /password/i,
      /cookie/i,
      /hunter2/i,
      /SyntheticSynthetic/i,
      /injected-synthetic-secret/i,
      /8f14e45fceea167a/i,
    ]) {
      assert.doesNotMatch(serialized, pattern, `快照不得包含凭据模式 ${pattern}`);
    }
    assert.match(serialized, /普通告警行保留/, "无害文本不被误删，redact 不是一刀切");
    assert.doesNotMatch(serialized, /AbCdEf0123456789/);
  });
});

// ---------------------------------------------------------------------------
// 3. bridges 组聚合形状（fake 桥注入）
// ---------------------------------------------------------------------------

test("bridges aggregate eight rows from injected read-only probes with honest states", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
      bridges: {
        crmSnapshot: async () => undefined,
        fbiMetrics: async () => null,
        pplInspection: async () => undefined,
        opsDigest: async () => undefined,
      },
    });
    const snapshot = await bridge.snapshot();
    assert.deepEqual(
      snapshot.bridges.map((row) => row.name),
      ["crm", "dingtalk", "fbi-metrics", "ppl-inspection", "kb", "cases", "ops", "maas"],
      "八桥固定行序",
    );
    assert.equal(rowOf(snapshot, "bridges", "crm").state, "unconfigured");
    assert.match(rowOf(snapshot, "bridges", "crm").detail, /crm-snapshot\.json/);
    assert.equal(rowOf(snapshot, "bridges", "fbi-metrics").state, "unconfigured");
    assert.equal(rowOf(snapshot, "bridges", "ppl-inspection").state, "unconfigured");
    assert.equal(rowOf(snapshot, "bridges", "ops").state, "unconfigured");
    assert.equal(rowOf(snapshot, "bridges", "dingtalk").state, "ok");
    assert.match(rowOf(snapshot, "bridges", "dingtalk").detail, /1 条/);
    assert.equal(rowOf(snapshot, "bridges", "kb").state, "ok");
    assert.match(rowOf(snapshot, "bridges", "kb").detail, /1\/2/);
    assert.equal(rowOf(snapshot, "bridges", "maas").state, "unconfigured", "缺 CRM 快照时 maas 候选不可生成");
    assert.equal(rowOf(snapshot, "bridges", "cases").state, "unconfigured");
    // 行白名单：绝无多余字段（无凭据位形的空间）。
    for (const row of snapshot.bridges) {
      assert.deepEqual(Object.keys(row).sort(), ["detail", "name", "state"]);
    }
  });
});

test("a throwing bridge probe degrades to its own error row with a redacted reason", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
      bridges: {
        dingtalkWrites: async () => {
          throw new Error("writes 文件损坏 auth_token=AbCdEf0123456789AbCd");
        },
      },
    });
    const snapshot = await bridge.snapshot();
    const dingtalk = rowOf(snapshot, "bridges", "dingtalk");
    assert.equal(dingtalk.state, "error");
    assert.match(dingtalk.detail, /已脱敏/);
    assert.doesNotMatch(dingtalk.detail, /AbCdEf0123456789/);
    assert.equal(rowOf(snapshot, "bridges", "crm").state, "ok", "单桥异常不影响其余桥");
  });
});

test("cases row reads the config file only (never fans out channel CLIs) and reports counts", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "cases.json");
    await writeFile(configPath, JSON.stringify({
      code: { repos: [{ repo: "合成组/甲科技仓" }] },
      oss: { bucket: "deck-bucket.example" },
    }), "utf-8");
    let cliCalls = 0;
    const runner: HealthCommandRunner = async (...args) => {
      cliCalls += 1;
      return okRunner(...args);
    };
    const bridge = createTestBridge({ run: runner, casesConfigPath: configPath });
    const snapshot = await bridge.snapshot();
    const cases = rowOf(snapshot, "bridges", "cases");
    assert.equal(cases.state, "ok");
    assert.match(cases.detail, /仓库 1 个/);
    assert.match(cases.detail, /OSS 桶 1 个/);
    assert.equal(cliCalls, 5, "只有五个 CLI presence 探测，绝无渠道扇出");
  });
});

// ---------------------------------------------------------------------------
// 4. caps 组：env 只报 set/unset；条件修法行只在缺口真实存在时出现
// ---------------------------------------------------------------------------

test("caps report env set/unset booleans only and never leak values", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({
      env: { DASHSCOPE_API_KEY: "sk-live-synthetic-value-0001", OPS_DINGTALK_PUSH_ENABLED: "true" },
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
    });
    const snapshot = await bridge.snapshot();
    const dashscope = rowOf(snapshot, "caps", "DASHSCOPE_API_KEY");
    assert.equal(dashscope.state, "ok");
    assert.equal(dashscope.set, true);
    const push = rowOf(snapshot, "caps", "OPS_DINGTALK_PUSH_ENABLED");
    assert.equal(push.set, true);
    const receiver = rowOf(snapshot, "caps", "OPS_DINGTALK_PUSH_OPEN_DINGTALK_ID");
    assert.equal(receiver.set, false);
    assert.equal(receiver.state, "unconfigured");
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-live-synthetic-value-0001/);
    assert.equal(snapshot.caps.length, 3, "无缺口时不凑条件行");
  });
});

test("conditional fix hints appear only when an enabled config needs a missing CLI", async () => {
  await withTempDir(async (dir) => {
    const kbNeedingDws = healthyBridgeFakes({
      kbConfig: async () => ({ sources: [{ enabled: true, type: "bailian" }] }),
    });
    const bridge = createTestBridge({
      run: missingDwsRunner,
      casesConfigPath: join(dir, "absent-cases.json"),
      cacheDir: dir,
      bridges: { kbConfig: kbNeedingDws.kbConfig },
    });
    const snapshot = await bridge.snapshot();
    const kbDws = rowOf(snapshot, "caps", "kb-dws");
    assert.equal(kbDws.state, "error");
    assert.match(kbDws.note, /dws auth login/);
    // cases 配置缺失 → cases-a1 / cases-ossutil 修法行不出现（无配置就没有「要它」）。
    assert.equal(snapshot.caps.some((row) => row.name === "cases-a1"), false);

    const configPath = join(dir, "cases.json");
    await writeFile(configPath, JSON.stringify({
      code: { repos: [{ repo: "合成组/甲科技仓" }] },
      oss: { bucket: "deck-bucket.example" },
    }), "utf-8");
    const missingCasesClis: HealthCommandRunner = fakeRunner((file) =>
      file === "a1" || file === "ossutil" ? { code: "ENOENT" } : { stdout: `${file} version 2.4.1 (synthetic)\n` });
    const casesBridge = createTestBridge({
      run: missingCasesClis,
      casesConfigPath: configPath,
      cacheDir: dir,
      bridges: { kbConfig: async () => ({ sources: [] }) },
    });
    const casesSnapshot = await casesBridge.snapshot();
    assert.match(rowOf(casesSnapshot, "caps", "cases-a1").note, /a1 auth login/);
    assert.match(rowOf(casesSnapshot, "caps", "cases-ossutil").note, /ossutil config/);
    assert.equal(casesSnapshot.caps.some((row) => row.name === "kb-dws"), false, "kb 无启用 dws 源时不出现该行");
  });
});

// ---------------------------------------------------------------------------
// 5. 路由端点（/local/health，只读）
// ---------------------------------------------------------------------------

const TRUSTED = { host: "127.0.0.1:8000" };

function get(path: string): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method: "GET", headers: TRUSTED });
}

test("router serves GET /local/health read-only and maps bridge failure to 502", async () => {
  await withTempDir(async (dir) => {
    const bridge = createTestBridge({ casesConfigPath: join(dir, "absent-cases.json"), cacheDir: dir });
    const router = createLocalRouter({ port: 8000, healthBridge: bridge });
    const response = await router(get("/local/health"));
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; data: HealthSnapshot };
    assert.equal(body.ok, true);
    assert.equal(body.data.bridges.length, 8);
    assert.equal(body.data.cli.length, 5);
    assert.match(body.data.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

    const rejected = await router(new Request("http://127.0.0.1:8000/local/health", { method: "POST", headers: TRUSTED }));
    assert.equal(rejected.status, 405, "只读端点拒绝写方法");

    const failingRouter = createLocalRouter({
      port: 8000,
      healthBridge: { snapshot: async () => { throw new Error("boom"); } },
    });
    const failed = await failingRouter(get("/local/health"));
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as { error: string }).error, "health_unavailable");
  });
});
