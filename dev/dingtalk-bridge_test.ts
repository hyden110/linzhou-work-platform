import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandResult, CommandRunner } from "./crm-bridge.ts";
import {
  createDingtalkBridge,
  createTodoCommand,
  readbackCommand,
  type TodoCreateInput,
} from "./dingtalk-bridge.ts";
import { createLocalRouter } from "./local-router.ts";

const NOW = Date.parse("2026-10-19T02:00:00Z");
const USER_ID = "userSynthetic01";
const TASK_ID = "taskSynthetic001";
const INPUT: TodoCreateInput = {
  requestId: "req-20261019-0001",
  title: "合成待办：跟进部署",
  dueAt: "2026-10-20T18:00:00+08:00",
  priority: 20,
  executor: "self",
};
const DUE_MS = Date.parse(INPUT.dueAt);

function localDate(moment: number): string {
  const date = new Date(moment);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The bridge compares against the operator's local day, not UTC. */
const TODAY = localDate(NOW);
const OTHER_DATE = TODAY === "2026-10-18" ? "2026-10-19" : "2026-10-18";

const PROFILE_SECRETS = {
  corpId: "corpSynthetic01",
  corpName: "DROP-CORP-NAME",
  userName: "DROP-USER-NAME",
  clientId: "DROP-CLIENT-ID",
} as const;

function profilePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    currentProfile: `${PROFILE_SECRETS.corpId}:${USER_ID}`,
    profiles: [{
      profile: `${PROFILE_SECRETS.corpId}:${USER_ID}`,
      ...PROFILE_SECRETS,
      userId: USER_ID,
      isCurrent: true,
    }],
    ...overrides,
  });
}

const DETAIL = {
  taskId: TASK_ID,
  subject: INPUT.title,
  dueTime: DUE_MS,
  isDone: false,
  executorIds: [USER_ID],
};

function dryPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    outcome: "success",
    dry_run: true,
    data: {
      dryRun: true,
      executed: false,
      operation: "create",
      params: {
        PersonalTodoCreateVO: {
          executorIds: [USER_ID],
          priority: INPUT.priority,
          subject: INPUT.title,
        },
      },
      tool: "create_personal_todo",
      ...overrides,
    },
  });
}

function createPayload(detail: Record<string, unknown> | null = DETAIL): string {
  return JSON.stringify({
    ok: true,
    outcome: "success",
    data: detail ? { todoDetailModel: detail } : { executed: true },
  });
}

function readbackPayload(detail: Record<string, unknown> = DETAIL): string {
  return JSON.stringify({ result: { todoDetailModel: detail } });
}

type Script = (args: readonly string[], callIndex: number) => CommandResult | Promise<CommandResult>;

function fakeRunner(script: Script): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_file, args) => {
    const copy = [...args];
    calls.push(copy);
    return script(copy, calls.length - 1);
  };
  return { runner, calls };
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout };
}

async function withCache(handler: (cacheDir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "dingtalk-bridge-"));
  try {
    await handler(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function bridge(cacheDir: string, runner: CommandRunner, env: NodeJS.ProcessEnv = { DINGTALK_USER_ID: USER_ID }) {
  return createDingtalkBridge({ cacheDir, run: runner, now: () => NOW, env });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(await predicate(), "timed out waiting for the bridge");
}

test("create runs dry-run, create and readback in order", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) => {
      if (index === 0) return ok(dryPayload());
      if (index === 1) return ok(createPayload());
      return ok(readbackPayload());
    });
    const result = await bridge(cacheDir, runner).createTodo(INPUT);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reused, false);
    assert.equal(result.record.state, "created");
    assert.equal(result.record.taskId, TASK_ID);
    assert.equal(result.record.dryRun, "passed");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]!.slice(0, 2), ["todo", "+create"]);
    assert.ok(calls[0]!.includes("--dry-run"));
    assert.deepEqual(calls[1]!.slice(0, 2), ["todo", "+create"]);
    assert.ok(!calls[1]!.includes("--dry-run"));
    assert.deepEqual(calls[2]!.slice(0, 3), ["todo", "task", "get"]);
    assert.equal(calls[2]![calls[2]!.indexOf("--task-id") + 1], TASK_ID);
    assert.ok(calls.every((call) => call[0] !== "profile"), "a valid env override must skip profile lookup");

    const writesPath = join(cacheDir, "dingtalk-todo-writes.json");
    const stored = JSON.parse(await readFile(writesPath, "utf-8")) as {
      writes: Record<string, { state: string; taskId: string }>;
    };
    assert.equal(stored.writes[INPUT.requestId]!.state, "created");
    assert.equal(stored.writes[INPUT.requestId]!.taskId, TASK_ID);
    assert.equal((await stat(writesPath)).mode & 0o777, 0o600);

    const audit = await readFile(join(cacheDir, "dingtalk-todo-audit.jsonl"), "utf-8");
    const lines = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.event), [
      "create_started", "dry_run", "create", "readback", "create_succeeded",
    ]);
    assert.equal(lines[2]!.taskId, TASK_ID);
    assert.ok(!audit.includes(USER_ID), "executor id must not be audited");
    assert.ok(!audit.includes(cacheDir), "absolute paths must not be audited");
    assert.equal((await stat(join(cacheDir, "dingtalk-todo-audit.jsonl"))).mode & 0o777, 0o600);
  });
});

