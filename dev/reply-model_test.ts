import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveReplyCandidates,
  extractDingtalkGroup,
  replyChannelOf,
  REPLY_CANDIDATE_LIMIT,
  REPLY_DINGTALK_SOURCES,
  REPLY_WECHAT_SOURCES,
  type ReplySourceItem,
} from "../src/lib/reply-model.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：客户/群名只用「甲科技（合成）/乙股份（合成）」等合成值；
// cid 一律 cidSynth* 形态，绝不含真实会话 id 或真实客户数据。
// ---------------------------------------------------------------------------

function item(overrides: Partial<ReplySourceItem> = {}): ReplySourceItem {
  return {
    id: "syn-dt-001",
    kind: "dingtalk",
    title: "甲科技（合成）服务群新消息",
    summary: "客户询问本月账单周期（合成）。",
    source: "dingtalk",
    link: "https://example.com/dt?cid=cidSynthGroup01",
    createdAt: "2026-10-20T01:00:00.000Z",
    read: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 渠道判定（白名单字面量，判不出为 ""，绝不猜）
// ---------------------------------------------------------------------------

test("replyChannelOf only accepts whitelist literals and falls back to empty", () => {
  assert.equal(replyChannelOf({ kind: "dingtalk", source: "" }), "dingtalk", "kind 兜底");
  assert.equal(replyChannelOf({ kind: "test", source: "dingtalk" }), "dingtalk");
  assert.equal(replyChannelOf({ kind: "test", source: " DingTalk " }), "dingtalk", "trim + 小写比对");
  assert.equal(replyChannelOf({ kind: "test", source: "钉钉" }), "dingtalk");
  assert.equal(replyChannelOf({ kind: "cust", source: "wechat" }), "wechat");
  assert.equal(replyChannelOf({ kind: "cust", source: "微信" }), "wechat");
  assert.equal(replyChannelOf({ kind: "lead", source: "合成雷达" }), "", "未知源没有通道，如实空");
  assert.equal(replyChannelOf({ kind: "lead", source: "" }), "");
  assert.deepEqual(REPLY_DINGTALK_SOURCES, ["dingtalk", "钉钉"]);
  assert.deepEqual(REPLY_WECHAT_SOURCES, ["wechat", "weixin", "微信"]);
});

// ---------------------------------------------------------------------------
// 2. openConversationId 提取（严格正则，提取不到即 ""）
// ---------------------------------------------------------------------------

test("extractDingtalkGroup takes cid from link first, then id, else empty", () => {
  assert.equal(extractDingtalkGroup(item()), "cidSynthGroup01", "link 查询串里的 cid（键名 cid= 不得吞进值）");
  assert.equal(
    extractDingtalkGroup(item({ link: "", id: "cidSynthGroup02" })),
    "cidSynthGroup02",
    "link 无 cid 时回落 id",
  );
  assert.equal(
    extractDingtalkGroup(item({ link: "https://example.com/dt?cid=cidSynthA0001", id: "cidSynthB0002" })),
    "cidSynthA0001",
    "link 优先于 id",
  );
  assert.equal(extractDingtalkGroup(item({ link: "https://example.com/x", id: "syn-dt-001" })), "", "两处都无 cid → 空");
  assert.equal(extractDingtalkGroup(item({ link: "", id: "cidab" })), "", "cid 后不足 4 位主体不是会话 id");
  assert.equal(extractDingtalkGroup(item({ link: "", id: "DCIDSynth0003" })), "", "大写 CID 前缀不命中（形态从严）");
});

// ---------------------------------------------------------------------------
// 3. 候选派生：钉钉源 + 未读/未回复；已读且已回复才退出
// ---------------------------------------------------------------------------

test("derive keeps dingtalk unread-or-unreplied items and drops read+replied ones", () => {
  const items = [
    item({ id: "syn-dt-unread" }),
    item({ id: "syn-dt-read-unreplied", read: true }),
    item({ id: "syn-dt-read-replied", read: true }),
    item({ id: "syn-dt-unread-replied" }),
    item({ id: "syn-wx-001", kind: "cust", source: "wechat", link: "", read: false }),
    item({ id: "syn-lead-001", kind: "lead", source: "合成雷达", link: "", read: false }),
  ];
  const replied = new Set(["syn-dt-read-replied", "syn-dt-unread-replied"]);
  const rows = deriveReplyCandidates(items, replied);
  assert.deepEqual(rows.map((row) => row.id), [
    "syn-dt-unread",
    "syn-dt-read-unreplied",
    "syn-dt-unread-replied",
  ], "微信/未知源不进候选；已读且已回复退出；未读即使已回复仍在（要人看一眼）");
  const unrepliedRow = rows.find((row) => row.id === "syn-dt-unread-replied");
  assert.equal(unrepliedRow?.replied, true, "replied 位如实回填（来自发送审计）");
  assert.equal(rows[0].channel, "dingtalk");
  assert.equal(rows[0].group, "cidSynthGroup01");
});

test("derive projects a body-free candidate (privacy) and never mutates inputs", () => {
  const items = [item()];
  const frozenCopy = structuredClone(items);
  const rows = deriveReplyCandidates(items, new Set());
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "channel", "createdAt", "group", "id", "read", "replied", "title",
  ], "候选投影白名单：不带 summary（消息正文不进候选清单，donor 隐私口径）");
  assert.equal("summary" in rows[0], false);
  assert.deepEqual(items, frozenCopy, "输入数组与条目一律不改动（不可变）");
});

test("derive sorts newest-first, tolerates bad timestamps and caps at the limit", () => {
  const items = [
    item({ id: "syn-dt-a", createdAt: "2026-10-19T01:00:00.000Z" }),
    item({ id: "syn-dt-b", createdAt: "2026-10-20T01:00:00.000Z" }),
    item({ id: "syn-dt-c", createdAt: "不是时间" }),
  ];
  const rows = deriveReplyCandidates(items, new Set());
  assert.deepEqual(rows.map((row) => row.id), ["syn-dt-b", "syn-dt-a", "syn-dt-c"], "时间倒序，坏时间排最后");

  const many: ReplySourceItem[] = [];
  for (let index = 1; index <= REPLY_CANDIDATE_LIMIT + 10; index += 1) {
    many.push(item({ id: `syn-dt-${String(index).padStart(3, "0")}` }));
  }
  assert.equal(deriveReplyCandidates(many, new Set()).length, REPLY_CANDIDATE_LIMIT, "超出上限截断");
  assert.deepEqual(deriveReplyCandidates([], new Set()), [], "空收件箱 → 空候选（不抛错）");
});
