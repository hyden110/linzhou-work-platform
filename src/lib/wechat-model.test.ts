import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWechatQrTree,
  filterWechatGroups,
  groupWechatTodosByUrgency,
  sortWechatGroups,
  sortWechatTodos,
  unrepliedWechatSingles,
  wechatCustomerOptions,
  wechatGroupActivity,
  WECHAT_UNBOUND_KEY,
  type WechatGroupView,
  type WechatSingleView,
  type WechatTodoView,
} from "./wechat-model.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：群 id 一律 syn-*@chatroom、群名「合成群X」、客户「甲科技（合成）」等；
// 零真实微信数据。派生函数一律不可变：调用前后夹具深比较不变。
// ---------------------------------------------------------------------------

const T0 = 1_760_000_000; // 固定秒级时间戳，纯排序不依赖真实时钟

function group(over: Partial<WechatGroupView> & { id: string; name: string }): WechatGroupView {
  return {
    memberCount: 10,
    muted: false,
    unread: 0,
    lastMsgAt: T0,
    lastSummaryMasked: "",
    custKeys: [],
    customerStatus: "pending",
    bindNote: "",
    msg: { d7: 0, d30: 0, dWin: 0, all: 0 },
    senders: { d7: 0, d30: 0, all: 0 },
    mine: { d7: 0, d30: 0, all: 0, lastAt: 0 },
    atMe: { all: 0, lastAt: 0, daysSince: null, unreplied: false },
    recentAtMe: [],
    ...over,
  };
}

function todo(over: Partial<WechatTodoView> & { groupId: string }): WechatTodoView {
  return {
    groupName: "合成群A",
    custKeys: [],
    urgency: "low",
    daysSince: 1,
    at: T0,
    fromName: "合成同事",
    textMasked: "合成消息…",
    ...over,
  };
}

function single(over: Partial<WechatSingleView> & { idMasked: string; name: string }): WechatSingleView {
  return {
    muted: false,
    msg: { d7: 0, d30: 0, all: 0 },
    lastMsgAt: T0,
    unread: 0,
    lastSummaryMasked: "",
    unreplied: false,
    ...over,
  };
}

test("sortWechatTodos: urgency rank 优先，同紧急度按 daysSince 降序，输入不被改动", () => {
  const todos = [
    todo({ groupId: "syn-g1@chatroom", urgency: "overdue", daysSince: 40 }),
    todo({ groupId: "syn-g2@chatroom", urgency: "high", daysSince: 1 }),
    todo({ groupId: "syn-g3@chatroom", urgency: "high", daysSince: 2 }),
    todo({ groupId: "syn-g4@chatroom", urgency: "mid", daysSince: 5 }),
    todo({ groupId: "syn-g5@chatroom", urgency: "low", daysSince: 20 }),
  ];
  const frozen = JSON.parse(JSON.stringify(todos));
  const sorted = sortWechatTodos(todos);
  assert.deepEqual(todos, frozen, "输入数组不被改动（不可变）");
  assert.deepEqual(
    sorted.map((t) => t.groupId),
    ["syn-g3@chatroom", "syn-g2@chatroom", "syn-g4@chatroom", "syn-g5@chatroom", "syn-g1@chatroom"],
    "high(2天) → high(1天) → mid → low → overdue（donor urgencyRank + daysSince 降序）",
  );
});

test("groupWechatTodosByUrgency: 按 high/mid/low/overdue 分区，空区省略，标签照 donor", () => {
  const todos = [
    todo({ groupId: "syn-g1@chatroom", urgency: "low", daysSince: 10 }),
    todo({ groupId: "syn-g2@chatroom", urgency: "high", daysSince: 2 }),
    todo({ groupId: "syn-g3@chatroom", urgency: "high", daysSince: 1 }),
  ];
  const grouped = groupWechatTodosByUrgency(todos);
  assert.deepEqual(grouped.map((g) => g.urgency), ["high", "low"], "mid/overdue 空区省略");
  assert.equal(grouped[0].label, "高（≤2天）");
  assert.deepEqual(grouped[0].items.map((t) => t.groupId), ["syn-g2@chatroom", "syn-g3@chatroom"], "区内已排序");
});

