import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import {
  CHROME_UNSUPPORTED_REASON,
  countCookiePairs,
  createDefaultWhoamiRunner,
  createProfileBridge,
  DOMAIN_ALLOWLIST,
  EMP_RE,
  maskCookie,
  MAX_SESSION_COOKIE,
  PROFILE_ROUTES,
  ProfileBridgeError,
  WHOAMI_TIMEOUT_MS,
  type ProfileBridge,
  type WhoamiOutcome,
  type WhoamiRunOptions,
  type WhoamiRunner,
} from "./profile-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：工号 / cookie / 姓名全为合成值（SYN-EMP-0001 / SYN-COOKIE-*），
// 绝不出现真实客户名、真实工号、真实 token；文件读写全部落在 mkdtemp 临时 home，
// 判活全程 stub runner（默认 runner 集成用例只跑本地合成 python 脚本，不触网）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-21T03:40:00.000Z");
const NOW_ISO = "2026-10-21T03:40:00.000Z";
const EMP = "SYN-EMP-0001";
const OTHER_EMP = "SYN-EMP-9999";
const SYN_COOKIE = "syn_session_a=SYN-COOKIE-abc123; syn_session_b=SYN-VALUE-xyz789";
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const WHOAMI_PY = join(PROJECT_ROOT, "tools", "profile", "whoami.py");

