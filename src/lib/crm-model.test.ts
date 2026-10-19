import assert from "node:assert/strict";
import test from "node:test";

import {
  actionQueue,
  classifyMaas,
  customerLifecycle,
  customersByGaap,
  dingtalkBoard,
  filterFollowupByStage,
  gaapAnomalies,
  gaapAnomaly,
  lifecycleBoard,
  overviewBoard,
  parseLocalTime,
  pplFollowupBoard,
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

test("completed todos never enter the action queue while legacy snapshots still count", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const queue = actionQueue({
    todos: [
      { id: "done-overdue", title: "已完成但逾期", priority: 40, dueAt: now - 3_600_000, done: true },
      { id: "done-today", title: "已完成今天", priority: 40, dueAt: now + 3_600_000, done: true },
      { id: "legacy", title: "旧快照无状态", priority: 20, dueAt: now - 3_600_000 },
      { id: "pending", title: "未完成今天", priority: 20, dueAt: now + 3_600_000 },
    ],
    agenda: [],
    mentions: [],
  }, now);
  assert.deepEqual(queue.map((item) => item.id), ["todo:legacy", "todo:pending"]);
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

// --- GAAP 异动分析 ---

// 夹具默认上月基数 100 万（高于 30 万低基数门槛），涨跌额直接给 yesterdayGaapDiff。
function gaapCustomer(overrides: Partial<CustomerItem>): CustomerItem {
  return customer({
    cid: "C1",
    lastMonthGaap: 1_000_000,
    yesterdayGaap: 120_000,
    yesterdayGaapRate: 20,
    yesterdayGaapDiff: 20_000,
    ...overrides,
  });
}

test("gaap anomaly rate boundaries: 49.9 stays silent, 50.0 and 50.1 hit T3", () => {
  const below = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 49.9, yesterdayGaapDiff: 1_000 }));
  assert.equal(below, null);
  const at = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 50, yesterdayGaapDiff: 1_000 }));
  assert.equal(at?.tier, "T3");
  assert.equal(at?.direction, "up");
  const above = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 50.1, yesterdayGaapDiff: 1_000 }));
  assert.equal(above?.tier, "T3");
});

test("gaap anomaly absolute boundaries: 4.99万 silent, 5万 T1, 30万 T2", () => {
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 49_999 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 50_000 }))?.tier, "T1");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 299_999 }))?.tier, "T1");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 300_000 }))?.tier, "T2");
});

test("gaap anomaly reports both directions and takes the highest tier on multi-hit", () => {
  const down = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -55, yesterdayGaapDiff: -60_000 }));
  assert.equal(down?.direction, "down");
  assert.equal(down?.tier, "T3"); // 环比档 T3 高于绝对档 T1
  const both = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 80, yesterdayGaapDiff: 400_000 }));
  assert.equal(both?.tier, "T3"); // T3(环比) + T2(绝对) 同时命中取最高档 T3
});

test("gaap anomaly stays silent on null rate, zero rate and missing yesterday value", () => {
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: null })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 0, yesterdayGaapDiff: 600_000 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaap: null, yesterdayGaapRate: 60 })), null);
});

test("low base suppresses absolute tiers but keeps the rate tier flagged as low base", () => {
  // 基数 10 万 < 30 万门槛：绝对档不上报。
  assert.equal(gaapAnomaly(gaapCustomer({ lastMonthGaap: 100_000, yesterdayGaapRate: 5, yesterdayGaapDiff: 100_000 })), null);
  // 环比档仍上报，但标「低基数」。
  const lowBase = gaapAnomaly(gaapCustomer({ lastMonthGaap: 100_000, yesterdayGaapRate: 60, yesterdayGaapDiff: 100_000 }));
  assert.equal(lowBase?.tier, "T3");
  assert.equal(lowBase?.lowBase, true);
  const normalBase = gaapAnomaly(gaapCustomer({ lastMonthGaap: 1_000_000, yesterdayGaapRate: 60 }));
  assert.equal(normalBase?.lowBase, false);
});

