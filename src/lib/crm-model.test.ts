import assert from "node:assert/strict";
import test from "node:test";

import {
  actionKey,
  buildActionFeed,
  loadTriage,
  normalizeTriage,
  parseDayOnly,
  pruneTriage,
  saveTriage,
  setTriageState,
  triageStateOf,
  type TriageMap,
  type TriageStorage,
} from "./action-feed.ts";
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
import type { CrmSnapshot, CustomerItem, ProjectItem, SourceStatus } from "./crm-types.ts";

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

// --- 统一行动队列：PPL 临近节点 + 本机 triage ---
// 以下用例全部使用合成客户（甲科技有限公司 / 乙股份有限公司）与虚构项目名，不含真实客户数据。

const DAY = 86_400_000;

/** 行动队列专用夹具：固定「今天 = 2026-10-14」，节点日期全部围绕该日合成。 */
function queueFixture(projects: ProjectItem[]) {
  return {
    todos: [],
    agenda: [],
    mentions: [],
    customers: [
      customer({ cid: "C1", name: "甲科技有限公司" }),
      customer({ cid: "C2", name: "乙股份有限公司" }),
    ],
    projects,
  };
}

function fakeStorage(initial: string | null): TriageStorage & { snapshot: () => string | null } {
  let data = initial;
  return {
    getItem: () => data,
    setItem: (_key: string, value: string) => { data = value; },
    snapshot: () => data,
  };
}

test("ppl queue takes the nearest node within ±7 days and skips everything else", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const feed = buildActionFeed(queueFixture([
    // 双节点都入窗：取距今天最近的「起量 +2」，不是「签约 +5」。
    project({ id: "P1", cid: "C1", name: "FY27-甲科技-大模型平台", expectedContractDate: "2026-10-19", expectedGaapStartDate: "2026-10-16" }),
    // 只有一个节点且在窗外（+8）：不进队。
    project({ id: "P2", cid: "C1", name: "FY27-甲科技-资源上量", expectedContractDate: "2026-10-22" }),
    // -7 天边界：在窗内，算已逾期节点。
    project({ id: "P3", cid: "C1", name: "FY27-甲科技-推理服务", expectedContractDate: "2026-10-07" }),
    // -8 天窗外：不进队。
    project({ id: "P4", cid: "C1", name: "FY27-甲科技-历史项目", expectedGaapStartDate: "2026-10-06" }),
    // 已关闭项目：即使日期入窗也不进队（队列只收还要行动的项目）。
    project({ id: "P5", cid: "C1", name: "FY27-甲科技-已关闭", state: "PROJECT_STATE_LOST", expectedGaapStartDate: "2026-10-15" }),
    // 同一客户第二个项目：独立行动，各自成项。
    project({ id: "P6", cid: "C2", name: "FY27-乙股份-混合云", expectedContractDate: "2026-10-20" }),
  ]), { now, triage: {}, showHandled: false });

  const ppl = feed.items.filter((item) => item.kind === "ppl");
  // 桶序 over → today → week：逾期节点在前。
  assert.deepEqual(ppl.map((item) => [item.node, item.days]), [["contract", -7], ["gaap", 2], ["contract", 6]]);
  assert.deepEqual(ppl.map((item) => item.customer), ["甲科技有限公司", "甲科技有限公司", "乙股份有限公司"]);
  assert.deepEqual(ppl.map((item) => item.bucket), ["over", "week", "week"]);
  assert.deepEqual(ppl.map((item) => item.urgency), ["overdue", "soon", "soon"]);
  assert.equal(ppl[1]!.detail.includes("起量 2 天后"), true);
  assert.equal(ppl[0]!.detail.includes("签约 逾期 7 天"), true);
  assert.equal(feed.counts.ppl, 3);
});

test("triage keys are stable across days and the hash part is exactly 14 chars", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const snapshot = queueFixture([
    project({ id: "P1", cid: "C1", name: "FY27-甲科技-大模型平台", expectedContractDate: "2026-10-16" }),
  ]);
  const dayOne = buildActionFeed({
    ...snapshot,
    todos: [{ id: "t1", title: "合成待办", priority: 20, dueAt: now + 3_600_000 }],
  }, { now, triage: {}, showHandled: false });
  const dayTwo = buildActionFeed({
    ...snapshot,
    todos: [{ id: "t1", title: "合成待办", priority: 20, dueAt: now + 3_600_000 }],
  }, { now: now + DAY, triage: {}, showHandled: false });

  const keysOne = dayOne.items.map((item) => item.key).sort();
  const keysTwo = dayTwo.items.map((item) => item.key).sort();
  // 同一快照在 NOW 与 NOW+24h 键完全一致（跨日稳定）。
  assert.deepEqual(keysTwo, keysOne);
  // 键 = 来源前缀 + 恰 14 字符 base36 哈希；不同来源不同前缀。
  for (const key of keysOne) assert.match(key, /^(todo|meeting|mention|ppl):[0-9a-z]{14}$/);
  // 不同输入不碰撞：同一前缀下两个不同条目键不同。
  const pplKeys = dayOne.items.filter((item) => item.kind === "ppl").map((item) => item.key);
  const todoKeys = dayOne.items.filter((item) => item.kind === "todo").map((item) => item.key);
  assert.notDeepEqual(pplKeys, todoKeys);
  assert.equal(new Set(keysOne).size, keysOne.length);
  // 纯函数自身确定：同输入两次调用同键。
  assert.equal(actionKey("ppl", ["P1", "签约", "2026-10-16"]), actionKey("ppl", ["P1", "签约", "2026-10-16"]));
});

