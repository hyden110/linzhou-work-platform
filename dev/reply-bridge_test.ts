import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNotifyBridge, type NotifyBridge } from "./notify-bridge.ts";
import {
  beijingDayKey,
  buildSuggestPrompt,
  createReplyBridge,
  DEFAULT_REPLY_DIR,
  matchCustomerProfile,
  parseEngineJson,
  ReplyBridgeError,
  resolveEngineBin,
  REPLY_ENGINE_ARGS,
  REPLY_ENGINE_TIMEOUT_MS,
  REPLY_MAX_TEXT_CHARS,
  REPLY_QUOTA_PER_CONV_DAY,
  REPLY_QUOTA_PER_DAY,
  REPLY_ROUTES,
  REPLY_SEND_TIMEOUT_MS,
  shapeSuggestion,
  type ReplyBridge,
  type ReplyBridgeOptions,
  type ReplyCommandResult,
  type ReplyCommandRunner,
} from "./reply-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：客户/群名/会话 id 只用「甲科技（合成）/cidSynth*」等合成值；
// 引擎与 dws 一律注入 stub runner——测试绝不真发、绝不起真子进程；
// 存储全部落临时目录（.local-cache 零接触）。FIXED_NOW = 2026-10-20T02:30:00Z（北京日键 2026-10-20）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");
const SYNTH_DAY = "2026-10-20";
const GROUP = "cidSynthGroup01";
const DT_ID = "syn-dt-001";
const WX_ID = "syn-wx-001";
const LEAD_ID = "syn-lead-001";
const NOGROUP_ID = "syn-dt-nogroup";
const SUMMARY = "客户询问本月账单周期（合成）。";
const ENGINE_BIN = "/synthetic/bin/qodercli";
const DWS_BIN = "/synthetic/bin/dws";

interface RunnerCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: { readonly timeoutMs: number; readonly stdin?: string };
}

function stubRunner(result: ReplyCommandResult): { calls: RunnerCall[]; run: ReplyCommandRunner } {
  const calls: RunnerCall[] = [];
  const run: ReplyCommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return result;
  };
  return { calls, run };
}

const engineOk = (payload: unknown): ReplyCommandResult => ({
  code: 0,
  stdout: `qodercli 告警行（合成）\n${JSON.stringify(payload)}\n完成`,
  stderr: "",
});