const pythonAvailable = await new Promise<boolean>((resolve) => {
  execFile("python3", ["--version"], (error) => resolve(!error));
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "profile-bridge-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

interface BridgeOptions {
  readonly now?: () => number;
  readonly whoamiRunner?: WhoamiRunner;
  readonly whoamiPath?: string;
}

function makeBridge(home: string, options: BridgeOptions = {}): ProfileBridge {
  return createProfileBridge({
    home,
    now: options.now ?? (() => FIXED_NOW),
    whoamiRunner: options.whoamiRunner,
    whoamiPath: options.whoamiPath,
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

function stubRunner(outcome: WhoamiOutcome, calls: WhoamiRunOptions[] = []): WhoamiRunner {
  return async (runOptions) => {
    calls.push(runOptions);
    return outcome;
  };
}

/** 预置一份已配置好的 active + profile（manual 会话）。 */
async function seedConfigured(home: string, cookie = SYN_COOKIE): Promise<void> {
  const userDir = join(home, ".sa-workbench", "users", EMP);
  await mkdir(userDir, { recursive: true });
  await writeFile(
    join(home, ".sa-workbench", "active.json"),
    JSON.stringify({ empId: EMP, at: NOW_ISO }, null, 2),
    "utf-8",
  );
  await writeFile(
    join(userDir, "profile.json"),
    JSON.stringify({
      version: 1,
      user: { empId: EMP, name: "合成用户" },
      source: { mode: "manual" },
      session: { value: cookie, domains: [...DOMAIN_ALLOWLIST], updatedAt: NOW_ISO, lastCheck: null, verifiedAt: null },
      prefs: { autoCheckOnOpen: true },
    }, null, 2),
    "utf-8",
  );
  await chmod(join(userDir, "profile.json"), 0o600);
}

function profileFile(home: string): string {
  return join(home, ".sa-workbench", "users", EMP, "profile.json");
}

async function readProfileFile(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(profileFile(home), "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. 路由表契约（供交付负责人接线 local-router.ts）
// ---------------------------------------------------------------------------

test("PROFILE_ROUTES exposes the five wiring entries (method + path + handler)", () => {
  assert.deepEqual(
    PROFILE_ROUTES.map((route) => `${route.method} ${route.path} -> ${route.handler}`),
    [
      "GET /local/profile -> view",
      "PUT /local/profile/session -> putSession",
      "DELETE /local/profile/session -> deleteSession",
      "POST /local/profile/test -> testSession",
      "PUT /local/profile/prefs -> putPrefs",
    ],
  );
});

// ---------------------------------------------------------------------------
// 2. GET /local/profile：未配置诚实空视图；损坏 JSON 拒读并报 409
// ---------------------------------------------------------------------------

test("GET view without active user returns an honest unconfigured view", async () => {
  await withTempHome(async (home) => {
    const response = await makeBridge(home).view(jsonRequest("GET", "/local/profile"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.equal(body.ok, true);
    const data = body.data as Record<string, unknown>;
    assert.equal(data.configured, false);
    assert.deepEqual(data.user, { empId: "", name: "" });
    const session = data.session as Record<string, unknown>;
    assert.equal(session.set, false);
    assert.equal(session.state, "unset");
  });
});

test("GET view returns publicView with masked session and never the raw cookie", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const response = await makeBridge(home).view(jsonRequest("GET", "/local/profile"));
    const body = await readBody(response);
    assert.equal(body.ok, true);
    // 掩码单测（红线）：整个响应 JSON 序列化后不含合成 cookie 原值。
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE), "响应绝不含 session 原值");
    assert.ok(!JSON.stringify(body).includes("SYN-VALUE-xyz789"), "响应绝不含任何 cookie 分量原值");
    const data = body.data as Record<string, unknown>;
    assert.equal(data.configured, true);
    assert.deepEqual(data.user, { empId: EMP, name: "合成用户" });
    assert.deepEqual(data.source, { mode: "manual" });
    const session = data.session as Record<string, unknown>;
    assert.equal(session.set, true);
    assert.equal(session.masked, maskCookie(SYN_COOKIE));
    assert.equal(session.count, countCookiePairs(SYN_COOKIE));
    assert.deepEqual(session.domains, [...DOMAIN_ALLOWLIST]);
    assert.equal(session.updatedAt, NOW_ISO);
    assert.equal(session.verifiedAt, null);
    assert.equal(session.state, "set");
    assert.deepEqual(data.prefs, { autoCheckOnOpen: true });
  });
});

test("corrupt active.json is refused with profile_corrupt (409), never overwritten", async () => {
  await withTempHome(async (home) => {
    const dir = join(home, ".sa-workbench");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "active.json"), "{ not-json", "utf-8");
    const response = await makeBridge(home).view(jsonRequest("GET", "/local/profile"));
    assert.equal(response.status, 409);
    const body = await readBody(response);
    assert.equal((body.error as Record<string, unknown>).code, "profile_corrupt");
    assert.equal(await readFile(join(dir, "active.json"), "utf-8"), "{ not-json");
  });
});

// ---------------------------------------------------------------------------
// 3. PUT /local/profile/session：manual 校验 + 原子写 + 0600；chrome/auto 诚实拒绝
// ---------------------------------------------------------------------------

test("PUT manual session writes active + profile (0600) and returns the masked view", async () => {
  await withTempHome(async (home) => {
    const response = await makeBridge(home).putSession(
      jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: SYN_COOKIE }),
    );
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.equal(body.ok, true);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE), "PUT 响应绝不含 session 原值");
    const data = body.data as Record<string, unknown>;
    assert.equal(data.supported, true);
    const view = data.view as Record<string, unknown>;
    assert.equal((view.session as Record<string, unknown>).set, true);

    const active = JSON.parse(await readFile(join(home, ".sa-workbench", "active.json"), "utf-8"));
    assert.equal(active.empId, EMP);
    assert.equal(typeof active.at, "string");

    const onDisk = await readProfileFile(home);
    assert.equal((onDisk.session as Record<string, unknown>).value, SYN_COOKIE, "原值只落 0600 文件");
    assert.deepEqual((onDisk.session as Record<string, unknown>).domains, [...DOMAIN_ALLOWLIST]);
    assert.equal((onDisk.source as Record<string, unknown>).mode, "manual");
    const mode = (await stat(profileFile(home))).mode & 0o777;
    assert.equal(mode, 0o600, "profile.json 必须 0600");
    const dirMode = (await stat(join(home, ".sa-workbench", "users", EMP))).mode & 0o777;
    assert.equal(dirMode, 0o700, "用户目录必须 0700");
  });
});

test("PUT manual session without empId and without active user is refused (400)", async () => {
  await withTempHome(async (home) => {
    const response = await makeBridge(home).putSession(
      jsonRequest("PUT", "/local/profile/session", { source: "manual", value: SYN_COOKIE }),
    );
    assert.equal(response.status, 400);
    const body = await readBody(response);
    assert.equal((body.error as Record<string, unknown>).code, "profile_no_active");
  });
});

test("PUT manual session rejects empty value, oversize value and hostile empId (400)", async () => {
  await withTempHome(async (home) => {
    const bridge = makeBridge(home);
    const empty = await bridge.putSession(jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: "  " }));
    assert.equal(empty.status, 400);
    assert.equal((await readBody(empty)).ok, false);

    const oversize = "a".repeat(MAX_SESSION_COOKIE + 1);
    const tooLong = await bridge.putSession(jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: oversize }));
    assert.equal(tooLong.status, 400);
    const tooLongBody = JSON.stringify(await readBody(tooLong));
    assert.ok(!tooLongBody.includes(oversize), "超长拒绝的错误信息绝不回显 cookie 内容");

    const badEmp = await bridge.putSession(jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: "../evil", value: SYN_COOKIE }));
    assert.equal(badEmp.status, 400);
    assert.equal((await readBody(badEmp)).ok, false);
    assert.ok(!EMP_RE.test("../evil"));
  });
});

