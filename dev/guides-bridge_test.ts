import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GUIDES_ROUTES,
  GuidesBridgeError,
  createGuidesBridge,
  type GuidesBridge,
} from "./guides-bridge.ts";
import type { GuideCommandRunner } from "./guides/guides-types.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：dws 输出全部为合成构造（含刻意敌意的凭据样文本），
// 绝不触碰真实 dws / 真实 .local-cache（runner 与 cacheDir 全量注入）。
// ---------------------------------------------------------------------------

const FIXED_NOW = () => Date.parse("2026-10-20T08:00:00.000Z");
const HOST = "127.0.0.1:8000";

interface RunnerCall {
  readonly file: string;
  readonly args: readonly string[];
}

interface Reply {
  readonly code?: number | string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

function fakeRunner(handler: (file: string, args: readonly string[]) => Reply) {
  const calls: RunnerCall[] = [];
  const run: GuideCommandRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const reply = handler(file, args);
    return {
      code: reply && "code" in reply ? (reply.code as number | string | null) : 0,
      stdout: reply?.stdout ?? "",
      stderr: reply?.stderr ?? "",
    };
  };
  return { run, calls };
}

const AUTH_OK = JSON.stringify({ success: true, data: { authenticated: true, corp_name: "SyntheticCorp", user_name: "synthetic-user", refresh_expires_at: "2026-11-20T00:00:00Z" } });
const AUTH_BAD = JSON.stringify({ success: true, data: { authenticated: false } });

const dwsOkRunner = fakeRunner((file, args) => {
  if (file !== "synthetic-dws") return { code: "ENOENT" };
  if (args[0] === "--version") return { stdout: "dws version 2.4.1 (synthetic)\n" };
  if (args[0] === "auth") return { stdout: AUTH_OK };
  return { stdout: "{}" };
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "guides-bridge-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeBridge(options: Parameters<typeof createGuidesBridge>[0] = {}) {
  return createGuidesBridge({ now: FIXED_NOW, env: {}, ...options });
}

async function routed(bridge: GuidesBridge, method: string, path: string, body?: unknown): Promise<Response | undefined> {
  return bridge.handle(new Request(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

/* ============================= defs ============================= */

test("routes constant exposes exactly the three guides routes", () => {
  assert.deepEqual(
    GUIDES_ROUTES.map((r) => `${r.method} ${r.path}`),
    ["GET /local/guides", "POST /local/guide/check", "POST /local/guide/act"],
  );
});

test("defs: all 10 guides with full step definitions, no secrets", async () => {
  const bridge = makeBridge();
  const view = await bridge.defs();
  assert.equal(view.version, "2026-10-17");
  assert.equal(view.guides.length, 10);
  const dws = view.guides.find((g) => g.id === "dws");
  assert.ok(dws);
  assert.deepEqual(dws.steps.map((s) => s.id), ["bin", "auth", "verify", "done"]);
  const response = await routed(bridge, "GET", "/local/guides");
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

/* ============================= check ============================= */

test("check bin: installed → ok without absolute paths; missing → fail", async () => {
  const ok = makeBridge({ run: dwsOkRunner.run, dwsBin: "synthetic-dws" });
  const result = await ok.check({ guide: "dws", step: "bin" });
  assert.equal(result.state, "ok");
  assert.ok(!result.detail.includes("/"), "detail must not leak absolute paths");

  const missing = makeBridge({ run: fakeRunner(() => ({ code: "ENOENT" })).run, dwsBin: "synthetic-dws" });
  const fail = await missing.check({ guide: "dws", step: "bin" });
  assert.equal(fail.state, "fail");
  assert.ok(fail.detail.includes("未找到"));
});

test("check dwsSession: authorized → ok, identity values never echoed", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run, dwsBin: "synthetic-dws" });
  const result = await bridge.check({ guide: "dws", step: "verify" });
  assert.equal(result.state, "ok");
  assert.ok(result.detail.includes("已授权"));
  assert.ok(!result.detail.includes("SyntheticCorp"), "corp_name must not be echoed");
  assert.ok(!result.detail.includes("synthetic-user"), "user_name must not be echoed");
});

test("check dwsSession: unauthorized / missing cli / hostile output", async () => {
  const unauth = makeBridge({
    run: fakeRunner((file, args) => (args[0] === "auth" ? { stdout: AUTH_BAD } : { stdout: "dws 2.4.1" })).run,
    dwsBin: "synthetic-dws",
  });
  const fail = await unauth.check({ guide: "aitable-leads", step: "dws" });
  assert.equal(fail.state, "fail");
  assert.ok(fail.detail.includes("dws auth login"));

  const noCli = makeBridge({ run: fakeRunner(() => ({ code: "ENOENT" })).run, dwsBin: "synthetic-dws" });
  const missing = await noCli.check({ guide: "dws", step: "verify" });
  assert.equal(missing.state, "fail");
  assert.ok(missing.detail.includes("不存在") || missing.detail.includes("未找到"));

  const hostile = makeBridge({
    run: fakeRunner((file, args) => (args[0] === "auth"
      ? { code: 1, stdout: "", stderr: "error: AccessKeyId=LTAI5tSyntheticSyntheticValue01 sk-synthetic0123456789abcdef" }
      : { stdout: "dws 2.4.1" })).run,
    dwsBin: "synthetic-dws",
  });
  const error = await hostile.check({ guide: "dws", step: "verify" });
  assert.equal(error.state, "fail");
  assert.ok(!error.detail.includes("LTAI5tSyntheticSyntheticValue01"));
  assert.ok(!error.detail.includes("sk-synthetic0123456789abcdef"));
});

test("check: unknown guide / unknown step / non-check step → guides_not_found", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run });
  for (const body of [
    { guide: "nope", step: "bin" },
    { guide: "dws", step: "nope" },
    { guide: "dws", step: "done" },
    { guide: "dws", step: "auth" }, // action 步不能走 check
    {},
  ]) {
    await assert.rejects(
      () => bridge.check(body),
      (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_not_found",
    );
  }
});

test("check cap: injected capsView decides; absent view fails honestly", async () => {
  const withCaps = makeBridge({ run: dwsOkRunner.run, capsView: () => ({ leads: { state: "ok" } }) });
  const ok = await withCaps.check({ guide: "aitable-leads", step: "cap" });
  assert.equal(ok.state, "ok");

  const notReady = makeBridge({ run: dwsOkRunner.run, capsView: () => ({ leads: { state: "unconfigured" } }) });
  const fail = await notReady.check({ guide: "aitable-leads", step: "cap" });
  assert.equal(fail.state, "fail");
  assert.ok(fail.detail.includes("unconfigured"));

  const noView = makeBridge({ run: dwsOkRunner.run });
  const honest = await noView.check({ guide: "aitable-leads", step: "cap" });
  assert.equal(honest.state, "fail");
  assert.ok(honest.detail.includes("能力视图"));
});

test("check aitable-verify: no config → fail with onboarding hint", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge({ run: dwsOkRunner.run, dwsBin: "synthetic-dws", cacheDir: dir });
    const result = await bridge.check({ guide: "aitable-leads", step: "verify" });
    assert.equal(result.state, "fail");
    assert.ok(result.detail.includes("leads"));
    assert.ok(Array.isArray(result.results));
    assert.equal(result.results?.[0]?.ok, false);
  });
});