const SUGGEST_PAYLOAD = {
  needReply: true,
  text: "已确认本月账单周期为 25 日出账（合成），如有出入我再核对。",
  tone: "平实",
  reason: "客户询问账单周期，需要明确答复",
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reply-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function crmSnapshotFile(dir: string): string {
  return join(dir, "crm-snapshot.json");
}

async function writeCrmSnapshot(dir: string): Promise<void> {
  await writeFile(crmSnapshotFile(dir), JSON.stringify({
    schemaVersion: 1,
    customers: [
      { cid: "91001", name: "甲科技（合成）", industry: "软件（合成）", area: "浙江省/杭州市", level: "GC7", lastMonthGaap: 123.45 },
      { cid: "91002", name: "乙股份（合成）", industry: "制造（合成）", area: "江苏省/南京市", level: "GC5" },
    ],
  }), "utf-8");
}

interface Harness {
  readonly bridge: ReplyBridge;
  readonly notify: NotifyBridge;
  readonly engine: { calls: RunnerCall[]; run: ReplyCommandRunner };
  readonly dws: { calls: RunnerCall[]; run: ReplyCommandRunner };
  readonly dir: string;
  readonly replyDir: string;
}

async function makeHarness(
  dir: string,
  overrides: Partial<ReplyBridgeOptions> = {},
  engineResult: ReplyCommandResult = engineOk(SUGGEST_PAYLOAD),
  dwsResult: ReplyCommandResult = { code: 0, stdout: '{"success":true}', stderr: "" },
): Promise<Harness> {
  const replyDir = join(dir, "reply");
  const notify = createNotifyBridge({ inboxPath: join(dir, "inbox.json"), now: () => FIXED_NOW });
  const engine = stubRunner(engineResult);
  const dws = stubRunner(dwsResult);
  const bridge = createReplyBridge({
    notifyBridge: notify,
    dir: replyDir,
    crmSnapshotPath: crmSnapshotFile(dir),
    now: () => FIXED_NOW,
    env: { HOME: join(dir, "home") },
    existsSync: (path) => path === ENGINE_BIN || path === DWS_BIN,
    engineBin: ENGINE_BIN,
    dwsBin: DWS_BIN,
    engineRunner: engine.run,
    dwsRunner: dws.run,
    ...overrides,
  });
  return { bridge, notify, engine, dws, dir, replyDir };
}

async function seedInbox(h: Harness): Promise<void> {
  const ingest = h.notify.ingest;
  assert.ok(typeof ingest === "function");
  await ingest({
    id: DT_ID, kind: "dingtalk", title: "甲科技（合成）服务群新消息",
    summary: SUMMARY, source: "dingtalk", link: `https://example.com/dt?cid=${GROUP}`,
    at: "2026-10-20T01:00:00.000Z",
  });
  await ingest({
    id: NOGROUP_ID, kind: "dingtalk", title: "乙股份（合成）钉群新消息",
    summary: "群里没有会话 id 的合成消息。", source: "dingtalk", link: "",
    at: "2026-10-20T01:30:00.000Z",
  });
  await ingest({
    id: WX_ID, kind: "cust", title: "微信客户消息（合成）",
    summary: "微信侧合成消息。", source: "wechat", link: "",
    at: "2026-10-20T01:10:00.000Z",
  });
  await ingest({
    id: LEAD_ID, kind: "lead", title: "合成雷达线索",
    summary: "未知源合成消息。", source: "合成雷达", link: "",
    at: "2026-10-20T01:20:00.000Z",
  });
}

function request(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method,
    headers: { host: "127.0.0.1:8000", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

async function writeQuota(dir: string, quota: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "quota.json"), JSON.stringify(quota), "utf-8");
}

async function readAuditLines(dir: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(join(dir, "sends.jsonl"), "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1. 常量与路由表（任务口径逐条对齐）
// ---------------------------------------------------------------------------

test("route table constant matches the five contracted routes", () => {
  assert.deepEqual(REPLY_ROUTES.map(({ method, path }) => `${method} ${path}`), [
    "GET /local/reply/candidates",
    "GET /local/reply/history",
    "POST /local/reply/suggest",
    "POST /local/reply/send",
    "GET /local/reply/sends",
  ]);
  assert.equal(REPLY_QUOTA_PER_CONV_DAY, 6);
  assert.equal(REPLY_QUOTA_PER_DAY, 60);
  assert.equal(REPLY_MAX_TEXT_CHARS, 600);
});

test("default reply dir resolves under .local-cache/reply", () => {
  assert.match(DEFAULT_REPLY_DIR, /[\\/]\.local-cache[\\/]reply$/);
  assert.ok(!DEFAULT_REPLY_DIR.includes(join("dev", ".local-cache")), "must not resolve under dev/");
  assert.equal(beijingDayKey(FIXED_NOW), SYNTH_DAY, "UTC 18:30 后仍算北京当日");
});

// ---------------------------------------------------------------------------
// 2. 候选派生（notify items + 发送审计 → 待回复清单）
// ---------------------------------------------------------------------------

test("candidates derive dingtalk-only rows with quota/engine views", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);
    const view = await h.bridge.candidates();
    assert.deepEqual(view.items.map((row) => row.id), [NOGROUP_ID, DT_ID], "钉钉源、时间倒序；微信/未知源不进候选");
    assert.equal(view.items.every((row) => row.channel === "dingtalk"), true);
    assert.equal(view.items.find((row) => row.id === DT_ID)?.group, GROUP);
    assert.deepEqual(view.quota, { day: SYNTH_DAY, used: 0, limit: 60, perConvLimit: 6 });
    assert.equal(view.engine.localOnly, true, "对前端恒声明：该能力永不走云端");
    assert.ok(typeof view.engine.available === "boolean");
  });
});

test("candidates mark replied from send audit and drop read+replied items", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    await h.bridge.send({ id: DT_ID, text: "已回复（合成）", confirm: DT_ID });
    let view = await h.bridge.candidates();
    assert.equal(view.items.find((row) => row.id === DT_ID)?.replied, true, "未读+已回复仍留在清单（replied 如实标）");
    await h.notify.markRead({ ids: [DT_ID] });
    view = await h.bridge.candidates();
    assert.equal(view.items.some((row) => row.id === DT_ID), false, "已读且已回复 → 退出候选");
  });
});

