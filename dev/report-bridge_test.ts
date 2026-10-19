import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  beijingDate,
  beijingWeekday,
  createReportBridge,
  parseAutomationDetail,
  ReportBridgeError,
  type ReportBridge,
  type ReportState,
} from "./report-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import {
  DEFAULT_REPORT_CONFIG_PATH,
  sanitizeReportConfig,
  TRIGGER_PATTERN,
} from "./report/report-config.ts";
import {
  AUTOMATIONS_SSH_TIMEOUT_MS,
  DOC_READ_TIMEOUT_MS,
  DRIVE_LIST_TIMEOUT_MS,
  OUTBOX_LIST_TIMEOUT_MS,
  RATE_RETRY_SLEEP_MS,
  RECORD_QUERY_TIMEOUT_MS,
  redactText,
  type ReportCommandRunner,
} from "./report/report-dws.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：baseId/tableId/字段 ID/触发器/主机 全为合成值（bse-syn-report /
// fld-topic / tr_syn0001 / ecs-syn.example），企业只出现「甲科技/乙股份」等合成名；
// dws 与 ssh 全程 fake runner，真实 CLI/SSH 一个都不碰，绝不跑任何写命令。
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
  weekly: { folderId: "synfold000000000001", workspaceId: "synws00000000000001" },
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

const FIELD_IDS = ["fld-topic", "fld-dept", "fld-work", "fld-date", "fld-follow", "fld-opp", "fld-risk", "fld-other"];

const NODE_A = "synweek0000000000000a";
const NODE_B = "synweek0000000000000b";

function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: "rec-syn-01",
    cells: {
      "fld-topic": { text: "合成日报主题" },
      "fld-dept": "交付部",
      "fld-work": "正常",
      "fld-follow": ["跟进甲科技试点", "推进乙股份续约"],
      "fld-opp": "合成商机线索一条",
      "fld-risk": "",
      "fld-other": "",
      "fld-date": 1760000000000,
    },
    lastModifiedTime: "2026-10-20T09:00:00+08:00",
    ...overrides,
  };
}

function recordQueryReply(records: unknown[]): string {
  return JSON.stringify({ success: true, data: { records } });
}

const OUTBOX_ROWS = [
  { "标题": "合成日报（10-20 晚）", "日期": "2026-10-20T21:05:00+08:00" },
  { "标题": "合成日报（10-20 早）", "日期": "2026-10-20T09:00:00+08:00" },
  { "标题": "昨日日报（不应出现）", "日期": "2026-10-19T21:00:00+08:00" },
];

function driveListReply(): string {
  return JSON.stringify({
    success: true,
    data: {
      nodes: [
        {
          nodeId: NODE_B, name: "20261012-20261023 双周报（合成乙）", nodeType: "file",
          docUrl: "https://alidocs.dingtalk.com/i/nodes/doc-b?share=1",
          createTime: 1760000000000, updateTime: 1760010000000,
        },
        {
          nodeId: NODE_A, name: "20260928-20261009 双周报（合成甲）", nodeType: "file",
          updateTime: 1760000000000,
        },
        { nodeId: "fold00000000000000001", name: "子目录", nodeType: "folder" },
        { nodeId: "bad-id", name: "非法 id（应剔除）", nodeType: "file" },
      ],
    },
    hasMore: false,
  });
}

function detailBlock(trigger: string, name: string, overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    TRIGGER_ID: trigger,
    NAME: name,
    ENABLED: "true",
    KIND: "schedule",
    CONDITION_SUMMARY: "每个工作日（合成条件）",
    LAST_RUN_STATUS: "success",
    LAST_RUN_AT: "2026-10-19T19:00:03+08:00",
    NEXT_RUN_AT: "2026-10-20T19:00:00+08:00",
    ...overrides,
  };
  return Object.entries(base).map(([key, value]) => `${key}: ${value}`).join("\n")
    + "\nTASK_DESCRIPTION: 提示词正文（不应进入解析）\nLAST_RUN_STATUS: forged-after-description";
}