test("check aitable-verify: config + complete remote fields → ok", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "leads.json"), JSON.stringify({ baseId: "basSynthetic01", tableId: "tblSynthetic01", tableName: "拓新企业清单" }), "utf-8");
    const required = ["企业名称", "Name判定", "CRM状态", "综合分", "省份", "城市", "赛道", "一句话", "最新信号时间", "CID"];
    const extra = ["ECID", "电话"];
    const runner = fakeRunner((file, args) => {
      if (args[0] === "auth") return { stdout: AUTH_OK };
      if (args.includes("table") && args.includes("get")) {
        return {
          stdout: JSON.stringify({
            success: true,
            data: { tables: [{ tableId: "tblSynthetic01", fields: [...required, ...extra].map((name, i) => ({ fieldId: `fld${i}`, fieldName: name, type: "text" })) }] },
          }),
        };
      }
      return { stdout: "{}" };
    });
    const bridge = makeBridge({ run: runner.run, dwsBin: "synthetic-dws", cacheDir: dir });
    const result = await bridge.check({ guide: "aitable-leads", step: "verify" });
    assert.equal(result.state, "ok");
    assert.equal(result.results?.[0]?.ok, true);
  });
});

/* ============================= act ============================= */

test("act terminal: returns command text only, runner never invoked", async () => {
  const runner = fakeRunner((file, args) => (args[0] === "auth" ? { stdout: AUTH_OK } : { stdout: "{}" }));
  const bridge = makeBridge({ run: runner.run, dwsBin: "synthetic-dws" });
  const result = await bridge.act({ guide: "dws", step: "auth" });
  assert.equal(result.terminal, true);
  assert.equal(result.command, "dws auth login");
  assert.ok(result.note?.includes("终端"));
  assert.deepEqual(runner.calls, [], "terminal action must not touch the runner at all");
});