test("PUT manual session enforces the domain suffix allowlist and normalizes case/dots", async () => {
  await withTempHome(async (home) => {
    const bridge = makeBridge(home);
    const evil = await bridge.putSession(
      jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: SYN_COOKIE, domains: ["evil.example"] }),
    );
    assert.equal(evil.status, 400);
    assert.equal(((await readBody(evil)).error as Record<string, unknown>).code, "profile_invalid_request");

    const ok = await bridge.putSession(
      jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: SYN_COOKIE, domains: [".Aliyun-Inc.com", "crd.alibaba-inc.com"] }),
    );
    assert.equal(ok.status, 200);
    const onDisk = await readProfileFile(home);
    assert.deepEqual((onDisk.session as Record<string, unknown>).domains, ["aliyun-inc.com", "crd.alibaba-inc.com"]);
  });
});

test("PUT chrome / auto honestly report supported:false and write nothing", async () => {
  await withTempHome(async (home) => {
    const bridge = makeBridge(home);
    for (const source of ["chrome", "auto"] as const) {
      const response = await bridge.putSession(jsonRequest("PUT", "/local/profile/session", { source }));
      assert.equal(response.status, 200);
      const body = await readBody(response);
      assert.equal(body.ok, true);
      const data = body.data as Record<string, unknown>;
      assert.equal(data.supported, false);
      assert.equal(data.reason, CHROME_UNSUPPORTED_REASON);
      assert.equal(data.reason, "chrome 提取未接入");
      assert.equal(data.view, null);
    }
    await assert.rejects(stat(join(home, ".sa-workbench", "active.json")), "chrome/auto 绝不落任何存储");
  });
});

test("PUT with an unknown source is refused (400)", async () => {
  await withTempHome(async (home) => {
    const response = await makeBridge(home).putSession(jsonRequest("PUT", "/local/profile/session", { source: "firefox" }));
    assert.equal(response.status, 400);
  });
});

test("corrupt profile.json blocks every write with profile_corrupt and stays untouched", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    await writeFile(profileFile(home), "{{{ broken", "utf-8");
    const bridge = makeBridge(home);

    const put = await bridge.putSession(jsonRequest("PUT", "/local/profile/session", { source: "manual", empId: EMP, value: SYN_COOKIE }));
    assert.equal(put.status, 409);
    assert.equal(((await readBody(put)).error as Record<string, unknown>).code, "profile_corrupt");

    const del = await bridge.deleteSession(jsonRequest("DELETE", "/local/profile/session"));
    assert.equal(del.status, 409);

    const prefs = await bridge.putPrefs(jsonRequest("PUT", "/local/profile/prefs", { prefs: { autoCheckOnOpen: false } }));
    assert.equal(prefs.status, 409);

    const check = await bridge.testSession(jsonRequest("POST", "/local/profile/test"));
    assert.equal(check.status, 409);

    assert.equal(await readFile(profileFile(home), "utf-8"), "{{{ broken", "损坏文件绝不静默覆盖");
  });
});

// ---------------------------------------------------------------------------
// 4. DELETE /local/profile/session
// ---------------------------------------------------------------------------

test("DELETE clears the stored session but keeps active + prefs", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const response = await makeBridge(home).deleteSession(jsonRequest("DELETE", "/local/profile/session"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.equal(body.ok, true);
    const data = body.data as Record<string, unknown>;
    assert.equal((data.session as Record<string, unknown>).set, false);
    const onDisk = await readProfileFile(home);
    assert.equal(onDisk.session, null, "原值必须从磁盘上消失");
    assert.deepEqual(onDisk.prefs, { autoCheckOnOpen: true });
    const active = JSON.parse(await readFile(join(home, ".sa-workbench", "active.json"), "utf-8"));
    assert.equal(active.empId, EMP);
  });
});

test("DELETE without active user is refused (400)", async () => {
  await withTempHome(async (home) => {
    const response = await makeBridge(home).deleteSession(jsonRequest("DELETE", "/local/profile/session"));
    assert.equal(response.status, 400);
    assert.equal(((await readBody(response)).error as Record<string, unknown>).code, "profile_no_active");
  });
});

// ---------------------------------------------------------------------------
// 5. POST /local/profile/test：本人 / 非本人 / 失败三态 + env 注入 + 掩码红线
// ---------------------------------------------------------------------------