function automationsStdout(): string {
  // 真实远端形状（评审 P1-1）：stdout 只含 echo 回显的标记本身，绝不含 shell 模板
  // `; echo "..."`；fixture 若用命令模板拼接会把 split 缺陷锁死成恒真。
  return [
    detailBlock("tr_syn0001", "日报初稿（合成）"),
    detailBlock("tr_syn0002", "日报提交（合成）", { LAST_RUN_STATUS: "running", NEXT_RUN_AT: "2026-10-20T23:15:00+08:00" }),
    detailBlock("tr_syn0003", "双周报（合成）", { LAST_RUN_STATUS: "", LAST_RUN_AT: "", NEXT_RUN_AT: "2026-10-23T17:00:00+08:00" }),
  ].join("\n=====SA=====\n") + "\n";
}

interface CliReply {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface Handlers {
  readonly recordQuery?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly outboxList?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly driveList?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly docRead?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly ssh?: (args: readonly string[], timeoutMs: number) => CliReply;
  readonly onDws?: (args: readonly string[], timeoutMs: number) => void;
  readonly onSsh?: (args: readonly string[], timeoutMs: number) => void;
}

function fakeRunner(handlers: Handlers = {}): ReportCommandRunner {
  return async (file, args, options) => {
    if (file === "ssh") {
      handlers.onSsh?.(args, options.timeoutMs);
      return handlers.ssh ? handlers.ssh(args, options.timeoutMs) : { code: 0, stdout: "", stderr: "" };
    }
    // 桥会把解析后的完整 dws 路径传入（QODERWAKE_DWS_CLI_PATH → DWS_BIN → ~/.qoderwork → PATH），
    // 按 basename 匹配 dws 命令，与真实执行契约一致。
    const bin = file.split(/[\\/]/).pop();
    if (bin !== "dws") return { code: "ENOENT", stdout: "", stderr: "" };
    handlers.onDws?.(args, options.timeoutMs);
    const ok = (reply: unknown): CliReply => ({ code: 0, stdout: JSON.stringify(reply) });
    if (args.includes("record") && args.includes("query")) {
      return handlers.recordQuery ? handlers.recordQuery(args, options.timeoutMs) : ok({ success: true, data: { records: [] } });
    }
    if (args.includes("outbox") && args.includes("list")) {
      return handlers.outboxList ? handlers.outboxList(args, options.timeoutMs) : ok({ success: true, result: [] });
    }
    if (args.includes("drive") && args.includes("list")) {
      return handlers.driveList ? handlers.driveList(args, options.timeoutMs) : ok({ success: true, data: { nodes: [] } });
    }
    if (args.includes("doc") && args.includes("read")) {
      return handlers.docRead ? handlers.docRead(args, options.timeoutMs) : ok({ success: true, data: { markdown: "" } });
    }
    return { code: "ENOENT", stdout: "", stderr: "" };
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "report-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface BridgeOptions {
  readonly config?: unknown;
  readonly omitConfig?: boolean;
  readonly run?: ReportCommandRunner;
}

interface SleepRecorder {
  readonly calls: number[];
  readonly impl: (ms: number) => Promise<void>;
}

function sleepRecorder(): SleepRecorder {
  const calls: number[] = [];
  return { calls, impl: async (ms: number) => { calls.push(ms); } };
}

function makeBridge(dir: string, options: BridgeOptions = {}): { bridge: ReportBridge; sleep: SleepRecorder } {
  const sleep = sleepRecorder();
  const bridge = createReportBridge({
    configPath: join(dir, "report.json"),
    run: options.run ?? fakeRunner(),
    env: { HOME: "/home/syn" },
    existsSync: () => true,
    now: () => FIXED_NOW,
    sleep: sleep.impl,
  });
  return { bridge, sleep };
}

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await writeFile(join(dir, "report.json"), JSON.stringify(config), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. 配置与北京日期边界
// ---------------------------------------------------------------------------

test("default config path resolves to the project-root .local-cache/report.json", () => {
  assert.match(DEFAULT_REPORT_CONFIG_PATH, /[\\/]\.local-cache[\\/]report\.json$/);
  assert.ok(!DEFAULT_REPORT_CONFIG_PATH.includes(join("dev", ".local-cache")), "must not resolve under dev/");
});

test("missing or corrupt config answers configured:false and never throws on state", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = makeBridge(dir, { omitConfig: true });
    const missing = await bridge.state();
    assert.equal(missing.configured, false);
    assert.match(missing.configNote, /report\.json/);
    assert.match(missing.configNote, /dws auth login/);
    assert.equal(missing.record, null);
    assert.equal(missing.today, TODAY, "北京日期仍如实给出");

    await writeFile(join(dir, "report.json"), "{ 不是 JSON", "utf-8");
    const corrupt = await bridge.state();
    assert.equal(corrupt.configured, false);
    await assert.rejects(() => bridge.weeklies(), (error: unknown) => error instanceof ReportBridgeError
      && error.code === "report_unconfigured");
    await assert.rejects(() => bridge.automations(), (error: unknown) => error instanceof ReportBridgeError
      && error.code === "report_unconfigured");
  });
});