test("act aitable-provision: confirm!==true (strict) → guides_confirm_required", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run, dwsBin: "synthetic-dws" });
  for (const body of [
    { guide: "aitable-leads", step: "provision" },
    { guide: "aitable-leads", step: "provision", confirm: "true" },
    { guide: "aitable-leads", step: "provision", confirm: 1 },
  ]) {
    await assert.rejects(
      () => bridge.act(body),
      (error: unknown) => {
        assert.ok(error instanceof GuidesBridgeError);
        assert.equal(error.code, "guides_confirm_required");
        assert.ok(error.confirmText?.includes("aitable_leads") || error.confirmText?.includes("leads"));
        return true;
      },
    );
  }
});

test("act aitable-provision: confirm===true → base-bootstrap via injected runner, config written 0600", async () => {
  await withTempDir(async (dir) => {
    const required = ["企业名称", "Name判定", "CRM状态", "综合分", "省份", "城市", "赛道", "一句话", "最新信号时间", "CID"];
    const runner = fakeRunner((file, args) => {
      assert.equal(file, "synthetic-dws");
      if (args[0] === "auth") return { stdout: AUTH_OK };
      if (args[0] === "aitable" && args[1] === "base" && args[2] === "list") {
        return { stdout: JSON.stringify({ success: true, data: { bases: [] } }) };
      }
      if (args[0] === "aitable" && args[1] === "+base-bootstrap") {
        return { stdout: JSON.stringify({ success: true, data: { baseId: "basSynthetic01" } }) };
      }
      if (args[0] === "aitable" && args[1] === "+base-get") {
        return { stdout: JSON.stringify({ success: true, data: { tables: [{ name: "拓新企业清单", tableId: "tblSynthetic01" }] } }) };
      }
      if (args[0] === "aitable" && args[1] === "table" && args[2] === "get") {
        return {
          stdout: JSON.stringify({
            success: true,
            data: { tables: [{ tableId: "tblSynthetic01", fields: required.map((name, i) => ({ fieldId: `fld${i}`, fieldName: name, type: "text" })) }] },
          }),
        };
      }
      return { stdout: "{}" };
    });
    const bridge = makeBridge({ run: runner.run, dwsBin: "synthetic-dws", cacheDir: dir });
    const result = await bridge.act({ guide: "aitable-leads", step: "provision", confirm: true });
    assert.equal(result.provision?.ok, true);
    assert.equal(result.provision?.baseId, "basSynthetic01");
    assert.ok(runner.calls.some((c) => c.args[1] === "+base-bootstrap"));

    const configPath = join(dir, "leads.json");
    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const written = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
    assert.equal(written.baseId, "basSynthetic01");
    assert.equal(written.tableId, "tblSynthetic01");
    assert.equal(written.tableName, "拓新企业清单");
  });
});

test("act aitable-provision: unauthorized dws → guides_provision_failed at auth step, nothing written", async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner((file, args) => (args[0] === "auth" ? { stdout: AUTH_BAD } : { stdout: "{}" }));
    const bridge = makeBridge({ run: runner.run, dwsBin: "synthetic-dws", cacheDir: dir });
    await assert.rejects(
      () => bridge.act({ guide: "aitable-leads", step: "provision", confirm: true }),
      (error: unknown) => {
        assert.ok(error instanceof GuidesBridgeError);
        assert.equal(error.code, "guides_provision_failed");
        assert.ok(error.message.includes("dws auth login"));
        return true;
      },
    );
    assert.ok(!runner.calls.some((c) => c.args.includes("+base-bootstrap")), "must not create anything when unauthorized");
    await assert.rejects(() => readFile(join(dir, "leads.json"), "utf-8"));
  });
});

