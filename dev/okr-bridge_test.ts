import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import {
  createDefaultPythonRunner,
  createOkrBridge,
  editKey,
  OKR_REFRESH_TIMEOUT_MS,
  OKR_ROUTES,
  OKR_SYNC_TIMEOUT_MS,
  parseLastJson,
  validateOkrEdits,
  type OkrBridge,
  type PythonRunOptions,
  type PythonRunResult,
  type PythonRunner,
} from "./okr-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定（红线）：工号 / cookie / 目标 id / 目标文本全为合成值，
// 绝不出现真实客户名、真实工号、真实 token；python 全程 stub runner 注入，
// 不触真实内网（默认 runner 集成用例只跑本地合成脚本）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-21T03:40:00.000Z");
const NOW_ISO = "2026-10-21T03:40:00.000Z";
const EMP = "SYN-EMP-0001";
const SYN_COOKIE = "syn_session_a=SYN-COOKIE-abc123; syn_session_b=SYN-VALUE-xyz789";
const O_ID = "0123456789abcdef01234567";
const KR_ID = "abcdef0123456789abcdef01";
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");

const pythonAvailable = await new Promise<boolean>((resolve) => {
  execFile("python3", ["--version"], (error) => resolve(!error));
});

interface Fixture {
  readonly home: string;
  readonly cacheDir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "okr-bridge-"));
  const home = join(root, "home");
  const cacheDir = join(root, "cache");
  await mkdir(home, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  return { home, cacheDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 预置 active + profile（manual 会话，合成 cookie）。 */
async function seedSession(fx: Fixture, cookie: string | null = SYN_COOKIE): Promise<void> {
  const userDir = join(fx.home, ".sa-workbench", "users", EMP);
  await mkdir(userDir, { recursive: true });
  await writeFile(
    join(fx.home, ".sa-workbench", "active.json"),
    JSON.stringify({ empId: EMP, at: NOW_ISO }, null, 2),
    "utf-8",
  );
  await writeFile(
    join(userDir, "profile.json"),
    JSON.stringify({
      version: 1,
      user: { empId: EMP, name: "合成用户" },
      source: { mode: "manual" },
      session: cookie === null ? null : { value: cookie, domains: ["aliyun-inc.com"], updatedAt: NOW_ISO, lastCheck: null, verifiedAt: null },
      prefs: {},
    }, null, 2),
    "utf-8",
  );
  await chmod(join(userDir, "profile.json"), 0o600);
}

interface BridgeOptions {
  readonly pythonRunner?: PythonRunner;
  readonly now?: () => number;
}

function makeBridge(fx: Fixture, options: BridgeOptions = {}): OkrBridge {
  return createOkrBridge({
    home: fx.home,
    cacheDir: fx.cacheDir,
    now: options.now ?? (() => FIXED_NOW),
    pythonRunner: options.pythonRunner,
  });
}

function jsonRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:8000${path}`, init);
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function pyResult(partial: Partial<PythonRunResult> = {}): PythonRunResult {
  return { exitCode: 0, timedOut: false, stdout: "", stderr: "", spawnError: null, ...partial };
}

function stubRunner(result: PythonRunResult, calls: PythonRunOptions[] = []): PythonRunner {
  return async (options) => {
    calls.push(options);
    return result;
  };
}

function deferredRunner(calls: PythonRunOptions[] = []): { runner: PythonRunner; release: (result: PythonRunResult) => void } {
  let releaseFn: ((result: PythonRunResult) => void) | null = null;
  const pending = new Promise<PythonRunResult>((resolve) => { releaseFn = resolve; });
  const runner: PythonRunner = async (options) => {
    calls.push(options);
    return pending;
  };
  return { runner, release: (result) => releaseFn?.(result) };
}

const EDIT_TITLE = { kind: "o", oId: O_ID, field: "title", from: "合成旧目标标题", to: "合成新目标标题" } as const;
const EDIT_KR_WEIGHT = { kind: "kr", oId: O_ID, krId: KR_ID, field: "weight", from: "30", to: "40" } as const;
const KEY_TITLE = `${O_ID}||title`;
const KEY_KR_WEIGHT = `${O_ID}|${KR_ID}|weight`;

/** donor okr_write.py 的末行 JSON（dry-run：一冲突一待写）。 */
function dryStdout(): string {
  return JSON.stringify({
    ok: true,
    mode: "dry-run",
    acceptConflicts: false,
    baseSnapshotAt: "2026-10-01 10:00:00",
    wrote: 0,
    results: [
      { kind: "o", oId: O_ID, krId: null, field: "title", from: EDIT_TITLE.from, to: EDIT_TITLE.to, crd: "合成他人已改标题", state: "conflict", note: "CRD 当前值与导出原值不同（他人已改），默认跳过" },
      { kind: "kr", oId: O_ID, krId: KR_ID, field: "weight", from: "30", to: "40", crd: "30", state: "pending", note: "" },
    ],
    note: "dry-run：未写任何数据；1 项待同步，1 项冲突跳过",
  });
}

function confirmStdout(wrote: number): string {
  return JSON.stringify({
    ok: true,
    mode: "confirm",
    acceptConflicts: false,
    wrote,
    results: [
      { kind: "kr", oId: O_ID, krId: KR_ID, field: "weight", from: "30", to: "40", crd: "30", state: "written", note: "" },
    ],
    note: "",
  });
}

const SYN_SNAPSHOT = {
  generatedAt: "2026-10-20 09:00:00",
  mode: "live",
  period: { id: "p1", name: "FY27", periodType: "FY" },
  periodsFY: [{ id: "p1", name: "FY27", periodType: "FY", duration: null }],
  totals: { oCount: 1, krCount: 2, crdProgressCount: 1 },
  objectives: [{ idx: "O1", id: O_ID, title: "合成目标", keyResults: [] }],
};

async function seedSnapshot(fx: Fixture): Promise<void> {
  await writeFile(join(fx.cacheDir, "okr.json"), JSON.stringify(SYN_SNAPSHOT, null, 1), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. 路由表契约（供交付负责人接线 local-router.ts）
// ---------------------------------------------------------------------------

test("OKR_ROUTES exposes the five wiring entries (method + path + handler)", () => {
  assert.deepEqual(
    OKR_ROUTES.map((route) => `${route.method} ${route.path} -> ${route.handler}`),
    [
      "GET /local/okr -> view",
      "POST /local/okr/refresh -> refresh",
      "GET /local/okr/edits -> edits",
      "POST /local/okr/sync-dry -> syncDry",
      "POST /local/okr/sync-confirm -> syncConfirm",
    ],
  );
});

// ---------------------------------------------------------------------------
// 2. 纯函数：编辑键与白名单校验
// ---------------------------------------------------------------------------

test("editKey builds oId|krId|field and keeps kr slot empty for objective edits", () => {
  assert.equal(editKey({ oId: O_ID, krId: null, field: "title" }), KEY_TITLE);
  assert.equal(editKey({ oId: O_ID, krId: KR_ID, field: "weight" }), KEY_KR_WEIGHT);
});

test("validateOkrEdits accepts whitelisted fields and rejects hostile shapes", () => {
  const ok = validateOkrEdits([EDIT_TITLE, EDIT_KR_WEIGHT]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.edits.map((edit) => editKey(edit)), [KEY_TITLE, KEY_KR_WEIGHT]);
  }
  const bad: unknown[] = [
    [],
    [{ kind: "x", oId: O_ID, field: "title", to: "a" }],
    [{ kind: "o", oId: O_ID, field: "secret", to: "a" }],
    [{ kind: "o", oId: "../evil", field: "title", to: "a" }],
    [{ kind: "kr", oId: O_ID, field: "title", to: "a" }], // kr 缺 krId
    [{ kind: "o", oId: O_ID, field: "title", to: "x".repeat(4001) }],
    [{ kind: "o", oId: O_ID, field: "title", to: { nested: true } }],
    "not-an-array",
  ];
  for (const input of bad) {
    assert.equal(validateOkrEdits(input).ok, false, `应拒绝：${JSON.stringify(input)?.slice(0, 60)}`);
  }
  const tooMany = Array.from({ length: 201 }, () => EDIT_TITLE);
  assert.equal(validateOkrEdits(tooMany).ok, false);
});

test("parseLastJson tolerates warning lines and rejects non-JSON tails", () => {
  assert.deepEqual(parseLastJson('noise\n{"ok": true}\n'), { ok: true });
  assert.equal(parseLastJson("no json here"), null);
  assert.equal(parseLastJson(""), null);
});

// ---------------------------------------------------------------------------
// 3. 无会话：五个端点一律 400 profile_no_session（诚实引导态）
// ---------------------------------------------------------------------------

test("every endpoint answers 400 profile_no_session without a configured BUC session", async () => {
  const fx = await makeFixture();
  try {
    const bridge = makeBridge(fx);
    const responses = [
      await bridge.view(jsonRequest("GET", "/local/okr")),
      await bridge.refresh(jsonRequest("POST", "/local/okr/refresh")),
      await bridge.edits(jsonRequest("GET", "/local/okr/edits")),
      await bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", { edits: [EDIT_TITLE] })),
      await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_TITLE] })),
    ];
    for (const response of responses) {
      assert.equal(response.status, 400);
      const body = await readBody(response);
      assert.equal(body.ok, false);
      assert.equal((body.error as Record<string, unknown>).code, "profile_no_session");
      assert.ok(String((body.error as Record<string, unknown>).message).includes("个人中心"));
    }
  } finally {
    await fx.cleanup();
  }
});

test("session saved but no active user / empty cookie also yields profile_no_session", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx, null);
    const response = await makeBridge(fx).view(jsonRequest("GET", "/local/okr"));
    assert.equal(response.status, 400);
    assert.equal(((await readBody(response)).error as Record<string, unknown>).code, "profile_no_session");
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. GET /local/okr：快照 + 周期列表 + 编辑态；无快照诚实空态；损坏拒读
// ---------------------------------------------------------------------------

test("GET view returns snapshot, periods, staged edits and a masked session (never the cookie)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    await seedSnapshot(fx);
    await writeFile(
      join(fx.cacheDir, "edits.json"),
      JSON.stringify({ exportedAt: NOW_ISO, baseSnapshotAt: "2026-10-20 09:00:00", edits: [EDIT_TITLE] }, null, 2),
      "utf-8",
    );
    const response = await makeBridge(fx).view(jsonRequest("GET", "/local/okr"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(SYN_COOKIE), "响应绝不含 session 原值");
    assert.ok(!serialized.includes("SYN-VALUE-xyz789"), "响应绝不含任何 cookie 分量原值");
    const data = body.data as Record<string, unknown>;
    assert.equal(data.hasSnapshot, true);
    const snapshot = data.snapshot as Record<string, unknown>;
    assert.deepEqual(snapshot.period, SYN_SNAPSHOT.period);
    assert.deepEqual(snapshot.periodsFY, SYN_SNAPSHOT.periodsFY);
    assert.deepEqual(data.edits, [{ ...EDIT_TITLE, krId: null }]);
    const session = data.session as Record<string, unknown>;
    assert.equal((session.user as Record<string, unknown>).empId, EMP);
    assert.ok(String((session.session as Record<string, unknown>).masked).includes("…共"));
  } finally {
    await fx.cleanup();
  }
});

test("GET view without snapshot answers hasSnapshot:false (honest empty state)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const body = await readBody(await makeBridge(fx).view(jsonRequest("GET", "/local/okr")));
    const data = body.data as Record<string, unknown>;
    assert.equal(data.hasSnapshot, false);
    assert.equal(data.snapshot, null);
    assert.deepEqual(data.edits, []);
  } finally {
    await fx.cleanup();
  }
});

test("GET view refuses a corrupt snapshot with 409 okr_corrupt and never overwrites it", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    await writeFile(join(fx.cacheDir, "okr.json"), "{ broken", "utf-8");
    const response = await makeBridge(fx).view(jsonRequest("GET", "/local/okr"));
    assert.equal(response.status, 409);
    assert.equal(((await readBody(response)).error as Record<string, unknown>).code, "okr_corrupt");
    assert.equal(await readFile(join(fx.cacheDir, "okr.json"), "utf-8"), "{ broken");
  } finally {
    await fx.cleanup();
  }
});

test("GET edits returns the staged edit file (empty list when absent)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const bridge = makeBridge(fx);
    const empty = await readBody(await bridge.edits(jsonRequest("GET", "/local/okr/edits")));
    assert.deepEqual((empty.data as Record<string, unknown>).edits, []);
    await writeFile(
      join(fx.cacheDir, "edits.json"),
      JSON.stringify({ exportedAt: NOW_ISO, baseSnapshotAt: "", edits: [EDIT_KR_WEIGHT] }, null, 2),
      "utf-8",
    );
    const body = await readBody(await bridge.edits(jsonRequest("GET", "/local/okr/edits")));
    const data = body.data as Record<string, unknown>;
    assert.deepEqual(data.edits, [{ ...EDIT_KR_WEIGHT }]);
    assert.equal(data.exportedAt, NOW_ISO);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. POST /local/okr/refresh：execFile python3 + env 注入 + 60s 超时 + 掩码
// ---------------------------------------------------------------------------

test("POST refresh runs fetch_okr.py with --out, 60s timeout and env-injected cookie only", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    const summary = { ok: true, generatedAt: "2026-10-21 03:40:00", mode: "live", period: { id: "p1", name: "FY27", periodType: "FY" }, totals: { oCount: 1, krCount: 2, crdProgressCount: 3 }, sizeKb: 12 };
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult({ stdout: `[1/3] 拉取中\n${JSON.stringify(summary)}\n` }), calls) });
    const response = await bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE));
    const data = body.data as Record<string, unknown>;
    assert.equal(data.generatedAt, summary.generatedAt);
    assert.deepEqual(data.totals, summary.totals);

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.scriptPath.endsWith(join("tools", "okr", "fetch_okr.py")), "默认脚本路径指向 tools/okr/fetch_okr.py");
    assert.deepEqual(calls[0]!.args, ["--out", join(fx.cacheDir, "okr.json")]);
    assert.equal(calls[0]!.timeoutMs, OKR_REFRESH_TIMEOUT_MS);
    assert.equal(calls[0]!.timeoutMs, 60_000);
    assert.equal(calls[0]!.env.SA_SESSION_COOKIE, SYN_COOKIE, "cookie 只经 env 注入子进程");
    assert.ok(!calls[0]!.args.some((arg) => arg.includes(SYN_COOKIE)), "cookie 绝不进 argv");
  } finally {
    await fx.cleanup();
  }
});

test("POST refresh failure redacts hostile output and answers 502 okr_refresh_failed", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const bridge = makeBridge(fx, {
      pythonRunner: stubRunner(pyResult({ exitCode: 1, stdout: "", stderr: `boom cookie=${SYN_COOKIE} leaked` })),
    });
    const response = await bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    assert.equal(response.status, 502);
    const body = await readBody(response);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(SYN_COOKIE), "敌意 stderr 里的 cookie 必须被 redact");
    assert.ok(!serialized.includes("SYN-VALUE-xyz789"));
    assert.equal((body.error as Record<string, unknown>).code, "okr_refresh_failed");
  } finally {
    await fx.cleanup();
  }
});

test("POST refresh reports timeout honestly (502, timedOut flag in message)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult({ exitCode: null, timedOut: true })) });
    const response = await bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    assert.equal(response.status, 502);
    const body = await readBody(response);
    assert.ok(String((body.error as Record<string, unknown>).message).includes("超时"));
  } finally {
    await fx.cleanup();
  }
});

test("single-flight lock: second refresh while one is running answers 429 okr_busy", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const { runner, release } = deferredRunner();
    const bridge = makeBridge(fx, { pythonRunner: runner });
    const first = bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    const second = await bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    assert.equal(second.status, 429);
    assert.equal(((await readBody(second)).error as Record<string, unknown>).code, "okr_busy");
    release(pyResult({ stdout: JSON.stringify({ ok: true, generatedAt: "x", mode: "live", period: null, totals: { oCount: 0, krCount: 0, crdProgressCount: 0 }, sizeKb: 1 }) }));
    assert.equal((await first).status, 200);
    // 锁已释放：第三次可再进入（runner 会再被调用）。
    const third = await bridge.refresh(jsonRequest("POST", "/local/okr/refresh"));
    assert.equal(third.status, 200);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. POST /local/okr/sync-dry：逐项差异，不落远端（绝不带 --confirm）
// ---------------------------------------------------------------------------

test("sync-dry validates edits, stages edits.json and maps per-item diffs (never --confirm)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult({ stdout: dryStdout() }), calls) });
    const response = await bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", {
      edits: [EDIT_TITLE, EDIT_KR_WEIGHT],
      baseSnapshotAt: "2026-10-20 09:00:00",
    }));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE));
    const data = body.data as Record<string, unknown>;
    assert.equal(data.mode, "dry-run");
    const items = data.items as Record<string, unknown>[];
    assert.equal(items.length, 2);
    const conflict = items.find((item) => item.key === KEY_TITLE)!;
    assert.equal(conflict.field, "title");
    assert.equal(conflict.before, EDIT_TITLE.from);
    assert.equal(conflict.after, EDIT_TITLE.to);
    assert.equal(conflict.crd, "合成他人已改标题");
    assert.equal(conflict.conflict, true);
    const pending = items.find((item) => item.key === KEY_KR_WEIGHT)!;
    assert.equal(pending.conflict, false);
    assert.equal(pending.state, "pending");

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.scriptPath.endsWith(join("tools", "okr", "okr_write.py")));
    assert.ok(!calls[0]!.args.includes("--confirm"), "dry-run 绝不带 --confirm（不落远端）");
    assert.ok(!calls[0]!.args.includes("--accept-conflicts"));
    assert.equal(calls[0]!.timeoutMs, OKR_SYNC_TIMEOUT_MS);
    assert.equal(calls[0]!.env.SA_SESSION_COOKIE, SYN_COOKIE);

    // edits.json 已暂存（GET /local/okr/edits 可读回）
    const staged = JSON.parse(await readFile(join(fx.cacheDir, "edits.json"), "utf-8")) as Record<string, unknown>;
    assert.equal((staged.edits as unknown[]).length, 2);
    assert.equal(staged.baseSnapshotAt, "2026-10-20 09:00:00");
    const listed = await readBody(await bridge.edits(jsonRequest("GET", "/local/okr/edits")));
    assert.equal(((listed.data as Record<string, unknown>).edits as unknown[]).length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("sync-dry rejects invalid bodies with 400 okr_invalid_request", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult()) });
    for (const body of [{ edits: [] }, { edits: "x" }, {}, { edits: [{ kind: "o", oId: "short", field: "title", to: "a" }] }]) {
      const response = await bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", body));
      assert.equal(response.status, 400);
      assert.equal(((await readBody(response)).error as Record<string, unknown>).code, "okr_invalid_request");
    }
  } finally {
    await fx.cleanup();
  }
});

test("sync-dry runner failure answers 502 okr_sync_failed with redacted note", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const bridge = makeBridge(fx, {
      pythonRunner: stubRunner(pyResult({ exitCode: 1, stderr: `find 失败 cookie: ${SYN_COOKIE}` })),
    });
    const response = await bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", { edits: [EDIT_TITLE] }));
    assert.equal(response.status, 502);
    const serialized = JSON.stringify(await readBody(response));
    assert.ok(!serialized.includes(SYN_COOKIE));
    assert.ok(!serialized.includes("SYN-VALUE-xyz789"));
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. POST /local/okr/sync-confirm：仅勾选键 + 冲突拒绝 + 单飞锁 + 审计
// ---------------------------------------------------------------------------

async function seedDryRun(fx: Fixture, bridge: OkrBridge): Promise<void> {
  const response = await bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", { edits: [EDIT_TITLE, EDIT_KR_WEIGHT] }));
  assert.equal(response.status, 200);
}

test("sync-confirm with a conflicted key and no acceptConflicts is refused 409 with the conflict list", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult({ stdout: dryStdout() }), calls) });
    await seedDryRun(fx, bridge);
    calls.length = 0;
    const response = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_TITLE, KEY_KR_WEIGHT] }));
    assert.equal(response.status, 409);
    const body = await readBody(response);
    assert.equal((body.error as Record<string, unknown>).code, "okr_conflict");
    const conflicts = body.conflicts as Record<string, unknown>[];
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.key, KEY_TITLE);
    assert.equal(conflicts[0]!.crd, "合成他人已改标题");
    assert.equal(calls.length, 0, "冲突未确认时绝不触发写通道");
  } finally {
    await fx.cleanup();
  }
});

test("sync-confirm writes only the selected keys, passes --confirm and appends the audit line", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    let phase = "dry";
    let confirmFileAtRunTime: Record<string, unknown> | null = null;
    const runner: PythonRunner = async (options) => {
      calls.push(options);
      if (phase === "confirm") {
        // 在写通道被调用的瞬间抓取 confirm 文件内容（成功后桥会清理该文件）。
        const editsArg = options.args[options.args.indexOf("--edits") + 1]!;
        confirmFileAtRunTime = JSON.parse(await readFile(editsArg, "utf-8")) as Record<string, unknown>;
      }
      return pyResult({ stdout: phase === "dry" ? dryStdout() : confirmStdout(1) });
    };
    const bridge = makeBridge(fx, { pythonRunner: runner });
    await seedDryRun(fx, bridge);
    phase = "confirm";

    const response = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_KR_WEIGHT] }));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE));
    const data = body.data as Record<string, unknown>;
    assert.equal(data.mode, "confirm");
    assert.equal(data.wrote, 1);
    assert.equal((data.items as unknown[]).length, 1);

    const confirmCall = calls[calls.length - 1]!;
    assert.ok(confirmCall.args.includes("--confirm"));
    assert.ok(!confirmCall.args.includes("--accept-conflicts"), "未勾选冲突项时绝不带 --accept-conflicts");
    assert.equal(confirmCall.env.SA_SESSION_COOKIE, SYN_COOKIE);
    const editsArg = confirmCall.args[confirmCall.args.indexOf("--edits") + 1]!;
    assert.equal(editsArg, join(fx.cacheDir, "edits.confirm.json"));
    // 仅勾选键进入 confirm 文件（冲突项 KEY_TITLE 未被勾选，绝不下发）
    const stagedEdits = (confirmFileAtRunTime as Record<string, unknown> | null)?.edits as Record<string, unknown>[];
    assert.equal(stagedEdits.length, 1);
    assert.equal(stagedEdits[0]!.field, "weight");
    assert.equal(stagedEdits[0]!.krId, KR_ID);
    // 写入成功后 confirm 文件清理（donor 语义：失败才保留）
    await assert.rejects(readFile(join(fx.cacheDir, "edits.confirm.json"), "utf-8"));

    const audit = (await readFile(join(fx.cacheDir, "audit.jsonl"), "utf-8")).trim().split("\n");
    assert.equal(audit.length, 1);
    const line = JSON.parse(audit[0]!) as Record<string, unknown>;
    assert.deepEqual(line, { at: NOW_ISO, keys: [KEY_KR_WEIGHT], acceptConflicts: false, exitCode: 0 });
    assert.ok(!audit[0]!.includes(SYN_COOKIE), "审计行绝不含 cookie");
  } finally {
    await fx.cleanup();
  }
});

test("sync-confirm keeps the confirm file when the write failed and audits the exit code", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    let phase = "dry";
    const bridge = makeBridge(fx, {
      pythonRunner: async () => pyResult(
        phase === "dry"
          ? { stdout: dryStdout() }
          : { exitCode: 1, stdout: JSON.stringify({ ok: false, mode: "confirm", wrote: 0, results: [{ kind: "kr", oId: O_ID, krId: KR_ID, field: "weight", from: "30", to: "40", crd: "30", state: "failed", note: "update 失败" }], note: "" }) },
      ),
    });
    await seedDryRun(fx, bridge);
    phase = "confirm";
    const response = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_KR_WEIGHT] }));
    assert.equal(response.status, 200);
    const data = (await readBody(response)).data as Record<string, unknown>;
    assert.equal(data.ok, false);
    const kept = JSON.parse(await readFile(join(fx.cacheDir, "edits.confirm.json"), "utf-8")) as Record<string, unknown>;
    assert.equal((kept.edits as unknown[]).length, 1, "写失败时确认文件保留供排查");
    const audit = (await readFile(join(fx.cacheDir, "audit.jsonl"), "utf-8")).trim().split("\n");
    assert.equal((JSON.parse(audit[0]!) as Record<string, unknown>).exitCode, 1);
  } finally {
    await fx.cleanup();
  }
});

test("sync-confirm with acceptConflicts:true passes --accept-conflicts and audits the flag", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    let phase = "dry";
    const runner: PythonRunner = async (options) => {
      calls.push(options);
      return pyResult({ stdout: phase === "dry" ? dryStdout() : confirmStdout(2) });
    };
    const bridge = makeBridge(fx, { pythonRunner: runner });
    await seedDryRun(fx, bridge);
    phase = "confirm";
    const response = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", {
      keys: [KEY_TITLE, KEY_KR_WEIGHT],
      acceptConflicts: true,
    }));
    assert.equal(response.status, 200);
    const confirmCall = calls[calls.length - 1]!;
    assert.ok(confirmCall.args.includes("--confirm"));
    assert.ok(confirmCall.args.includes("--accept-conflicts"));
    const audit = (await readFile(join(fx.cacheDir, "audit.jsonl"), "utf-8")).trim().split("\n");
    assert.equal((JSON.parse(audit[0]!) as Record<string, unknown>).acceptConflicts, true);
  } finally {
    await fx.cleanup();
  }
});

test("sync-confirm rejects unknown keys, empty keys, non-boolean acceptConflicts and missing dry-run", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const calls: PythonRunOptions[] = [];
    const bridge = makeBridge(fx, { pythonRunner: stubRunner(pyResult({ stdout: dryStdout() }), calls) });

    // 未跑 dry-run（无 edits.json）→ 400
    const noDry = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_TITLE] }));
    assert.equal(noDry.status, 400);
    assert.equal(((await readBody(noDry)).error as Record<string, unknown>).code, "okr_invalid_request");

    await seedDryRun(fx, bridge);
    const unknownKey = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [`${O_ID}||desc`] }));
    assert.equal(unknownKey.status, 400);
    const empty = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [] }));
    assert.equal(empty.status, 400);
    const badFlag = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_KR_WEIGHT], acceptConflicts: "yes" }));
    assert.equal(badFlag.status, 400);
    const badShape = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: ["not-a-key"] }));
    assert.equal(badShape.status, 400);
    assert.equal(calls.filter((call) => call.args.includes("--confirm")).length, 0, "任何 400 都不得触发写通道");
  } finally {
    await fx.cleanup();
  }
});

test("single-flight lock spans sync-dry and sync-confirm (429 okr_busy)", async () => {
  const fx = await makeFixture();
  try {
    await seedSession(fx);
    const { runner, release } = deferredRunner();
    const bridge = makeBridge(fx, { pythonRunner: runner });
    const first = bridge.syncDry(jsonRequest("POST", "/local/okr/sync-dry", { edits: [EDIT_TITLE] }));
    const second = await bridge.syncConfirm(jsonRequest("POST", "/local/okr/sync-confirm", { keys: [KEY_TITLE] }));
    assert.equal(second.status, 429);
    assert.equal(((await readBody(second)).error as Record<string, unknown>).code, "okr_busy");
    release(pyResult({ stdout: dryStdout() }));
    assert.equal((await first).status, 200);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. 默认 python runner 集成（本地合成脚本，不触网；无 python3 则如实跳过）
// ---------------------------------------------------------------------------

test("default python runner injects env, enforces shell:false semantics and surfaces exit codes", { skip: !pythonAvailable }, async () => {
  const fx = await makeFixture();
  try {
    const script = join(fx.cacheDir, "syn-runner.py");
    await writeFile(
      script,
      [
        "import json, os, sys",
        "ck = os.environ.get('SA_SESSION_COOKIE', '')",
        "print('warning: noisy line before json', flush=True)",
        `if ck != ${JSON.stringify(SYN_COOKIE)}:`,
        "    print(json.dumps({'ok': False, 'code': 'env_missing'}))",
        "    sys.exit(1)",
        "print(json.dumps({'ok': True, 'echo': 'syn'}))",
      ].join("\n"),
      "utf-8",
    );
    const runner = createDefaultPythonRunner();
    const okRun = await runner({
      scriptPath: script,
      args: [],
      timeoutMs: 15_000,
      env: { ...process.env, SA_SESSION_COOKIE: SYN_COOKIE },
    });
    assert.equal(okRun.exitCode, 0);
    assert.equal(okRun.timedOut, false);
    assert.deepEqual(parseLastJson(okRun.stdout), { ok: true, echo: "syn" });

    const badRun = await runner({ scriptPath: script, args: [], timeoutMs: 15_000, env: { ...process.env } });
    assert.equal(badRun.exitCode, 1);
    assert.deepEqual(parseLastJson(badRun.stdout), { ok: false, code: "env_missing" });

    const missing = await runner({ scriptPath: join(fx.cacheDir, "nope.py"), args: [], timeoutMs: 5_000, env: {} });
    assert.notEqual(missing.exitCode, 0);
    assert.ok(missing.spawnError !== null || missing.exitCode !== 0);

    const slow = await runner({
      scriptPath: script,
      args: [],
      timeoutMs: 1,
      env: { ...process.env, SA_SESSION_COOKIE: SYN_COOKIE, PYTHONUNBUFFERED: "1" },
    });
    // 1ms 超时：要么被杀（timedOut），要么极快跑完（罕见）——两者都必须是诚实结果。
    assert.ok(slow.timedOut || slow.exitCode === 0);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. 移植 python 脚本离线契约（不触网：全部在触网前失败 / 完成）
// ---------------------------------------------------------------------------

test("tools/okr python scripts compile", { skip: !pythonAvailable }, async () => {
  const scripts = [join(PROJECT_ROOT, "tools", "okr", "fetch_okr.py"), join(PROJECT_ROOT, "tools", "okr", "okr_write.py")];
  for (const script of scripts) {
    const result = await new Promise<number>((resolve) => {
      execFile("python3", ["-m", "py_compile", script], { timeout: 20_000, shell: false }, (error) => resolve(error ? 1 : 0));
    });
    assert.equal(result, 0, `py_compile 失败：${script}`);
  }
});

test("okr_write.py without an edits file exits 1 with an honest last-line JSON (offline)", { skip: !pythonAvailable }, async () => {
  const fx = await makeFixture();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [join(PROJECT_ROOT, "tools", "okr", "okr_write.py"), "--edits", join(fx.cacheDir, "missing.json")],
        { timeout: 20_000, shell: false, env: { ...process.env, SA_SESSION_COOKIE: "" } },
        (error, out) => {
          const exitCode = (error as { code?: number | string } | null)?.code;
          if (error && exitCode !== 1) reject(error);
          else resolve(String(out));
        },
      );
    });
    const parsed = parseLastJson(stdout) as Record<string, unknown>;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.mode, "dry-run");
  } finally {
    await fx.cleanup();
  }
});

test("okr_write.py with no legal edits exits 0 before touching the network (offline)", { skip: !pythonAvailable }, async () => {
  const fx = await makeFixture();
  try {
    const file = join(fx.cacheDir, "edits-empty.json");
    await writeFile(file, JSON.stringify({ exportedAt: NOW_ISO, edits: [{ kind: "zzz", field: "hack" }] }), "utf-8");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [join(PROJECT_ROOT, "tools", "okr", "okr_write.py"), "--edits", file],
        { timeout: 20_000, shell: false, env: { ...process.env, SA_SESSION_COOKIE: "" } },
        (error, out) => (error ? reject(error) : resolve(String(out))),
      );
    });
    const parsed = parseLastJson(stdout) as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.ok(String(parsed.note).includes("没有合法"));
  } finally {
    await fx.cleanup();
  }
});

test("fetch_okr.py without SA_SESSION_COOKIE exits 1 with code no_cookie before any network call", { skip: !pythonAvailable }, async () => {
  const fx = await makeFixture();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [join(PROJECT_ROOT, "tools", "okr", "fetch_okr.py"), "--out", join(fx.cacheDir, "okr.json")],
        { timeout: 20_000, shell: false, env: { PATH: process.env.PATH ?? "", HOME: fx.home } },
        (error, out) => {
          const exitCode = (error as { code?: number | string } | null)?.code;
          if (error && exitCode !== 1) reject(error);
          else resolve(String(out));
        },
      );
    });
    const parsed = parseLastJson(stdout) as Record<string, unknown>;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "no_cookie");
  } finally {
    await fx.cleanup();
  }
});