test("config sanitize degrades each section independently and keeps valid sections", () => {
  const full = sanitizeReportConfig(CONFIG);
  assert.equal(full.daily?.baseId, "bse-syn-report");
  assert.equal(full.daily?.templateName, "工作日报（合成模板）");
  assert.equal(full.weekly?.folderId, "synfold000000000001");
  assert.equal(full.remote?.jobs.length, 3);

  const partial = sanitizeReportConfig({
    baseId: "bse-syn-report",
    tableId: "tbl-syn-daily",
    fields: CONFIG.fields,
    weekly: { folderId: "短", workspaceId: "synws00000000000001" },
    remote: { host: "bad host", key: "", bin: "", wakerId: "x" },
  });
  assert.ok(partial.daily, "daily 段合法时保留");
  assert.equal(partial.weekly, null);
  assert.match(partial.weeklyNote, /weekly\.folderId/);
  assert.equal(partial.remote, null);
  assert.match(partial.remoteNote, /remote 段/);

  const missingField = sanitizeReportConfig({ ...CONFIG, fields: { ...CONFIG.fields, date: { id: "" } } });
  assert.equal(missingField.daily, null);
  assert.match(missingField.dailyNote, /date/);

  assert.ok(TRIGGER_PATTERN.test("tr_syn0001"));
  assert.ok(!TRIGGER_PATTERN.test("run-now-tr_syn0001"), "触发器形态必须 tr_ 前缀，杜绝把触发动作当配置");
});

test("beijing calendar day converts at the fixed UTC+8 boundary (Asia/Shanghai)", () => {
  // 23:59:59 北京 ↔ 15:59:59Z：仍是当日；16:00:00Z 起翻到次日。
  assert.equal(beijingDate(Date.parse("2026-10-20T15:59:59.000Z")), "2026-10-20");
  assert.equal(beijingWeekday(Date.parse("2026-10-20T15:59:59.000Z")), 2);
  assert.equal(beijingDate(Date.parse("2026-10-20T16:00:00.000Z")), "2026-10-21");
  assert.equal(beijingWeekday(Date.parse("2026-10-20T16:00:00.000Z")), 3);
  assert.equal(beijingDate(Date.parse("2026-01-01T16:30:00.000Z")), "2026-01-02", "跨年翻日");
  assert.equal(beijingDate(FIXED_NOW), TODAY);
});

// ---------------------------------------------------------------------------
// 2. 当日草稿 + outbox（state 只读查询）
// ---------------------------------------------------------------------------

