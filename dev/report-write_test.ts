import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReportWriteBridge, type ReportWriteBridgeOptions } from "./report/report-write.ts";
import { createReportWriteStore, maskWritePreview } from "./report/report-write-store.ts";
import {
  DRY_TOKEN_TTL_MS,
  RECORD_UPDATE_TIMEOUT_MS,
  REPORT_WRITE_ROUTES,
  REPORT_WRITABLE_FIELDS,
  SUBMIT_COOLDOWN_MS,
  WRITES_TAIL,
  type ReportWriteAudit,
} from "./report/report-write-types.ts";
import type { ReportCommandResult, ReportCommandRunner } from "./report/report-dws.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：baseId/tableId/字段 ID/触发器/主机全为合成值（bse-syn-report /
// fld-topic / tr_syn0002 / ecs-syn.example），企业只出现「甲科技/乙股份」等合成名；
// dws 与 ssh 全程 fake runner（注入），真实子进程零调用；FS 只碰 mkdtemp 临时目录。
// FIXED_NOW = 2026-10-20T02:30:00Z → 北京时间 2026-10-20 10:30（周二）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");
const TODAY = "2026-10-20";

const CONFIG = {
  baseId: "bse-syn-report",
  tableId: "tbl-syn-daily",
  fields: {
    topic: { id: "fld-topic" },
    dept: { id: "fld-dept" },
    workStatus: { id: "fld-work" },
    date: { id: "fld-date" },
    followup: { id: "fld-follow" },
    opportunity: { id: "fld-opp" },
    risk: { id: "fld-risk" },
    other: { id: "fld-other" },
  },
  oa: { templateName: "工作日报（合成模板）" },
  remote: {
    host: "root@ecs-syn.example",
    key: "~/.ssh/syn-key.pem",
    bin: "~/.qoderwake/bin/qoderwake",
    wakerId: "waker-syn-01",
    timeoutMs: 60000,
    jobs: {
      draft: { trigger: "tr_syn0001", name: "日报初稿（合成）" },
      submit: { trigger: "tr_syn0002", name: "日报提交（合成）" },
      weekly: { trigger: "tr_syn0003", name: "双周报（合成）" },
    },
  },
};

const FIELD_BY_KEY: Record<string, string> = {
  topic: "fld-topic", dept: "fld-dept", workStatus: "fld-work", date: "fld-date",
  followup: "fld-follow", opportunity: "fld-opp", risk: "fld-risk", other: "fld-other",
};

function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: "rec-syn-01",
    cells: {
      "fld-topic": "合成主题甲",
      "fld-dept": "合成部门",
      "fld-work": "正常",
      "fld-date": TODAY,
      "fld-follow": "跟进甲科技试点",
      "fld-opp": "",
      "fld-risk": "",
      "fld-other": "",
    },
    lastModifiedTime: "2026-10-20T09:00:00+08:00",
    ...overrides,
  };
}

const DETAIL_TEXT = [
  "TRIGGER_ID: tr_syn0002",
  "NAME: 日报提交（合成）",
  "ENABLED: true",
  "KIND: cron",
  "CONDITION_SUMMARY: 工作日 23:15",
  "LAST_RUN_STATUS: success",
  "LAST_RUN_AT: 2026-10-19T23:15:02+08:00",
  "NEXT_RUN_AT: 2026-10-20T23:15:00+08:00",
  "TASK_DESCRIPTION: 合成提示词正文（不得透出到页面）",
].join("\n");

interface Harness {
  readonly bridge: ReturnType<typeof createReportWriteBridge>;
  readonly dir: string;
  readonly calls: Array<{ file: string; args: readonly string[] }>;
  readonly runNowCommands: string[];
  readonly updatedFiles: string[];
  /** 可编排状态：当前 AI 表格记录 / outbox 行 / 各类失败注入。 */
  records: Array<Record<string, unknown>>;
  outboxRows: Array<Record<string, unknown>>;
  failQuery: "ENOENT" | "business" | null;
  failUpdate: "ENOENT" | "business" | null;
  failSshDetail: boolean;
  failSshRunNow: "exit" | "refuse" | "ENOENT" | null;
  /** true=update「成功」但不落库（模拟回读不一致）；false=正常应用 cells。 */
  updateNoop: boolean;
  /** true=run-now 成功后 outbox 立即可见（模拟远端秒回）；false=回读暂未可见。 */
  runNowFillsOutbox: boolean;
  advance: (ms: number) => void;
  cleanup: () => Promise<void>;
}