test("POST test self: runner gets SA_SESSION_COOKIE via env only, verifiedAt written back", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const calls: WhoamiRunOptions[] = [];
    const bridge = makeBridge(home, { whoamiRunner: stubRunner({ ok: true, empId: EMP, name: "合成用户", code: null, note: "" }, calls) });
    const response = await bridge.testSession(jsonRequest("POST", "/local/profile/test"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE), "判活响应绝不含 session 原值");
    const data = body.data as Record<string, unknown>;
    assert.equal(data.state, "self");
    assert.equal(data.empId, EMP);
    assert.equal(data.checkedAt, NOW_ISO);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.timeoutMs, WHOAMI_TIMEOUT_MS);
    assert.ok(calls[0]!.whoamiPath.endsWith(join("tools", "profile", "whoami.py")), "默认 whoamiPath 指向 tools/profile/whoami.py");
    assert.equal(calls[0]!.env.SA_SESSION_COOKIE, SYN_COOKIE, "cookie 只经 env 注入子进程");

    const onDisk = await readProfileFile(home);
    const session = onDisk.session as Record<string, unknown>;
    assert.equal(session.verifiedAt, NOW_ISO);
    const lastCheck = session.lastCheck as Record<string, unknown>;
    assert.deepEqual({ ok: lastCheck.ok, self: lastCheck.self, at: lastCheck.at }, { ok: true, self: true, at: NOW_ISO });
  });
});

test("POST test mismatch: verifiedAt stays null, lastCheck.self=false, other empId surfaced", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const bridge = makeBridge(home, { whoamiRunner: stubRunner({ ok: true, empId: OTHER_EMP, name: "合成他人", code: null, note: "" }) });
    const response = await bridge.testSession(jsonRequest("POST", "/local/profile/test"));
    const body = await readBody(response);
    const data = body.data as Record<string, unknown>;
    assert.equal(data.state, "mismatch");
    assert.equal(data.empId, OTHER_EMP);
    const onDisk = await readProfileFile(home);
    const session = onDisk.session as Record<string, unknown>;
    assert.equal(session.verifiedAt, null, "非本人绝不写 verifiedAt");
    assert.equal((session.lastCheck as Record<string, unknown>).self, false);
  });
});

test("POST test failure: honest state with redacted note, lastCheck.ok=false", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const hostileNote = `expired cookie=${SYN_COOKIE} leaked`;
    const bridge = makeBridge(home, { whoamiRunner: stubRunner({ ok: false, empId: null, name: null, code: "expired", note: hostileNote }) });
    const response = await bridge.testSession(jsonRequest("POST", "/local/profile/test"));
    assert.equal(response.status, 200);
    const body = await readBody(response);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(SYN_COOKIE), "敌意 note 里的 cookie 也必须被 redact");
    assert.ok(!serialized.includes("SYN-VALUE-xyz789"));
    const data = body.data as Record<string, unknown>;
    assert.equal(data.state, "failed");
    assert.equal(data.code, "expired");
    const onDisk = await readProfileFile(home);
    const lastCheck = (onDisk.session as Record<string, unknown>).lastCheck as Record<string, unknown>;
    assert.equal(lastCheck.ok, false);
    assert.equal(String(lastCheck.note ?? "").includes(SYN_COOKIE), false, "落盘 note 同样不含原值");
  });
});

test("POST test without active user / without session returns honest failed states", async () => {
  await withTempHome(async (home) => {
    const bridge = makeBridge(home);
    const noActive = await readBody(await bridge.testSession(jsonRequest("POST", "/local/profile/test")));
    assert.equal((noActive.data as Record<string, unknown>).state, "failed");
    assert.equal((noActive.data as Record<string, unknown>).code, "no_active");

    await seedConfigured(home);
    await bridge.deleteSession(jsonRequest("DELETE", "/local/profile/session"));
    const noSession = await readBody(await bridge.testSession(jsonRequest("POST", "/local/profile/test")));
    assert.equal((noSession.data as Record<string, unknown>).state, "failed");
    assert.equal((noSession.data as Record<string, unknown>).code, "no_session");
  });
});

// ---------------------------------------------------------------------------
// 6. PUT /local/profile/prefs：不可变合并
// ---------------------------------------------------------------------------

