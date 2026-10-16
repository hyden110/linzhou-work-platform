import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCrmBridge,
  parseAnswerMessageId,
  parseFinalAnswer,
  parseReportResource,
  parseSessionInfo,
  parseWorkspaceFileContent,
  parseWorkspaceFiles,
  type CommandRunner,
} from "./crm-bridge.ts";
import { createLocalRouter } from "./local-router.ts";

const MESSAGE_ID = "fb7bb646ab474ef0a2870715d19aab3f";
const REPORT_URL = "https://fbi.example.com/fbi/report/53694/view.htm";

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

test("snapshot passes the dingtalk sections through and drops unknown keys", async () => {
  await withCache(async (dir) => {
    await writeSnapshot(dir, {
      groups: [{ id: "cidA==", name: "示例群", type: "NORMAL_GROUP", memberCount: 3 }],
      mentions: [{ id: "msgX==", conversationId: "cidA==", conversationName: "示例群", sender: "甲", text: "@你", time: "2026-10-15 09:44:29" }],
      unread: [{ id: "cidB==", name: "未读群" }],
      evilExtra: [1, 2],
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: recordingRunner({}).runner });
    const snapshot = await bridge.snapshot() as Record<string, unknown>;
    assert.equal((snapshot.groups as unknown[]).length, 1);
    assert.equal((snapshot.mentions as unknown[]).length, 1);
    assert.equal((snapshot.unread as unknown[]).length, 1);
    assert.equal(snapshot.evilExtra, undefined);
    assert.equal(snapshot.secretToken, undefined);
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

test("parses FBI client script outputs", () => {
  assert.deepEqual(
    parseReportResource(JSON.stringify({ resource_id: "53694", resource_type: "report", source_url: REPORT_URL }, null, 2)),
    { resourceId: "53694", resourceType: "report" },
  );
  assert.deepEqual(
    parseReportResource(`提示行\n{"resource_id": "71959005", "resource_type": "dataset"}\n结尾行`),
    { resourceId: "71959005", resourceType: "dataset" },
  );
  assert.equal(parseReportResource('{"resource_id":"12"}'), undefined);
  assert.equal(parseReportResource("traceback"), undefined);

  assert.deepEqual(
    parseWorkspaceFiles("✅ 数据文件列表查询成功：\n  1. data/agents.csv\n  2. data/maas income.json\n"),
    ["data/agents.csv", "data/maas income.json"],
  );
  assert.deepEqual(parseWorkspaceFiles("✅ 数据文件列表查询成功：\n  （无数据文件）\n"), []);
  assert.equal(parseWorkspaceFiles("❌ 查询失败"), undefined);

  assert.deepEqual(
    parseWorkspaceFileContent(`✅ 文件内容查询成功：\n${JSON.stringify({ path: "data/agents.csv" }, null, 2)}\n`),
    { ok: true, content: { path: "data/agents.csv" } },
  );
  assert.deepEqual(parseWorkspaceFileContent("没有输出标记"), { ok: false, error: "content_failed" });

  assert.deepEqual(
    parseSessionInfo("使用已有会话 ID：sess-1（创建于 2026-10-14，已刷新最近使用时间）\n当前会话 ID：sess-1"),
    { sessionId: "sess-1", reused: true },
  );
  assert.deepEqual(parseSessionInfo("新会话已创建并保存：sess_2\n当前会话 ID：sess_2"), { sessionId: "sess_2", reused: false });
  assert.equal(parseSessionInfo("暂时没有输出"), undefined);
});

test("resolveReport turns a report url into a bound resource", async () => {
  await withCache(async (dir) => {
    const { calls, runner } = recordingRunner({
      "search_report.py": { code: 0, stdout: JSON.stringify({ resource_id: "53694", resource_type: "report", source_url: REPORT_URL }, null, 2) },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });

    assert.deepEqual(await bridge.resolveReport(REPORT_URL), { ok: true, resourceId: "53694", resourceType: "report" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args[0]!.split("/").pop(), "search_report.py");
    assert.equal(calls[0]!.args[1], REPORT_URL);
    assert.equal(calls[0]!.pwd, calls[0]!.cwd);

    assert.deepEqual(await bridge.resolveReport("javascript:alert(1)"), { ok: false, error: "invalid_url" });
    assert.deepEqual(await bridge.resolveReport(`https://fbi.example.com/${"a".repeat(600)}`), { ok: false, error: "invalid_url" });
    assert.equal(calls.length, 1);

    const failing = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "search_report.py": { code: 1, stdout: "traceback token=secret" } }).runner });
    assert.deepEqual(await failing.resolveReport(REPORT_URL), { ok: false, error: "resolve_failed" });

    const incomplete = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "search_report.py": { code: 0, stdout: '{"resource_id": "53694"}' } }).runner });
    assert.deepEqual(await incomplete.resolveReport(REPORT_URL), { ok: false, error: "resolve_failed" });

    const unsafe = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "search_report.py": { code: 0, stdout: '{"resource_id": "../../etc", "resource_type": "report"}' } }).runner });
    assert.deepEqual(await unsafe.resolveReport(REPORT_URL), { ok: false, error: "resolve_failed" });
  });
});