// ---------------------------------------------------------------------------
// 3. 建议生成：本机引擎 localOnly / 额度 / 上下文 / 草稿落库
// ---------------------------------------------------------------------------

test("suggest fails honest engine_missing without ever touching a runner (no cloud fallback)", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir, { engineBin: undefined, existsSync: () => false });
    await seedInbox(h);
    await assert.rejects(
      () => h.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "engine_missing",
    );
    assert.equal(h.engine.calls.length, 0, "缺引擎时绝不尝试任何子进程");
    assert.equal(h.dws.calls.length, 0);
    const quotaPath = join(h.replyDir, "quota.json");
    await assert.rejects(() => stat(quotaPath), "失败不记账");
  });
});

test("suggest runs the local engine with prompt over stdin and shapes the draft", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);
    const result = await h.bridge.suggest({ id: DT_ID });
    assert.equal(h.engine.calls.length, 1);
    const call = h.engine.calls[0];
    assert.equal(call.file, ENGINE_BIN);
    assert.deepEqual([...call.args], [...REPLY_ENGINE_ARGS]);
    assert.equal(call.options.timeoutMs, REPLY_ENGINE_TIMEOUT_MS);
    assert.ok(call.options.stdin?.includes(SUMMARY), "消息原文进 prompt（只经 stdin，不进 argv）");
    assert.ok(call.options.stdin?.includes("甲科技（合成）"), "crm 快照客户画像进上下文（只读）");
    assert.ok(!call.args.some((arg) => arg.includes(SUMMARY)), "正文绝不出现在 argv");
    assert.equal(result.needReply, true);
    assert.equal(result.text, SUGGEST_PAYLOAD.text);
    assert.equal(result.tone, "平实");
    assert.equal(result.engine, "qodercli");
    assert.equal(result.localOnly, true);
    assert.equal(result.contextProfile, true);
    assert.deepEqual(result.quota, { day: SYNTH_DAY, used: 1, limit: 60, perConvLimit: 6 });
  });
});

test("suggest records draft conclusion only (no message body) with 0600 atomic files", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);
    await h.bridge.suggest({ id: DT_ID });
    const store = await readJsonFile(join(h.replyDir, "store.json"));
    const rows = store.rows as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, DT_ID);
    assert.equal(rows[0].text, SUGGEST_PAYLOAD.text);
    assert.equal(rows[0].convKey, GROUP, "会话键 = openConversationId（无 cid 才回落候选 id）");
    const raw = await readFile(join(h.replyDir, "store.json"), "utf-8");
    assert.ok(!raw.includes(SUMMARY), "store 只存结论不存消息原文（donor store.js 口径）");
    for (const name of ["store.json", "quota.json"]) {
      const info = await stat(join(h.replyDir, name));
      assert.equal(info.mode & 0o777, 0o600, `${name} 0600`);
    }
    const dirInfo = await stat(h.replyDir);
    assert.equal(dirInfo.mode & 0o777, 0o700, "reply 目录 0700");
    assert.deepEqual((await readdir(h.replyDir)).filter((n) => n.endsWith(".tmp")), [], "无 tmp 残留");
    const quota = await readJsonFile(join(h.replyDir, "quota.json"));
    assert.equal(quota.total, 1);
    assert.deepEqual(quota.conv, { [GROUP]: { count: 1 } });
  });
});

test("suggest quota: per-conversation day cap 6 and global day cap 60, day rollover resets", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);
    await writeQuota(h.replyDir, { day: SYNTH_DAY, total: 6, conv: { [GROUP]: { count: 6 } } });
    await assert.rejects(
      () => h.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "quota_exceeded"
        && /会话/.test(error.message),
      "每会话日 ≤6",
    );
    assert.equal(h.engine.calls.length, 0, "额度闸门先于引擎");

    await writeQuota(h.replyDir, { day: SYNTH_DAY, total: 60, conv: {} });
    await assert.rejects(
      () => h.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "quota_exceeded"
        && /60/.test(error.message),
      "全局日 ≤60",
    );

    await writeQuota(h.replyDir, { day: "2026-10-19", total: 60, conv: { [GROUP]: { count: 6 } } });
    const result = await h.bridge.suggest({ id: DT_ID });
    assert.equal(result.quota.used, 1, "跨日归零：昨日满额不拦今日");
    const quota = await readJsonFile(join(h.replyDir, "quota.json"));
    assert.equal(quota.day, SYNTH_DAY);
    assert.equal(quota.total, 1);
  });
});