interface HarnessOverrides extends Partial<ReportWriteBridgeOptions> {
  readonly config?: unknown;
}

async function makeHarness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "sa-report-write-test-"));
  const configPath = join(dir, "report-config.json");
  await writeFile(configPath, JSON.stringify(overrides.config ?? CONFIG), "utf-8");
  const writesDir = join(dir, "writes");

  const h: Harness = {
    bridge: null as unknown as Harness["bridge"],
    dir,
    calls: [],
    runNowCommands: [],
    updatedFiles: [],
    records: [recordFixture()],
    outboxRows: [],
    failQuery: null,
    failUpdate: null,
    failSshDetail: false,
    failSshRunNow: null,
    updateNoop: false,
    runNowFillsOutbox: true,
    advance: () => {},
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
  let clock = FIXED_NOW;
  h.advance = (ms: number) => { clock += ms; };

  const dwsResult = (args: readonly string[]): ReportCommandResult => {
    const joined = args.join(" ");
    if (joined.includes("aitable record query")) {
      if (h.failQuery === "ENOENT") return { code: "ENOENT", stdout: "", stderr: "" };
      if (h.failQuery === "business") return { code: 0, stdout: JSON.stringify({ success: false, error: { message: "合成上游失败" } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ data: { records: h.records } }), stderr: "" };
    }
    if (joined.includes("aitable record update")) {
      if (h.failUpdate === "ENOENT") return { code: "ENOENT", stdout: "", stderr: "" };
      if (h.failUpdate === "business") return { code: 0, stdout: JSON.stringify({ success: false, error: { message: "合成上游失败" } }), stderr: "" };
      // 模拟远端落库：读 records-file 应用到 h.records（回读校验据此通过）。
      const filePath = args[args.indexOf("--records-file") + 1] ?? "";
      h.updatedFiles.push(String(filePath));
      if (!h.updateNoop) {
        const payload = JSON.parse(readFileSync(String(filePath), "utf-8")) as Array<{ recordId: string; cells: Record<string, string> }>;
        for (const entry of payload) {
          const hit = h.records.find((row) => row.recordId === entry.recordId);
          if (hit) hit.cells = { ...(hit.cells as Record<string, unknown>), ...entry.cells };
        }
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, error: {} }), stderr: "" };
    }
    if (joined.includes("report outbox list")) {
      return { code: 0, stdout: JSON.stringify({ result: h.outboxRows }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
  };

  const sshResult = (args: readonly string[]): ReportCommandResult => {
    const remoteCommand = String(args[args.length - 1] ?? "");
    if (remoteCommand.includes("automation detail")) {
      if (h.failSshDetail) return { code: 255, stdout: "", stderr: "ssh: connect to host ecs-syn.example port 22: Operation timed out" };
      return { code: 0, stdout: DETAIL_TEXT, stderr: "" };
    }
    if (remoteCommand.includes("automation run-now")) {
      h.runNowCommands.push(remoteCommand);
      if (h.failSshRunNow === "ENOENT") return { code: "ENOENT", stdout: "", stderr: "" };
      if (h.failSshRunNow === "exit") return { code: 255, stdout: "", stderr: "合成 SSH 失败输出" };
      if (h.failSshRunNow === "refuse") return { code: 0, stdout: JSON.stringify({ error: { message: "远端拒绝（合成）" } }), stderr: "" };
      if (h.runNowFillsOutbox) {
        h.outboxRows = [{ 标题: "合成日报（甲科技）", 日期: `${TODAY}T10:31:00+08:00` }];
      }
      return { code: 0, stdout: JSON.stringify({ runId: "run-syn-01", sessionId: "ses-syn-01" }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const run: ReportCommandRunner = async (file, args) => {
    h.calls.push({ file, args: [...args] });
    return file === "ssh" ? sshResult(args) : dwsResult(args);
  };

  let tokenSeq = 0;
  h.bridge = createReportWriteBridge({
    configPath,
    dir: writesDir,
    run,
    env: { HOME: "/synthetic-home", QODERWAKE_DWS_CLI_PATH: "/synthetic/dws" } as NodeJS.ProcessEnv,
    existsSync: (path: string) => path.endsWith("syn-key.pem"),
    now: () => clock,
    sleep: async () => {},
    randomToken: () => `tok-syn-${(tokenSeq += 1)}`,
    ...overrides,
  });
  return h;
}

function req(path: string, method = "POST", body?: unknown): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function post(bridge: Harness["bridge"], path: string, body: unknown): Promise<{ status: number; payload: Record<string, any> }> {
  const response = await bridge.handle(req(path, "POST", body));
  assert.ok(response, `${path} 必须命中写路由`);
  return { status: response.status, payload: await response.json() as Record<string, any> };
}

function dwsCalls(h: Harness, marker: string): Array<{ file: string; args: readonly string[] }> {
  return h.calls.filter((call) => call.file !== "ssh" && call.args.join(" ").includes(marker));
}

function sshCalls(h: Harness, marker: string): Array<{ file: string; args: readonly string[] }> {
  return h.calls.filter((call) => call.file === "ssh" && String(call.args[call.args.length - 1]).includes(marker));
}

async function readAudits(h: Harness): Promise<readonly ReportWriteAudit[]> {
  const raw = await readFile(join(h.dir, "writes", "writes.jsonl"), "utf-8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReportWriteAudit);
}

/* ========================================================================== */
/* 路由表与子路由闭环                                                          */
/* ========================================================================== */

test("route table covers exactly the five write routes", () => {
  assert.deepEqual(
    REPORT_WRITE_ROUTES.map((route) => `${route.method} ${route.path}`),
    [
      "POST /local/report/save-dry",
      "POST /local/report/save-confirm",
      "POST /local/report/submit-dry",
      "POST /local/report/submit-confirm",
      "GET /local/report/writes",
    ],
  );
});

test("handle returns undefined for foreign paths and the four read-only GET routes", async () => {
  const h = await makeHarness();
  try {
    assert.equal(await h.bridge.handle(req("/local/reply/send")), undefined, "非 report 路径交回主路由");
    // 既有 4 条只读 GET 路由由 local-router 内联接线，本桥绝不拦截（行为字节不变）。
    for (const path of ["/local/report/state", "/local/report/automations", "/local/report/weeklies", "/local/report/weekly"]) {
      assert.equal(await h.bridge.handle(req(path, "GET")), undefined, `${path} 必须交回主路由`);
    }
    assert.equal(h.calls.length, 0, "路由判定不触发任何外部调用");
  } finally { await h.cleanup(); }
});

test("wrong method on a write route yields 405", async () => {
  const h = await makeHarness();
  try {
    const response = await h.bridge.handle(req("/local/report/save-dry", "GET"));
    assert.equal(response?.status, 405);
    const payload = await response?.json() as Record<string, any>;
    assert.equal(payload.error.code, "method_not_allowed");
    const writesPost = await h.bridge.handle(req("/local/report/writes", "POST", {}));
    assert.equal(writesPost?.status, 405);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* save-dry：白名单 diff / 拒绝面                                              */
/* ========================================================================== */

test("save-dry returns whitelist diff with before values and a token", async () => {
  const h = await makeHarness();
  try {
    const { status, payload } = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { topic: "合成主题乙", followup: "跟进甲科技试点" },
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    const data = payload.data;
    assert.equal(typeof data.token, "string");
    assert.ok(data.token.length > 0);
    assert.equal(data.recordId, "rec-syn-01");
    assert.equal(data.today, TODAY);
    assert.deepEqual(data.diff.map((item: any) => item.key), ["topic", "followup"]);
    assert.equal(data.diff[0].before, "合成主题甲");
    assert.equal(data.diff[0].after, "合成主题乙");
    assert.equal(data.diff[0].changed, true);
    assert.equal(data.diff[0].fieldId, "fld-topic");
    assert.equal(data.diff[1].changed, false, "值未变也要如实标 changed:false");
    // 只回白名单字段：dept/workStatus/date 等无关字段不出现在 diff 里
    assert.equal(JSON.stringify(data.diff).includes("fld-dept"), false);
    assert.equal(JSON.stringify(data.diff).includes("合成部门"), false);
    // dry 只读：一条 update 都不许发
    assert.equal(dwsCalls(h, "aitable record update").length, 0);
    assert.equal(dwsCalls(h, "aitable record query").length, 1);
  } finally { await h.cleanup(); }
});

test("save-dry rejects non-whitelist fields, oversize text and bad recordId before any external call", async () => {
  const h = await makeHarness();
  try {
    const outside = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { topic: "x", dept: "越权部门改写" },
    });
    assert.equal(outside.status, 400);
    assert.equal(outside.payload.error.code, "report_invalid_request");
    assert.match(outside.payload.error.message, /dept/);

    const oversize = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { topic: "长".repeat(4001) },
    });
    assert.equal(oversize.status, 400);
    assert.equal(oversize.payload.error.code, "report_invalid_request");

    const nulText = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { risk: "含\u0000控制符" },
    });
    assert.equal(nulText.status, 400);

    const badRecordId = await post(h.bridge, "/local/report/save-dry", {
      recordId: "../escape",
      cells: { topic: "x" },
    });
    assert.equal(badRecordId.status, 400);

    const emptyCells = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: {} });
    assert.equal(emptyCells.status, 400);

    assert.equal(h.calls.length, 0, "输入校验必须先于任何外部调用");
  } finally { await h.cleanup(); }
});

test("save-dry reports no_record (409) and recordId conflict (409) with the conflict list", async () => {
  const h = await makeHarness();
  try {
    h.records = [];
    const missing = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "x" } });
    assert.equal(missing.status, 409);
    assert.equal(missing.payload.error.code, "no_record");

    h.records = [recordFixture({ recordId: "rec-syn-02" })];
    const conflict = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "x" } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.error.code, "record_conflict");
    const data = conflict.payload.error.data;
    assert.equal(data.expectedRecordId, "rec-syn-01");
    assert.equal(data.currentRecordId, "rec-syn-02");
    assert.equal(data.current.topic, "合成主题甲", "冲突清单带最新内容供页面刷新");
    assert.equal(dwsCalls(h, "aitable record update").length, 0, "冲突绝不覆盖");
  } finally { await h.cleanup(); }
});

