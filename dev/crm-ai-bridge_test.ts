import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCrmAiBridge,
  crmAiQuestion,
  extractAssistantReply,
  fbiProductSummary,
  parseOpenTaskId,
  type CrmAiRunner,
} from "./crm-ai-bridge.ts";

const NOW = new Date("2026-10-22T04:00:00Z").getTime();
const ASSISTANT_ID = "DuGpVUiimT77sMXSOwbNze9j6PIMsUmRje";

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crm-ai-"));
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

async function seedCustomer(dir: string): Promise<void> {
  await writeFile(join(dir, "crm-snapshot.json"), JSON.stringify({
    customers: [{ cid: "cid001", name: "示例客户", yesterdayGaapRate: 42.5, yesterdayGaapDiff: 350_000 }],
  }), "utf-8");
}

async function seedAttribution(dir: string, state = "done"): Promise<void> {
  await mkdir(join(dir, "crm-attribution"), { recursive: true });
  await writeFile(join(dir, "crm-attribution", "cid001.json"), JSON.stringify({
    schemaVersion: 1,
    cid: "cid001",
    state,
    createdAt: "2026-10-22T03:00:00.000Z",
    finishedAt: state === "done" ? "2026-10-22T03:05:00.000Z" : null,
    answerMessageId: state === "done" ? "msg1" : null,
    reportResourceId: "1842553",
    currentDate: state === "done" ? "2026-10-21" : null,
    previousDate: state === "done" ? "2026-10-20" : null,
    rows: state === "done"
      ? [
        { level1: "模型服务", level2: "百炼", current: 1_200_000, previous: 800_000 },
        { level1: "计算", level2: null, current: 600_000, previous: 550_000 },
      ]
      : [],
    reason: null,
    droppedRows: 0,
    error: null,
  }), "utf-8");
}

interface CrmAiCall {
  readonly kind: "send" | "read";
  readonly args: string[];
}

test("crmAiQuestion carries both data sources with explicit 口径 labels and no credentials", () => {
  const question = crmAiQuestion({
    name: "示例客户",
    cid: "cid001",
    rate: 42.5,
    diff: 350_000,
    currentDate: "2026-10-21",
    previousDate: "2026-10-20",
    productSummary: "模型服务 +40 万、计算 +5 万",
  });
  assert.ok(question.includes("客户「示例客户」（CID cid001）"));
  assert.ok(question.includes("鲲鹏异动卡（主关联人归属口径）：昨日环比 +42.5%"));
  assert.ok(question.includes("涨跌额 +35 万"));
  assert.ok(question.includes("FBI 报表（业绩分成口径，2026-10-21 vs 2026-10-20）：模型服务 +40 万、计算 +5 万"));
  assert.ok(question.includes("口径不同"));
  assert.ok(!question.toLowerCase().includes("token"));

  const missing = crmAiQuestion({
    name: "示例客户",
    cid: "cid001",
    rate: null,
    diff: null,
    currentDate: null,
    previousDate: null,
    productSummary: null,
  });
  assert.ok(missing.includes("昨日环比缺失"));
  assert.ok(missing.includes("未返回该客户的产品拆分"));

  const negative = crmAiQuestion({
    name: "示例客户",
    cid: "cid001",
    rate: -12.5,
    diff: -350_000,
    currentDate: "2026-10-21",
    previousDate: null,
    productSummary: "模型服务 -40 万",
  });
  assert.ok(negative.includes("昨日环比 -12.5%"));
  assert.ok(negative.includes("涨跌额 -35 万"));
  assert.ok(negative.includes("2026-10-21 vs 前一日"));
});

test("fbiProductSummary keeps top3 by the caller and parse helpers stay strict", () => {
  assert.equal(fbiProductSummary([]), null);
  assert.equal(
    fbiProductSummary([{ level1: "模型服务", diff: 400_000 }, { level1: "计算", diff: 50_000 }]),
    "模型服务 +40 万、计算 +5 万",
  );
  assert.equal(fbiProductSummary([
    { level1: "一", diff: 1 },
    { level1: "二", diff: 2 },
    { level1: "三", diff: 3 },
    { level1: "四", diff: 4 },
  ]), "一 +1、二 +2、三 +3");

  const payload = {
    messages: [
      { messageId: "mine-0001", text: "问题", createTime: "2026-10-22 12:00:30" },
      { messageId: "reply-0002", text: "回复", createTime: "2026-10-22 12:01:00" },
      { messageId: "later-0003", text: "再后一条", createTime: "2026-10-22 12:02:00" },
    ],
  };
  assert.equal(extractAssistantReply(payload, "问题")?.text, "回复");
  assert.equal(extractAssistantReply({ messages: [{ messageId: "a1b2", text: "只回了" }] }, "问题")?.text, "只回了");
  assert.equal(extractAssistantReply({ messages: [] }, "问题"), undefined);
  assert.equal(parseOpenTaskId('{"openTaskId":"task-0001","success":true}'), "task-0001");
  assert.equal(parseOpenTaskId('{"success":true}'), undefined);
});