test("invalid input never reaches the runner", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner(() => ok(dryPayload()));
    const instance = bridge(cacheDir, runner);
    const invalid = [
      { ...INPUT, title: "" },
      { ...INPUT, title: "x".repeat(201) },
      { ...INPUT, title: "第一行\n第二行" },
      { ...INPUT, priority: 15 },
      { ...INPUT, priority: "20" },
      { ...INPUT, dueAt: "2026-10-20" },
      { ...INPUT, dueAt: "not-a-date" },
      { ...INPUT, requestId: "short" },
      { ...INPUT, requestId: "__proto__" },
      { ...INPUT, executor: "someone-else" },
      null,
    ];
    for (const input of invalid) {
      const result = await instance.createTodo(input);
      assert.equal(result.ok, false);
      assert.equal(result.error, "invalid_request");
    }
    assert.equal(calls.length, 0);
  });
});

test("missing env resolves the executor from dws profile list", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) => {
      if (index === 0) return ok(profilePayload());
      if (index === 1) return ok(dryPayload());
      if (index === 2) return ok(createPayload());
      return ok(readbackPayload());
    });
    const result = await bridge(cacheDir, runner, {}).createTodo(INPUT);

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["profile", "list", "--format", "json"]);
    assert.equal(calls.length, 4);
    assert.equal(calls[1]![calls[1]!.indexOf("--executors") + 1], USER_ID);

    const audit = await readFile(join(cacheDir, "dingtalk-todo-audit.jsonl"), "utf-8");
    assert.ok(!audit.includes(USER_ID), "executor id must not be audited");
    for (const secret of Object.values(PROFILE_SECRETS)) {
      assert.ok(!audit.includes(secret), `${secret} must not be audited`);
    }
    const writes = await readFile(join(cacheDir, "dingtalk-todo-writes.json"), "utf-8");
    for (const secret of [USER_ID, ...Object.values(PROFILE_SECRETS)]) {
      assert.ok(!writes.includes(secret), `${secret} must not be persisted`);
    }
  });
});

test("profile fallback uses the isCurrent userId when currentProfile is absent", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) => {
      if (index === 0) {
        return ok(profilePayload({
          currentProfile: undefined,
          profiles: [
            { userId: "someoneElse", isCurrent: false, corpId: "DROP-OTHER-CORP" },
            { userId: USER_ID, isCurrent: true, userName: "DROP-USER-NAME" },
          ],
        }));
      }
      if (index === 1) return ok(dryPayload());
      if (index === 2) return ok(createPayload());
      return ok(readbackPayload());
    });
    const result = await bridge(cacheDir, runner, {}).createTodo(INPUT);

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["profile", "list", "--format", "json"]);
    assert.equal(calls[1]![calls[1]!.indexOf("--executors") + 1], USER_ID);
  });
});