test("save-dry with missing dws is an honest 503 dws_missing, never a fake success", async () => {
  const h = await makeHarness();
  try {
    h.failQuery = "ENOENT";
    const { status, payload } = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "x" } });
    assert.equal(status, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "dws_missing");
    assert.match(payload.error.message, /dws auth login/);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* save-confirm：confirm 闸门 / 白名单执行 / 冲突 / 回读校验 / 审计            */
/* ========================================================================== */

test("save-confirm executes the whitelist update, verifies by readback, appends masked audit, token is single-use", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { topic: "合成主题乙", risk: "合成风险一条" },
    });
    const token = dry.payload.data.token as string;

    const { status, payload } = await post(h.bridge, "/local/report/save-confirm", { confirm: token });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.recordId, "rec-syn-01");
    assert.equal(payload.data.verified, true, "回读校验必须通过");
    assert.deepEqual(payload.data.updated, ["topic", "risk"]);
    assert.equal(payload.data.audited, true);

    // update 命令：数组 argv、records-file、60s 硬超时；cells 只含白名单字段 ID
    const update = dwsCalls(h, "aitable record update");
    assert.equal(update.length, 1);
    assert.ok(update[0].args.includes("--records-file"));
    assert.ok(update[0].args.includes("--base-id") && update[0].args.includes("bse-syn-report"));
    const tmpFile = update[0].args[update[0].args.indexOf("--records-file") + 1];
    assert.ok(h.updatedFiles.includes(String(tmpFile)));
    let tmpGone = true;
    try { readFileSync(String(tmpFile)); tmpGone = false; } catch { /* 期望已删 */ }
    assert.ok(tmpGone, "records 临时文件用后即删");

    // 审计：append-only 一行，掩码预览不落全文
    const audits = await readAudits(h);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].op, "save");
    assert.equal(audits[0].ok, true);
    assert.equal(audits[0].verified, true);
    assert.equal(audits[0].target, "rec-syn-01");
    assert.ok(audits[0].maskedPreview.length <= 25);

    // token 单次消费：重放同一 token → 409 confirm_stale，且不再触发第二次 update
    const replay = await post(h.bridge, "/local/report/save-confirm", { confirm: token });
    assert.equal(replay.status, 409);
    assert.equal(replay.payload.error.code, "confirm_stale");
    assert.equal(dwsCalls(h, "aitable record update").length, 1);
  } finally { await h.cleanup(); }
});