test("state queries today's draft with the exact read-only reference argv", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const dwsCalls: { args: readonly string[]; timeoutMs: number }[] = [];
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({ code: 0, stdout: recordQueryReply([recordFixture()]) }),
        outboxList: () => ({ code: 0, stdout: JSON.stringify({ success: true, result: OUTBOX_ROWS }) }),
        onDws: (args, timeoutMs) => dwsCalls.push({ args, timeoutMs }),
      }),
    });
    const state = await bridge.state();
    assert.equal(state.configured, true);
    assert.equal(state.today, TODAY);
    assert.equal(state.weekday, 2);
    assert.equal(state.dws.ok, true);

    const query = dwsCalls.find((call) => call.args.includes("record"));
    assert.ok(query, "必须发起 aitable record query");
    assert.equal(query.timeoutMs, RECORD_QUERY_TIMEOUT_MS);
    assert.deepEqual([...query.args], [
      "aitable", "record", "query",
      "--base-id", "bse-syn-report",
      "--table-id", "tbl-syn-daily",
      "--filters", JSON.stringify({
        operator: "and",
        operands: [{ operator: "date_eq", operands: ["fld-date", TODAY] }],
      }),
      "--field-ids", FIELD_IDS.join(","),
      "--format", "json",
    ]);

    for (const call of dwsCalls) {
      for (const verb of ["update", "create", "delete", "chat", "+dm"]) {
        assert.equal(call.args.includes(verb), false, `只读红线：argv 不得出现 ${verb}`);
      }
    }
  });
});

test("record view maps cells via the reference cellText and picks the latest record", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({
          code: 0,
          stdout: recordQueryReply([
            recordFixture({ recordId: "rec-syn-old", lastModifiedTime: "2026-10-20T09:00:00+08:00" }),
            recordFixture({
              recordId: "rec-syn-new",
              lastModifiedTime: "2026-10-20T10:30:00+08:00",
              cells: { "fld-topic": "合成日报（最新）", "fld-follow": [{ text: "对象文本取 text" }] },
            }),
          ]),
        }),
      }),
    });
    const state = await bridge.state();
    assert.ok(state.record);
    assert.equal(state.record.recordId, "rec-syn-new", "取 lastModifiedTime 最新一条");
    assert.equal(state.record.topic, "合成日报（最新）");
    assert.equal(state.record.followup, "对象文本取 text");
    assert.equal(state.record.modifiedAt, "2026-10-20T10:30:00+08:00");
  });
});

test("empty today falls back to the honest record note", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const { bridge } = makeBridge(dir);
    const state = await bridge.state();
    assert.equal(state.record, null);
    assert.match(state.recordNote, /今日尚无记录/);
    assert.match(state.recordNote, /19:00/);
  });
});

test("outbox list keeps only today's submissions with the reference argv and caps at five", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    let outboxArgs: readonly string[] = [];
    let outboxTimeout = 0;
    const manyRows = Array.from({ length: 8 }, (_, index) => ({
      "标题": `合成提交 ${index + 1}`,
      "日期": `2026-10-20T1${index}:0${index % 10}:00+08:00`,
    }));
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        outboxList: (args, timeoutMs) => {
          outboxArgs = args;
          outboxTimeout = timeoutMs;
          return { code: 0, stdout: JSON.stringify({ success: true, result: [...OUTBOX_ROWS, ...manyRows] }) };
        },
      }),
    });
    const state = await bridge.state();
    assert.deepEqual([...outboxArgs], [
      "report", "outbox", "list",
      "--cursor", "0", "--size", "20",
      "--start", `${TODAY}T00:00:00+08:00`,
      "--end", `${TODAY}T23:59:59+08:00`,
      "--template-name", "工作日报（合成模板）",
      "--format", "json",
    ]);
    assert.equal(outboxTimeout, OUTBOX_LIST_TIMEOUT_MS);
    assert.ok(state.submitted);
    assert.equal(state.submitted.n, 10, "昨日行被过滤，只数今日");
    assert.equal(state.submitted.items.length, 5, "照静态版最多回 5 条");
    assert.equal(state.submitted.items[0].title, "合成日报（10-20 晚）", "按时间倒序，21:05 居首");
    assert.equal(state.submitted.items[0].time, new Date(Date.parse("2026-10-20T21:05:00+08:00")).toISOString());
    const late = makeBridge(dir, {
      run: fakeRunner({
        outboxList: () => ({
          code: 0,
          stdout: JSON.stringify({ success: true, data: { result: OUTBOX_ROWS.filter((row) => String(row["日期"]).startsWith("2026-10-19")) } }),
        }),
      }),
    });
    const yesterday = await late.bridge.state();
    assert.equal(yesterday.submitted?.n, 0, "昨日提交不计入今日状态（data.result 形态同样解析）");
  });
});

