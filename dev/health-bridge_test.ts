import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HEALTH_ROUTES, HealthBridgeError, createHealthBridge, type HealthBridge, type HealthSnapshot } from "./health-bridge.ts";
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

test("maas row reads manual override count / corrupt state from the injected read-only probe", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({ schemaVersion: 1 }), "utf-8");
    let probeCalls = 0;
    const withState = (state: { overrides: Record<string, string>; source: string }): HealthBridge => createHealthBridge({
      now: () => Date.parse("2026-10-20T02:00:00.000Z"),
      env: {},
      run: okRunner,
      cacheDir: dir,
      casesConfigPath: join(dir, "absent-cases.json"),
      ...healthyBridgeFakes(),
      kbConfig: healthyBridgeFakes().kbConfig as never,
      maasOverrides: async () => {
        probeCalls += 1;
        return state as never;
      },
    });

    const ok = rowOf(await withState({ overrides: { "9900000001": "maas", "9900000002": "non_maas" }, source: "local" }).snapshot(), "bridges", "maas");
    assert.equal(ok.state, "ok");
    assert.match(ok.detail, /人工覆盖 2 条/);
    assert.doesNotMatch(ok.detail, /9900/, "只报计数，cid 不进快照");

    const corrupt = rowOf(await withState({ overrides: {}, source: "corrupt" }).snapshot(), "bridges", "maas");
    assert.equal(corrupt.state, "error");
    assert.match(corrupt.detail, /损坏/);
    assert.equal(probeCalls, 2, "每次体检只调只读覆盖表探针一次");

    // 未注入探针 → 保持旧口径（只判快照存在性），不凭空造计数。
    const legacy = rowOf(await createTestBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json") }).snapshot(), "bridges", "maas");
    assert.equal(legacy.state, "ok");
    assert.doesNotMatch(legacy.detail, /人工覆盖/);
  });
});