test("save-confirm gate rejects wrong/missing confirm before any external call", async () => {
  const h = await makeHarness();
  try {
    const wrong = await post(h.bridge, "/local/report/save-confirm", { confirm: "tok-syn-forged" });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.payload.error.code, "confirm_stale");
    const missing = await post(h.bridge, "/local/report/save-confirm", {});
    assert.equal(missing.status, 400);
    assert.equal(missing.payload.error.code, "confirm_mismatch");
    assert.equal(h.calls.length, 0, "confirm 闸门必须先于任何外部调用");
  } finally { await h.cleanup(); }
});

test("save-confirm re-checks recordId at execution time: conflict → 409, no update", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "合成主题乙" } });
    const token = dry.payload.data.token as string;
    // dry 与 confirm 之间记录被外部任务重建（recordId 变化）
    h.records = [recordFixture({ recordId: "rec-syn-02" })];
    const { status, payload } = await post(h.bridge, "/local/report/save-confirm", { confirm: token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "record_conflict");
    assert.equal(payload.error.data.currentRecordId, "rec-syn-02");
    assert.equal(dwsCalls(h, "aitable record update").length, 0, "冲突时绝不覆盖");
  } finally { await h.cleanup(); }
});

test("save-confirm maps dws business failure to 502 dws_failed and still appends the audit row", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "合成主题丙" } });
    h.failUpdate = "business";
    const failed = await post(h.bridge, "/local/report/save-confirm", { confirm: dry.payload.data.token });
    assert.equal(failed.status, 502);
    assert.equal(failed.payload.error.code, "dws_failed");
    assert.match(failed.payload.error.message, /合成上游失败/);
    const audits = await readAudits(h);
    assert.equal(audits.length, 1, "失败的真实尝试也必须留审计");
    assert.equal(audits[0].ok, false);
    assert.equal(audits[0].verified, false);
    assert.equal(audits[0].executed, true);
  } finally { await h.cleanup(); }
});