test("dws failures degrade per-section: need_auth / no_enterprise / dws-error with fix hints", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const auth = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({ code: 0, stdout: JSON.stringify({ success: false, error: { message: "not_authenticated: 请先 dws auth login" } }) }),
      }),
    });
    const authState = await auth.bridge.state();
    assert.equal(authState.dws.ok, false);
    assert.equal(authState.dws.code, "need_auth");
    assert.match(authState.dws.fix, /dws auth login/);
    assert.ok(authState.submitted, "单段失败不拖垮 outbox 段");

    const enterprise = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({ code: 0, stdout: JSON.stringify({ success: true, error: { message: "ENTERPRISE_NOT_AUTHORIZED" } }) }),
      }),
    });
    assert.equal((await enterprise.bridge.state()).dws.code, "no_enterprise");

    const generic = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({ code: 0, stdout: JSON.stringify({ success: false, error: { message: "内部错误" } }) }),
      }),
    });
    assert.equal((await generic.bridge.state()).dws.code, "dws-error");
  });
});

test("rate-limited dws-error retries once after the reference sleep then succeeds", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    let calls = 0;
    const { bridge, sleep } = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => {
          calls += 1;
          if (calls === 1) {
            return { code: 0, stdout: JSON.stringify({ success: false, error: { message: "business error: success=false 请求被限流" } }) };
          }
          return { code: 0, stdout: recordQueryReply([recordFixture()]) };
        },
      }),
    });
    const state = await bridge.state();
    assert.equal(calls, 2, "限流形态隔一个间隔重试一次");
    assert.deepEqual(sleep.calls, [RATE_RETRY_SLEEP_MS]);
    assert.ok(state.record, "重试成功后今日记录可读");
  });
});

// ---------------------------------------------------------------------------
// 3. 双周报（目录 + 正文，只读）
// ---------------------------------------------------------------------------

test("weeklies lists the drive folder read-only, sorts by name desc and caches by TTL", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    let driveCalls = 0;
    let driveTimeout = 0;
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        driveList: (args, timeoutMs) => {
          driveCalls += 1;
          driveTimeout = timeoutMs;
          return { code: 0, stdout: driveListReply() };
        },
      }),
    });
    const list = await bridge.weeklies();
    assert.equal(driveTimeout, DRIVE_LIST_TIMEOUT_MS);
    assert.equal(list.folderUrl, "https://alidocs.dingtalk.com/i/nodes/synfold000000000001");
    assert.deepEqual(list.items.map((item) => item.nodeId), [NODE_B, NODE_A], "文件名倒序，目录/非法 id 剔除");
    assert.equal(list.items[0].url, "https://alidocs.dingtalk.com/i/nodes/doc-b", "docUrl 去掉查询串");
    assert.equal(list.items[1].url, `https://alidocs.dingtalk.com/i/nodes/${NODE_A}`, "无 docUrl 回落标准链接");
    assert.equal(list.items[0].updated, new Date(1760010000000).toISOString());
    assert.equal(list.hasMore, false);

    await bridge.weeklies();
    assert.equal(driveCalls, 1, "5 分钟 TTL 内复用缓存");
    await bridge.weeklies({ fresh: true });
    assert.equal(driveCalls, 2, "?fresh=1 绕过缓存");
  });
});