test("a concurrent replay during profile resolution reuses the finished write", async () => {
  await withCache(async (cacheDir) => {
    const gates: Array<() => void> = [];
    const { runner, calls } = fakeRunner(async (args) => {
      if (args[0] === "profile") {
        await new Promise<void>((resolve) => gates.push(resolve));
        return ok(profilePayload());
      }
      if (args[1] === "+create" && args.includes("--dry-run")) return ok(dryPayload());
      if (args[1] === "+create") return ok(createPayload());
      return ok(readbackPayload());
    });
    const instance = bridge(cacheDir, runner, {});
    const first = instance.createTodo(INPUT);
    await waitFor(() => gates.length === 1);
    const second = instance.createTodo(INPUT);
    await waitFor(() => gates.length === 2);

    gates[0]!();
    const finished = await first;
    assert.equal(finished.ok, true);
    assert.equal(calls.filter((call) => call[0] === "profile").length, 2);
    gates[1]!();
    const replayed = await second;

    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.reused, true);
    assert.equal(replayed.record.taskId, TASK_ID);
    assert.equal(calls.filter((call) => call[1] === "+create").length, 2, "dry-run + create only once");
  });
});

test("profile lookup failures refuse creation as user_id_unavailable", async () => {
  await withCache(async (cacheDir) => {
    const failures: Array<[string, Script]> = [
      ["non-zero", () => ({ code: 1, stdout: "" })],
      ["not json", () => ok("{not json")],
      ["success false", () => ok(JSON.stringify({
        success: false, currentProfile: `${PROFILE_SECRETS.corpId}:${USER_ID}`, profiles: [],
      }))],
      ["no userId", () => ok(JSON.stringify({
        success: true, currentProfile: "corpSynthetic01", profiles: [],
      }))],
      ["invalid userId", () => ok(JSON.stringify({
        success: true, currentProfile: "corpSynthetic01:bad user id", profiles: [],
      }))],
      ["spawn throws", () => { throw new Error("spawn failed"); }],
    ];
    for (const [index, [label, script]] of failures.entries()) {
      const { runner, calls } = fakeRunner(script);
      const request = { ...INPUT, requestId: `req-profile-${index}-01` };
      const result = await bridge(cacheDir, runner, {}).createTodo(request);
      assert.equal(result.ok, false, label);
      assert.equal(result.error, "user_id_unavailable", label);
      assert.equal(calls.length, 1, label);
      assert.deepEqual(calls[0], ["profile", "list", "--format", "json"], label);
    }
    await assert.rejects(readFile(join(cacheDir, "dingtalk-todo-writes.json"), "utf-8"));
  });
});

test("same requestId replay does not call the runner again", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) => {
      if (index === 0) return ok(dryPayload());
      if (index === 1) return ok(createPayload());
      return ok(readbackPayload());
    });
    const instance = bridge(cacheDir, runner);
    const first = await instance.createTodo(INPUT);
    const second = await instance.createTodo(INPUT);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.reused, true);
    assert.equal(second.record.taskId, TASK_ID);
    assert.equal(calls.length, 3);
    assert.equal((await instance.writes()).length, 1);
  });
});

test("failed requestId replay returns the stored failure without a retry", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner(() => ({ code: 1, stdout: "" }));
    const instance = bridge(cacheDir, runner);
    const first = await instance.createTodo(INPUT);
    const second = await instance.createTodo(INPUT);

    assert.equal(first.ok, false);
    assert.equal(first.error, "todo_write_failed");
    assert.equal(second.ok, false);
    assert.equal(second.error, "todo_write_failed");
    assert.equal(calls.length, 1);
  });
});

test("dry-run failure never executes the real create", async () => {
  await withCache(async (cacheDir) => {
    const wrongSubject = JSON.stringify({
      ok: true,
      outcome: "success",
      dry_run: true,
      data: {
        dryRun: true,
        executed: false,
        params: {
          PersonalTodoCreateVO: {
            subject: "另一个标题",
            priority: INPUT.priority,
            executorIds: [USER_ID],
          },
        },
      },
    });
    const cases: Array<[string, CommandResult]> = [
      ["executed", ok(dryPayload({ executed: true }))],
      ["missing flags", ok(JSON.stringify({ ok: true, outcome: "success", data: {} }))],
      ["wrong subject", ok(wrongSubject)],
      ["not json", ok("{not json")],
      ["non-zero", { code: 2, stdout: dryPayload() }],
    ];
    for (const [index, [label, result]] of cases.entries()) {
      const { runner, calls } = fakeRunner(() => result);
      const request = { ...INPUT, requestId: `req-dryfail-${index}-01` };
      const created = await bridge(cacheDir, runner).createTodo(request);
      assert.equal(created.ok, false, label);
      assert.equal(created.error, "todo_write_failed", label);
      assert.equal(calls.length, 1, label);
      assert.ok(calls[0]!.includes("--dry-run"), label);
    }
  });
});