test("createChat binds a resolved resource and parses the answer id", async () => {
  await withCache(async (dir) => {
    const { calls, runner } = recordingRunner({
      "create_chat.py": { code: 0, stdout: `提交成功！\nanswerMessageId: ${MESSAGE_ID}\nquestionMessageId: q1` },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });

    const created = await bridge.createChat("统计客户维度 Agent 数量", { resourceId: "53694", resourceType: "report" });
    assert.deepEqual(created, { ok: true, answerMessageId: MESSAGE_ID });
    assert.equal(calls[0]!.args[0]!.split("/").pop(), "create_chat.py");
    assert.equal(calls[0]!.args[1], "统计客户维度 Agent 数量");
    assert.deepEqual(JSON.parse(calls[0]!.args[2]!), { resourceId: "53694", resourceType: "report" });
    assert.equal(calls[0]!.pwd, calls[0]!.cwd);

    await bridge.createChat("无资源绑定的问题");
    assert.equal(calls[1]!.args.length, 2);

    assert.deepEqual(await bridge.createChat("   "), { ok: false, error: "invalid_question" });
    assert.deepEqual(await bridge.createChat("问题", { resourceId: "../etc", resourceType: "report" }), { ok: false, error: "invalid_resource" });
    assert.deepEqual(await bridge.createChat("问题", { resourceId: "53694", resourceType: "dashboard" }), { ok: false, error: "invalid_resource" });
    assert.equal(calls.length, 2);

    const failing = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "create_chat.py": { code: 1, stdout: "鉴权失败" } }).runner });
    assert.deepEqual(await failing.createChat("问题"), { ok: false, error: "create_failed" });
  });
});

test("workspaceFiles lists the data files of an answer", async () => {
  await withCache(async (dir) => {
    const { calls, runner } = recordingRunner({
      "query_workspace_file.py": { code: 0, stdout: "✅ 数据文件列表查询成功：\n  1. data/fbi_agents.csv\n  2. data/maas_income.json\n" },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });

    assert.deepEqual(await bridge.workspaceFiles(MESSAGE_ID), { ok: true, files: ["data/fbi_agents.csv", "data/maas_income.json"] });
    assert.deepEqual(calls[0]!.args.slice(1), [MESSAGE_ID]);
    assert.deepEqual(await bridge.workspaceFiles("short"), { ok: false, error: "invalid_message_id" });
    assert.equal(calls.length, 1);

    const empty = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "query_workspace_file.py": { code: 0, stdout: "✅ 数据文件列表查询成功：\n  （无数据文件）\n" } }).runner });
    assert.deepEqual(await empty.workspaceFiles(MESSAGE_ID), { ok: true, files: [] });

    const failing = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "query_workspace_file.py": { code: 1, stdout: "❌ 查询失败" } }).runner });
    assert.deepEqual(await failing.workspaceFiles(MESSAGE_ID), { ok: false, error: "list_failed" });
  });
});

test("workspaceFile reads content and guards the file path", async () => {
  await withCache(async (dir) => {
    const payload = { path: "data/fbi_agents.csv", content: "date,agents\n2026-10-14,12" };
    const { calls, runner } = recordingRunner({
      "query_workspace_file.py": { code: 0, stdout: `✅ 文件内容查询成功：\n${JSON.stringify(payload, null, 2)}\n` },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });

    assert.deepEqual(await bridge.workspaceFile(MESSAGE_ID, "data/fbi_agents.csv"), { ok: true, content: payload });
    assert.deepEqual(calls[0]!.args.slice(1), [MESSAGE_ID, "data/fbi_agents.csv"]);
    assert.deepEqual(await bridge.workspaceFile("short", "data/a.csv"), { ok: false, error: "invalid_message_id" });
    assert.deepEqual(await bridge.workspaceFile(MESSAGE_ID, "../secrets"), { ok: false, error: "invalid_file_path" });
    assert.deepEqual(await bridge.workspaceFile(MESSAGE_ID, "/etc/passwd"), { ok: false, error: "invalid_file_path" });
    assert.deepEqual(await bridge.workspaceFile(MESSAGE_ID, "data\\win.csv"), { ok: false, error: "invalid_file_path" });
    assert.equal(calls.length, 1);

    const failing = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "query_workspace_file.py": { code: 1, stdout: "❌ 查询失败" } }).runner });
    assert.deepEqual(await failing.workspaceFile(MESSAGE_ID, "data/a.csv"), { ok: false, error: "content_failed" });

    const junk = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "query_workspace_file.py": { code: 0, stdout: "意外输出" } }).runner });
    assert.deepEqual(await junk.workspaceFile(MESSAGE_ID, "data/a.csv"), { ok: false, error: "content_failed" });

    const huge = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "query_workspace_file.py": { code: 0, stdout: `✅ 文件内容查询成功：\n"${"x".repeat(150_000)}"` } }).runner });
    assert.deepEqual(await huge.workspaceFile(MESSAGE_ID, "data/big.csv"), { ok: false, error: "content_too_large" });
  });
});

test("ensureSession reports reused and freshly created data mate sessions", async () => {
  await withCache(async (dir) => {
    const { calls, runner } = recordingRunner({
      "data_mate_session.py": { code: 0, stdout: "使用已有会话 ID：sess-1（创建于 2026-10-14，已刷新最近使用时间）\n当前会话 ID：sess-1\n" },
    });
    const bridge = createCrmBridge({ cacheDir: dir, run: runner });

    assert.deepEqual(await bridge.ensureSession(), { ok: true, sessionId: "sess-1", reused: true });
    assert.equal(calls[0]!.args.length, 1);
    assert.equal(calls[0]!.args[0]!.split("/").pop(), "data_mate_session.py");
    assert.equal(calls[0]!.pwd, calls[0]!.cwd);

    const fresh = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "data_mate_session.py": { code: 0, stdout: "未找到已有会话，正在创建新会话...\n新会话已创建并保存：sess-2\n当前会话 ID：sess-2\n" } }).runner });
    assert.deepEqual(await fresh.ensureSession(), { ok: true, sessionId: "sess-2", reused: false });

    const failing = createCrmBridge({ cacheDir: dir, run: recordingRunner({ "data_mate_session.py": { code: 1, stdout: "" } }).runner });
    assert.deepEqual(await failing.ensureSession(), { ok: false, error: "session_failed" });
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