test("weekly doc requires the directory whitelist and truncates oversized markdown", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    let docArgs: readonly string[] = [];
    let docTimeout = 0;
    let docCalls = 0;
    const bigMarkdown = "# 合成双周报\r\n\r\n" + "合成段落。".repeat(45_000);
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        driveList: () => ({ code: 0, stdout: driveListReply() }),
        docRead: (args, timeoutMs) => {
          docCalls += 1;
          docArgs = args;
          docTimeout = timeoutMs;
          return { code: 0, stdout: JSON.stringify({ success: true, data: { markdown: bigMarkdown } }) };
        },
      }),
    });

    await assert.rejects(
      () => bridge.weekly("short-id"),
      (error: unknown) => error instanceof ReportBridgeError && error.code === "report_unconfigured"
        && /node 参数不合法/.test(error.message),
    );
    await assert.rejects(
      () => bridge.weekly("outsider00000000000001"),
      (error: unknown) => error instanceof ReportBridgeError && error.code === "report_unconfigured"
        && /不在双周报目录/.test(error.message),
      "目录白名单外的 node 一律拒绝",
    );

    const doc = await bridge.weekly(NODE_B);
    assert.deepEqual([...docArgs], ["doc", "read", "--node", NODE_B, "--format", "json"]);
    assert.equal(docTimeout, DOC_READ_TIMEOUT_MS);
    assert.equal(doc.name, "20261012-20261023 双周报（合成乙）");
    assert.equal(doc.truncated, true);
    assert.equal(doc.markdown.length, 200 * 1024, "正文按静态版 MD_MAX 截断");
    assert.equal(doc.markdown.includes("\r"), false, "\\r\\n 先归一为 \\n");
    const normalized = bigMarkdown.replace(/\r\n?/g, "\n").slice(0, 200 * 1024);
    assert.equal(doc.contentHash, createHash("sha256").update(normalized, "utf-8").digest("hex"));
    assert.equal(docCalls, 1);

    await bridge.weekly(NODE_B, { fresh: true });
    assert.equal(docCalls, 2, "fresh 绕过正文缓存");
    await bridge.weekly(NODE_B);
    assert.equal(docCalls, 2, "10 分钟 TTL 内复用正文缓存");
  });
});

// ---------------------------------------------------------------------------
// 4. QoderWake 定时任务（SSH 只读状态）
// ---------------------------------------------------------------------------

test("automations read QoderWake status over ssh with the fixed template and never run-now", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const sshArgsHistory: { args: readonly string[]; timeoutMs: number }[] = [];
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        ssh: () => ({ code: 0, stdout: automationsStdout() }),
        onSsh: (args, timeoutMs) => sshArgsHistory.push({ args, timeoutMs }),
      }),
    });
    const autos = await bridge.automations();
    assert.equal(autos.configured, true);
    assert.equal(sshArgsHistory.length, 1);
    const { args, timeoutMs } = sshArgsHistory[0];
    assert.equal(timeoutMs, AUTOMATIONS_SSH_TIMEOUT_MS);
    assert.equal(args[0], "-o");
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("ConnectTimeout=8"));
    assert.equal(args[args.length - 2], "root@ecs-syn.example");
    assert.equal(args[args.length - 3], "/home/syn/.ssh/syn-key.pem", "~ 按注入 HOME 展开");
    const remote = args[args.length - 1];
    for (const trigger of ["tr_syn0001", "tr_syn0002", "tr_syn0003"]) {
      assert.ok(remote.includes(`automation detail --waker-id waker-syn-01 --automation-id ${trigger} --runs-limit 1`));
    }
    assert.ok(remote.includes('=====SA====='), "多任务块以固定分隔符拼接");
    assert.ok(!remote.includes("run-now"), "只读红线：绝不出现触发类远端动作");

    assert.equal(autos.jobs.length, 3);
    assert.equal(autos.jobs[0].key, "draft");
    assert.equal(autos.jobs[0].name, "日报初稿（合成）");
    assert.equal(autos.jobs[0].enabled, true);
    assert.equal(autos.jobs[0].lastStatus, "success");
    assert.equal(autos.jobs[0].nextAt, "2026-10-20T19:00:00+08:00");
    assert.equal(autos.jobs[1].lastStatus, "running");
    assert.equal(autos.jobs[2].lastStatus, "", "TASK_DESCRIPTION 之后的内容不参与解析");
    assert.equal(autos.jobs[2].nextAt, "2026-10-23T17:00:00+08:00");

    await bridge.automations();
    assert.equal(sshArgsHistory.length, 1, "60s TTL 内复用缓存");
    await bridge.automations({ fresh: true });
    assert.equal(sshArgsHistory.length, 2, "?fresh=1 绕过缓存");
  });
});

