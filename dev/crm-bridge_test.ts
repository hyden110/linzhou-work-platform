import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCrmBridge,
  parseAnswerMessageId,
  parseFinalAnswer,
  type CommandRunner,
} from "./crm-bridge.ts";
import { createLocalRouter } from "./local-router.ts";

const MESSAGE_ID = "fb7bb646ab474ef0a2870715d19aab3f";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pwd: string | undefined;
}

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crm-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSnapshot(dir: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dir, "crm-snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-14T01:00:00Z",
      readOnly: true,
      sources: { customers: { status: "ok" } },
      customers: [{ cid: "C123", name: "示例「客户」\n公司" }],
      agenda: [],
      secretToken: "should-not-leak",
      ...extra,
    }),
  );
}

function recordingRunner(responses: Record<string, { code: number | null; stdout: string }>) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, pwd: options.env.PWD });
    const script = args[0]?.split("/").pop() ?? "";
    return responses[script] ?? { code: 1, stdout: "" };
  };
  return { calls, runner };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("parses FBI script output", () => {
  assert.equal(parseAnswerMessageId(`提交成功！\nanswerMessageId: ${MESSAGE_ID}\nquestionMessageId: x`), MESSAGE_ID);
  assert.equal(parseAnswerMessageId("提交失败"), undefined);
  const stdout = `思考中...\n========== 最终结果 ==========\n${JSON.stringify({ finalAnswer: "消耗下降 12%", finalize: true })}`;
  assert.equal(parseFinalAnswer(stdout), "消耗下降 12%");
  assert.equal(parseFinalAnswer("没有结果"), undefined);
  assert.equal(parseFinalAnswer("========== 最终结果 ==========\n{broken"), undefined);
});

test("snapshot keeps only known sections", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const bridge = createCrmBridge({ cacheDir: dir, run: recordingRunner({}).runner });
    const snapshot = await bridge.snapshot() as Record<string, unknown>;
    assert.equal(snapshot.secretToken, undefined);
    assert.deepEqual(snapshot.projects, []);
    assert.equal((snapshot.customers as unknown[]).length, 1);
  });
});

test("refresh runs once at a time and reports failure codes only", async () => {
  await withCache(async (dir) => {
    let release: (value: { code: number; stdout: string }) => void = () => {};
    let calls = 0;
    const runner: CommandRunner = () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });
    assert.equal(bridge.startRefresh().state, "running");
    assert.equal(bridge.startRefresh().state, "running");
    assert.equal(calls, 1);
    release({ code: 1, stdout: "token=secret" });
    await flush();
    assert.deepEqual(
      { state: bridge.refreshStatus().state, error: bridge.refreshStatus().error },
      { state: "failed", error: "all_sources_failed" },
    );
  });
});

test("insight resolves the name server-side, persists and reuses the task", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const { calls, runner } = recordingRunner({
      "create_chat.py": { code: 0, stdout: `answerMessageId: ${MESSAGE_ID}` },
      "query_chat_result.py": {
        code: 0,
        stdout: `========== 最终结果 ==========\n${JSON.stringify({ finalAnswer: "近7日消耗下降" })}`,
      },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner, now: () => Date.parse("2026-10-14T02:00:00Z") });

    const started = await bridge.startInsight("C123");
    assert.ok(started.ok);
    assert.equal(started.reused, false);
    assert.match(calls[0]!.args[1]!, /客户「示例客户公司」（CID C123）/);
    assert.equal(calls[0]!.pwd, calls[0]!.cwd);
    await flush();

    const done = await bridge.insight("C123");
    assert.equal(done?.state, "done");
    assert.equal(done?.answer, "近7日消耗下降");
    assert.equal(((await stat(join(dir, "fbi-insights", "C123.json"))).mode & 0o777), 0o600);

    const again = await bridge.startInsight("C123");
    assert.ok(again.ok && again.reused);
    assert.equal(calls.filter((call) => call.args[0]!.endsWith("create_chat.py")).length, 1);
  });
});

test("insight rejects unknown or malformed customers without calling FBI", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const { calls, runner } = recordingRunner({});
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });
    assert.deepEqual(await bridge.startInsight("../etc"), { ok: false, error: "invalid_cid" });
    assert.deepEqual(await bridge.startInsight("C999"), { ok: false, error: "customer_not_found" });
    assert.equal(calls.length, 0);
  });
});

test("failed creation is recorded and can be retried", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const { calls, runner } = recordingRunner({ "create_chat.py": { code: 1, stdout: "鉴权失败" } });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });
    const first = await bridge.startInsight("C123");
    assert.ok(first.ok);
    assert.equal(first.record.state, "failed");
    assert.equal(first.record.error, "fbi_create_failed");
    await bridge.startInsight("C123");
    assert.equal(calls.length, 2);
  });
});

test("router exposes CRM routes without the FBI message id", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir);
    const { runner } = recordingRunner({
      "create_chat.py": { code: 0, stdout: `answerMessageId: ${MESSAGE_ID}` },
      "query_chat_result.py": { code: 0, stdout: "" },
    });
    const router = createLocalRouter({ port: 8000, crmBridge: createCrmBridge({ cacheDir: dir, run: runner }) });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    const snapshot = await router(new Request("http://127.0.0.1:8000/local/crm/snapshot", { headers }));
    assert.equal(snapshot.status, 200);

    const created = await router(new Request("http://127.0.0.1:8000/local/fbi/insight", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "C123", name: "伪造名称" }),
    }));
    assert.equal(created.status, 202);
    const text = await created.text();
    assert.ok(!text.includes(MESSAGE_ID));
    assert.ok(!text.includes("伪造名称"));
    await flush();

    const stored = JSON.parse(await readFile(join(dir, "fbi-insights", "C123.json"), "utf-8"));
    assert.equal(stored.answerMessageId, MESSAGE_ID);
    assert.equal(stored.state, "failed");

    const missing = await router(new Request("http://127.0.0.1:8000/local/fbi/insight?cid=C999", { headers }));
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { ok: true, data: null });

    const crossOrigin = await router(new Request("http://127.0.0.1:8000/local/crm/refresh", {
      method: "POST",
      headers: { ...headers, origin: "https://attacker.example" },
    }));
    assert.equal(crossOrigin.status, 403);
  });
});