test("dry-run spawn failure maps to dws_missing and stops", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner(() => ({ code: null, stdout: "" }));
    const result = await bridge(cacheDir, runner).createTodo(INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.error, "dws_missing");
    assert.equal(calls.length, 1);
  });
});

test("real create failure maps to todo_write_failed", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) =>
      index === 0 ? ok(dryPayload()) : ({ code: 4, stdout: '{"ok":false}' }));
    const result = await bridge(cacheDir, runner).createTodo(INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.error, "todo_write_failed");
    assert.equal(calls.length, 2);
  });
});

test("missing task id is reported as todo_verify_failed without blind retry", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner((_args, index) =>
      index === 0 ? ok(dryPayload()) : ok(createPayload(null)));
    const result = await bridge(cacheDir, runner).createTodo(INPUT);

    assert.equal(result.ok, false);
    assert.equal(result.error, "todo_verify_failed");
    assert.equal(result.record?.state, "failed");
    assert.equal(calls.length, 2);
  });
});

test("readback mismatch is reported as todo_verify_failed with the task id", async () => {
  await withCache(async (cacheDir) => {
    const mismatches = [
      { ...DETAIL, subject: "标题不一致" },
      { ...DETAIL, dueTime: DUE_MS + 60_000 },
      { ...DETAIL, taskId: "taskDifferent01" },
      { ...DETAIL, isDone: true },
      { ...DETAIL, executorIds: ["someoneElse"] },
    ];
    for (const [index, detail] of mismatches.entries()) {
      const { runner } = fakeRunner((_args, callIndex) => {
        if (callIndex === 0) return ok(dryPayload());
        if (callIndex === 1) return ok(createPayload());
        return ok(readbackPayload(detail));
      });
      const request = { ...INPUT, requestId: `req-readback-${index}01` };
      const result = await bridge(cacheDir, runner).createTodo(request);
      assert.equal(result.ok, false);
      assert.equal(result.error, "todo_verify_failed");
      assert.equal(result.record?.taskId, TASK_ID);
    }
  });
});

test("concurrent calls for the same requestId are rejected as busy", async () => {
  await withCache(async (cacheDir) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, calls } = fakeRunner(async (_args, index) => {
      if (index === 0) {
        await gate;
        return ok(dryPayload());
      }
      if (index === 1) return ok(createPayload());
      return ok(readbackPayload());
    });
    const instance = bridge(cacheDir, runner);
    const first = instance.createTodo(INPUT);
    await waitFor(() => calls.length === 1);
    const second = await instance.createTodo(INPUT);
    assert.equal(second.ok, false);
    assert.equal(second.error, "busy");
    release();
    const finished = await first;
    assert.equal(finished.ok, true);
    assert.equal(calls.length, 3);
  });
});

test("summary lifecycle: 404-style miss, running singleton, projection", async () => {
  await withCache(async (cacheDir) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, calls } = fakeRunner(async () => {
      await gate;
      return { code: 0, stdout: "" };
    });
    const instance = bridge(cacheDir, runner);

    assert.equal(await instance.summary(TODAY), undefined);
    assert.equal((await instance.summaryStatus()).state, "idle");

    const started = await instance.startSummary(TODAY);
    assert.equal(started.ok, true);
    assert.equal(started.reused, false);
    assert.equal(started.status.state, "running");
    const again = await instance.startSummary(TODAY);
    assert.equal(again.reused, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1], "--date");
    assert.equal(calls[0]![2], TODAY);
    assert.ok(calls[0]!.includes("--cache-dir"));
    assert.equal(calls[0]![calls[0]!.indexOf("--snapshot") + 1], join(cacheDir, "crm-snapshot.json"));

    await mkdir(join(cacheDir, "dingtalk-daily"), { recursive: true });
    await writeFile(join(cacheDir, "dingtalk-daily", `summary-${TODAY}.json`), JSON.stringify({
      schemaVersion: 1,
      date: TODAY,
      chats: [{ chatId: "cidSynthetic==", summary: "合成摘要", tickets: [] }],
    }));
    release();
    await waitFor(async () => (await instance.summaryStatus()).state === "succeeded");

    const summary = await instance.summary(TODAY) as { chats: { summary: string }[] };
    assert.equal(summary.chats[0]!.summary, "合成摘要");
    assert.equal(await instance.summary(OTHER_DATE), undefined);
    assert.equal(await instance.summary("not-a-date"), undefined);
  });
});