test("ppl cap runs after triage: marking the earliest done surfaces the sixth item", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const projects = [1, 2, 3, 4, 5, 6].map((n) =>
    project({ id: `P${n}`, cid: "C1", name: `FY27-甲科技-项目${n}`, expectedContractDate: `2026-10-${14 + n}` }));
  const args = { now, triage: {} as TriageMap, showHandled: false };

  const before = buildActionFeed(queueFixture(projects), args);
  assert.equal(before.counts.ppl, 5); // 6 条 open 只进 5 条
  assert.equal(before.counts.openPpl, 5);
  assert.equal(before.buckets.week.filter((item) => item.kind === "ppl").length, 5);

  // 标记最早一条（+1 天）done → 第 6 条顶上。
  const earliest = [...before.items].filter((item) => item.kind === "ppl")
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))[0]!;
  const triage = setTriageState({}, earliest.key, "done", now);
  const after = buildActionFeed(queueFixture(projects), { ...args, triage });
  assert.equal(after.counts.done, 1);
  assert.equal(after.counts.dealt, 1);
  assert.equal(after.counts.ppl, 6); // 5 open + 1 handled 全量计数
  assert.equal(after.counts.openPpl, 5);
  // 默认隐藏已处理：桶里只有 5 条未处理；tab 计数只算未处理。
  assert.equal(after.buckets.week.length, 5);
  assert.equal(after.counts.week, 5);
  assert.ok(after.buckets.week.every((item) => item.state === null));
  assert.ok(after.buckets.week.some((item) => item.kind === "ppl" && item.days === 6)); // 第 6 条出现了

  // 「显示已处理」展开：6 条全量可见，已处理带状态。
  const expanded = buildActionFeed(queueFixture(projects), { ...args, triage, showHandled: true });
  assert.equal(expanded.buckets.week.length, 6);
  assert.equal(expanded.buckets.week.filter((item) => item.state === "done").length, 1);
});

test("duplicate project+node+date rows dedupe, distinct projects stay, dealt counting survives", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const projects = [
    project({ id: "P1", cid: "C1", name: "FY27-甲科技-大模型平台", expectedContractDate: "2026-10-16" }),
    // 重复行：同项目 + 同节点 + 同日期 → 去重成一条。
    project({ id: "P1", cid: "C1", name: "FY27-甲科技-大模型平台", expectedContractDate: "2026-10-16" }),
    // 同客户另一项目：独立行动，不去重。
    project({ id: "P2", cid: "C1", name: "FY27-甲科技-推理服务", expectedContractDate: "2026-10-17" }),
  ];
  const feed = buildActionFeed(queueFixture(projects), { now, triage: {}, showHandled: false });
  const ppl = feed.items.filter((item) => item.kind === "ppl");
  assert.equal(ppl.length, 2);
  assert.deepEqual(ppl.map((item) => item.days), [2, 3]);

  // 去重后逐条 triage：done + ignored → dealt = 2。
  const triage = setTriageState(setTriageState({}, ppl[0]!.key, "done", now), ppl[1]!.key, "ignored", now);
  const after = buildActionFeed(queueFixture(projects), { now, triage, showHandled: true });
  assert.equal(after.counts.done, 1);
  assert.equal(after.counts.ignored, 1);
  assert.equal(after.counts.dealt, 2);
  assert.equal(after.counts.open, 0);
});