test("startExplain sends the template question 1:1 once and reads the reply", async () => {
  await withCache(async (dir) => {
    await seedCustomer(dir);
    await seedAttribution(dir);
    const calls: CrmAiCall[] = [];
    const runner: CrmAiRunner = async (_file, args) => {
      if (args[0] === "chat" && args[1] === "message" && args[2] === "send") {
        calls.push({ kind: "send", args: [...args] });
        return { code: 0, stdout: '{"openTaskId":"task-0001","success":true}' };
      }
      if (args[0] === "chat" && args[1] === "+chat-messages") {
        calls.push({ kind: "read", args: [...args] });
        const send = calls.find((call) => call.kind === "send");
        const question = send ? (send.args[send.args.indexOf("--content") + 1] ?? "") : "";
        return {
          code: 0,
          stdout: JSON.stringify({
            messages: [
              { messageId: "mine-0001", text: question, createTime: "2026-10-22 12:00:30" },
              { messageId: "reply-0002", text: "主要变化来自模型服务：百炼放量。", createTime: "2026-10-22 12:01:00" },
            ],
          }),
        };
      }
      return { code: 0, stdout: "{}" };
    };
    const bridge = createCrmAiBridge({
      cacheDir: dir,
      run: runner,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
      existsSync: () => false,
    });

    const started = await bridge.startExplain("cid001");
    assert.ok(started.ok && !started.reused);
    assert.equal(started.record.state, "running");
    const send = calls.find((call) => call.kind === "send");
    assert.ok(send);
    assert.ok(send.args.includes("--open-dingtalk-id"));
    assert.equal(send.args[send.args.indexOf("--open-dingtalk-id") + 1], ASSISTANT_ID, "只发给配置的 CRM AI 助理");
    const question = send.args[send.args.indexOf("--content") + 1] ?? "";
    assert.ok(question.includes("客户「示例客户」（CID cid001）"));
    assert.ok(!question.toLowerCase().includes("token"), "问题不携带凭据");
    // 时间窗起点 = 发送时刻（上海时间）往前 1 分钟。
    const read = calls.find((call) => call.kind === "read");
    assert.ok(read);
    assert.equal(read.args[read.args.indexOf("--start") + 1], "2026-10-22 11:59:00");

    await waitFor(async () => (await bridge.explain("cid001"))?.state === "done");
    const done = await bridge.explain("cid001");
    assert.equal(done?.answer, "主要变化来自模型服务：百炼放量。");
    assert.equal(done?.answerAt, "2026-10-22 12:01:00");

    // done 且问题未变：直接复用，绝不二次发送；force 才重新问。
    assert.ok((await bridge.startExplain("cid001")).reused);
    assert.equal(calls.filter((call) => call.kind === "send").length, 1);
    assert.ok(!(await bridge.startExplain("cid001", true)).reused);
    assert.equal(calls.filter((call) => call.kind === "send").length, 2);
  });
});