test("historical dates are read-only and never start a run", async () => {
  await withCache(async (cacheDir) => {
    const { runner, calls } = fakeRunner(async (args) => {
      if (args[0]?.includes("dingtalk_daily.py")) {
        await mkdir(join(cacheDir, "dingtalk-daily"), { recursive: true });
        await writeFile(join(cacheDir, "dingtalk-daily", "runs.json"), JSON.stringify({
          schemaVersion: 1, date: TODAY, state: "succeeded",
          startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(),
          error: null, modelSource: "default", elapsedMs: 4321,
        }));
      }
      return ok("");
    });
    const instance = bridge(cacheDir, runner);
    await mkdir(join(cacheDir, "dingtalk-daily"), { recursive: true });
    await writeFile(join(cacheDir, "dingtalk-daily", `summary-${OTHER_DATE}.json`), JSON.stringify({
      schemaVersion: 1,
      date: OTHER_DATE,
      chats: [{ chatId: "cidSynthetic==", summary: "历史合成摘要", tickets: [] }],
    }));

    const historical = await instance.startSummary(OTHER_DATE);
    assert.equal(historical.ok, false);
    assert.equal(historical.error, "historical_read_only");
    assert.equal(calls.length, 0);
    assert.equal((await instance.summaryStatus()).state, "idle");
    const oldSummary = await instance.summary(OTHER_DATE) as { chats: { summary: string }[] };
    assert.equal(oldSummary.chats[0]!.summary, "历史合成摘要", "historical artifacts stay readable");

    const explicit = await instance.startSummary(TODAY);
    assert.equal(explicit.ok, true);
    assert.equal(explicit.reused, false);
    await waitFor(async () => (await instance.summaryStatus()).state === "succeeded");
    const status = await instance.summaryStatus();
    assert.equal(status.modelSource, "default");
    assert.equal(status.elapsedMs, 4321);

    const defaulted = await instance.startSummary();
    assert.equal(defaulted.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]![2], TODAY);
    await waitFor(async () => (await instance.summaryStatus()).state === "succeeded");
  });
});

test("summary status projects the script's channel label and duration", async () => {
  await withCache(async (cacheDir) => {
    await mkdir(join(cacheDir, "dingtalk-daily"), { recursive: true });
    await writeFile(join(cacheDir, "dingtalk-daily", "runs.json"), JSON.stringify({
      schemaVersion: 1, date: TODAY, state: "succeeded",
      startedAt: "2026-10-19T01:59:00Z", finishedAt: "2026-10-19T02:00:00Z",
      error: null, modelSource: "default", elapsedMs: 60_000,
      warnings: ["isolated_log_chmod_failed"],
    }));
    const instance = bridge(cacheDir, fakeRunner(() => ok("")).runner);
    const status = await instance.summaryStatus();

    assert.equal(status.state, "succeeded");
    assert.equal(status.date, TODAY);
    assert.equal(status.modelSource, "default");
    assert.equal(status.elapsedMs, 60_000);
    assert.deepEqual(status.warnings, ["isolated_log_chmod_failed"]);
    assert.ok(!JSON.stringify(status).includes(cacheDir), "absolute paths must not be exposed");
  });
});

test("stale running summary is settled and can be started again", async () => {
  await withCache(async (cacheDir) => {
    const dailyDir = join(cacheDir, "dingtalk-daily");
    const runsPath = join(dailyDir, "runs.json");
    const startedAt = new Date(NOW - 12 * 60_000).toISOString();
    await mkdir(dailyDir, { recursive: true });
    await writeFile(runsPath, JSON.stringify({
      schemaVersion: 1, date: TODAY, state: "running", startedAt,
      finishedAt: null, error: null, modelSource: "isolated", elapsedMs: null,
    }));

    const { runner, calls } = fakeRunner(() => ok(""));
    const instance = bridge(cacheDir, runner);
    const status = await instance.summaryStatus();
    assert.equal(status.state, "failed");
    assert.equal(status.error, "summary_stale");
    assert.equal(status.modelSource, "isolated");
    assert.ok(status.elapsedMs && status.elapsedMs > 0);

    const onDisk = JSON.parse(await readFile(runsPath, "utf-8")) as Record<string, unknown>;
    assert.equal(onDisk.state, "failed");
    assert.equal(onDisk.error, "summary_stale");
    assert.equal(onDisk.date, TODAY);
    assert.equal(onDisk.modelSource, "isolated");
    assert.equal(typeof onDisk.elapsedMs, "number");
    assert.equal((await stat(runsPath)).mode & 0o777, 0o600);

    const started = await instance.startSummary(TODAY);
    assert.equal(started.ok, true);
    assert.equal(started.reused, false);
    assert.equal(calls.length, 1, "a stale row must not block the real script");
  });
});