test("suggest engine failures are honest engine_error and consume no quota", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const failing = await makeHarness(dir, {}, { code: 3, stdout: "", stderr: "boom token=supersecretvalue1" });
    await seedInbox(failing);
    await assert.rejects(
      () => failing.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "engine_error"
        && !error.message.includes("supersecretvalue1"),
      "引擎非零退出 → engine_error，错误消息先脱敏",
    );
    const storePath = join(failing.replyDir, "store.json");
    await assert.rejects(() => stat(storePath), "失败不落草稿");

    const noisy = await makeHarness(dir, {}, { code: 0, stdout: "没有任何 JSON", stderr: "" });
    await seedInbox(noisy);
    await assert.rejects(
      () => noisy.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "engine_error",
      "输出无可解析 JSON → engine_error（不猜不造）",
    );

    const timeout = await makeHarness(dir, {}, { code: null, stdout: "", stderr: "", killed: true });
    await seedInbox(timeout);
    await assert.rejects(
      () => timeout.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "engine_error"
        && /超时/.test(error.message),
    );

    const enoent = await makeHarness(dir, {}, { code: "ENOENT", stdout: "", stderr: "" });
    await seedInbox(enoent);
    await assert.rejects(
      () => enoent.bridge.suggest({ id: DT_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "engine_missing",
      "bin 定位得到但 spawn ENOENT → 仍按缺引擎诚实失败",
    );
    for (const harness of [failing, noisy, timeout, enoent]) {
      await assert.rejects(() => stat(join(harness.replyDir, "quota.json")), `${harness === enoent ? "enoent" : "case"} 失败不记账`);
    }
  });
});

test("suggest validates body and unknown ids, and survives a missing crm snapshot", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir); // 不写 crm 快照
    await seedInbox(h);
    await assert.rejects(() => h.bridge.suggest(null), ReplyBridgeError);
    await assert.rejects(() => h.bridge.suggest({}), (e: unknown) => e instanceof ReplyBridgeError && e.code === "reply_invalid_request");
    await assert.rejects(() => h.bridge.suggest({ id: "" }), ReplyBridgeError);
    await assert.rejects(() => h.bridge.suggest({ id: 123 }), ReplyBridgeError);
    await assert.rejects(
      () => h.bridge.suggest({ id: "syn-dt-missing" }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "reply_not_found",
    );
    assert.equal(h.engine.calls.length, 0, "校验失败不碰引擎");
    const result = await h.bridge.suggest({ id: DT_ID });
    assert.equal(result.contextProfile, false, "快照缺失 → 无画像仍如实生成（旁路不挡主链路）");
    assert.equal(result.text, SUGGEST_PAYLOAD.text);
  });
});

// ---------------------------------------------------------------------------
// 4. 发送：confirm===id 闸门 / 渠道 / dws argv / 审计
// ---------------------------------------------------------------------------

test("send requires confirm === id strictly and never touches dws otherwise", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    for (const body of [
      { id: DT_ID, text: "正文（合成）" },
      { id: DT_ID, text: "正文（合成）", confirm: true },
      { id: DT_ID, text: "正文（合成）", confirm: DT_ID.toUpperCase() },
      { id: DT_ID, text: "正文（合成）", confirm: NOGROUP_ID },
    ]) {
      await assert.rejects(
        () => h.bridge.send(body),
        (error: unknown) => error instanceof ReplyBridgeError && error.code === "confirm_mismatch",
        `confirm=${JSON.stringify(body.confirm)} 必须拒绝`,
      );
    }
    assert.equal(h.dws.calls.length, 0, "确认闸门先于一切：dws 一次都不能被调");
    assert.deepEqual(await readAuditLines(h.replyDir), [], "未进入执行不留审计（与本体桥同口径）");
  });
});

