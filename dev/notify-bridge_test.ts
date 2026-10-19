import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNotifyBridge,
  DEFAULT_NOTIFY_INBOX_PATH,
  NotifyBridgeError,
  type NotifyBridge,
} from "./notify-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import {
  cleanNotifyText,
  NOTIFY_INBOX_LIMIT,
  NOTIFY_ID_PATTERN,
  NOTIFY_STATE_LIMIT,
  normalizeNotifyIncoming,
  projectNotifyItem,
  redactNotify,
} from "./notify/notify-model.ts";
import { NOTIFY_KIND_LABELS, NOTIFY_KINDS } from "./notify/notify-types.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：消息标题/摘要只用「甲科技/乙股份」等合成值，绝不含真实客户数据；
// 收件箱一律落在临时目录（.local-cache 零接触）。FIXED_NOW = 2026-10-20T02:30:00Z。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");

function incoming(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "syn-msg-001",
    kind: "lead",
    title: "甲科技新线索（合成）",
    summary: "拓新雷达出现 A 档合成线索，请查看。",
    source: "合成雷达",
    link: "https://example.com/leads",
    at: "2026-10-20T01:00:00.000Z",
    ...overrides,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "notify-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeBridge(dir: string, nowMs: number = FIXED_NOW): NotifyBridge {
  return createNotifyBridge({ inboxPath: join(dir, "inbox.json"), now: () => nowMs });
}

async function ingestMany(bridge: NotifyBridge, count: number, prefix = "syn-msg"): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const result = await ingestOne(bridge, {
      ...incoming(),
      id: `${prefix}-${String(index).padStart(3, "0")}`,
      title: `合成消息 ${index}`,
    });
    assert.ok(result.added, `第 ${index} 条应入箱`);
  }
}

async function ingestOne(bridge: NotifyBridge, raw: Record<string, unknown>): Promise<{ id: string; added: boolean }> {
  // 结构化入队走桥公开的 ingest 路径（收件箱唯一写入口，后续批次生产者复用同一入口）。
  const ingestable = (bridge as unknown as { ingest?: (raw: unknown) => Promise<{ id: string; added: boolean }> }).ingest;
  assert.ok(typeof ingestable === "function", "bridge 必须暴露 ingest 供测试/后续批次生产者复用");
  return ingestable.call(bridge, raw);
}

// ---------------------------------------------------------------------------
// 1. 归一化（clean 口径照抄 index.js + 凭据脱敏加严）
// ---------------------------------------------------------------------------

test("normalize keeps the reference whitelist, falls back kind to test and only allows http(s) links", () => {
  const item = normalizeNotifyIncoming(incoming(), FIXED_NOW);
  assert.ok(item);
  assert.equal(item.kind, "lead");
  assert.equal(item.createdAt, "2026-10-20T01:00:00.000Z", "可解析的 at 保持原值");
  assert.equal(item.read, false);
  assert.equal(item.readAt, "");

  const fallback = normalizeNotifyIncoming(incoming({ kind: "unknown-kind", link: "javascript:alert(1)", at: "不是日期" }), FIXED_NOW);
  assert.ok(fallback);
  assert.equal(fallback.kind, "test", "kind 白名单外一律落 test（照 index.js）");
  assert.equal(fallback.link, "", "非 http(s) 链接一律丢弃");
  assert.equal(fallback.createdAt, new Date(FIXED_NOW).toISOString(), "坏 at 回落注入的 now");

  assert.equal(normalizeNotifyIncoming({ title: "无 id" }, FIXED_NOW), null, "缺 id 拒绝");
  assert.equal(normalizeNotifyIncoming({ id: "bad id!" }, FIXED_NOW), null, "id 形态不符拒绝");
  assert.equal(normalizeNotifyIncoming({ id: "syn-msg-2", title: "   " }, FIXED_NOW), null, "空标题拒绝");
  assert.ok(NOTIFY_ID_PATTERN.test("rmd-daily-2026-10-20"));
  assert.ok(!NOTIFY_ID_PATTERN.test("空格 不行"));
});