test("a running row without a valid startedAt is treated as stale", async () => {
  await withCache(async (cacheDir) => {
    const dailyDir = join(cacheDir, "dingtalk-daily");
    const runsPath = join(dailyDir, "runs.json");
    await mkdir(dailyDir, { recursive: true });
    for (const startedAt of [undefined, "not-a-date", ""]) {
      await writeFile(runsPath, JSON.stringify({
        schemaVersion: 1, date: TODAY, state: "running", startedAt,
        finishedAt: null, error: null, modelSource: "default", elapsedMs: null,
      }));
      const instance = bridge(cacheDir, fakeRunner(() => ok("")).runner);
      const status = await instance.summaryStatus();
      assert.equal(status.state, "failed", String(startedAt));
      assert.equal(status.error, "summary_stale", String(startedAt));
      const onDisk = JSON.parse(await readFile(runsPath, "utf-8")) as Record<string, unknown>;
      assert.equal(onDisk.state, "failed", String(startedAt));
      assert.equal(onDisk.error, "summary_stale", String(startedAt));
    }
  });
});

test("a fresh running row from another process is reused", async () => {
  await withCache(async (cacheDir) => {
    const dailyDir = join(cacheDir, "dingtalk-daily");
    const runsPath = join(dailyDir, "runs.json");
    await mkdir(dailyDir, { recursive: true });
    await writeFile(runsPath, JSON.stringify({
      schemaVersion: 1, date: TODAY, state: "running",
      startedAt: new Date(NOW - 60_000).toISOString(),
      finishedAt: null, error: null, modelSource: "default", elapsedMs: null,
    }));

    const { runner, calls } = fakeRunner(() => ok(""));
    const instance = bridge(cacheDir, runner);
    const status = await instance.summaryStatus();
    assert.equal(status.state, "running");
    const started = await instance.startSummary(TODAY);
    assert.equal(started.reused, true);
    assert.equal(started.status.state, "running");
    assert.equal(calls.length, 0);
    const onDisk = JSON.parse(await readFile(runsPath, "utf-8")) as Record<string, unknown>;
    assert.equal(onDisk.state, "running", "a fresh row must not be rewritten");
  });
});

test("an active in-process run is never reconciled as stale", async () => {
  await withCache(async (cacheDir) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, calls } = fakeRunner(async () => {
      await gate;
      return ok("");
    });
    const instance = bridge(cacheDir, runner);
    await instance.startSummary(TODAY);
    await waitFor(() => calls.length === 1);

    const runsPath = join(cacheDir, "dingtalk-daily", "runs.json");
    await mkdir(join(cacheDir, "dingtalk-daily"), { recursive: true });
    await writeFile(runsPath, JSON.stringify({
      schemaVersion: 1, date: TODAY, state: "running",
      startedAt: new Date(NOW - 60 * 60_000).toISOString(),
      finishedAt: null, error: null, modelSource: null, elapsedMs: null,
    }));
    const status = await instance.summaryStatus();
    assert.equal(status.state, "running", "the active run owns the status");
    const onDisk = JSON.parse(await readFile(runsPath, "utf-8")) as Record<string, unknown>;
    assert.equal(onDisk.state, "running", "the active run's row must stay untouched");

    release();
    await waitFor(async () => (await instance.summaryStatus()).state === "succeeded");
  });
});

