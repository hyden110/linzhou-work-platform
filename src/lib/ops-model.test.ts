import assert from "node:assert/strict";
import test from "node:test";

import {
  OPS_SOURCE_BADGES,
  groupOpsItemsByDay,
  opsStatusLabel,
  opsStatusTone,
  splitWechatLinks,
} from "./ops-model.ts";
import type { OpsItem } from "./ops-types.ts";

const NOW = new Date("2026-10-16T12:00:00").getTime();

function item(id: string, publishedAt: string | null, sourceType: OpsItem["sourceType"] = "blog"): OpsItem {
  return {
    id,
    sourceType,
    source: "示例来源",
    title: `条目 ${id}`,
    url: null,
    publishedAt,
    summary: null,
    kind: null,
  };
}

test("groups the last seven days into newest-first day buckets", () => {
  const board = groupOpsItemsByDay([
    item("a", "2026-10-16T09:30:00"),
    item("b", "2026-10-15T18:00:00"),
    item("c", "2026-10-16T08:00:00"),
    item("edge", "2026-10-10T23:30:00"),
    item("d", "2026-10-09T08:00:00"),
  ], NOW);
  assert.deepEqual(board.map((day) => day.key), ["2026-10-16", "2026-10-15", "2026-10-10"]);
  assert.equal(board[0]!.isToday, true);
  assert.deepEqual(board[0]!.items.map((entry) => entry.id), ["a", "c"]);
  assert.equal(board[1]!.items[0]!.id, "b");
  assert.equal(board[2]!.items[0]!.id, "edge");
  assert.match(board[0]!.label, /2026-10-16（周[一二三四五六日]）/);
});

test("undated items land in an honest no-date bucket at the end of the board", () => {
  const board = groupOpsItemsByDay([
    item("dated", "2026-10-16T09:30:00"),
    item("undated", null, "announcement"),
    item("unparsable", "not-a-date", "changelog"),
  ], NOW);
  assert.deepEqual(board.map((day) => day.key), ["2026-10-16", "nodate"]);
  const nodate = board[1]!;
  assert.equal(nodate.label, "无日期");
  assert.equal(nodate.isToday, false);
  assert.deepEqual(nodate.items.map((entry) => entry.id), ["undated", "unparsable"]);
  assert.match(nodate.note ?? "", /未提供发布日期/);
  assert.equal(board[0]!.note, null);
});

test("keeps every source badge label distinct and mapped", () => {
  assert.deepEqual(Object.keys(OPS_SOURCE_BADGES), ["blog", "changelog", "announcement", "qianzai"]);
  assert.equal(new Set(Object.values(OPS_SOURCE_BADGES)).size, 4);
});

test("maps source statuses to honest labels and tones", () => {
  assert.equal(opsStatusLabel("ok"), "正常");
  assert.equal(opsStatusTone("ok"), "green");
  assert.equal(opsStatusLabel("partial"), "部分数据");
  assert.equal(opsStatusLabel("error"), "读取失败");
  assert.equal(opsStatusTone("error"), "amber");
  assert.equal(opsStatusLabel("missing"), "未同步");
  assert.equal(opsStatusTone("missing"), "muted");
  assert.equal(opsStatusLabel("auth_required"), "待授权");
});

test("splitWechatLinks splits on whitespace lines, dedupes and rejects non-http(s)", () => {
  const raw = [
    "https://mp.weixin.qq.com/s/aaa111",
    "", // 空行忽略
    "https://mp.weixin.qq.com/s/aaa111", // 重复去重
    "https://mp.weixin.qq.com/s/bbb222",
    "ftp://mp.weixin.qq.com/s/nope", // 非 http(s) 拒绝
    "随便一段文字", // 拒绝
  ].join("\n");
  const { valid, invalid } = splitWechatLinks(raw);
  assert.deepEqual(valid, ["https://mp.weixin.qq.com/s/aaa111", "https://mp.weixin.qq.com/s/bbb222"]);
  assert.deepEqual(invalid, ["ftp://mp.weixin.qq.com/s/nope", "随便一段文字"]);
  // 同行空格分隔也能拆出 URL；拆出的无协议片段如实拒绝，不猜测补全。
  const spaced = splitWechatLinks("https://mp.weixin.qq.com/s/d1 https://mp.weixin.qq.com/s/d2 tail");
  assert.deepEqual(spaced.valid, ["https://mp.weixin.qq.com/s/d1", "https://mp.weixin.qq.com/s/d2"]);
  assert.deepEqual(spaced.invalid, ["tail"]);
  // 逗号/分号分隔同样支持（粘贴习惯）。
  const comma = splitWechatLinks("https://mp.weixin.qq.com/s/c1，https://mp.weixin.qq.com/s/c2；https://mp.weixin.qq.com/s/c1");
  assert.deepEqual(comma.valid, ["https://mp.weixin.qq.com/s/c1", "https://mp.weixin.qq.com/s/c2"]);
  assert.deepEqual(splitWechatLinks("   ").valid, []);
  assert.deepEqual(splitWechatLinks("   ").invalid, []);
});