test("startExplain degrades honestly on missing pieces and failed sends", async () => {
  await withCache(async (dir) => {
    const noop: CrmAiRunner = async () => ({ code: 0, stdout: "{}" });
    const env = { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID };

    assert.deepEqual(
      (await createCrmAiBridge({ cacheDir: dir, run: noop, now: () => NOW, env: {}, existsSync: () => false }).startExplain("cid001")),
      { ok: false, error: "unconfigured" },
      "缺助理配置不允许发起",
    );

    await seedAttribution(dir);
    assert.deepEqual(
      (await createCrmAiBridge({ cacheDir: dir, run: noop, now: () => NOW, env, existsSync: () => false }).startExplain("cid001")),
      { ok: false, error: "customer_not_found" },
      "快照里没有客户",
    );

    await seedCustomer(dir);
    await seedAttribution(dir, "running");
    assert.deepEqual(
      (await createCrmAiBridge({ cacheDir: dir, run: noop, now: () => NOW, env, existsSync: () => false }).startExplain("cid001")),
      { ok: false, error: "attribution_missing" },
      "归因未完成前不允许发起解读",
    );
    await seedAttribution(dir);

    const missingDws = await createCrmAiBridge({
      cacheDir: dir,
      run: async () => ({ code: "ENOENT", stdout: "" }),
      now: () => NOW,
      env,
      existsSync: () => false,
    }).startExplain("cid001");
    assert.ok(missingDws.ok && missingDws.record.state === "failed");
    assert.equal(missingDws.record.error, "dws_missing");

    const failedSend = await createCrmAiBridge({
      cacheDir: dir,
      run: async () => ({ code: 1, stdout: "boom" }),
      now: () => NOW,
      env,
      existsSync: () => false,
    }).startExplain("cid001");
    assert.ok(failedSend.ok && failedSend.record.state === "failed");
    assert.equal(failedSend.record.error, "dws_send_failed");
    const raw = await readFile(join(dir, "crm-attribution", "cid001.explain.json"), "utf-8");
    assert.ok(!raw.includes("boom"), "子进程输出不落缓存");
  });
});

test("waitForReply lands crm_ai_timeout or dws_read_failed honestly instead of hanging", async () => {
  await withCache(async (dir) => {
    await seedCustomer(dir);
    await seedAttribution(dir);
    let clock = NOW;
    const advancing = () => (clock += 30_000);
    const bridge = createCrmAiBridge({
      cacheDir: dir,
      run: async (_file, args) => {
        if (args[0] === "chat" && args[1] === "message") {
          return { code: 0, stdout: '{"openTaskId":"task-0002"}' };
        }
        return { code: 0, stdout: JSON.stringify({ messages: [] }) };
      },
      now: advancing,
      sleep: () => Promise.resolve(),
      env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
      existsSync: () => false,
    });
    assert.ok((await bridge.startExplain("cid001")).ok);
    await waitFor(async () => (await bridge.explain("cid001"))?.state === "failed");
    assert.equal((await bridge.explain("cid001"))?.error, "crm_ai_timeout");

    clock = NOW;
    const failing = createCrmAiBridge({
      cacheDir: dir,
      run: async (_file, args) => {
        if (args[0] === "chat" && args[1] === "message") {
          return { code: 0, stdout: '{"openTaskId":"task-0003"}' };
        }
        return { code: 1, stdout: "" };
      },
      now: advancing,
      sleep: () => Promise.resolve(),
      env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
      existsSync: () => false,
    });
    assert.ok((await failing.startExplain("cid001", true)).ok);
    await waitFor(async () => (await failing.explain("cid001"))?.state === "failed");
    assert.equal((await failing.explain("cid001"))?.error, "dws_read_failed");
  });
});

test("explain resumes an interrupted running record instead of polling forever", async () => {
  await withCache(async (dir) => {
    await seedCustomer(dir);
    await seedAttribution(dir);
    const askedAt = new Date(NOW - 60_000).toISOString();
    await mkdir(join(dir, "crm-attribution"), { recursive: true });
    const question = crmAiQuestion({
      name: "示例客户",
      cid: "cid001",
      rate: 42.5,
      diff: 350_000,
      currentDate: "2026-10-21",
      previousDate: "2026-10-20",
      productSummary: "模型服务 +40 万",
    });
    await writeFile(join(dir, "crm-attribution", "cid001.explain.json"), JSON.stringify({
      schemaVersion: 1,
      cid: "cid001",
      state: "running",
      createdAt: askedAt,
      finishedAt: null,
      question,
      askedAt,
      answer: null,
      answerAt: null,
      error: null,
    }), "utf-8");

    let sends = 0;
    const bridge = createCrmAiBridge({
      cacheDir: dir,
      run: async (_file, args) => {
        if (args[0] === "chat" && args[1] === "message") {
          sends += 1;
          return { code: 0, stdout: '{"openTaskId":"task-0004"}' };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            messages: [
              { messageId: "mine-0001", text: question, createTime: "2026-10-22 11:59:30" },
              { messageId: "reply-0002", text: "重启后续跑读到的回复。", createTime: "2026-10-22 12:00:10" },
            ],
          }),
        };
      },
      now: () => NOW,
      sleep: () => Promise.resolve(),
      env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
      existsSync: () => false,
    });
    const resumed = await bridge.explain("cid001");
    assert.equal(resumed?.state, "running");
    await waitFor(async () => (await bridge.explain("cid001"))?.state === "done");
    assert.equal(sends, 0, "续跑只补读回复，绝不重复发送");

    // 缺配置时无法续跑：如实落终态，不让前端永远轮询 running。
    const stuck = createCrmAiBridge({
      cacheDir: dir,
      run: async () => ({ code: 0, stdout: "{}" }),
      now: () => NOW,
      env: {},
      existsSync: () => false,
    });
    await writeFile(join(dir, "crm-attribution", "cid001.explain.json"), JSON.stringify({
      schemaVersion: 1,
      cid: "cid001",
      state: "running",
      createdAt: askedAt,
      finishedAt: null,
      question,
      askedAt,
      answer: null,
      answerAt: null,
      error: null,
    }), "utf-8");
    const settled = await stuck.explain("cid001");
    assert.equal(settled?.state, "failed");
    assert.equal(settled?.error, "crm_ai_timeout");
  });
});

