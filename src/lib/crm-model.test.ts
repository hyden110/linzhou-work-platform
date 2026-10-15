import assert from "node:assert/strict";
import test from "node:test";

import {
  actionQueue,
  customerLifecycle,
  lifecycleBoard,
  parseLocalTime,
  projectStage,
} from "./crm-model.ts";
import type { CustomerItem, ProjectItem } from "./crm-types.ts";

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
  }, now);
  assert.deepEqual(queue.map((item) => item.id), ["todo:t1", "todo:t0", "meeting:e1", "meeting:e3", "todo:t3"]);
  assert.deepEqual(queue.map((item) => item.urgency), ["overdue", "overdue", "today", "soon", "watch"]);
});
