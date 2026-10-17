import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandRunner } from "./crm-bridge.ts";
import { createFbiMetricsBridge, FBI_METRICS_QUESTION, parseMetricsAnswer } from "./fbi-metrics-bridge.ts";

const NOW = new Date("2026-10-16T12:00:00Z").getTime();
const FINAL_MARKER = "========== 最终结果 ==========";

async function withCache(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fbi-metrics-"));
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

test("parseMetricsAnswer extracts the fixed schema out of wrapped answers", () => {
  const clean = parseMetricsAnswer('{"date":"2026-10-15","dailyGaap":12345.6,"validCustomers":3,"callVolume":1000,"moMRate":0.5}');
  // 坐席数停用商机预估口径：即使答案里带坐席字段（历史遗留），也一律置 null，不透出。
  const legacySeats = parseMetricsAnswer('{"date":"2026-10-15","dailyGaap":1,"validCustomers":1,"callVolume":1,"moMRate":null,"qoderSeats":9900,"qwenworkSeats":8800}');
  assert.equal(legacySeats?.qoderSeats, null);
  assert.equal(legacySeats?.qwenworkSeats, null);
  assert.deepEqual(clean, { date: "2026-10-15", dailyGaap: 12345.6, validCustomers: 3, callVolume: 1000, moMRate: 0.5, qoderSeats: null, qwenworkSeats: null });
  const fenced = parseMetricsAnswer('```json\n{"date":"2026-10-15","dailyGaap":null,"validCustomers":null,"callVolume":null,"moMRate":null}\n```');
  assert.equal(fenced?.date, "2026-10-15");
  assert.equal(fenced?.dailyGaap, null);
  assert.equal(parseMetricsAnswer("no json here"), undefined);
  assert.equal(parseMetricsAnswer('{"dailyGaap":1}'), undefined);
  assert.equal(parseMetricsAnswer('{"date":"2026/10/15"}'), undefined);
});

test("start resolves the report from env, asks the fixed question and stores metrics", async () => {
  await withCache(async (dir) => {
    const calls: { script: string; args: string[] }[] = [];
    const runner: CommandRunner = async (file, args) => {
      const script = String(args[0]);
      calls.push({ script, args: [...args] });
      if (script.endsWith("create_chat.py")) {
        return { code: 0, stdout: "提交成功！\nanswerMessageId: msgMetrics123456\nquestionMessageId: q1" };
      }
      if (script.endsWith("query_chat_result.py")) {
        // 答案仍带历史坐席字段：bridge 必须置 null 而非透出商机预估值。
        const finalAnswer = { finalAnswer: '{"date":"2026-10-15","dailyGaap":12345.6,"validCustomers":3,"callVolume":1000,"moMRate":0.25,"qoderSeats":9900,"qwenworkSeats":8800}', finalize: true };
        return { code: 0, stdout: `${FINAL_MARKER}\n${JSON.stringify(finalAnswer, null, 2)}` };
      }
      return { code: 0, stdout: "{}" };
    };
    const bridge = createFbiMetricsBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "999001" },
    });
    assert.equal(await bridge.needsRefresh(), true);
    const started = await bridge.start();
    assert.deepEqual(started, { ok: true });

    const createCall = calls.find((call) => call.script.endsWith("create_chat.py"));
    assert.ok(createCall);
    assert.equal(createCall.args[1], FBI_METRICS_QUESTION);
    assert.equal(createCall.args[2], JSON.stringify({ resourceId: "999001", resourceType: "report" }));
    // 问题文本固定且不含任何用户输入或凭证。
    assert.match(FBI_METRICS_QUESTION, /只输出一个 JSON 对象/);
    assert.ok(!FBI_METRICS_QUESTION.includes("token"), "question must stay credential-free");

    await waitFor(() => bridge.status().state === "succeeded");
    const metrics = await bridge.metrics();
    assert.ok(metrics);
    assert.equal(metrics.state, "done");
    assert.equal(metrics.reportResourceId, "999001");
    assert.equal(metrics.date, "2026-10-15");
    assert.equal(metrics.dailyGaap, 12345.6);
    assert.equal(metrics.validCustomers, 3);
    assert.equal(metrics.moMRate, 0.25);
    // 坐席卡占位：seats 恒 null（在用席位待 2000986 权限），即使答案带值也不透出。
    assert.equal(metrics.qoderSeats, null);
    assert.equal(metrics.qwenworkSeats, null);
    // 产物 0600 且无凭证/消息 ID 泄漏。
    assert.equal((await stat(join(dir, "fbi-metrics.json"))).mode & 0o777, 0o600);
    const raw = await readFile(join(dir, "fbi-metrics.json"), "utf-8");
    assert.ok(!raw.includes("msgMetrics123456"));
    assert.ok(!raw.toLowerCase().includes("token"));
    // 新鲜产物不需要刷新；未配置 env 的桥则视为需要。
    assert.equal(await bridge.needsRefresh(), false);
    const unconfigured = createFbiMetricsBridge({ cacheDir: dir, run: runner, now: () => NOW, env: {} });
    assert.deepEqual(await unconfigured.start(), { ok: false, error: "not_configured" });
    assert.equal(unconfigured.status().state, "failed");
  });
});