test("clean truncates to caps and redaction strips credential-shaped text before storage", () => {
  assert.equal(cleanNotifyText("a\u0000b\u001fc  d", 10), "a b c d", "控制字符折为空格 + 空白折叠（照 index.js）");
  assert.equal(cleanNotifyText("甲".repeat(50), 10).length, 10, "标题截断 120 上限由调用处传参");

  const hostile = normalizeNotifyIncoming(incoming({
    title: "线索标题 token=supersecretvalue1 附言",
    summary: "access key sk-sentinel0123456789 与 LTAI9999abcd0123 出现在摘要",
  }), FIXED_NOW);
  assert.ok(hostile);
  const serialized = JSON.stringify(hostile);
  assert.equal(serialized.includes("supersecretvalue1"), false, "凭据形态文本不得入箱");
  assert.equal(serialized.includes("sk-sentinel0123456789"), false);
  assert.equal(serialized.includes("LTAI9999abcd0123"), false);
  assert.ok(serialized.includes("[已脱敏]"));

  assert.equal(redactNotify("password=hunter2"), "[已脱敏]");
  // 评审 P2-1 回归：词边界 + 长度下限——正常词不得被误吞（旧实现会吞进盘）。
  const normalTitle = "日报 task-list 跟进 · risk-control 例会 · sklearn 模型上线";
  assert.equal(normalizeNotifyIncoming(incoming({ title: normalTitle }), FIXED_NOW)?.title, normalTitle,
    "task-list / risk-control / sklearn 不是凭据，标题原样入箱");
  assert.equal(redactNotify("sk-proj-abcdefghijklmnop1234"), "[已脱敏]", "sk- 16 位裸密钥仍抹除");
  assert.equal(redactNotify("Bearer sk-short1"), "Bearer sk-short1", "sk- 后不足 16 位不是裸密钥");
  assert.equal(projectNotifyItem({ id: "syn-1", kind: "lead", title: "t", link: "javascript:alert(1)", read: "yes" })?.link, "");
  assert.equal(projectNotifyItem({ id: "bad id" }), null, "读回白名单投影拒绝坏 id");
  assert.deepEqual(NOTIFY_KINDS, ["dingtalk", "lead", "cust", "reminder", "reply", "test"], "以 index.js 为准（含 reply）");
  assert.equal(NOTIFY_KIND_LABELS.reply, "待回复");
});

// ---------------------------------------------------------------------------
// 2. 收件箱：去重 / cap 200 / 0600 原子写
// ---------------------------------------------------------------------------

test("default inbox path resolves under .local-cache/notifications", () => {
  assert.match(DEFAULT_NOTIFY_INBOX_PATH, /[\\/]\.local-cache[\\/]notifications[\\/]inbox\.json$/);
  assert.ok(!DEFAULT_NOTIFY_INBOX_PATH.includes(join("dev", ".local-cache")), "must not resolve under dev/");
});

test("ingest dedupes by id fingerprint and keeps the inbox file immutable on duplicates", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const first = await ingestOne(bridge, incoming());
    assert.ok(first.added);
    const before = await readFile(join(dir, "inbox.json"), "utf-8");
    const duplicate = await ingestOne(bridge, incoming({ title: "同 id 不同标题（应拒绝）" }));
    assert.equal(duplicate.added, false, "同 id 指纹去重");
    const after = await readFile(join(dir, "inbox.json"), "utf-8");
    assert.equal(after, before, "重复入队不改写收件箱文件");
    const state = await bridge.state();
    assert.equal(state.total, 1);
  });
});

test("inbox caps at 200 and drops the oldest entries", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await ingestMany(bridge, NOTIFY_INBOX_LIMIT + 5);
    const state = await bridge.state();
    assert.equal(state.total, NOTIFY_INBOX_LIMIT, "超出 200 丢最旧");
    assert.ok(state.items.every((item) => Number(item.id.replace("syn-msg-", "")) >= 6), "最早 5 条被挤出");
    const full = await bridge.items();
    assert.equal(full.items.length, NOTIFY_INBOX_LIMIT);
    assert.equal(full.items[0].id, "syn-msg-205", "最新在前");
  });
});

test("writes are atomic (unique tmp cleaned up) and land with mode 0600", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await ingestOne(bridge, incoming());
    const files = await readdir(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "rename 后不留 tmp 文件");
    const info = await stat(join(dir, "inbox.json"));
    assert.equal(info.mode & 0o777, 0o600, "收件箱文件 0600");
    const raw = JSON.parse(await readFile(join(dir, "inbox.json"), "utf-8"));
    assert.equal(typeof raw.savedAt, "string");
    assert.equal(raw.items.length, 1);
  });
});

test("corrupt inbox file degrades to an honest empty inbox instead of throwing", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "inbox.json"), "{ 坏 JSON", "utf-8");
    await chmod(join(dir, "inbox.json"), 0o600);
    const bridge = makeBridge(dir);
    const state = await bridge.state();
    assert.equal(state.total, 0);
    assert.equal(state.savedAt, "");
    const added = await ingestOne(bridge, incoming());
    assert.ok(added.added, "坏文件后可恢复写入（桥是唯一写者）");
  });
});

// ---------------------------------------------------------------------------
// 3. 已读位 / state 截断 50
// ---------------------------------------------------------------------------