test("save readback mismatch yields verified:false (no fake success)", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "合成主题乙" } });
    // update「成功」但远端没有真正落库（updateNoop）→ 回读不一致必须如实 verified:false
    h.updateNoop = true;
    const { status, payload } = await post(h.bridge, "/local/report/save-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 200);
    assert.equal(payload.data.verified, false);
    assert.match(payload.data.note, /人工确认|不一致/);
    const audits = await readAudits(h);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].ok, true);
    assert.equal(audits[0].verified, false, "审计同样如实记录回读未通过");
  } finally { await h.cleanup(); }
});

test("save-confirm with dws missing on update is 503 dws_missing, never pretends success", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", { recordId: "rec-syn-01", cells: { topic: "合成主题乙" } });
    h.failUpdate = "ENOENT";
    const { status, payload } = await post(h.bridge, "/local/report/save-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 503);
    assert.equal(payload.error.code, "dws_missing");
    const audits = await readAudits(h);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].executed, false, "ENOENT=外部进程没跑过，如实记 executed:false");
    assert.equal(audits[0].ok, false);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* submit-dry：预检（冷却 / outbox 去重 / SSH 通道探测）                        */
/* ========================================================================== */

test("submit-dry probes the SSH channel read-only and mints a token", async () => {
  const h = await makeHarness();
  try {
    const { status, payload } = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(status, 200);
    const data = payload.data;
    assert.ok(data.token.length > 0);
    assert.equal(data.blocked, false);
    assert.equal(data.cooldownRemainMs, 0);
    assert.equal(data.alreadySubmitted, null);
    assert.equal(data.channel.available, true);
    assert.equal(data.channel.enabled, true);
    assert.equal(data.channel.lastStatus, "success");
    // 探测只用只读 detail，绝不 run-now
    assert.equal(sshCalls(h, "automation detail").length, 1);
    assert.equal(sshCalls(h, "run-now").length, 0);
    const detailCommand = String(sshCalls(h, "automation detail")[0].args.slice(-1)[0]);
    assert.match(detailCommand, /automation detail --waker-id waker-syn-01 --automation-id tr_syn0002/);
    assert.equal(JSON.stringify(data).includes("合成提示词正文"), false, "TASK_DESCRIPTION 不得透出");
  } finally { await h.cleanup(); }
});