test("malformed dates and triage payloads never throw and degrade to empty", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const feed = buildActionFeed(queueFixture([
    project({ id: "P1", cid: "C1", name: "缺日期" }),
    project({ id: "P2", cid: "C1", name: "自然语言", expectedContractDate: "下周三" }),
    project({ id: "P3", cid: "C1", name: "假日期", expectedGaapStartDate: "2026-02-31" }),
    project({ id: "P4", cid: "C1", name: "超范围月份", expectedContractDate: "2026-13-05" }),
    project({ id: "P5", cid: "C1", name: "空串", expectedGaapStartDate: "" }),
    project({ id: "P6", cid: "C2", name: "带时间前缀", expectedContractDate: "2026-10-16 09:00:00" }),
  ]), { now, triage: {}, showHandled: false });
  // 只有合法的 ISO 日期前缀（+2 天）入队，其余全部静默跳过。
  assert.deepEqual(feed.items.filter((item) => item.kind === "ppl").map((item) => item.days), [2]);

  // 畸形日期解析为 null，不抛错。
  assert.equal(parseDayOnly(null), null);
  assert.equal(parseDayOnly(42), null);
  assert.equal(parseDayOnly("2026-02-30"), null);
  assert.equal(parseDayOnly("2026-10-16T09:00"), parseLocalTime("2026-10-16")!);

  // 畸形 triage 数据：合法条目保留，畸形丢弃，不抛错。
  const normalized = normalizeTriage({
    k1: { s: "done", at: "2026-10-13T00:00:00.000Z" },
    k2: { s: "bogus", at: "2026-10-13T00:00:00.000Z" },
    k3: "junk",
    k4: { s: "ignored" },
    k5: { s: "ignored", at: 42 },
  });
  assert.deepEqual(Object.keys(normalized), ["k1"]);
  assert.deepEqual(normalizeTriage(null), {});
  assert.deepEqual(normalizeTriage([1, 2]), {});
});

test("triage set/undo/prune round-trips through local storage", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  let map: TriageMap = {};
  map = setTriageState(map, "ppl:x", "done", now);
  assert.equal(triageStateOf(map, "ppl:x"), "done");
  // 撤销 = 删键回到 open。
  map = setTriageState(map, "ppl:x", "open", now);
  assert.equal(triageStateOf(map, "ppl:x"), null);
  // 非法 state 不改内容。
  const untouched = setTriageState(map, "ppl:y", "bogus" as never, now);
  assert.deepEqual(untouched, map);

  map = setTriageState(map, "ppl:keep", "ignored", now - 10 * DAY);
  map = setTriageState(map, "ppl:stale", "done", now - 40 * DAY);
  map = setTriageState(map, "ppl:broken", "done", now);
  map = { ...map, "ppl:broken": { s: "done", at: "not-a-date" } };
  const pruned = pruneTriage(map, now);
  assert.equal(triageStateOf(pruned, "ppl:keep"), "ignored");
  assert.equal("ppl:stale" in pruned, false); // 超 30 天清理
  assert.equal("ppl:broken" in pruned, false); // 畸形时间戳丢弃

  // 存储往返 + 损坏/越界数据处理。
  const storage = fakeStorage(null);
  assert.equal(saveTriage(pruned, storage), true);
  assert.deepEqual(loadTriage(storage, now), pruned);
  assert.deepEqual(loadTriage(fakeStorage("{not-json"), now), {});
  assert.deepEqual(loadTriage(fakeStorage(JSON.stringify({
    fresh: { s: "done", at: new Date(now - 5 * DAY).toISOString() },
    old: { s: "done", at: new Date(now - 40 * DAY).toISOString() },
  })), now), { fresh: { s: "done", at: new Date(now - 5 * DAY).toISOString() } });
  // 无存储环境安全降级。
  assert.deepEqual(loadTriage(null, now), {});
  assert.equal(saveTriage(pruned, null), false);
});

test("base todo/meeting/mention items join the same triage flow and buckets", () => {
  const now = parseLocalTime("2026-10-14 10:00")!;
  const snapshot = {
    todos: [{ id: "t1", title: "合成逾期待办", priority: 20, dueAt: now - 3_600_000 }],
    agenda: [{ id: "e1", title: "合成下午会", start: "2026-10-14 15:00", end: "2026-10-14 16:00" }],
    mentions: [] as CrmSnapshot["mentions"],
    customers: [] as CrmSnapshot["customers"],
    projects: [] as CrmSnapshot["projects"],
  };
  const feed = buildActionFeed(snapshot, { now, triage: {}, showHandled: false });
  assert.deepEqual(feed.buckets.over.map((item) => item.id), ["todo:t1"]);
  assert.deepEqual(feed.buckets.today.map((item) => item.id), ["meeting:e1"]);
  assert.equal(feed.counts.over, 1);
  assert.equal(feed.counts.today, 1);

  // 待办标记 done 后默认隐藏，展开可见；撤销后回到 open。
  const key = feed.buckets.over[0]!.key;
  const done = buildActionFeed(snapshot, { now, triage: setTriageState({}, key, "done", now), showHandled: false });
  assert.equal(done.buckets.over.length, 0);
  assert.equal(done.counts.dealt, 1);
  const shown = buildActionFeed(snapshot, { now, triage: setTriageState({}, key, "done", now), showHandled: true });
  assert.equal(shown.buckets.over.length, 1);
  assert.equal(shown.buckets.over[0]!.state, "done");
  const undone = buildActionFeed(snapshot, { now, triage: setTriageState(setTriageState({}, key, "done", now), key, "open", now), showHandled: false });
  assert.equal(undone.buckets.over.length, 1);
  assert.equal(undone.counts.open, 2);
});