test("router wires only the maas bridge read-only override state into the health bridge (static assertion)", async () => {
  // 静态断言：不实例化默认体检桥（那会探测真实 CLI 与 .local-cache），只核对接线。
  const source = await readFile(new URL("./local-router.ts", import.meta.url), "utf-8");
  const wiring = source.slice(source.indexOf("createHealthBridge({"), source.indexOf("});", source.indexOf("createHealthBridge({")));
  assert.match(wiring, /maasOverrides:\s*maasBridge\.overridesState,/);
  assert.doesNotMatch(wiring, /candidates/, "体检绝不接入会写盘的 candidates()");
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

// ---------------------------------------------------------------------------
// 现场重检（POST /local/health/check）与登录态续期检测（POST /local/health/renew）
// 合成数据约定同上：runner 全量注入，凭据样文本全部为敌意合成构造。
// ---------------------------------------------------------------------------

function createClockBridge(options: HealthOptions & { clock?: { t: number } } = {}) {
  const clock = options.clock ?? { t: Date.parse("2026-10-20T02:00:00.000Z") };
  const fakes = healthyBridgeFakes(options.bridges);
  const bridge = createHealthBridge({
    now: () => clock.t,
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
  return { bridge, clock };
}

const renewRunner = fakeRunner((file, args) => {
  if (file === "a1" && args[0] === "auth") {
    return { stdout: JSON.stringify({ account: "synthetic-account", nickname: "合成花名", source: "ncs" }) };
  }
  if (file === "dws" && args[0] === "auth") {
    return { stdout: JSON.stringify({ authenticated: true, corp_name: "SyntheticCorp", user_name: "synthetic-user", refresh_expires_at: "2026-11-20T00:00:00Z" }) };
  }
  if (file === "aliyun" && args[0] === "sts") {
    return { stdout: JSON.stringify({ Arn: "acs:ram::123456:role/synthetic-role", IdentityType: "AssumedRoleUser" }) };
  }
  if (file === "ossutil" && args[0] === "ls") {
    return { stdout: "Bucket Number is: 3\nelapsed: 0.5s\n" };
  }
  if (file === "qodercli") return { stdout: "qodercli 1.9.9 (synthetic)\n" };
  return { stdout: "" };
});

test("check: first run without persisted snapshot runs all groups and persists group timestamps", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json") });
    const result = await bridge.check({ group: "cli" });
    assert.equal(result.cli.length, 5);
    assert.equal(result.bridges.length, 8);
    assert.ok(result.caps.length >= 3);
    assert.equal(result.groupCheckedAt.bridges, "2026-10-20T02:00:00.000Z");
    assert.equal(result.groupCheckedAt.cli, "2026-10-20T02:00:00.000Z");
    assert.equal(result.groupCheckedAt.caps, "2026-10-20T02:00:00.000Z");
    const persisted = JSON.parse(await readFile(join(dir, "health.json"), "utf-8")) as { groupCheckedAt: Record<string, string> };
    assert.equal(persisted.groupCheckedAt.cli, "2026-10-20T02:00:00.000Z");
  });
});

test("check: re-running one group reuses the other groups from the persisted snapshot", async () => {
  await withTempDir(async (dir) => {
    const clock = { t: Date.parse("2026-10-20T02:00:00.000Z") };
    const first = createClockBridge({ cacheDir: dir, clock, casesConfigPath: join(dir, "absent-cases.json"), run: okRunner });
    await first.bridge.check({ group: "bridges" });

    // 换 runner + 推进时钟：只重检 cli，其余组沿用上轮
    clock.t = Date.parse("2026-10-20T03:00:00.000Z");
    const second = createClockBridge({ cacheDir: dir, clock, casesConfigPath: join(dir, "absent-cases.json"), run: missingRunner });
    const result = await second.bridge.check({ group: "cli" });
    assert.equal(rowOf(result, "cli", "a1").state, "missing", "cli 组应来自新 runner");
    assert.equal(result.groupCheckedAt.cli, "2026-10-20T03:00:00.000Z");
    assert.equal(result.groupCheckedAt.bridges, "2026-10-20T02:00:00.000Z", "bridges 组沿用上轮时间戳");
    assert.equal(result.groupCheckedAt.caps, "2026-10-20T02:00:00.000Z");
    assert.equal(result.bridges.length, 8, "bridges 行沿用上轮快照");
  });
});

test("check: bridges group rerun keeps cli rows from previous round", async () => {
  await withTempDir(async (dir) => {
    const clock = { t: Date.parse("2026-10-20T02:00:00.000Z") };
    const first = createClockBridge({ cacheDir: dir, clock, casesConfigPath: join(dir, "absent-cases.json"), run: missingRunner });
    await first.bridge.check({ group: "cli" });
    clock.t = Date.parse("2026-10-20T04:00:00.000Z");
    const second = createClockBridge({ cacheDir: dir, clock, casesConfigPath: join(dir, "absent-cases.json"), run: okRunner });
    const result = await second.bridge.check({ group: "bridges" });
    assert.equal(rowOf(result, "cli", "a1").state, "missing", "cli 行必须沿用上一轮，不得被顺带重跑");
    assert.equal(result.groupCheckedAt.bridges, "2026-10-20T04:00:00.000Z");
    assert.equal(result.groupCheckedAt.cli, "2026-10-20T02:00:00.000Z");
  });
});

test("check: invalid group rejected; concurrent checks are single-flight", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json") });
    await assert.rejects(
      () => bridge.check({ group: "nope" }),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "health_invalid_group",
    );
    await assert.rejects(
      () => bridge.check({}),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "health_invalid_request",
    );
  });
});

test("check: corrupt persisted snapshot falls back to a full fresh run", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "health.json"), "{corrupt", "utf-8");
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json") });
    const result = await bridge.check({ group: "cli" });
    assert.equal(result.cli.length, 5);
    assert.equal(result.bridges.length, 8);
    const persisted = JSON.parse(await readFile(join(dir, "health.json"), "utf-8")) as { cli: unknown[] };
    assert.equal(persisted.cli.length, 5);
  });
});

test("check: hostile CLI output never reaches the persisted snapshot", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: hostileRunner });
    await bridge.check({ group: "cli" });
    const text = await readFile(join(dir, "health.json"), "utf-8");
    assert.ok(!text.includes("LTAI5tSyntheticSyntheticValue01"));
    assert.ok(!text.includes("8f14e45fceea167a5a36dedd4bea2543"));
    assert.ok(!text.includes("sk-synthetic0123456789abcdef"));
    assert.ok(!text.includes("hunter2-master-key-2026"));
  });
});

test("renew: reruns login-state subcommands for all five CLIs without echoing identity values", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: renewRunner });
    const result = await bridge.renew({});
    assert.equal(result.renewedAt, "2026-10-20T02:00:00.000Z");
    assert.equal(result.results.length, 5);
    const byKey = new Map(result.results.map((r) => [r.key, r]));
    assert.equal(byKey.get("a1")?.state, "ok");
    assert.equal(byKey.get("dws")?.state, "ok");
    assert.equal(byKey.get("dws")?.expiresAt, "2026-11-20T00:00:00.000Z");
    assert.equal(byKey.get("aliyun")?.state, "ok");
    assert.equal(byKey.get("ossutil")?.state, "ok");
    assert.ok(byKey.get("ossutil")?.note.includes("3"));
    assert.equal(byKey.get("qodercli")?.state, "ok");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("synthetic-account"), "身份值绝不回显");
    assert.ok(!serialized.includes("SyntheticCorp"));
    assert.ok(!serialized.includes("synthetic-user"));
    assert.ok(!serialized.includes("acs:ram::123456"));
  });
});

