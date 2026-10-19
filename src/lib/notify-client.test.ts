import assert from "node:assert/strict";
import test from "node:test";

import {
  markNotifyRead,
  NOTIFY_KIND_LABELS,
  notifyErrorMessage,
  notifyRelativeTime,
  notifyUnreadBadge,
  fetchNotifyItems,
  fetchNotifyState,
  sendNotifyTest,
  type NotifyItem,
} from "./notify-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：标题/摘要只用「甲科技/乙股份」等合成值；fetch 全程 mock。
// ---------------------------------------------------------------------------

const ITEM: NotifyItem = {
  id: "syn-msg-001",
  kind: "lead",
  title: "甲科技新线索（合成）",
  summary: "拓新雷达出现 A 档合成线索，请查看。",
  source: "合成雷达",
  link: "https://example.com/leads",
  createdAt: "2026-10-20T01:00:00.000Z",
  readAt: "",
  read: false,
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okData = (data: unknown): Response => jsonRes({ ok: true, data });

test("fetchNotifyState projects items with the whitelist and counts unread/total", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData({ savedAt: "2026-10-20T02:30:00.000Z", unread: 1, total: 1, items: [ITEM, { broken: true }] });
  }) as unknown as typeof fetch;
  const state = await fetchNotifyState(fetchImpl);
  assert.equal(requested, "http://localhost/local/notify/state");
  assert.equal(state.total, 1);
  assert.equal(state.unread, 1);
  assert.equal(state.items.length, 1, "坏行丢弃");
  assert.equal(state.items[0].title, "甲科技新线索（合成）");
  assert.equal(state.items[0].read, false);
});

test("fetchNotifyItems returns the full inbox", async () => {
  const fetchImpl = (async () => okData({ savedAt: "s", unread: 0, total: 2, items: [ITEM, { ...ITEM, id: "syn-msg-002", read: true }] })) as unknown as typeof fetch;
  const view = await fetchNotifyItems(fetchImpl);
  assert.equal(view.items.length, 2);
  assert.equal(view.items[1].read, true);
});

test("markNotifyRead posts the read-bit body and returns marked/unread", async () => {
  let body = "";
  let method = "";
  const fetchImpl = (async (input: Request | string) => {
    const request = input as Request;
    method = request.method;
    body = await request.text();
    return okData({ marked: 1, unread: 0 });
  }) as unknown as typeof fetch;
  const result = await markNotifyRead({ ids: ["syn-msg-001"] }, fetchImpl);
  assert.equal(method, "POST");
  assert.deepEqual(JSON.parse(body), { ids: ["syn-msg-001"] });
  assert.equal(result.marked, 1);

  const all = await markNotifyRead({ all: true }, fetchImpl);
  assert.equal(all.unread, 0);

  const bad = (async () => jsonRes({ ok: false, error: "invalid_request" }, 400)) as unknown as typeof fetch;
  const error = await markNotifyRead({}, bad).catch((reason: unknown) => reason as Error);
  assert.match(notifyErrorMessage(error), /参数/);
});

test("sendNotifyTest enqueues a test-only message", async () => {
  const fetchImpl = (async () => okData({ id: "test-1", added: true })) as unknown as typeof fetch;
  const result = await sendNotifyTest(fetchImpl);
  assert.equal(result.added, true);
  assert.equal(result.id, "test-1");
});

test("offline bridge folds to the honest local-runtime copy", async () => {
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const error = await fetchNotifyState(offline).catch((reason: unknown) => reason as Error);
  assert.match(notifyErrorMessage(error), /本地桥未启动/);
  assert.match(notifyErrorMessage(error), /npm run dev:function/);
});

test("notifyUnreadBadge caps at 99+ and hides zero", () => {
  assert.equal(notifyUnreadBadge(0), "");
  assert.equal(notifyUnreadBadge(5), "5");
  assert.equal(notifyUnreadBadge(99), "99");
  assert.equal(notifyUnreadBadge(120), "99+", "未读数超 99 封顶展示");
});

test("notifyRelativeTime renders the reference buckets", () => {
  const now = Date.parse("2026-10-20T10:30:00.000Z");
  assert.equal(notifyRelativeTime(new Date(now - 20_000).toISOString(), now), "刚刚");
  assert.equal(notifyRelativeTime(new Date(now - 5 * 60_000).toISOString(), now), "5 分钟前");
  assert.equal(notifyRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now), "3 小时前");
  assert.equal(notifyRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now), "2 天前");
  assert.equal(notifyRelativeTime("2026-09-01T00:00:00.000Z", now), "2026-09-01");
  assert.equal(notifyRelativeTime("不是日期", now), "");
});

test("kind labels keep the index.js wording including reply", () => {
  assert.equal(NOTIFY_KIND_LABELS.dingtalk, "钉钉");
  assert.equal(NOTIFY_KIND_LABELS.lead, "线索");
  assert.equal(NOTIFY_KIND_LABELS.cust, "客户");
  assert.equal(NOTIFY_KIND_LABELS.reminder, "提醒");
  assert.equal(NOTIFY_KIND_LABELS.reply, "待回复");
  assert.equal(NOTIFY_KIND_LABELS.test, "测试");
});