test("send rejects wechat and unknown sources with no_channel (copy-only)", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    await assert.rejects(
      () => h.bridge.send({ id: WX_ID, text: "正文（合成）", confirm: WX_ID }),
      (error: unknown) => error instanceof ReplyBridgeError && error.code === "no_channel"
        && /复制/.test(error.message),
      "微信源没有发送通道，只许复制",
    );
    await assert.rejects(
      () => h.bridge.send({ id: LEAD_ID, text: "正文（合成）", confirm: LEAD_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "no_channel",
    );
    await assert.rejects(
      () => h.bridge.send({ id: "syn-dt-missing", text: "正文", confirm: "syn-dt-missing" }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "reply_not_found",
    );
    await assert.rejects(
      () => h.bridge.send({ id: NOGROUP_ID, text: "正文（合成）", confirm: NOGROUP_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "no_group",
      "钉钉源但解析不出 openConversationId → 如实 no_group",
    );
    assert.equal(h.dws.calls.length, 0);
  });
});

test("send validates text (no_text / too_long) before any subprocess", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    await assert.rejects(
      () => h.bridge.send({ id: DT_ID, text: "   ", confirm: DT_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "no_text",
    );
    await assert.rejects(
      () => h.bridge.send({ id: DT_ID, text: "长".repeat(REPLY_MAX_TEXT_CHARS + 1), confirm: DT_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "too_long",
      "超限不截断直接拒（截半句发出去比不发更糟，donor 口径）",
    );
    assert.equal(h.dws.calls.length, 0);
  });
});

test("send runs dws with the contracted argv and writes the masked audit line", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    const text = "你好，本月账单周期已确认为 25 日出账（合成），如有出入随时找我核对。";
    const result = await h.bridge.send({ id: DT_ID, text, confirm: DT_ID });
    assert.equal(h.dws.calls.length, 1);
    const call = h.dws.calls[0];
    assert.equal(call.file, DWS_BIN);
    assert.deepEqual([...call.args], [
      "chat", "message", "send", "--group", GROUP, "--text", text, "-y", "--format", "json",
    ], "仅钉钉 dws chat message send --group <openConversationId>");
    assert.equal(call.options.timeoutMs, REPLY_SEND_TIMEOUT_MS);
    assert.equal(call.options.stdin, undefined, "dws 正文只经 argv（shim 无 stdin 入口，donor 口径）");
    assert.equal(result.exitCode, 0);
    assert.equal(result.audited, true);
    assert.equal(result.group, GROUP);

    const lines = await readAuditLines(h.replyDir);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "exitCode", "group", "id", "maskedPreview"]);
    assert.equal(lines[0].id, DT_ID);
    assert.equal(lines[0].group, GROUP);
    assert.equal(lines[0].exitCode, 0);
    assert.equal(lines[0].at, new Date(FIXED_NOW).toISOString());
    const preview = String(lines[0].maskedPreview);
    assert.ok(preview.length <= 25, "预览 ≤24 字 + 省略号");
    assert.ok(!preview.includes(text), "审计不落全文");
    assert.ok(!JSON.stringify(lines[0]).includes(SUMMARY), "审计不含消息原文");
    const info = await stat(join(h.replyDir, "sends.jsonl"));
    assert.equal(info.mode & 0o777, 0o600, "审计 0600");
  });
});

test("send masks credential-shaped text in the audit preview", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await seedInbox(h);
    await h.bridge.send({ id: DT_ID, text: "回执 token=supersecretvalue1 已处理（合成）", confirm: DT_ID });
    const lines = await readAuditLines(h.replyDir);
    assert.ok(!JSON.stringify(lines[0]).includes("supersecretvalue1"));
    assert.ok(String(lines[0].maskedPreview).includes("[已脱敏]"));
  });
});