test("router serves the explain endpoint with guards and stable error codes", async () => {
  await withCache(async (dir) => {
    await seedCustomer(dir);
    await seedAttribution(dir);
    const { createLocalRouter } = await import("./local-router.ts");
    const { createCrmBridge } = await import("./crm-bridge.ts");
    const { createCrmAttributionBridge } = await import("./crm-attribution-bridge.ts");
    const router = createLocalRouter({
      port: 8000,
      crmBridge: createCrmBridge({ cacheDir: dir, run: async () => ({ code: 0, stdout: "" }) }),
      crmAttributionBridge: createCrmAttributionBridge({
        cacheDir: dir, run: async () => ({ code: 0, stdout: "" }), now: () => NOW, env: {},
      }),
      crmAiBridge: createCrmAiBridge({
        cacheDir: dir,
        run: async (_file, args) => {
          if (args[0] === "chat" && args[1] === "message") {
            return { code: 0, stdout: '{"openTaskId":"task-0005"}' };
          }
          return { code: 0, stdout: JSON.stringify({ messages: [] }) };
        },
        now: () => NOW,
        sleep: () => new Promise(() => undefined),
        env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
        existsSync: () => false,
      }),
    });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    const empty = await router(new Request("http://127.0.0.1:8000/local/crm/attribution/explain?cid=cid001", { headers }));
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { data: unknown }).data, null);

    const started = await router(new Request("http://127.0.0.1:8000/local/crm/attribution/explain", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid001" }),
    }));
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { data: { state: string; question: string | null } };
    assert.equal(startedBody.data.state, "running");
    assert.ok(startedBody.data.question?.includes("客户「示例客户」"));

    const invalid = await router(new Request("http://127.0.0.1:8000/local/crm/attribution/explain", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    assert.equal(invalid.status, 400);

    // 归因缺失：先删掉 done 记录再触发（attribution_missing）。
    // 用全新桥实例：上方 started 的后台任务被 sleep 冻结、同桥会先命中 busy 429；
    // attribution_missing 守卫需在无在途任务的桥上验证（快照与归因缓存同目录）。
    await rm(join(dir, "crm-attribution", "cid001.json"));
    const notReadyRouter = createLocalRouter({
      port: 8000,
      crmAiBridge: createCrmAiBridge({
        cacheDir: dir,
        run: async () => ({ code: 0, stdout: "" }),
        now: () => NOW,
        sleep: () => new Promise(() => undefined),
        env: { CRM_AI_OPEN_DINGTALK_ID: ASSISTANT_ID },
      }),
    });
    const notReady = await notReadyRouter(new Request("http://127.0.0.1:8000/local/crm/attribution/explain", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid001" }),
    }));
    assert.equal(notReady.status, 400);
    assert.equal((await notReady.json() as { error: string }).error, "attribution_missing");

    const unconfigured = createLocalRouter({
      port: 8000,
      crmAiBridge: createCrmAiBridge({ cacheDir: dir, run: async () => ({ code: 0, stdout: "" }), now: () => NOW, env: {} }),
    });
    const blocked = await unconfigured(new Request("http://127.0.0.1:8000/local/crm/attribution/explain", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: "cid001" }),
    }));
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json() as { error: string }).error, "unconfigured");

    const crossOrigin = await router(new Request("http://127.0.0.1:8000/local/crm/attribution/explain?cid=cid001", {
      headers: { ...headers, origin: "https://attacker.example" },
    }));
    assert.equal(crossOrigin.status, 403);
  });
});