test("markRead flips only the read bit, supports ids/all/read:false and validates input", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await ingestMany(bridge, 3);
    const one = await bridge.markRead({ ids: ["syn-msg-001"] });
    assert.equal(one.marked, 1);
    let items = (await bridge.items()).items;
    assert.equal(items.find((item) => item.id === "syn-msg-001")?.read, true);
    assert.ok(items.find((item) => item.id === "syn-msg-001")?.readAt);

    const restored = await bridge.markRead({ ids: ["syn-msg-001"], read: false });
    assert.equal(restored.marked, 1, "read:false 还原未读");
    items = (await bridge.items()).items;
    const target = items.find((item) => item.id === "syn-msg-001");
    assert.equal(target?.read, false);
    assert.equal(target?.readAt, "");

    const all = await bridge.markRead({ all: true });
    assert.equal(all.marked, 3, "三条全部已读（含刚还原未读的 001）");
    assert.equal((await bridge.state()).unread, 0);

    const twice = await bridge.markRead({ all: true });
    assert.equal(twice.marked, 0, "幂等：已读再标不计 marked");

    await assert.rejects(
      () => bridge.markRead({}),
      (error: unknown) => error instanceof NotifyBridgeError && error.code === "notify_invalid_request",
      "缺 ids/all 一律 400",
    );
    await assert.rejects(() => bridge.markRead({ ids: "syn-msg-001" }), NotifyBridgeError);
  });
});

test("state returns the latest 50 items with unread counts over the whole inbox", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await ingestMany(bridge, NOTIFY_STATE_LIMIT + 10);
    await bridge.markRead({ ids: ["syn-msg-001", "syn-msg-002"] });
    const state = await bridge.state();
    assert.equal(state.total, 60);
    assert.equal(state.unread, 58, "未读数按全量计");
    assert.equal(state.items.length, 50, "state 只带最近 50 条");
    assert.equal(state.items[0].id, "syn-msg-060");
    assert.ok(state.savedAt.length > 0);
  });
});

test("enqueueTest produces an explicit test-only message with no real data", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const first = await bridge.enqueueTest();
    assert.ok(first.added);
    const second = await bridge.enqueueTest();
    assert.ok(second.added, "连发两条都入箱（id 唯一）");
    assert.notEqual(first.id, second.id);
    const state = await bridge.state();
    assert.equal(state.items.length, 2);
    for (const item of state.items) {
      assert.equal(item.kind, "test");
      assert.ok(item.title.startsWith("测试"), "内容前缀明确「测试」");
      assert.match(item.summary, /测试/);
      assert.match(item.summary, /后续批次/, "如实说明事件源待接入");
      assert.equal(item.source, "测试");
      assert.equal(item.link, "", "测试消息不带任何链接");
    }
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes("sk-"), false);
    assert.equal(serialized.includes("LTAI"), false);
  });
});

// ---------------------------------------------------------------------------
// 4. 路由端点
// ---------------------------------------------------------------------------

const TRUSTED = { host: "127.0.0.1:8000" };

function request(path: string, method: "GET" | "POST", body?: unknown): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method,
    headers: { ...TRUSTED, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("router serves notify state/items/read/test and maps errors to 400/502/405", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const router = createLocalRouter({ port: 8000, notifyBridge: bridge });

    const testPost = await router(request("/local/notify/test", "POST"));
    assert.equal(testPost.status, 200);
    const testBody = await testPost.json() as { ok: boolean; data: { id: string; added: boolean } };
    assert.equal(testBody.ok, true);
    assert.ok(testBody.data.added);

    const state = await router(request("/local/notify/state", "GET"));
    assert.equal(state.status, 200);
    const stateBody = await state.json() as { ok: boolean; data: { total: number; unread: number; items: unknown[] } };
    assert.equal(stateBody.data.total, 1);
    assert.equal(stateBody.data.unread, 1);
    assert.equal(stateBody.data.items.length, 1);

    const items = await router(request("/local/notify/items", "GET"));
    assert.equal(items.status, 200);
    assert.equal(((await items.json()) as { data: { total: number } }).data.total, 1);

    const badRead = await router(request("/local/notify/read", "POST", {}));
    assert.equal(badRead.status, 400, "缺 ids/all → 400");
    assert.equal(((await badRead.json()) as { error: string }).error, "invalid_request");

    const read = await router(request("/local/notify/read", "POST", { all: true }));
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { data: { marked: number } }).data.marked, 1);

    const after = await router(request("/local/notify/state", "GET"));
    assert.equal(((await after.json()) as { data: { unread: number } }).data.unread, 0);

    const unknownPost = await router(request("/local/notify/unknown", "POST"));
    assert.equal(unknownPost.status, 405);

    const brokenRouter = createLocalRouter({
      port: 8000,
      notifyBridge: {
        state: async () => { throw new Error("boom"); },
        items: async () => { throw new Error("boom"); },
        markRead: async () => { throw new Error("boom"); },
        enqueueTest: async () => { throw new Error("boom"); },
      },
    });
    const unavailable = await brokenRouter(request("/local/notify/state", "GET"));
    assert.equal(unavailable.status, 502);
    assert.equal(((await unavailable.json()) as { error: string }).error, "notify_unavailable", "未知异常兜底 502（F5 P3-1）");
  });
});