test("start can resolve the report id from a clean fbi url without signature params", async () => {
  await withCache(async (dir) => {
    const runner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      if (script.endsWith("search_report.py")) {
        return { code: 0, stdout: '{\n  "resource_id": "999001",\n  "resource_type": "report"\n}' };
      }
      if (script.endsWith("create_chat.py")) {
        return { code: 0, stdout: "answerMessageId: msgFromUrl12345" };
      }
      if (script.endsWith("query_chat_result.py")) {
        const finalAnswer = { finalAnswer: '{"date":"2026-10-15","dailyGaap":1,"validCustomers":1,"callVolume":1,"moMRate":null}', finalize: true };
        return { code: 0, stdout: `${FINAL_MARKER}\n${JSON.stringify(finalAnswer)}` };
      }
      return { code: 0, stdout: "" };
    };
    const bridge = createFbiMetricsBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      env: { FBI_REPORT_URL: "https://fbi.alibaba-inc.com/fbi/pro/888001/view.htm?menuId=abc123&menuInfoId=1" },
    });
    assert.deepEqual(await bridge.start(), { ok: true });
    await waitFor(() => bridge.status().state === "succeeded");
    const metrics = await bridge.metrics();
    assert.equal(metrics?.reportResourceId, "999001");
    // 签名参数与 URL 本身都不落产物。
    const raw = await readFile(join(dir, "fbi-metrics.json"), "utf-8");
    assert.ok(!raw.includes("888001"));
    assert.ok(!raw.includes("_dt_sig"));
  });
});

test("create failure is recorded honestly without faking numbers", async () => {
  await withCache(async (dir) => {
    const runner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      if (script.endsWith("create_chat.py")) {
        return { code: 1, stdout: "boom with token=secret inside" };
      }
      return { code: 0, stdout: "" };
    };
    const bridge = createFbiMetricsBridge({
      cacheDir: dir, run: runner, now: () => NOW,
      env: { FBI_REPORT_RESOURCE_ID: "999001" },
    });
    assert.deepEqual(await bridge.start(), { ok: true });
    await waitFor(() => bridge.status().state === "failed");
    const metrics = await bridge.metrics();
    assert.equal(metrics?.state, "failed");
    assert.equal(metrics?.error, "fbi_create_failed");
    assert.equal(metrics?.dailyGaap, null);
    const raw = await readFile(join(dir, "fbi-metrics.json"), "utf-8");
    assert.ok(!raw.includes("secret"), "child stdout must not be persisted");
  });
});

test("router wires fbi metrics endpoints with host and origin guards", async () => {
  await withCache(async (dir) => {
    const runner: CommandRunner = async (_file, args) => {
      const script = String(args[0]);
      if (script.endsWith("create_chat.py")) {
        return { code: 0, stdout: "answerMessageId: msgRouter12345" };
      }
      if (script.endsWith("query_chat_result.py")) {
        const finalAnswer = { finalAnswer: '{"date":"2026-10-15","dailyGaap":9,"validCustomers":2,"callVolume":8,"moMRate":0.1,"qoderSeats":null,"qwenworkSeats":null}', finalize: true };
        return { code: 0, stdout: `${FINAL_MARKER}\n${JSON.stringify(finalAnswer)}` };
      }
      return { code: 0, stdout: "" };
    };
    const { createLocalRouter } = await import("./local-router.ts");
    const { createCrmBridge } = await import("./crm-bridge.ts");
    const router = createLocalRouter({
      port: 8000,
      crmBridge: createCrmBridge({ cacheDir: dir, run: runner }),
      fbiMetricsBridge: createFbiMetricsBridge({
        cacheDir: dir, run: runner, now: () => NOW, env: { FBI_REPORT_RESOURCE_ID: "999001" },
      }),
    });
    const headers = { host: "127.0.0.1:8000", origin: "http://127.0.0.1:4173" };

    const missing = await router(new Request("http://127.0.0.1:8000/local/fbi/metrics", { headers }));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, "metrics_unavailable");

    const started = await router(new Request("http://127.0.0.1:8000/local/fbi/metrics", { method: "POST", headers }));
    assert.equal(started.status, 202);
    await waitFor(async () => {
      const status = await router(new Request("http://127.0.0.1:8000/local/fbi/metrics", { headers }));
      const body = await status.json() as { status: { state: string } };
      return body.status.state === "succeeded";
    });
    const done = await router(new Request("http://127.0.0.1:8000/local/fbi/metrics", { headers }));
    const doneBody = await done.json() as { ok: boolean; data: { date: string; state: string } };
    assert.equal(done.status, 200);
    assert.equal(doneBody.data.state, "done");
    assert.equal(doneBody.data.date, "2026-10-15");

    const crossOrigin = await router(new Request("http://127.0.0.1:8000/local/fbi/metrics", {
      headers: { ...headers, origin: "https://attacker.example" },
    }));
    assert.equal(crossOrigin.status, 403);
  });
});