test("send classifies dws failures honestly and still audits the attempt", async () => {
  await withTempDir(async (dir) => {
    const enoent = await makeHarness(dir, {}, undefined, { code: "ENOENT", stdout: "", stderr: "" });
    await seedInbox(enoent);
    await assert.rejects(
      () => enoent.bridge.send({ id: DT_ID, text: "正文（合成）", confirm: DT_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "dws_missing",
    );
    let lines = await readAuditLines(enoent.replyDir);
    assert.equal(lines.length, 1, "真实子进程尝试必留审计");
    assert.equal(lines[0].exitCode, "ENOENT");

    const failed = await makeHarness(dir, {}, undefined, { code: 3, stdout: "", stderr: "dws exploded token=abc123" });
    await seedInbox(failed);
    await assert.rejects(
      () => failed.bridge.send({ id: DT_ID, text: "正文（合成）", confirm: DT_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "send_failed"
        && !e.message.includes("abc123"),
      "非零退出 → send_failed，消息脱敏",
    );
    lines = await readAuditLines(failed.replyDir);
    assert.equal(lines.length, 2, "同一审计文件累积追加");
    assert.equal(lines[1].exitCode, 3);

    const biz = await makeHarness(dir, {}, undefined, {
      code: 0, stdout: '{"success":false,"error":{"message":"ENTERPRISE_NOT_AUTHORIZED"}}', stderr: "",
    });
    await seedInbox(biz);
    await assert.rejects(
      () => biz.bridge.send({ id: DT_ID, text: "正文（合成）", confirm: DT_ID }),
      (e: unknown) => e instanceof ReplyBridgeError && e.code === "send_failed"
        && /ENTERPRISE_NOT_AUTHORIZED/.test(e.message),
      "退出码 0 但业务失败 → 不假装发出去了",
    );
    lines = await readAuditLines(biz.replyDir);
    assert.equal(lines.length, 3);
    assert.equal(lines[2].exitCode, 0);
  });
});

test("sends view returns audit tail newest-first and history stays read-only", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);
    await h.bridge.send({ id: DT_ID, text: "第一条（合成）", confirm: DT_ID });
    await h.bridge.send({ id: NOGROUP_ID, text: "第二条（合成）", confirm: NOGROUP_ID }).catch(() => {});
    await h.bridge.suggest({ id: DT_ID });
    const sendsView = await h.bridge.sends();
    assert.equal(sendsView.sends.length, 1, "no_group 被拒的没有真实尝试，不入审计");
    assert.equal(sendsView.sends[0].id, DT_ID);
    assert.equal(sendsView.total, 1);
    const historyView = await h.bridge.history();
    assert.equal(historyView.rows.length, 1);
    assert.equal(historyView.rows[0].text, SUGGEST_PAYLOAD.text);
    const corruptDir = join(dir, "corrupt");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "store.json"), "{ 坏 JSON", "utf-8");
    await writeFile(join(corruptDir, "sends.jsonl"), "不是 JSON\n", "utf-8");
    const corrupt = await makeHarness(dir, { dir: corruptDir });
    assert.deepEqual((await corrupt.bridge.history()).rows, [], "坏历史文件 → 如实空表不抛错");
    assert.deepEqual((await corrupt.bridge.sends()).sends, [], "坏审计行跳过");
  });
});

// ---------------------------------------------------------------------------
// 5. 子路由 handle（禁改 local-router.ts，接线沿本体桥先例）
// ---------------------------------------------------------------------------