test("parseAutomationDetail keeps only reference keys and stops at TASK_DESCRIPTION", () => {
  const parsed = parseAutomationDetail(detailBlock("tr_syn0009", "合成任务"));
  assert.deepEqual(Object.keys(parsed).sort(), [
    "CONDITION_SUMMARY", "ENABLED", "KIND", "LAST_RUN_AT", "LAST_RUN_STATUS", "NAME", "NEXT_RUN_AT", "TRIGGER_ID",
  ].sort());
  assert.equal(parsed.LAST_RUN_STATUS, "success", "TASK_DESCRIPTION 之后的伪造 KEY 行不进入解析");
});

test("remote section missing or ssh failure answers honestly without leaking secrets", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, { ...CONFIG, remote: undefined });
    const { bridge } = makeBridge(dir);
    await assert.rejects(
      () => bridge.automations(),
      (error: unknown) => error instanceof ReportBridgeError && error.code === "report_unconfigured"
        && /remote 段/.test(error.message),
    );

    await writeConfig(dir, {
      ...CONFIG,
      remote: { ...CONFIG.remote, jobs: { draft: { trigger: "not-tr_1", name: "坏触发器" } } },
    });
    const badTrigger = makeBridge(dir);
    await assert.rejects(() => badTrigger.bridge.automations(), (error: unknown) => error instanceof ReportBridgeError
      && error.code === "report_unconfigured" && /触发器/.test(error.message));

    await writeConfig(dir, CONFIG);
    const sshFail = makeBridge(dir, {
      run: fakeRunner({
        ssh: () => ({ code: 255, stdout: "", stderr: "ssh: connect failed (key sk-abcdef1234567890abcd in log)" }),
      }),
    });
    await assert.rejects(
      () => sshFail.bridge.automations(),
      (error: unknown) => {
        assert.ok(error instanceof ReportBridgeError);
        assert.equal(error.code, "report_unavailable");
        assert.equal(/sk-abcdef/.test(error.message), false, "错误消息不得携带凭据形态文本");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 哨兵：敌意凭据形态不得进入任何透出文本
// ---------------------------------------------------------------------------

test("sentinel: hostile dws output never leaks credential-shaped text through the bridge", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const { bridge } = makeBridge(dir, {
      run: fakeRunner({
        recordQuery: () => ({
          code: 1,
          stdout: "",
          stderr: "dws: auth expired access_token=sk-sentinel0123456789 LTAI9999abcd0123 token=supersecretvalue1",
        }),
      }),
    });
    // state 不抛错：dws 失败降级到 dws 段（照静态版单段失败语义）。
    const state = await bridge.state();
    const serialized = JSON.stringify(state);
    assert.equal(state.dws.ok, false);
    assert.equal(serialized.includes("sk-sentinel0123456789"), false);
    assert.equal(serialized.includes("LTAI9999abcd0123"), false);
    assert.equal(serialized.includes("supersecretvalue1"), false);
    assert.ok(state.dws.note.length > 0, "失败信息如实存在但已脱敏");

    assert.equal(redactText("token=abc123 sk-xyz-LONGTOKENVALUE99 LTAI00011122334455").includes("abc123"), false);

    // 评审 P2-1 回归：词边界 + 长度下限——正常词不得被误吞，真凭据形态仍抹除。
    const normal = "日报 task-list 跟进 · risk-control 例会 · sklearn 模型上线 · flask-app 部署 · taskrunner 脚本";
    assert.equal(redactText(normal), normal, "无词边界的旧实现会把 task-/risk-/sk- 误当凭据");
    assert.equal(redactText("sk-proj-abcdefghijklmnop1234"), "[已脱敏]");
    assert.equal(redactText("Bearer sk-short1"), "Bearer sk-short1", "sk- 后不足 16 位不是裸密钥");
  });
});

// ---------------------------------------------------------------------------
// 6. 路由端点（GET 只读 + 错误码映射 + 405/502 兜底）
// ---------------------------------------------------------------------------

const TRUSTED = { host: "127.0.0.1:8000" };

function request(path: string, method: "GET" | "POST"): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method, headers: TRUSTED });
}