test("unrepliedWechatSingles: 只留 unreplied，lastMsgAt 降序", () => {
  const singles = [
    single({ idMasked: "wxid…aaaaaa", name: "合成联系人A", unreplied: true, lastMsgAt: T0 - 100 }),
    single({ idMasked: "wxid…bbbbbb", name: "合成联系人B", unreplied: false, lastMsgAt: T0 }),
    single({ idMasked: "wxid…cccccc", name: "合成联系人C", unreplied: true, lastMsgAt: T0 - 10 }),
  ];
  const rows = unrepliedWechatSingles(singles);
  assert.deepEqual(rows.map((s) => s.name), ["合成联系人C", "合成联系人A"], "最近的未回排最前");
});

test("wechatGroupActivity: d7>0 hot / d30>0 active / 其余 quiet", () => {
  const base = group({ id: "syn-g1@chatroom", name: "合成群A" });
  assert.equal(wechatGroupActivity({ ...base, msg: { ...base.msg, d7: 3, d30: 9 } }), "hot");
  assert.equal(wechatGroupActivity({ ...base, msg: { ...base.msg, d7: 0, d30: 9 } }), "active");
  assert.equal(wechatGroupActivity({ ...base, msg: { ...base.msg, d7: 0, d30: 0 } }), "quiet");
});

test("sortWechatGroups: at 键 = 未回优先 → @我累计 → 最后消息（donor ledgerRows 口径）", () => {
  const groups = [
    group({ id: "syn-g1@chatroom", name: "合成群A", lastMsgAt: T0 - 300, atMe: { all: 5, lastAt: T0, daysSince: 1, unreplied: false } }),
    group({ id: "syn-g2@chatroom", name: "合成群B", lastMsgAt: T0 - 200, atMe: { all: 2, lastAt: T0, daysSince: 1, unreplied: true } }),
    group({ id: "syn-g3@chatroom", name: "合成群C", lastMsgAt: T0 - 100, atMe: { all: 9, lastAt: T0, daysSince: 1, unreplied: false } }),
  ];
  assert.deepEqual(
    sortWechatGroups(groups, "at").map((g) => g.id),
    ["syn-g2@chatroom", "syn-g3@chatroom", "syn-g1@chatroom"],
    "未回的 syn-g2 最前；其余按 @我累计降序",
  );
  const byD30 = sortWechatGroups(
    [
      group({ id: "syn-g1@chatroom", name: "合成群A", msg: { d7: 1, d30: 10, dWin: 20, all: 30 } }),
      group({ id: "syn-g2@chatroom", name: "合成群B", msg: { d7: 1, d30: 99, dWin: 20, all: 30 } }),
    ],
    "d30",
  );
  assert.deepEqual(byD30.map((g) => g.id), ["syn-g2@chatroom", "syn-g1@chatroom"]);
});

test("filterWechatGroups: scope related/active/all + 客户键 + 搜索（群名/群ID/客户键，大小写不敏感）", () => {
  const groups = [
    group({ id: "syn-g1@chatroom", name: "合成群Alpha", custKeys: ["甲科技（合成）"], customerStatus: "matched", msg: { d7: 0, d30: 0, dWin: 0, all: 0 } }),
    group({ id: "syn-g2@chatroom", name: "合成群B", msg: { d7: 0, d30: 5, dWin: 5, all: 5 } }),
    group({ id: "syn-g3@chatroom", name: "合成群C" }),
  ];
  assert.deepEqual(filterWechatGroups(groups, { scope: "related" }).map((g) => g.id), ["syn-g1@chatroom"]);
  assert.deepEqual(filterWechatGroups(groups, { scope: "active" }).map((g) => g.id), ["syn-g1@chatroom", "syn-g2@chatroom"], "active = 近30天有消息或有绑定");
  assert.equal(filterWechatGroups(groups, { scope: "all" }).length, 3);
  assert.deepEqual(filterWechatGroups(groups, { scope: "all", custKey: "甲科技（合成）" }).map((g) => g.id), ["syn-g1@chatroom"]);
  assert.deepEqual(filterWechatGroups(groups, { scope: "all", query: "ALPHA" }).map((g) => g.id), ["syn-g1@chatroom"], "大小写不敏感命中群名");
  assert.deepEqual(filterWechatGroups(groups, { scope: "all", query: "syn-g2" }).map((g) => g.id), ["syn-g2@chatroom"], "命中群ID");
  assert.deepEqual(filterWechatGroups(groups, { scope: "all", query: "甲科技" }).map((g) => g.id), ["syn-g1@chatroom"], "命中客户键");
  assert.equal(filterWechatGroups(groups, {}).length, 3, "无 filter = 全部");
});