test("stale creating rows settle as manual checks and never retry the write", async () => {
  await withCache(async (cacheDir) => {
    const record = {
      requestId: INPUT.requestId,
      state: "creating",
      title: INPUT.title,
      dueAt: INPUT.dueAt,
      priority: INPUT.priority,
      taskId: null,
      dryRun: null,
      error: null,
      createdAt: new Date(NOW - 4 * 60_000).toISOString(),
      finishedAt: null,
    };
    await writeFile(join(cacheDir, "dingtalk-todo-writes.json"), JSON.stringify({
      schemaVersion: 1, writes: { [INPUT.requestId]: record },
    }));

    const { runner, calls } = fakeRunner(() => ok(dryPayload()));
    const instance = bridge(cacheDir, runner);
    const result = await instance.createTodo(INPUT);
    assert.equal(result.ok, false);
    assert.equal(result.error, "todo_manual_check_required");
    assert.equal(result.record?.state, "failed");
    assert.equal(calls.length, 0, "a possibly-created todo must never be retried");

    const stored = JSON.parse(await readFile(join(cacheDir, "dingtalk-todo-writes.json"), "utf-8")) as {
      writes: Record<string, { state: string; error: string }>;
    };
    assert.equal(stored.writes[INPUT.requestId]!.state, "failed");
    assert.equal(stored.writes[INPUT.requestId]!.error, "todo_manual_check_required");

    const audit = await readFile(join(cacheDir, "dingtalk-todo-audit.jsonl"), "utf-8");
    const failed = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === "create_failed");
    assert.equal(failed?.reason, "stale_creating");
    assert.ok(!audit.includes(USER_ID));

    const replayed = await instance.createTodo(INPUT);
    assert.equal(replayed.ok, false);
    assert.equal(replayed.error, "todo_manual_check_required");
    assert.equal(calls.length, 0);
  });
});

test("recent creating rows stay busy and timestamp-less rows are stale", async () => {
  await withCache(async (cacheDir) => {
    const records = [
      new Date(NOW - 30_000).toISOString(),
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW - 2 * 60_000).toISOString(),
    ];
    for (const [index, createdAt] of records.entries()) {
      const request = { ...INPUT, requestId: `req-recent-${index}01` };
      await writeFile(join(cacheDir, "dingtalk-todo-writes.json"), JSON.stringify({
        schemaVersion: 1,
        writes: {
          [request.requestId]: {
            requestId: request.requestId, state: "creating", title: request.title,
            dueAt: request.dueAt, priority: request.priority, taskId: null, dryRun: null,
            error: null, createdAt, finishedAt: null,
          },
        },
      }));
      const { runner, calls } = fakeRunner(() => ok(dryPayload()));
      const result = await bridge(cacheDir, runner).createTodo(request);
      assert.equal(result.ok, false, createdAt);
      assert.equal(result.error, "busy", createdAt);
      assert.equal(calls.length, 0, createdAt);
    }

    const request = { ...INPUT, requestId: "req-missing-time01" };
    await writeFile(join(cacheDir, "dingtalk-todo-writes.json"), JSON.stringify({
      schemaVersion: 1,
      writes: {
        [request.requestId]: {
          requestId: request.requestId, state: "creating", title: request.title,
          dueAt: request.dueAt, priority: request.priority, taskId: null, dryRun: null,
          error: null, finishedAt: null,
        },
      },
    }));
    const { runner, calls } = fakeRunner(() => ok(dryPayload()));
    const result = await bridge(cacheDir, runner).createTodo(request);
    assert.equal(result.ok, false);
    assert.equal(result.error, "todo_manual_check_required");
    assert.equal(calls.length, 0);
  });
});

test("summary failure is reported honestly", async () => {
  await withCache(async (cacheDir) => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: "" }));
    const instance = bridge(cacheDir, runner);
    await instance.startSummary(TODAY);
    await waitFor(async () => (await instance.summaryStatus()).state === "failed");
    assert.equal((await instance.summaryStatus()).error, "summary_failed");
    assert.equal((await instance.startSummary("2026/10/19")).error, "invalid_date");
    assert.equal((await instance.startSummary(OTHER_DATE)).error, "historical_read_only");
  });
});