test("gaap anomaly derives diff from rate for old snapshots and marks it estimated", () => {
  // 旧快照无 yesterdayGaapDiff：diff = yesterdayGaap × r ÷ (1+r)。
  const estimated = gaapAnomaly(gaapCustomer({ yesterdayGaapDiff: undefined, yesterdayGaap: 1_600, yesterdayGaapRate: 60 }));
  assert.equal(estimated?.tier, "T3");
  assert.equal(estimated?.estimatedDiff, true);
  assert.equal(estimated?.diff, 600);
  const explicit = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 60, yesterdayGaapDiff: 20_000 }));
  assert.equal(explicit?.estimatedDiff, false);
  assert.equal(explicit?.diff, 20_000);
});

test("gaap anomalies return exactly the expected set, ordered by tier then |rate|", () => {
  const alerts = gaapAnomalies([
    // T3 暴跌（|rate| 80）
    gaapCustomer({ cid: "C1", name: "甲公司", yesterdayGaapRate: -80, yesterdayGaapDiff: -30_000 }),
    // T3 暴增（|rate| 120）→ 排在 C1 前
    gaapCustomer({ cid: "C2", name: "乙公司", yesterdayGaapRate: 120, yesterdayGaapDiff: 10_000 }),
    // T2（绝对 30 万）
    gaapCustomer({ cid: "C3", name: "丙公司", yesterdayGaapRate: 8, yesterdayGaapDiff: 310_000 }),
    // T1（绝对 5 万）
    gaapCustomer({ cid: "C4", name: "丁公司", yesterdayGaapRate: 3, yesterdayGaapDiff: 51_000 }),
    // 不上报：无环比 / 环比为 0 / 幅度未达阈值 / 缺昨日值
    gaapCustomer({ cid: "C5", name: "戊公司", yesterdayGaapRate: null }),
    gaapCustomer({ cid: "C6", name: "己公司", yesterdayGaapRate: 0 }),
    gaapCustomer({ cid: "C7", name: "庚公司", yesterdayGaapRate: 10, yesterdayGaapDiff: 1_000 }),
    gaapCustomer({ cid: "C8", name: "辛公司", yesterdayGaapRate: 90, yesterdayGaap: null }),
  ]);
  // 集合与预期完全相等（不漏不误报），顺序 = 档位降序、同档 |rate| 降序。
  assert.deepEqual(alerts.map((alert) => [alert.customer.cid, alert.tier, alert.direction]), [
    ["C2", "T3", "up"],
    ["C1", "T3", "down"],
    ["C3", "T2", "up"],
    ["C4", "T1", "up"],
  ]);
});

// --- PPL 跟进视图 ---

function followupFixture() {
  const customers = [
    customer({ cid: "C1", name: "示例模型服务公司", lastMonthGaap: 500 }),
    customer({ cid: "C2", name: "示例传统公司", lastMonthGaap: 300 }),
    customer({ cid: "C3", name: "示例无项目公司", lastMonthGaap: 0 }),
  ];
  const projects = [
    project({ id: "P1", cid: "C1", name: "FY27-示例模型服务公司-大模型平台", stageName: "技术方案", price: 100 }),
    project({ id: "P2", cid: "C1", name: "FY27-示例模型服务公司-推理服务", stageName: "商务谈判", price: 200 }),
    project({ id: "P3", cid: "C2", name: "FY27-示例传统公司-混合云迁移", stageName: "技术方案", price: 50 }),
    // 项目无 cid、客户名能对上 → 归属 C2（不能静默丢弃）。
    project({ id: "P4", cid: null, customerName: "示例传统公司", name: "FY27-示例传统公司-资源上量", stageName: "开始上量" }),
    // 客户名/cid 均对不上 → 未匹配区。
    project({ id: "P5", cid: "C99", customerName: "未知客户", name: "FY27-未知客户-POC", stageName: "技术方案" }),
  ];
  return { customers, projects };
}

