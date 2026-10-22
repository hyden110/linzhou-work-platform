import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandRunner } from "./crm-bridge.ts";
import { attributionQuestion, createCrmAttributionBridge, parseAttributionAnswer } from "./crm-attribution-bridge.ts";

const NOW = new Date("2026-10-22T04:00:00Z").getTime();
const FINAL_MARKER = "========== 最终结果 ==========";
const ANSWER = {
  currentDate: "2026-10-21",
  previousDate: "2026-10-20",
  rows: [
    { level1: "模型服务", level2: "百炼", current: 1_200_000, previous: 800_000 },
    { level1: "计算", level2: null, current: 600_000, previous: 550_000 },
  ],
};

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crm-attribution-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200 && !(await predicate()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await predicate(), "timed out waiting for the bridge to settle");
}

async function seedSnapshot(dir: string): Promise<void> {
  await writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({
    customers: [{ cid: "cid001", name: "示例客户" }, { cid: "cid002", name: "第二客户" }],
  }), "utf-8");
}

function finalAnswer(payload: unknown): string {
  return `${FINAL_MARKER}\n${JSON.stringify({ finalAnswer: JSON.stringify(payload), finalize: true })}`;
}

test("attributionQuestion is a fixed template carrying only customer and cid", () => {
  const question = attributionQuestion("示例客户", "cid001");
  assert.ok(question.includes("客户「示例客户」（CID cid001）"));
  assert.ok(question.includes("只输出一个 JSON 对象"));
  assert.ok(!question.toLowerCase().includes("token"));
});

