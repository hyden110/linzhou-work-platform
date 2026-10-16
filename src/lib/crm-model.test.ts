import assert from "node:assert/strict";
import test from "node:test";

import {
  actionQueue,
  customerLifecycle,
  customersByGaap,
  dingtalkBoard,
  lifecycleBoard,
  overviewBoard,
  parseLocalTime,
  projectStage,
  topBoard,
} from "./crm-model.ts";
import type { CustomerItem, ProjectItem, SourceStatus } from "./crm-types.ts";

function customer(overrides: Partial<CustomerItem>): CustomerItem {
  return {
    cid: "C1", name: "示例科技有限公司", industry: null, area: null, level: null, formal: null, opportunity: null,
    lastMonthGaap: null, yesterdayGaap: null, yesterdayGaapRate: null, lastNoteAt: null, relatedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectItem>): ProjectItem {
  return {
    id: "P1", name: "项目", customerName: null, cid: "C1", stage: null, stageName: null, price: null, cate: null,
    state: "PROJECT_STATE_NORMAL", winRate: null, expectedContractDate: null, expectedGaapStartDate: null, createdAt: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceStatus>): SourceStatus {
  return {
    status: "ok", error: null, fetchedAt: null, lastSuccessAt: null, count: 0, complete: true, stale: false,
    ...overrides,
  };
}

test("project stage falls back to keywords and win rate when the code is unknown", () => {
  assert.equal(projectStage(project({ stageName: "商务谈判" })), "C");
  assert.equal(projectStage(project({ stageName: "商务方案" })), "C");
  assert.equal(projectStage(project({ stageName: "POC 测试" })), "B");
  assert.equal(projectStage(project({ stageName: "需求挖掘", winRate: 60 })), "C");
  assert.equal(projectStage(project({ stageName: "需求挖掘", winRate: 20 })), "B");
  assert.equal(projectStage(project({ stageName: "需求挖掘", winRate: 10 })), "A");
});

// Codes read back from 鲲鹏 projectStage on 2026-10-14; the stage code outranks
// win rate because most 潜在商机 projects carry a 10% default.
test("real 鲲鹏 stage codes drive the board", () => {
  const labelled = (stage: string, stageName: string) => project({ stage, stageName, winRate: 10 });
  assert.equal(projectStage(labelled("1", "潜在商机")), "A");
  assert.equal(projectStage(labelled("2", "商机确认")), "A");
  assert.equal(projectStage(labelled("3", "技术方案")), "B");
  assert.equal(projectStage(labelled("4", "商务谈判")), "C");
  assert.equal(projectStage(labelled("5", "商务方案")), "C");
  assert.equal(projectStage(labelled("6", "开始上量")), "C");
  assert.equal(projectStage(labelled("6", "资源上量")), "C");
  assert.equal(projectStage(labelled("7", "签约完成")), "C");
  assert.equal(projectStage(labelled("10", "收入确认")), "D");
  assert.equal(projectStage(labelled("11", "上量结束")), "D");
  assert.equal(projectStage(project({ stage: "99", winRate: 10 })), "A");
});

test("a customer whose only project closed at 上量结束 is operating, not a lead", () => {
  const result = customerLifecycle(customer({ lastMonthGaap: 1000 }), [
    project({ id: "a", stage: "11", stageName: "上量结束", winRate: 100, state: "PROJECT_STATE_COMPLETED" }),
  ]);
  assert.equal(result.stage, "D");
  assert.equal(result.activeProjects.length, 0);
});

test("an active 上量结束 project is already landed and counts as operating", () => {
  const result = customerLifecycle(customer({ lastMonthGaap: 1000 }), [
    project({ id: "a", stage: "11", stageName: "上量结束", winRate: 100 }),
  ]);
  assert.equal(result.stage, "D");
});

test("lifecycle picks the furthest active project and separates operating customers", () => {
  const base = customer({ lastMonthGaap: 1000 });
  const result = customerLifecycle(base, [
    project({ id: "a", stageName: "方案设计" }),
    project({ id: "b", stageName: "合同签约" }),
    project({ id: "c", stageName: "合同签约", state: "PROJECT_STATE_COMPLETED" }),
  ]);
  assert.equal(result.stage, "C");
  assert.equal(result.leadProject?.id, "b");
  assert.equal(result.activeProjects.length, 2);
  assert.equal(customerLifecycle(base, []).stage, "D");
  assert.equal(customerLifecycle(customer({ lastMonthGaap: 0 }), []).stage, "A");
});

test("lifecycle board sums GAAP per stage and matches projects by name when cid is absent", () => {
  const columns = lifecycleBoard({
    customers: [
      customer({ cid: "C1", name: "甲公司", lastMonthGaap: 300 }),
      customer({ cid: "C2", name: "乙公司", lastMonthGaap: 500 }),
      customer({ cid: "C3", name: "丙公司" }),
    ],
    projects: [project({ cid: null, customerName: "丙公司", stageName: "POC" })],
  });
  const byId = Object.fromEntries(columns.map((column) => [column.stage.id, column]));
  assert.deepEqual(byId.D!.customers.map((row) => row.customer.cid), ["C2", "C1"]);
  assert.equal(byId.D!.gaap, 800);
  assert.deepEqual(byId.B!.customers.map((row) => row.customer.cid), ["C3"]);
});

test("action queue orders overdue, today and upcoming items", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const queue = actionQueue({
    todos: [
      { id: "t1", title: "逾期", priority: 20, dueAt: now - 3_600_000 },
      { id: "t0", title: "久远逾期", priority: 20, dueAt: now - 90 * 86_400_000 },
      { id: "t2", title: "远期", priority: 20, dueAt: now + 10 * 86_400_000 },
      { id: "t3", title: "无期高优", priority: 40, dueAt: null },
      { id: "t4", title: "无期普通", priority: 20, dueAt: null },
    ],
    agenda: [
      { id: "e1", title: "下午会", start: "2026-10-14 15:00", end: "2026-10-14 16:00" },
      { id: "e2", title: "已结束", start: "2026-10-14 08:00", end: "2026-10-14 09:00" },
      { id: "e3", title: "明天会", start: "2026-10-15 09:00", end: "2026-10-15 10:00" },
    ],
    mentions: [],
  }, now);
  assert.deepEqual(queue.map((item) => item.id), ["todo:t1", "todo:t0", "meeting:e1", "meeting:e3", "todo:t3"]);
  assert.deepEqual(queue.map((item) => item.urgency), ["overdue", "overdue", "today", "soon", "watch"]);
});

test("mentions become newest-first actions graded by recency", () => {
  const now = parseLocalTime("2026-10-15 10:00")!;
  const mention = (id: string, time: string, overrides: Record<string, string | null> = {}) => ({
    id, conversationId: "g1", conversationName: "客户群", sender: "甲", text: `@${id}`, time, ...overrides,
  });
  const queue = actionQueue({
    todos: [],
    agenda: [],
    mentions: [
      mention("m1", "2026-10-15 09:00"),
      mention("m2", "2026-10-14 09:00"),
      mention("m3", "2026-10-11 09:00", { conversationName: null, sender: null }),
      mention("m4", "2026-10-15 08:00"),
    ],
  }, now);
  assert.deepEqual(queue.map((item) => item.id), ["mention:m1", "mention:m4", "mention:m2", "mention:m3"]);
  assert.deepEqual(queue.map((item) => item.urgency), ["today", "today", "soon", "watch"]);
  assert.equal(queue[0]!.detail, "客户群 · 甲");
  assert.equal(queue[3]!.detail, "钉钉 @我");
});

test("mentions queue after time-bound items within the same urgency band", () => {
  const now = parseLocalTime("2026-10-15 10:00")!;
  const queue = actionQueue({
    todos: [{ id: "t1", title: "今天到期", priority: 20, dueAt: parseLocalTime("2026-10-15 18:00") }],
    agenda: [],
    mentions: [{ id: "m1", conversationId: "g1", conversationName: "客户群", sender: "甲", text: "@你开会", time: "2026-10-15 09:00" }],
  }, now);
  assert.deepEqual(queue.map((item) => item.kind), ["todo", "mention"]);
});

// --- 客户盘面 ---

test("overview board reads the real data value and keeps missing metrics empty", () => {
  const board = overviewBoard({
    customers: [customer({ cid: "C1" }), customer({ cid: "C2", lastMonthGaap: 300 })],
    overview: [
      { id: "25", label: "客户数", value: 2, unit: "个", category: null },
      { id: "26", label: "昨日GAAP", value: 1200, unit: "元", category: "支付口径" },
      { id: "28", label: "日GAAP环比", value: 5.5, unit: "%", category: "支付口径" },
    ],
  });
  assert.equal(board.customerCount, 2);
  assert.equal(board.customerCountMatches, true);
  assert.equal(board.yesterdayGaap, 1200);
  assert.equal(board.payBasis, true);
  assert.equal(board.lastMonthGaapSum, 300);
  // 缺失指标必须是 null，不允许回退到别的数字凑数
  assert.equal(board.projectCount, null);
  assert.equal(board.yesterdayGaapDiff, null);
});

test("overview board flags a customer-count mismatch for the UI to show", () => {
  const board = overviewBoard({
    customers: [customer({}), customer({ cid: "C2" }), customer({ cid: "C3" })],
    overview: [{ id: "25", label: "客户数", value: 25, unit: "个", category: null }],
  });
  assert.equal(board.customerCountMatches, false);
});

test("top board turns 鲲鹏 self-check failures into a visible warning", () => {
  const item = { rank: 1, cid: "C1", name: "甲公司", industry: null, area: null, level: "GC7", lastMonthGaap: 10, yesterdayGaap: 1 };
  const ok = topBoard({
    top: [item],
    sources: { top: source({ total: 35, queriedAt: "2026-10-15 13:53:51", checks: { gaapMonotonicDesc: true, countWithinLimit: true } }) },
  });
  assert.equal(ok.checksOk, true);
  assert.equal(ok.queriedAt, "2026-10-15 13:53:51");
  const bad = topBoard({
    top: [item],
    sources: { top: source({ checks: { gaapMonotonicDesc: false, countWithinLimit: true } }) },
  });
  assert.equal(bad.checksOk, false);
});

test("customers are listed by last month GAAP descending", () => {
  const rows = customersByGaap([
    customer({ cid: "C1", lastMonthGaap: 1 }),
    customer({ cid: "C2", lastMonthGaap: 3 }),
    customer({ cid: "C3", lastMonthGaap: 2 }),
    customer({ cid: "C4" }),
  ]);
  assert.deepEqual(rows.map((row) => row.cid), ["C2", "C3", "C1", "C4"]);
});

// --- 钉群盘面 ---

test("dingtalk links groups to customers by normalized name", () => {
  const board = dingtalkBoard({
    customers: [
      customer({ cid: "C1", name: "示例科技有限公司", lastMonthGaap: 300 }),
      customer({ cid: "C2", name: "测试客户", lastMonthGaap: 100 }),
      customer({ cid: "C3", name: "无客户群", lastMonthGaap: 200 }),
    ],
    groups: [
      { id: "g1", name: "示例科技 有限公司", type: "NORMAL_GROUP", memberCount: 10 },
      { id: "g2", name: "POC支撑-测试客户联调群", type: "INTERNAL_GROUP", memberCount: 8 },
      { id: "g3", name: "内部闲聊群", type: "NORMAL_GROUP", memberCount: 5 },
      { id: "g4", name: "示例科技有限公司-服务群", type: "NORMAL_GROUP", memberCount: 6 },
    ],
    mentions: [],
    unread: [],
  });
  // 精确与「客户名完整前后缀」按已关联；仅中缀包含只能是疑似。
  assert.deepEqual(board.links.map((link) => [link.group.id, link.customer.cid, link.status]), [
    ["g1", "C1", "linked"],
    ["g2", "C2", "unconfirmed"],
    ["g4", "C1", "linked"],
  ]);
  assert.deepEqual(board.unlinked.map((group) => group.id), ["g3"]);
  assert.deepEqual(board.missingCustomers.map((row) => row.cid), ["C3"]);
});

test("dingtalk sorts mentions newest first and passes unread through", () => {
  const mention = (id: string, time: string | null) => ({
    id, conversationId: "g1", conversationName: "客户群", sender: "甲", text: `@${id}`, time,
  });
  const board = dingtalkBoard({
    customers: [],
    groups: [],
    mentions: [mention("m1", "2026-10-10 09:00"), mention("m2", "2026-10-15 09:00"), mention("m3", null)],
    unread: [{ id: "u1", name: "未读群" }, { id: "u2", name: null }],
  });
  assert.deepEqual(board.mentions.map((row) => row.id), ["m2", "m1", "m3"]);
  assert.deepEqual(board.unread, [{ id: "u1", name: "未读群" }, { id: "u2", name: null }]);
});