test("handle serves the five routes, maps error codes to statuses and 405s wrong methods", async () => {
  await withTempDir(async (dir) => {
    await writeCrmSnapshot(dir);
    const h = await makeHarness(dir);
    await seedInbox(h);

    assert.equal(await h.bridge.handle(request("/local/other", "GET")), undefined, "非 reply 路径交回主路由");

    const candidates = await h.bridge.handle(request("/local/reply/candidates/", "GET"));
    assert.equal(candidates?.status, 200, "尾斜杠容忍");
    const candidatesBody = await candidates?.json() as { ok: boolean; data: { items: unknown[] } };
    assert.equal(candidatesBody.ok, true);
    assert.equal(candidatesBody.data.items.length, 2);

    const wrongMethod = await h.bridge.handle(request("/local/reply/candidates", "POST"));
    assert.equal(wrongMethod?.status, 405);
    const wrongBody = await wrongMethod?.json() as { ok: false; error: { code: string } };
    assert.equal(wrongBody.error.code, "method_not_allowed");

    const badJson = await h.bridge.handle(new Request("http://127.0.0.1:8000/local/reply/suggest", {
      method: "POST", headers: { host: "127.0.0.1:8000", "content-type": "application/json" }, body: "{ 坏 JSON",
    }));
    assert.equal(badJson?.status, 400);

    const bigBody = await h.bridge.handle(request("/local/reply/suggest", "POST", { id: DT_ID, pad: "a".repeat(20 * 1024) }));
    assert.equal(bigBody?.status, 400, "超大请求体拒绝");

    const notFound = await h.bridge.handle(request("/local/reply/suggest", "POST", { id: "syn-dt-missing" }));
    assert.equal(notFound?.status, 404);
    const notFoundBody = await notFound?.json() as { ok: false; error: { code: string; message: string } };
    assert.equal(notFoundBody.error.code, "reply_not_found");
    assert.ok(notFoundBody.error.message.length > 0, "错误分层：{ok:false,error:{code,message}}");

    const mismatch = await h.bridge.handle(request("/local/reply/send", "POST", { id: DT_ID, text: "x", confirm: "y" }));
    assert.equal(mismatch?.status, 400);
    assert.equal(((await mismatch?.json()) as { error: { code: string } }).error.code, "confirm_mismatch");

    const noChannel = await h.bridge.handle(request("/local/reply/send", "POST", { id: WX_ID, text: "x", confirm: WX_ID }));
    assert.equal(noChannel?.status, 409);
    assert.equal(((await noChannel?.json()) as { error: { code: string } }).error.code, "no_channel");

    const okSuggest = await h.bridge.handle(request("/local/reply/suggest", "POST", { id: DT_ID }));
    assert.equal(okSuggest?.status, 200);
    const suggestBody = await okSuggest?.json() as { ok: true; data: { text: string; localOnly: boolean } };
    assert.equal(suggestBody.data.text, SUGGEST_PAYLOAD.text);
    assert.equal(suggestBody.data.localOnly, true);

    await writeQuota(h.replyDir, { day: SYNTH_DAY, total: 60, conv: {} });
    const quotaHit = await h.bridge.handle(request("/local/reply/suggest", "POST", { id: DT_ID }));
    assert.equal(quotaHit?.status, 429);
    assert.equal(((await quotaHit?.json()) as { error: { code: string } }).error.code, "quota_exceeded");

    const okSend = await h.bridge.handle(request("/local/reply/send", "POST", { id: DT_ID, text: "确认后的正文（合成）", confirm: DT_ID }));
    assert.equal(okSend?.status, 200);
    const sendBody = await okSend?.json() as { ok: true; data: { exitCode: number; audited: boolean } };
    assert.equal(sendBody.data.exitCode, 0);
    assert.equal(sendBody.data.audited, true);

    const historyRes = await h.bridge.handle(request("/local/reply/history", "GET"));
    assert.equal(historyRes?.status, 200);
    const sendsRes = await h.bridge.handle(request("/local/reply/sends", "GET"));
    assert.equal(sendsRes?.status, 200);
    assert.equal(((await sendsRes?.json()) as { data: { total: number } }).data.total, 1);
  });
});

test("handle maps engine_missing to 503 and unknown faults to 502", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { engineBin: undefined, existsSync: () => false });
    await seedInbox(h);
    const missing = await h.bridge.handle(request("/local/reply/suggest", "POST", { id: DT_ID }));
    assert.equal(missing?.status, 503);
    const body = await missing?.json() as { ok: false; error: { code: string; message: string } };
    assert.equal(body.error.code, "engine_missing");
    assert.match(body.error.message, /本机|云端/, "文案如实声明不回落云端");

    const dwsGone = await makeHarness(dir, {}, undefined, { code: "ENOENT", stdout: "", stderr: "" });
    await seedInbox(dwsGone);
    const dwsRes = await dwsGone.bridge.handle(request("/local/reply/send", "POST", { id: DT_ID, text: "正文（合成）", confirm: DT_ID }));
    assert.equal(dwsRes?.status, 503);
    assert.equal(((await dwsRes?.json()) as { error: { code: string } }).error.code, "dws_missing");

    const broken = createReplyBridge({
      dir: join(dir, "broken"),
      notifyBridge: {
        state: async () => { throw new Error("boom"); },
        items: async () => { throw new Error("boom"); },
        markRead: async () => { throw new Error("boom"); },
        enqueueTest: async () => { throw new Error("boom"); },
      },
    });
    const unavailable = await broken.handle(request("/local/reply/candidates", "GET"));
    assert.equal(unavailable?.status, 502);
    assert.equal(((await unavailable?.json()) as { error: { code: string } }).error.code, "reply_unavailable");
  });
});

// ---------------------------------------------------------------------------
// 6. 引擎纯函数单元（定位 / prompt / 解析 / 整形）
// ---------------------------------------------------------------------------