test("PUT prefs merges into a new object and keeps existing keys", async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const bridge = makeBridge(home);
    const first = await readBody(await bridge.putPrefs(jsonRequest("PUT", "/local/profile/prefs", { prefs: { maskEmpId: true } })));
    assert.deepEqual((first.data as Record<string, unknown>).prefs, { autoCheckOnOpen: true, maskEmpId: true });
    const second = await readBody(await bridge.putPrefs(jsonRequest("PUT", "/local/profile/prefs", { prefs: { autoCheckOnOpen: false } })));
    assert.deepEqual((second.data as Record<string, unknown>).prefs, { autoCheckOnOpen: false, maskEmpId: true });
    const onDisk = await readProfileFile(home);
    assert.deepEqual(onDisk.prefs, { autoCheckOnOpen: false, maskEmpId: true });
  });
});

test("PUT prefs validates value types and requires an active user", async () => {
  await withTempHome(async (home) => {
    const bridge = makeBridge(home);
    const noActive = await bridge.putPrefs(jsonRequest("PUT", "/local/profile/prefs", { prefs: { a: true } }));
    assert.equal(noActive.status, 400);
    assert.equal(((await readBody(noActive)).error as Record<string, unknown>).code, "profile_no_active");

    await seedConfigured(home);
    const bad = await bridge.putPrefs(jsonRequest("PUT", "/local/profile/prefs", { prefs: { a: { nested: true } } }));
    assert.equal(bad.status, 400);
    assert.equal(((await readBody(bad)).error as Record<string, unknown>).code, "profile_invalid_request");
  });
});

// ---------------------------------------------------------------------------
// 7. 纯函数：掩码 / 计数 / 白名单
// ---------------------------------------------------------------------------

test("maskCookie follows donor semantics: first 4 chars + total length, never the value", () => {
  assert.equal(maskCookie(SYN_COOKIE), `${SYN_COOKIE.slice(0, 4)}…共 ${SYN_COOKIE.length} 字符`);
  assert.ok(!maskCookie(SYN_COOKIE).includes(SYN_COOKIE));
  assert.equal(maskCookie(""), "");
  assert.equal(countCookiePairs(SYN_COOKIE), 2);
  assert.equal(countCookiePairs("Cookie: a=1; b=2; c=3"), 3);
});

test("ProfileBridgeError carries stable codes and status mapping", () => {
  const error = new ProfileBridgeError("profile_corrupt", "损坏");
  assert.equal(error.code, "profile_corrupt");
  assert.equal(error.name, "ProfileBridgeError");
});

// ---------------------------------------------------------------------------
// 8. 默认 whoamiRunner 集成（本地合成 python 脚本，不触网；无 python3 则如实跳过）
// ---------------------------------------------------------------------------

test("default whoamiRunner injects env cookie, tolerates warning lines and parses last-line JSON", { skip: !pythonAvailable }, async () => {
  await withTempHome(async (home) => {
    await seedConfigured(home);
    const script = join(home, "whoami-syn.py");
    await writeFile(
      script,
      [
        "import json, os",
        "ck = os.environ.get('SA_SESSION_COOKIE', '')",
        "print('warning: noisy line before json', flush=True)",
        `if ck != ${JSON.stringify(SYN_COOKIE)}:`,
        "    print(json.dumps({'ok': False, 'code': 'env_missing', 'note': 'SA_SESSION_COOKIE 未注入'}))",
        "else:",
        `    print(json.dumps({'ok': True, 'empId': ${JSON.stringify(EMP)}, 'name': '合成用户'}))`,
      ].join("\n"),
      "utf-8",
    );
    // 用默认 runner（execFile python3 + env 注入），whoamiPath 指向合成脚本。
    const bridge = createProfileBridge({
      home,
      now: () => FIXED_NOW,
      whoamiRunner: createDefaultWhoamiRunner(),
      whoamiPath: script,
    });
    const response = await bridge.testSession(jsonRequest("POST", "/local/profile/test"));
    const body = await readBody(response);
    assert.ok(!JSON.stringify(body).includes(SYN_COOKIE));
    assert.equal((body.data as Record<string, unknown>).state, "self", "env 注入 + 末行 JSON 宽容解析应判活成功");
  });
});

test("ported tools/profile/whoami.py --parse extracts empId/name offline (synthetic HTML)", { skip: !pythonAvailable }, async () => {
  await withTempHome(async (home) => {
    const html = join(home, "syn.html");
    await writeFile(
      html,
      '<script>window.USER_INFO = {"openId":"SYN-EMP-0001","name":"合成真名(合成花名)","nickNameCn":"合成花名","deptName":"合成部门"};</script>',
      "utf-8",
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("python3", [WHOAMI_PY, "--parse", html], { timeout: 15_000, shell: false }, (error, out) => {
        if (error) reject(error);
        else resolve(String(out));
      });
    });
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.empId, EMP);
    assert.equal(parsed.name, "合成花名");
  });
});