test("daily messages only project allowed fields and hash the chat id", async () => {
  await withCache(async (cacheDir) => {
    const chatId = "cidSynthetic==";
    const digest = createHash("sha256").update(chatId, "utf-8").digest("hex").slice(0, 24);
    const rawDir = join(cacheDir, "dingtalk-daily", "raw", "2026-10-19");
    await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, `chat_${digest}.json`), JSON.stringify({
      schemaVersion: 1,
      date: "2026-10-19",
      chatId,
      complete: true,
      messages: [
        {
          messageId: "m-1", sender: "合成同事", time: "2026-10-19T00:00:30Z", text: "合成正文",
          senderId: "sender-1", conversationId: chatId, contentExtra: "DROP-EXTRA",
        },
        { sender: "缺少 messageId 必须丢弃", text: "x" },
      ],
    }));

    const instance = bridge(cacheDir, fakeRunner(() => ok(dryPayload())).runner);
    const data = await instance.dailyMessages("2026-10-19", chatId);
    assert.ok(data);
    assert.deepEqual(Object.keys(data.messages[0]!).sort(), ["messageId", "sender", "text", "time"]);
    assert.equal(data.messages.length, 1);
    assert.ok(!JSON.stringify(data).includes("DROP-EXTRA"));
    assert.equal(await instance.dailyMessages("2026-10-20", chatId), undefined);
    assert.equal(await instance.dailyMessages("../2026-10-19", chatId), undefined);
    assert.equal(await instance.dailyMessages("2026-10-19", "bad/../id"), undefined);
  });
});

test("router exposes create, writes, summary and message routes", async () => {
  await withCache(async (cacheDir) => {
    const { runner } = fakeRunner((_args, index) => {
      if (index === 0) return ok(dryPayload());
      if (index === 1) return ok(createPayload());
      return ok(readbackPayload());
    });
    const instance = bridge(cacheDir, runner);
    const router = createLocalRouter({ port: 8000, dingtalkBridge: instance });
    const trusted = { host: "127.0.0.1:8000" };
    const post = (path: string, body: unknown) => router(new Request(`http://127.0.0.1:8000${path}`, {
      method: "POST", headers: { ...trusted, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const get = (path: string) => router(new Request(`http://127.0.0.1:8000${path}`, {
      method: "GET", headers: trusted,
    }));

    const created = await post("/local/dingtalk/todo", INPUT);
    assert.equal(created.status, 202);
    const replayed = await post("/local/dingtalk/todo", INPUT);
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { reused: boolean }).reused, true);

    const invalid = await post("/local/dingtalk/todo", { ...INPUT, title: "" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, "invalid_request");

    const writes = await get("/local/dingtalk/todo/writes");
    assert.equal(writes.status, 200);
    assert.equal((await writes.json() as { data: { writes: unknown[] } }).data.writes.length, 1);

    assert.equal((await get(`/local/dingtalk/summary?date=${TODAY}`)).status, 404);
    assert.equal((await get("/local/dingtalk/summary?date=../x")).status, 400);
    assert.equal((await get(`/local/dingtalk/daily-messages?date=${TODAY}`)).status, 400);
    assert.equal((await get(`/local/dingtalk/daily-messages?date=${TODAY}&chatId=cidSynthetic==`)).status, 404);
    assert.equal((await post("/local/dingtalk/summary", { date: "2026/10/19" })).status, 400);

    const historical = await post("/local/dingtalk/summary", { date: OTHER_DATE });
    assert.equal(historical.status, 400);
    assert.equal((await historical.json() as { error: string }).error, "historical_read_only");
    assert.equal((await post("/local/dingtalk/summary", { date: TODAY })).status, 202);
    assert.equal((await post("/local/dingtalk/summary", {})).status, 202);
  });
});

test("command builders and source keep the write whitelist tight", async () => {
  const dry = createTodoCommand(INPUT, USER_ID, true);
  const real = createTodoCommand(INPUT, USER_ID, false);
  assert.ok(dry.includes("--dry-run"));
  assert.ok(!real.includes("--dry-run"));
  assert.ok(dry.includes("--yes"));
  assert.equal(dry[dry.indexOf("--priority") + 1], "20");
  assert.equal(dry[dry.indexOf("--executors") + 1], USER_ID);
  assert.throws(() => readbackCommand("../etc/passwd"));

  const source = await readFile(new URL("./dingtalk-bridge.ts", import.meta.url), "utf-8");
  for (const token of ['"+complete"', '"+send"', '"+recall"', '"+update"', '"+mute"', '"+clear"', '"+delete"']) {
    assert.ok(!source.includes(token), token);
  }
  assert.ok(source.includes('const WRITE_PREFIX = ["todo", "+create"] as const;'));
  assert.ok(source.includes("shell: false"));
});