test("resolveEngineBin probes env override then qoder/qodercli paths and stays honest when absent", () => {
  const seen: string[] = [];
  const exists = (path: string): boolean => { seen.push(path); return path === "/synthetic/home/.qoder/bin/qoder"; };
  const bin = resolveEngineBin({ HOME: "/synthetic/home" } as NodeJS.ProcessEnv, exists);
  assert.equal(bin, "/synthetic/home/.qoder/bin/qoder");
  assert.ok(seen.some((p) => p.endsWith(".qoder/bin/qodercli")), "qodercli 先于 qoder 探测");

  const envBin = resolveEngineBin(
    { HOME: "/synthetic/home", SA_REPLY_ENGINE_BIN: "/synthetic/env/qodercli" } as NodeJS.ProcessEnv,
    (path) => path === "/synthetic/env/qodercli",
  );
  assert.equal(envBin, "/synthetic/env/qodercli", "env 覆盖优先（也要过存在性）");

  assert.equal(resolveEngineBin({ HOME: "/synthetic/home" } as NodeJS.ProcessEnv, () => false), "",
    "全部缺失 → 空串（调用方 engine_missing 诚实失败）");
});

test("prompt carries profile + message text; parse and shaping follow donor semantics", () => {
  const profile = matchCustomerProfile(
    { schemaVersion: 1, customers: [{ cid: "91001", name: "甲科技（合成）", industry: "软件（合成）", area: "浙江省/杭州市", level: "GC7", lastMonthGaap: 9.9 }] },
    { title: "甲科技（合成）服务群新消息", summary: SUMMARY },
  );
  assert.ok(profile);
  assert.deepEqual(Object.keys(profile).sort(), ["area", "cid", "industry", "level", "name"], "画像白名单五字段");
  assert.equal(matchCustomerProfile({ customers: [] }, { title: "甲科技（合成）", summary: "" }), null);
  assert.equal(matchCustomerProfile(null, { title: "甲科技（合成）", summary: "" }), null, "坏快照 → null 不抛错");
  assert.equal(matchCustomerProfile(
    { customers: [{ cid: "1", name: "乙股份（合成）" }] },
    { title: "无关标题", summary: "无关摘要" },
  ), null, "名字没出现不硬配");

  const prompt = buildSuggestPrompt({ title: "甲科技（合成）服务群新消息", summary: SUMMARY, createdAt: "2026-10-20T01:00:00.000Z", profile });
  assert.ok(prompt.includes(SUMMARY));
  assert.ok(prompt.includes("软件（合成）"));
  for (const key of ["needReply", "text", "tone", "reason"]) assert.ok(prompt.includes(key), `输出契约声明 ${key}`);
  const bare = buildSuggestPrompt({ title: "t", summary: "s", createdAt: "", profile: null });
  assert.ok(bare.includes("t") && bare.includes("s"));

  assert.deepEqual(parseEngineJson('告警\n{"needReply":true}\n完成'), { needReply: true });
  assert.equal(parseEngineJson("没有 JSON"), null);
  assert.equal(parseEngineJson("{ 坏"), null);

  const shaped = shapeSuggestion({ needReply: true, text: "  > # 草稿正文（合成）", tone: "俏皮", reason: "r".repeat(300) }, 12, "qodercli");
  assert.equal(shaped.text, "草稿正文（合成）", "markdown 前缀剥掉，复制即可发");
  assert.equal(shaped.tone, "", "语气白名单外落空");
  assert.equal(shaped.reason.length, 160, "reason 截 160");
  assert.equal(shaped.ms, 12);

  const long = shapeSuggestion({ text: "长".repeat(REPLY_MAX_TEXT_CHARS + 50) }, 0, "qodercli");
  assert.equal(long.text.length, REPLY_MAX_TEXT_CHARS);
  assert.equal(long.needReply, true, "缺省按需要回复");
  const noReply = shapeSuggestion({ needReply: false, text: "还是给了文本" }, 0, "qodercli");
  assert.equal(noReply.needReply, false);
  assert.equal(noReply.text, "", "判免回 → 文本清空（donor shapeResult 口径）");
  const empty = shapeSuggestion({ needReply: true, text: "   " }, 0, "qodercli");
  assert.equal(empty.needReply, false, "空文本不算需要回复");
});