test("renew: keys subset only runs requested CLIs; unknown key rejected", async () => {
  await withTempDir(async (dir) => {
    const calls: string[] = [];
    const trackingRunner: HealthCommandRunner = async (file, args) => {
      calls.push(file);
      return renewRunner(file, args, { timeoutMs: 1000 });
    };
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: trackingRunner });
    const result = await bridge.renew({ keys: ["dws"] });
    assert.deepEqual(calls, ["dws"]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.key, "dws");
    await assert.rejects(
      () => bridge.renew({ keys: ["nope"] }),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "health_invalid_request",
    );
  });
});

test("renew: expired session, missing CLI and timeout degrade per key", async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner((file, args) => {
      if (file === "dws") return { stdout: JSON.stringify({ authenticated: false }) };
      if (file === "a1") return { code: "ENOENT" };
      if (file === "aliyun") return { code: null };
      if (file === "ossutil") return { code: 1, stdout: "", stderr: "ossutil: config not found" };
      return { stdout: "qodercli 1.9.9\n" };
    });
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: runner });
    const result = await bridge.renew({});
    const byKey = new Map(result.results.map((r) => [r.key, r]));
    assert.equal(byKey.get("dws")?.state, "expired");
    assert.ok(byKey.get("dws")?.note.includes("dws auth login"));
    assert.equal(byKey.get("a1")?.state, "missing");
    assert.equal(byKey.get("aliyun")?.state, "error");
    assert.equal(byKey.get("ossutil")?.state, "error");
    assert.equal(byKey.get("qodercli")?.state, "ok");
  });
});

test("renew: hostile output redacted; results never written into health.json", async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner((file) => ({
      code: 1,
      stdout: "",
      stderr: "fatal: Set-Cookie: SESSION=8f14e45fceea167a5a36dedd4bea2543; login_token=AbCdEf0123456789AbCdEf0123456789",
    }));
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: runner });
    const result = await bridge.renew({ keys: ["dws"] });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("8f14e45fceea167a5a36dedd4bea2543"));
    assert.ok(!serialized.includes("AbCdEf0123456789"));
    await assert.rejects(() => readFile(join(dir, "health.json"), "utf-8"), "renew 不写快照文件");
  });
});

test("handle: POST /local/health/check and /local/health/renew; 405 on GET; unrelated → undefined", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: renewRunner });
    const post = (path: string, body: unknown) => new Request(`http://127.0.0.1:8000${path}`, {
      method: "POST",
      headers: { ...TRUSTED, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const checked = await bridge.handle(post("/local/health/check", { group: "cli" }));
    assert.ok(checked);
    assert.equal(checked.status, 200);
    assert.equal(checked.headers.get("cache-control"), "no-store");
    const checkPayload = await checked.json() as { ok: boolean; data: { groupCheckedAt: Record<string, string> } };
    assert.equal(checkPayload.ok, true);
    assert.ok(checkPayload.data.groupCheckedAt.cli);

    const renewed = await bridge.handle(post("/local/health/renew", { keys: ["dws"] }));
    assert.ok(renewed);
    assert.equal(renewed.status, 200);

    const badGroup = await bridge.handle(post("/local/health/check", { group: "nope" }));
    assert.ok(badGroup);
    assert.equal(badGroup.status, 400);

    const wrongMethod = await bridge.handle(get("/local/health/check"));
    assert.ok(wrongMethod);
    assert.equal(wrongMethod.status, 405);

    assert.equal(await bridge.handle(get("/local/health")), undefined, "GET /local/health 保持 local-router 既有接线");
    assert.deepEqual(HEALTH_ROUTES.map((r) => `${r.method} ${r.path}`), ["POST /local/health/check", "POST /local/health/renew"]);
  });
});

test("check: concurrent group checks are single-flight (health_busy)", async () => {
  await withTempDir(async (dir) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowRunner: HealthCommandRunner = async (file, args) => {
      await gate;
      return okRunner(file, args, { timeoutMs: 1000 });
    };
    const { bridge } = createClockBridge({ cacheDir: dir, casesConfigPath: join(dir, "absent-cases.json"), run: slowRunner });
    const first = bridge.check({ group: "cli" });
    await assert.rejects(
      () => bridge.check({ group: "caps" }),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "health_busy",
    );
    release();
    await first;
  });
});