test("ppl followup board groups every project exactly once and conserves counts", () => {
  const { customers, projects } = followupFixture();
  const board = pplFollowupBoard({ customers, projects });
  // 每个项目恰好出现一次：泳道内 + 未匹配 = 全量。
  const seen = [
    ...board.lanes.maas, ...board.lanes.non_maas, ...board.lanes.unconfirmed,
  ].flatMap((row) => row.projects.map((project) => project.id));
  seen.push(...board.unmatched.map((project) => project.id));
  assert.deepEqual([...seen].sort(), [...projects.map((project) => project.id)].sort());
  assert.equal(new Set(seen).size, seen.length); // 无重复
  // 三泳道客户计数之和 = 客户总数（含无项目客户）。
  assert.equal(board.counts.maas + board.counts.nonMaas + board.counts.unconfirmed, customers.length);
  assert.equal(board.counts.projects, projects.length);
  assert.equal(board.counts.unmatched, 1);
  assert.deepEqual(board.unmatched.map((project) => project.id), ["P5"]);
  // C1（项目名含「大模型/推理」关键词）→ MaaS 疑似；C2/C3 无法判定 → 未分类，不硬二分。
  assert.deepEqual(board.lanes.maas.map((row) => row.customer.cid), ["C1"]);
  assert.deepEqual(board.lanes.non_maas, []);
  assert.deepEqual([...board.lanes.unconfirmed].map((row) => row.customer.cid).sort(), ["C2", "C3"]);
});

test("maas classification: override wins, keyword hits are suspected, cate is never used", () => {
  const { customers, projects } = followupFixture();
  // 人工覆盖：C2 → non_maas（优先级最高，可审计）。
  const board = pplFollowupBoard({ customers, projects }, { C2: "non_maas", C3: "maas" });
  assert.equal(board.lanes.maas.map((row) => row.customer.cid).join(), "C1,C3");
  assert.equal(board.lanes.non_maas.map((row) => row.customer.cid).join(), "C2");
  assert.equal(board.lanes.maas[0]!.maas.basis, "keyword"); // 初筛命中 → 疑似
  assert.equal(board.lanes.maas[1]!.maas.basis, "override");
  assert.equal(board.lanes.non_maas[0]!.maas.basis, "override");
  // cate（混合云/公有云/国际）与 MaaS 无关：客户/项目名无关键词时 cate 不参与判定。
  const cateOnly = classifyMaas(customer({ cid: "C4", name: "示例公司" }), [project({ id: "P9", name: "示例-混合云", cate: "HYBRID" })]);
  assert.equal(cateOnly.status, "unconfirmed");
  assert.equal(cateOnly.basis, "none");
  // 客户名命中也算初筛（无项目时）。
  const byName = classifyMaas(customer({ cid: "C5", name: "示例百炼科技" }), []);
  assert.equal(byName.status, "maas");
  assert.equal(byName.basis, "keyword");
});

test("stage filter conserves project counts and hides customers without matches", () => {
  const { customers, projects } = followupFixture();
  const board = pplFollowupBoard({ customers, projects });
  const filtered = filterFollowupByStage(board, "技术方案");
  // 守恒：可见项目（泳道）+ 未匹配 = 该阶段项目总数。
  const visible = Object.values(filtered.lanes)
    .reduce((sum, lane) => sum + lane.reduce((count, row) => count + row.projects.length, 0), 0);
  const expected = projects.filter((project) => project.stageName === "技术方案").length;
  assert.equal(visible + filtered.unmatched.length, expected);
  // 无该阶段项目的客户被隐藏（C3 本来就无项目）。
  const shownCids = Object.values(filtered.lanes).flatMap((lane) => lane.map((row) => row.customer.cid));
  assert.deepEqual([...shownCids].sort(), ["C1", "C2"]);
  // null（全部阶段）原样返回，不改计数。
  assert.equal(filterFollowupByStage(board, null), board);
});


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