test("router serves GET /local/report/* read-only, maps codes, POST falls to 405", async () => {
  await withTempDir(async (dir) => {
    await writeConfig(dir, CONFIG);
    const bridge = createReportBridge({
      configPath: join(dir, "report.json"),
      run: fakeRunner({
        recordQuery: () => ({ code: 0, stdout: recordQueryReply([recordFixture()]) }),
        outboxList: () => ({ code: 0, stdout: JSON.stringify({ success: true, result: OUTBOX_ROWS }) }),
        driveList: () => ({ code: 0, stdout: driveListReply() }),
        docRead: () => ({ code: 0, stdout: JSON.stringify({ success: true, data: { markdown: "# 合成正文" } }) }),
        ssh: () => ({ code: 0, stdout: automationsStdout() }),
      }),
      env: { HOME: "/home/syn" },
      existsSync: () => true,
      now: () => FIXED_NOW,
      sleep: async () => {},
    });
    const router = createLocalRouter({ port: 8000, reportBridge: bridge });

    const state = await router(request("/local/report/state", "GET"));
    assert.equal(state.status, 200);
    const stateBody = await state.json() as { ok: boolean; data: ReportState };
    assert.equal(stateBody.ok, true);
    assert.equal(stateBody.data.configured, true);
    assert.equal(stateBody.data.record?.recordId, "rec-syn-01");

    const autos = await router(request("/local/report/automations", "GET"));
    assert.equal(autos.status, 200);
    assert.equal(((await autos.json()) as { data: { jobs: unknown[] } }).data.jobs.length, 3);

    const weeklies = await router(request("/local/report/weeklies", "GET"));
    assert.equal(weeklies.status, 200);
    assert.equal(((await weeklies.json()) as { data: { items: unknown[] } }).data.items.length, 2);

    const doc = await router(request(`/local/report/weekly?node=${NODE_B}`, "GET"));
    assert.equal(doc.status, 200);
    assert.equal(((await doc.json()) as { data: { nodeId: string } }).data.nodeId, NODE_B);

    const badNode = await router(request("/local/report/weekly?node=short", "GET"));
    assert.equal(badNode.status, 400);
    assert.equal(((await badNode.json()) as { error: string }).error, "report_unconfigured");

    const notAllowed = await router(request("/local/report/state", "POST"));
    assert.equal(notAllowed.status, 405, "写动作不存在：POST 由既有 method_not_allowed 兜底");
    const notAllowedWeekly = await router(request("/local/report/weekly", "POST"));
    assert.equal(notAllowedWeekly.status, 405);

    const noWeekly = createReportBridge({
      configPath: join(dir, "report.json"),
      run: fakeRunner(),
      env: { HOME: "/home/syn" },
      existsSync: () => true,
      now: () => FIXED_NOW,
      sleep: async () => {},
    });
    await writeFile(join(dir, "report-noweekly.json"), JSON.stringify({ ...CONFIG, weekly: undefined }), "utf-8");
    const noWeeklyRouter = createLocalRouter({
      port: 8000,
      reportBridge: createReportBridge({
        configPath: join(dir, "report-noweekly.json"),
        run: fakeRunner(),
        env: { HOME: "/home/syn" },
        existsSync: () => true,
        now: () => FIXED_NOW,
        sleep: async () => {},
      }),
    });
    void noWeekly;
    const unconfigured = await noWeeklyRouter(request("/local/report/weeklies", "GET"));
    assert.equal(unconfigured.status, 400);
    assert.equal(((await unconfigured.json()) as { error: string }).error, "report_unconfigured");

    const brokenRouter = createLocalRouter({
      port: 8000,
      reportBridge: {
        state: async () => { throw new Error("boom"); },
        automations: async () => { throw new Error("boom"); },
        weeklies: async () => { throw new Error("boom"); },
        weekly: async () => { throw new Error("boom"); },
      },
    });
    const upstream = await brokenRouter(request("/local/report/state", "GET"));
    assert.equal(upstream.status, 502);
    assert.equal(((await upstream.json()) as { error: string }).error, "report_unavailable", "未知异常兜底 502（F5 P3-1）");
  });
});