test("submit-dry reports blocked states honestly: cooldown, already-submitted, dead channel", async () => {
  const h = await makeHarness();
  try {
    // 1) outbox 今日已提交
    h.outboxRows = [{ 标题: "合成日报（甲科技）", 日期: `${TODAY}T09:00:00+08:00` }];
    const already = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(already.payload.data.blocked, true);
    assert.equal(already.payload.data.alreadySubmitted.n, 1);
    assert.match(already.payload.data.note, /已提交/);
    h.outboxRows = [];

    // 2) SSH 通道不可用
    h.failSshDetail = true;
    const dead = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(dead.payload.data.blocked, true);
    assert.equal(dead.payload.data.channel.available, false);
    assert.match(dead.payload.data.channel.note, /SSH|ssh/);
    h.failSshDetail = false;

    // 3) 冷却中：审计里预置 1 分钟前的真实 run 行
    const store = createReportWriteStore(join(h.dir, "writes"));
    await store.appendWrite({
      at: new Date(FIXED_NOW - 60_000).toISOString(),
      op: "submit", phase: "run", target: "tr_syn0002",
      exitCode: 0, executed: true, ok: true, verified: false, maskedPreview: "",
    });
    const cooling = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(cooling.payload.data.blocked, true);
    assert.ok(cooling.payload.data.cooldownRemainMs > 0);
    assert.ok(cooling.payload.data.cooldownRemainMs <= SUBMIT_COOLDOWN_MS);
  } finally { await h.cleanup(); }
});

test("submit-dry without remote/submit config is an honest 400 report_unconfigured", async () => {
  const { remote: _remote, ...noRemote } = CONFIG;
  const h = await makeHarness({ config: noRemote });
  try {
    const { status, payload } = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(status, 400);
    assert.equal(payload.error.code, "report_unconfigured");
    assert.equal(h.calls.length, 0);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* submit-confirm：闸门 / 冷却 429 / 去重 409 / run-now / 回读 / 审计          */
/* ========================================================================== */

test("submit-confirm gate rejects forged tokens before any external call", async () => {
  const h = await makeHarness();
  try {
    const wrong = await post(h.bridge, "/local/report/submit-confirm", { confirm: "tok-syn-forged" });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.payload.error.code, "confirm_stale");
    const missing = await post(h.bridge, "/local/report/submit-confirm", { confirm: 123 });
    assert.equal(missing.status, 400);
    assert.equal(missing.payload.error.code, "confirm_mismatch");
    assert.equal(h.calls.length, 0, "confirm 闸门先于任何外部调用");
    assert.equal(h.runNowCommands.length, 0);
  } finally { await h.cleanup(); }
});

test("submit-confirm triggers run-now once, verifies via outbox readback, and audits both phases", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const token = dry.payload.data.token as string;
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: token });
    assert.equal(status, 200);
    assert.equal(payload.data.executed, true);
    assert.equal(payload.data.runId, "run-syn-01");
    assert.equal(payload.data.sessionId, "ses-syn-01");
    assert.equal(payload.data.verified, true, "回读 outbox 看到新提交 → verified:true");
    assert.equal(payload.data.submittedN, 1);
    assert.equal(payload.data.audited, true);

    // run-now 远端命令为固定模板 + 正则校验后的配置值，且只触发一次
    assert.equal(h.runNowCommands.length, 1);
    assert.equal(
      h.runNowCommands[0],
      "~/.qoderwake/bin/qoderwake automation run-now --waker-id waker-syn-01 --automation-id tr_syn0002",
    );
    // ssh argv：BatchMode + ConnectTimeout + 私钥 + host（数组参数，无本地 shell）
    const sshCall = sshCalls(h, "run-now")[0];
    assert.deepEqual(sshCall.args.slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-i"]);
    assert.equal(sshCall.args[5], "/synthetic-home/.ssh/syn-key.pem", "~ 按注入 HOME 展开");
    assert.equal(sshCall.args[6], "root@ecs-syn.example");

    // 审计：run + verify 两行（append-only）
    const audits = await readAudits(h);
    assert.equal(audits.length, 2);
    assert.equal(audits[0].op, "submit");
    assert.equal(audits[0].phase, "run");
    assert.equal(audits[0].executed, true);
    assert.equal(audits[0].ok, true);
    assert.equal(audits[0].target, "tr_syn0002");
    assert.equal(audits[1].phase, "verify");
    assert.equal(audits[1].verified, true);

    // token 单次消费 + 冷却接力：立即重放 → confirm_stale；重新 dry+confirm → 429
    const replay = await post(h.bridge, "/local/report/submit-confirm", { confirm: token });
    assert.equal(replay.status, 409);
    assert.equal(replay.payload.error.code, "confirm_stale");
    const dry2 = await post(h.bridge, "/local/report/submit-dry", {});
    assert.ok(dry2.payload.data.cooldownRemainMs > 0);
    const cooled = await post(h.bridge, "/local/report/submit-confirm", { confirm: dry2.payload.data.token });
    assert.equal(cooled.status, 429);
    assert.equal(h.runNowCommands.length, 1, "全程只真实触发过一次");
  } finally { await h.cleanup(); }
});