test("act aitable-provision: hostile dws error is redacted", async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner((file, args) => {
      if (args[0] === "auth") return { stdout: AUTH_OK };
      if (args[1] === "+base-bootstrap") {
        return { code: 1, stdout: "", stderr: "failed: login_token=AbCdEf0123456789AbCdEf0123456789 password=hunter2-master-key-2026" };
      }
      return { stdout: "{}" };
    });
    const bridge = makeBridge({ run: runner.run, dwsBin: "synthetic-dws", cacheDir: dir });
    await assert.rejects(
      () => bridge.act({ guide: "aitable-all", step: "provision", confirm: true }),
      (error: unknown) => {
        assert.ok(error instanceof GuidesBridgeError);
        assert.ok(!error.message.includes("AbCdEf0123456789"));
        assert.ok(!error.message.includes("hunter2-master-key-2026"));
        return true;
      },
    );
  });
});

test("act provision single-flight: concurrent provision → guides_busy", async () => {
  await withTempDir(async (dir) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: GuideCommandRunner = async (file, args) => {
      if (args[0] === "auth") return { code: 0, stdout: AUTH_OK, stderr: "" };
      await gate;
      return { code: 0, stdout: JSON.stringify({ success: true, data: { bases: [{ name: "SA 工作台数据", baseId: "basSynthetic01" }], tables: [] } }), stderr: "" };
    };
    const bridge = makeBridge({ run: runner, dwsBin: "synthetic-dws", cacheDir: dir });
    const first = bridge.act({ guide: "aitable-dttask", step: "provision", confirm: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => bridge.act({ guide: "aitable-daily", step: "provision", confirm: true }),
      (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_busy",
    );
    release();
    await first.catch(() => {}); // 首次结果不重要，这里只验证互斥
  });
});

test("act refresh step delegates to injected actRefresh", async () => {
  const { actStep } = await import("./guides/guides-act.ts");
  const calls: (string | null)[] = [];
  const syntheticGuide = {
    id: "synthetic", t: "s", d: "s", kind: "base" as const,
    steps: [{ id: "r", kind: "action" as const, t: "刷新", action: { type: "refresh" as const, group: "cust" } }],
  };
  const syntheticNoGroup = {
    id: "synthetic2", t: "s", d: "s", kind: "base" as const,
    steps: [{ id: "r", kind: "action" as const, t: "刷新", action: { type: "refresh" as const } }],
  };
  const result = await actStep(syntheticGuide, syntheticGuide.steps[0]!, {}, {
    actRefresh: async (group) => { calls.push(group); return { ok: true, group }; },
  });
  assert.deepEqual(calls, ["cust"]);
  assert.deepEqual(result, { code: 200, obj: { ok: true, group: "cust" } });

  await assert.rejects(
    () => actStep(syntheticNoGroup, syntheticNoGroup.steps[0]!, {}, {}),
    (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_unavailable",
  );
});

test("act: unknown guide / non-action step / unknown action type", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run });
  await assert.rejects(
    () => bridge.act({ guide: "nope", step: "auth" }),
    (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_not_found",
  );
  await assert.rejects(
    () => bridge.act({ guide: "dws", step: "bin" }), // check 步不能走 act
    (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_not_found",
  );
  const { actStep } = await import("./guides/guides-act.ts");
  const synthetic = {
    id: "s", t: "s", d: "s", kind: "base" as const,
    steps: [{ id: "x", kind: "action" as const, t: "x", action: { type: "mystery" as never } }],
  };
  await assert.rejects(
    () => actStep(synthetic, synthetic.steps[0]!, {}, {}),
    (error: unknown) => error instanceof GuidesBridgeError && error.code === "guides_invalid_request",
  );
});

/* ============================= handle ============================= */

test("handle: routes, envelope, method mismatch, unrelated path", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run, dwsBin: "synthetic-dws" });
  const check = await routed(bridge, "POST", "/local/guide/check", { guide: "dws", step: "verify" });
  assert.ok(check);
  assert.equal(check.status, 200);
  const checkPayload = JSON.parse(await check.text()) as { ok: boolean; data: { state: string } };
  assert.equal(checkPayload.ok, true);
  assert.equal(checkPayload.data.state, "ok");

  const wrongMethod = await routed(bridge, "GET", "/local/guide/check");
  assert.ok(wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const notFound = await routed(bridge, "POST", "/local/guide/check", { guide: "nope", step: "x" });
  assert.ok(notFound);
  assert.equal(notFound.status, 404);

  const unrelated = await routed(bridge, "GET", "/local/health");
  assert.equal(unrelated, undefined);
});

test("handle: trailing slash tolerated", async () => {
  const bridge = makeBridge({ run: dwsOkRunner.run });
  const response = await routed(bridge, "GET", "/local/guides/");
  assert.ok(response);
  assert.equal(response.status, 200);
});