test("parseAttributionAnswer extracts the fixed schema and counts dropped rows", () => {
  const clean = parseAttributionAnswer(JSON.stringify(ANSWER));
  assert.deepEqual(clean, { currentDate: "2026-10-21", previousDate: "2026-10-20", rows: ANSWER.rows, droppedRows: 0 });

  const wrapped = parseAttributionAnswer(`好的，结果如下：\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
  assert.equal(wrapped?.currentDate, "2026-10-21");

  const dropped = parseAttributionAnswer(JSON.stringify({
    currentDate: "2026-10-21",
    previousDate: null,
    rows: [
      { level1: "  ", level2: null, current: 1, previous: 1 },
      { level1: "模型服务", level2: "百炼", current: null, previous: null },
      "not-a-row",
    ],
  }));
  assert.equal(dropped?.droppedRows, 2);
  assert.equal(dropped?.rows.length, 1);
  assert.equal(dropped?.rows[0]?.current, null);

  // currentDate 是表头数据日，缺失或格式非法都视为解析失败（不造行）。
  assert.equal(parseAttributionAnswer('{"rows":[]}'), undefined);
  assert.equal(parseAttributionAnswer('{"currentDate":"2026/10/21","rows":[]}'), undefined);
  assert.equal(parseAttributionAnswer("no json here"), undefined);
});

test("start asks the fixed question, stores rows and reuses done records", async () => {
  await withCache(async (dir) => {
    await seedSnapshot(dir);
    const calls: { script: string; args: string[] }[] = [];
    const runner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      calls.push({ script, args: [...args] });
      if (script.endsWith("create_chat.py")) {
        return { code: 0, stdout: "提交成功！\nanswerMessageId: msgAttr123456" };
      }
      if (script.endsWith("query_chat_result.py")) {
        return { code: 0, stdout: finalAnswer(ANSWER) };
      }
      return { code: 0, stdout: "{}" };
    };
    const bridge = createCrmAttributionBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "1842553" },
    });

    assert.deepEqual(await bridge.start("bad cid!"), { ok: false, error: "invalid_cid" });
    assert.deepEqual(await bridge.start("cid404"), { ok: false, error: "customer_not_found" });
    const unconfigured = createCrmAttributionBridge({
      cacheDir: dir, run: runner, now: () => NOW, env: {},
    });
    assert.deepEqual(
      await unconfigured.start("cid001"),
      { ok: false, error: "not_configured" },
      "未配置报表资源的桥不允许发起归因",
    );

    const configured = createCrmAttributionBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "1842553" },
    });
    const started = await configured.start("cid001");
    assert.ok(started.ok);
    assert.equal(started.reused, false);
    assert.equal(started.record.state, "running");
    assert.equal(started.record.reportResourceId, "1842553");

    const createCall = calls.find((call) => call.script.endsWith("create_chat.py"));
    assert.ok(createCall);
    assert.equal(createCall.args[1], attributionQuestion("示例客户", "cid001"));
    assert.equal(createCall.args[2], JSON.stringify({ resourceId: "1842553", resourceType: "report" }));

    await waitFor(async () => (await configured.attribution("cid001"))?.state === "done");
    const record = await configured.attribution("cid001");
    assert.equal(record?.currentDate, "2026-10-21");
    assert.equal(record?.previousDate, "2026-10-20");
    assert.equal(record?.rows.length, 2);
    assert.equal(record?.reason, null);
    assert.equal(record?.droppedRows, 0);

    // 产物 0600；记录保留 answerMessageId 供轮询续跑（不出路由层）。
    const artifact = join(dir, "crm-attribution", "cid001.json");
    assert.equal((await stat(artifact)).mode & 0o777, 0o600);

    const createCallsBefore = calls.filter((call) => call.script.endsWith("create_chat.py")).length;
    const reused = await configured.start("cid001");
    assert.ok(reused.ok && reused.reused);
    assert.equal(
      calls.filter((call) => call.script.endsWith("create_chat.py")).length,
      createCallsBefore,
      "done 记录未强制刷新时直接复用，不再发 FBI 会话",
    );
    const forced = await configured.start("cid001", true);
    assert.ok(forced.ok && !forced.reused);
    assert.equal(calls.filter((call) => call.script.endsWith("create_chat.py")).length, createCallsBefore + 1);
  });
});

test("empty rows land as done with reason no_rows; create failure lands as failed", async () => {
  await withCache(async (dir) => {
    await seedSnapshot(dir);
    const emptyBridge = createCrmAttributionBridge({
      cacheDir: dir,
      run: async (_file, args) => {
        const script = String(args[0]);
        if (script.endsWith("create_chat.py")) return { code: 0, stdout: "answerMessageId: msgEmpty1" };
        if (script.endsWith("query_chat_result.py")) {
          return { code: 0, stdout: finalAnswer({ currentDate: "2026-10-21", previousDate: null, rows: [] }) };
        }
        return { code: 0, stdout: "{}" };
      },
      now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "1842553" },
    });
    assert.ok((await emptyBridge.start("cid001")).ok);
    await waitFor(async () => (await emptyBridge.attribution("cid001"))?.state === "done");
    const empty = await emptyBridge.attribution("cid001");
    assert.equal(empty?.reason, "no_rows");
    assert.equal(empty?.rows.length, 0);

    const failBridge = createCrmAttributionBridge({
      cacheDir: dir,
      run: async (_file, args) => String(args[0]).endsWith("create_chat.py")
        ? { code: 1, stdout: "boom with token=secret inside" }
        : { code: 0, stdout: "" },
      now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "1842553" },
    });
    const failed = await failBridge.start("cid002");
    assert.ok(failed.ok && !failed.reused);
    assert.equal(failed.record.state, "failed");
    assert.equal(failed.record.error, "fbi_create_failed");
    const raw = await readFile(join(dir, "crm-attribution", "cid002.json"), "utf-8");
    assert.ok(!raw.includes("secret"), "child stdout must not be persisted");
  });
});

test("concurrency cap rejects a third in-flight attribution with busy", async () => {
  await withCache(async (dir) => {
    await seedSnapshot(dir);
    let release: (value: { code: number; stdout: string }) => void = () => undefined;
    const gate = new Promise<{ code: number; stdout: string }>((resolve) => {
      release = resolve;
    });
    const pendingRunner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      if (script.endsWith("create_chat.py")) return { code: 0, stdout: "answerMessageId: msgHold1" };
      if (script.endsWith("query_chat_result.py")) return gate;
      return { code: 0, stdout: "{}" };
    };
    const bridge = createCrmAttributionBridge({
      cacheDir: dir, run: pendingRunner, now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "1842553" },
    });
    assert.ok((await bridge.start("cid001")).ok);
    assert.ok((await bridge.start("cid002")).ok);
    assert.deepEqual(await bridge.start("cid001"), { ok: false, error: "busy" }, "同一客户在跑时再触发直接 busy");
    // 占位客户跑满两个并发位后，第三个不同客户也被拒。
    await writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({
      customers: [
        { cid: "cid001", name: "示例客户" },
        { cid: "cid002", name: "第二客户" },
        { cid: "cid003", name: "第三客户" },
      ],
    }), "utf-8");
    assert.deepEqual(await bridge.start("cid003"), { ok: false, error: "busy" });
    release({ code: 0, stdout: finalAnswer(ANSWER) });
    await waitFor(async () => (await bridge.attribution("cid001"))?.state === "done");
  });
});

test("router serves attribution with answerMessageId redacted and stable error codes", async () => {
  await withCache(async (dir) => {
    await seedSnapshot(dir);
    const runner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      if (script.endsWith("create_chat.py")) return { code: 0, stdout: "answerMessageId: msgRouter777" };
      if (script.endsWith("query_chat_result.py")) return { code: 0, stdout: finalAnswer(ANSWER) };
      return { code: 0, stdout: "" };
    };
    const { createLocalRouter } = await import("./local-router.ts");
    const { createCrmBridge } = await import("./crm-bridge.ts");
    const { createCrmAiBridge } = await import("./crm-ai-bridge.ts");
    const router = createLocalRouter({
      port: 8000,
      crmBridge: createCrmBridge({ cacheDir: dir, run: runner }),
      crmAttributionBridge: createCrmAttributionBridge({
        cacheDir: dir, run: runner, now: () => NOW, env: { FBI_REPORT_RESOURCE_ID: "1842553" },
      }),
      crmAiBridge: createCrmAiBridge({ cacheDir: dir, run: async () => ({ code: 0, stdout: "{}" }), now: () => NOW, env: {} }),
    });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    const missing = await router(new Request("http://127.0.0.1:8000/local/crm/attribution?cid=cid001", { headers }));
    assert.equal(missing.status, 200);
    assert.equal((await missing.json() as { data: unknown }).data, null);

    const invalid = await router(new Request("http://127.0.0.1:8000/local/crm/attribution", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, "invalid_request");

    const started = await router(new Request("http://127.0.0.1:8000/local/crm/attribution", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid001" }),
    }));
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { data: { answerMessageId?: string; state: string } };
    assert.equal(startedBody.data.state, "running");
    assert.equal(startedBody.data.answerMessageId, undefined, "FBI 会话 id 不出路由层");

    await waitFor(async () => {
      const current = await router(new Request("http://127.0.0.1:8000/local/crm/attribution?cid=cid001", { headers }));
      const body = await current.json() as { data: { state: string } };
      return body.data.state === "done";
    });
    const reused = await router(new Request("http://127.0.0.1:8000/local/crm/attribution", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid001" }),
    }));
    assert.equal(reused.status, 200);

    const notFound = await router(new Request("http://127.0.0.1:8000/local/crm/attribution", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid404" }),
    }));
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json() as { error: string }).error, "customer_not_found");

    const crossOrigin = await router(new Request("http://127.0.0.1:8000/local/crm/attribution?cid=cid001", {
      headers: { ...headers, origin: "https://attacker.example" },
    }));
    assert.equal(crossOrigin.status, 403);
  });
});