test("submit-confirm readback that sees nothing yet is honestly verified:false with a wait note", async () => {
  const h = await makeHarness();
  try {
    h.runNowFillsOutbox = false; // 远端任务 1–3 分钟才完成：回读暂时看不到
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 200);
    assert.equal(payload.data.executed, true);
    assert.equal(payload.data.verified, false);
    assert.equal(payload.data.submittedN, 0);
    assert.match(payload.data.note, /1–3 分钟|暂未可见/);
    const audits = await readAudits(h);
    const verifyRow = audits.find((row) => row.phase === "verify");
    assert.equal(verifyRow?.verified, false);
  } finally { await h.cleanup(); }
});

test("submit-confirm within cooldown is an honest 429 and never re-sends", async () => {
  const h = await makeHarness();
  try {
    const store = createReportWriteStore(join(h.dir, "writes"));
    await store.appendWrite({
      at: new Date(FIXED_NOW - 60_000).toISOString(),
      op: "submit", phase: "run", target: "tr_syn0002",
      exitCode: 0, executed: true, ok: true, verified: false, maskedPreview: "",
    });
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(dry.payload.data.blocked, true);
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 429);
    assert.equal(payload.error.code, "cooldown");
    assert.match(payload.error.message, /秒/);
    assert.equal(h.runNowCommands.length, 0, "冷却内绝不重发");
    assert.equal(sshCalls(h, "run-now").length, 0);
  } finally { await h.cleanup(); }
});

test("submit-confirm re-checks outbox at execution time: already submitted → 409, no run-now", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const token = dry.payload.data.token as string;
    // dry 与 confirm 之间远端定时任务完成了今日提交
    h.outboxRows = [{ 标题: "合成日报（甲科技）", 日期: `${TODAY}T10:29:00+08:00` }];
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "already_submitted");
    assert.match(payload.error.message, /不重复发送/);
    assert.equal(h.runNowCommands.length, 0);
  } finally { await h.cleanup(); }
});

test("submit-confirm run-now refusal is 502 with audit, and the attempt still arms the cooldown", async () => {
  const h = await makeHarness();
  try {
    h.failSshRunNow = "refuse";
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 502);
    assert.equal(payload.error.code, "submit_failed");
    assert.match(payload.error.message, /远端拒绝/);
    const audits = await readAudits(h);
    const runRow = audits.find((row) => row.phase === "run");
    assert.ok(runRow);
    assert.equal(runRow?.executed, true);
    assert.equal(runRow?.ok, false);
    // 真实尝试过（哪怕失败）→ 冷却生效，防连点重发
    const nextDry = await post(h.bridge, "/local/report/submit-dry", {});
    assert.ok(nextDry.payload.data.cooldownRemainMs > 0);
    const nextConfirm = await post(h.bridge, "/local/report/submit-confirm", { confirm: nextDry.payload.data.token });
    assert.equal(nextConfirm.status, 429);
    assert.equal(h.runNowCommands.length, 1, "只允许真实触发过一次");
  } finally { await h.cleanup(); }
});