test("wechatCustomerOptions: 按群数降序、同数按键名升序", () => {
  const groups = [
    group({ id: "syn-g1@chatroom", name: "合成群A", custKeys: ["乙咨询（合成）", "甲科技（合成）"] }),
    group({ id: "syn-g2@chatroom", name: "合成群B", custKeys: ["甲科技（合成）"] }),
  ];
  assert.deepEqual(wechatCustomerOptions(groups), [
    { key: "甲科技（合成）", count: 2 },
    { key: "乙咨询（合成）", count: 1 },
  ]);
});

test("buildWechatQrTree: 客户桶聚合 + 多客户群出现在每个客户下 + 未绑定桶恒排最后", () => {
  const groups = [
    group({
      id: "syn-g1@chatroom", name: "合成群A", custKeys: ["甲科技（合成）"], customerStatus: "confirmed",
      msg: { d7: 2, d30: 20, dWin: 30, all: 40 }, atMe: { all: 3, lastAt: T0, daysSince: 1, unreplied: true },
    }),
    group({
      id: "syn-g2@chatroom", name: "合成群B", custKeys: ["甲科技（合成）", "乙咨询（合成）"], customerStatus: "matched",
      msg: { d7: 0, d30: 7, dWin: 7, all: 7 },
    }),
    group({ id: "syn-g3@chatroom", name: "合成群C", msg: { d7: 0, d30: 99, dWin: 99, all: 99 } }),
  ];
  const nodes = buildWechatQrTree(groups);
  assert.deepEqual(nodes.map((n) => n.key), ["甲科技（合成）", "乙咨询（合成）", WECHAT_UNBOUND_KEY], "群数多的客户在前，未绑定最后");
  const jia = nodes[0];
  assert.equal(jia.kind, "cust");
  assert.equal(jia.groups, 2);
  assert.equal(jia.awaiting, 1, "未回 @我 的群计数");
  assert.equal(jia.msgD30, 27, "子群 d30 求和");
  assert.deepEqual(jia.children.map((c) => c.groupId), ["syn-g1@chatroom", "syn-g2@chatroom"], "未回的排最前");
  assert.equal(jia.children[0].unreplied, true);
  const unbound = nodes[2];
  assert.equal(unbound.kind, "unbound");
  assert.equal(unbound.name, "未绑定客户");
  assert.deepEqual(unbound.children.map((c) => c.groupId), ["syn-g3@chatroom"]);
  assert.deepEqual(buildWechatQrTree([]), [], "空输入 → 空树");
});

test("buildWechatQrTree: 未绑定桶即使消息最多也排最后（客户优先口径）", () => {
  const groups = [
    group({ id: "syn-g1@chatroom", name: "合成群A", msg: { d7: 0, d30: 500, dWin: 500, all: 500 } }),
    group({ id: "syn-g2@chatroom", name: "合成群B", custKeys: ["甲科技（合成）"], msg: { d7: 0, d30: 1, dWin: 1, all: 1 } }),
  ];
  assert.deepEqual(buildWechatQrTree(groups).map((n) => n.key), ["甲科技（合成）", WECHAT_UNBOUND_KEY]);
});