test("submit-confirm with missing ssh binary is 503 ssh_unavailable and does NOT arm the cooldown", async () => {
  const h = await makeHarness();
  try {
    h.failSshRunNow = "ENOENT";
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: dry.payload.data.token });
    assert.equal(status, 503);
    assert.equal(payload.error.code, "ssh_unavailable");
    const audits = await readAudits(h);
    const runRow = audits.find((row) => row.phase === "run");
    assert.equal(runRow?.executed, false, "ssh 不存在=没跑过，如实 executed:false");
    const nextDry = await post(h.bridge, "/local/report/submit-dry", {});
    assert.equal(nextDry.payload.data.cooldownRemainMs, 0, "没真实跑过不计冷却");
  } finally { await h.cleanup(); }
});

test("submit dry token expires after the TTL: confirm → 409 confirm_stale", async () => {
  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/submit-dry", {});
    const token = dry.payload.data.token as string;
    h.advance(DRY_TOKEN_TTL_MS + 1000);
    const { status, payload } = await post(h.bridge, "/local/report/submit-confirm", { confirm: token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "confirm_stale");
    assert.equal(h.runNowCommands.length, 0);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* GET /local/report/writes：审计尾 50 / 掩码                                  */
/* ========================================================================== */

test("GET writes returns the newest-first masked tail (≤50) with total", async () => {
  const h = await makeHarness();
  try {
    const store = createReportWriteStore(join(h.dir, "writes"));
    for (let i = 0; i < 55; i += 1) {
      await store.appendWrite({
        at: new Date(FIXED_NOW + i * 1000).toISOString(),
        op: "save", phase: "update", target: `rec-syn-${i}`,
        exitCode: 0, executed: true, ok: true, verified: true, maskedPreview: `预览${i}`,
      });
    }
    const response = await h.bridge.handle(req("/local/report/writes", "GET"));
    assert.equal(response?.status, 200);
    const payload = await response?.json() as Record<string, any>;
    assert.equal(payload.ok, true);
    assert.equal(payload.data.total, 55);
    assert.equal(payload.data.writes.length, WRITES_TAIL);
    assert.equal(payload.data.writes[0].target, "rec-syn-54", "最新在前");
  } finally { await h.cleanup(); }
});

test("audit preview masks secrets before truncation; jsonl never contains raw credentials", async () => {
  const masked = maskWritePreview("跟进甲科技 sk-ABCDEFGHIJKLMNOP1234567890 试点事项");
  assert.equal(masked.includes("sk-ABCDEFGHIJKLMNOP"), false);
  assert.match(masked, /已脱敏/);
  assert.ok(masked.length <= 25);

  const h = await makeHarness();
  try {
    const dry = await post(h.bridge, "/local/report/save-dry", {
      recordId: "rec-syn-01",
      cells: { topic: "泄漏检查 sk-ABCDEFGHIJKLMNOP1234567890 合成主题" },
    });
    await post(h.bridge, "/local/report/save-confirm", { confirm: dry.payload.data.token });
    const rawFile = await readFile(join(h.dir, "writes", "writes.jsonl"), "utf-8");
    assert.equal(rawFile.includes("sk-ABCDEFGHIJKLMNOP"), false, "审计文件绝不落明文凭据");
    assert.match(rawFile, /已脱敏/);
  } finally { await h.cleanup(); }
});

/* ========================================================================== */
/* 契约常量（donor 口径回归）                                                   */
/* ========================================================================== */

test("constants mirror the donor contract", () => {
  assert.deepEqual([...REPORT_WRITABLE_FIELDS], ["topic", "followup", "opportunity", "risk", "other"]);
  assert.equal(SUBMIT_COOLDOWN_MS, 5 * 60 * 1000);
  assert.equal(RECORD_UPDATE_TIMEOUT_MS, 60_000);
  assert.equal(WRITES_TAIL, 50);
});
