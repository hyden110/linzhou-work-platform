import assert from "node:assert/strict";
import test from "node:test";

import { buildActionFeed, setTriageState, type TriageMap } from "./action-feed.ts";
import { pplFollowupBoard, parseLocalTime } from "./crm-model.ts";
import type { CrmSnapshot, CustomerItem, ProjectItem } from "./crm-types";
import {
  LIFECYCLE_PHASES,
  PHASE_KEYS,
  PPL_PHASE_TABLE,
  customerTimeline,
  filterFollowupByPhase,
  phaseNavCounts,
  pplPhaseOf,
} from "./lifecycle-model.ts";
import type { PplInspectionBundle } from "./ppl-client";

// 合成数据：只用「甲科技 / 乙股份」，CID / 项目 ID 均为 SYN- 前缀占位，不含任何真实客户信息。
const JIA = "SYN-JIA";
const YI = "SYN-YI";
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();

function customer(overrides: Partial<CustomerItem>): CustomerItem {
  return {
    cid: JIA, name: "甲科技有限公司", industry: null, area: null, level: null, formal: null, opportunity: null,
    lastMonthGaap: null, yesterdayGaap: null, yesterdayGaapRate: null, lastNoteAt: null, relatedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectItem>): ProjectItem {
  return {
    id: "SYN-P0", name: "甲科技 合成项目", customerName: null, cid: JIA, stage: null, stageName: null, price: null,
    cate: null, state: "PROJECT_STATE_NORMAL", winRate: null, expectedContractDate: null, expectedGaapStartDate: null,
    createdAt: null,
    ...overrides,
  };
}

function snapshot(customers: CustomerItem[], projects: ProjectItem[]): Pick<CrmSnapshot, "customers" | "projects"> {
  return { customers, projects };
}

function fixtureBoard() {
  return pplFollowupBoard(snapshot(
    [
      customer({ cid: JIA, name: "甲科技有限公司", lastMonthGaap: 200 }),
      customer({ cid: YI, name: "乙股份有限公司", lastMonthGaap: 100 }),
    ],
    [
      project({ id: "SYN-P1", name: "甲科技 拓新", cid: JIA, stageName: "潜在商机" }),
      project({ id: "SYN-P2", name: "甲科技 方案", cid: JIA, stageName: "技术方案" }),
      project({ id: "SYN-P3", name: "甲科技 上量", cid: JIA, stageName: "开始上量" }),
      project({ id: "SYN-P4", name: "乙股份 谈判", cid: YI, stageName: "商务谈判" }),
      project({ id: "SYN-P5", name: "乙股份 新口径", cid: YI, stageName: "神秘新阶段" }),
      project({ id: "SYN-P6", name: "无归属合成项目", cid: null, customerName: null, stageName: "合同签署" }),
    ],
  ), { [YI]: "maas" });
}

// ---------------------------------------------------------------------------
// 阶段映射表
// ---------------------------------------------------------------------------

test("phase table follows the donor pplStageMap by stage name and flags the one V2-only entry", () => {
  const expected: Record<string, string> = {
    "潜在商机": "A",
    "技术方案": "B",
    "商机确认": "C", "商务谈判": "C", "商务方案": "C", "合同签署": "C", "项目赢单": "C", "履约完成": "C",
    "签约完成": "C",
    "收入确认": "D", "开始上量": "D", "资源上量": "D",
  };
  for (const [stageName, phase] of Object.entries(expected)) {
    assert.equal(pplPhaseOf({ stageName }), phase, stageName);
  }
  assert.deepEqual(PPL_PHASE_TABLE.map((row) => row.stageName).sort(), Object.keys(expected).sort(), "映射表恰好这些键");
  assert.deepEqual(PPL_PHASE_TABLE.filter((row) => row.basis === "v2").map((row) => row.stageName), ["签约完成"]);
  assert.deepEqual(LIFECYCLE_PHASES.map((meta) => meta.id), ["A", "B", "C", "D", "unclassified"]);
  assert.deepEqual(LIFECYCLE_PHASES.map((meta) => meta.name), ["识别机会", "塑造方案", "赢单交付", "持续经营", "未归类"]);
  assert.deepEqual(PHASE_KEYS, ["A", "B", "C", "D", "unclassified"]);
});

test("unknown or missing stage names go to 未归类 with no code / win-rate guessing", () => {
  assert.equal(pplPhaseOf({ stageName: null }), "unclassified");
  assert.equal(pplPhaseOf({ stageName: "" }), "unclassified");
  assert.equal(pplPhaseOf({ stageName: "神秘新阶段" }), "unclassified");
  assert.equal(pplPhaseOf({ stageName: "  技术方案 " }), "B", "首尾空白容忍");
  // 有 code 和高赢率也不猜：code 6 同时对应开始上量/资源上量，供体明确禁止按 code 映射。
  const guessy = project({ stage: "6", winRate: 90, stageName: "未知" });
  assert.equal(pplPhaseOf(guessy), "unclassified");
});

// ---------------------------------------------------------------------------
// 导航计数与筛选
// ---------------------------------------------------------------------------

test("nav counts conserve projects across phases, counting customers once per phase", () => {
  const counts = phaseNavCounts(fixtureBoard());
  assert.deepEqual(counts.phases.A, { projects: 1, customers: 1 });
  assert.deepEqual(counts.phases.B, { projects: 1, customers: 1 });
  assert.deepEqual(counts.phases.C, { projects: 2, customers: 1 }, "未匹配项目计入项目数但不计客户");
  assert.deepEqual(counts.phases.D, { projects: 1, customers: 1 });
  assert.deepEqual(counts.phases.unclassified, { projects: 1, customers: 1 });
  const sum = PHASE_KEYS.reduce((total, key) => total + counts.phases[key].projects, 0);
  assert.equal(sum, counts.totalProjects);
  assert.equal(counts.totalProjects, 6);
  assert.equal(counts.unmatchedProjects, 1);
  assert.equal(counts.customersWithoutPpl, 0);
});

test("customers without any PPL are reported separately and never placed in a phase", () => {
  const board = pplFollowupBoard(snapshot(
    [customer({ cid: JIA }), customer({ cid: YI, name: "乙股份有限公司" })],
    [project({ id: "SYN-P1", cid: JIA, stageName: "潜在商机" })],
  ));
  const counts = phaseNavCounts(board);
  assert.equal(counts.customersWithoutPpl, 1);
  assert.equal(counts.phases.A.customers, 1);
  assert.equal(counts.phases.unclassified.customers, 0);
});

test("phase filter: null keeps the original board reference (existing behaviour untouched)", () => {
  const board = fixtureBoard();
  assert.equal(filterFollowupByPhase(board, null), board);
});

test("phase filter keeps only matching projects, hides empty customers and recomputes counts immutably", () => {
  const board = fixtureBoard();
  const before = structuredClone(board);

  const a = filterFollowupByPhase(board, "A");
  assert.deepEqual(a.lanes.unconfirmed.map((row) => row.projects.map((p) => p.id)), [["SYN-P1"]]);
  assert.equal(a.lanes.maas.length, 0, "乙股份无 A 阶段项目 → 隐藏");
  assert.equal(a.unmatched.length, 0);
  assert.equal(a.counts.customers, 1);
  assert.equal(a.counts.projects, 1);

  const c = filterFollowupByPhase(board, "C");
  assert.deepEqual(c.lanes.maas.map((row) => row.projects.map((p) => p.id)), [["SYN-P4"]]);
  assert.deepEqual(c.unmatched.map((p) => p.id), ["SYN-P6"]);
  assert.equal(c.counts.projects, 2);
  assert.equal(c.counts.unmatched, 1);
  assert.equal(c.counts.maas, 1);

  const none = filterFollowupByPhase(board, "unclassified");
  assert.deepEqual(none.lanes.maas.map((row) => row.projects.map((p) => p.id)), [["SYN-P5"]]);

  assert.deepEqual(board, before, "输入看板不被修改");
});

// ---------------------------------------------------------------------------
// 触达时间轴
// ---------------------------------------------------------------------------

test("timeline orders existing local fields newest-first and skips absent ones", () => {
  const timeline = customerTimeline({
    customer: customer({
      lastNoteAt: "2026-10-10 09:30:00",
      relatedAt: "2026-01-02 10:00:00/2025-12-01 08:00:00",
    }),
    projects: [
      project({
        id: "SYN-P1", name: "甲科技 拓新", stageName: "潜在商机",
        createdAt: "2026-03-01T02:00:00Z",
        expectedContractDate: "2026-11-30T16:00:00Z",
        expectedGaapStartDate: "2026-02-01T16:00:00Z",
      }),
      project({ id: "SYN-P2", name: "甲科技 方案", stageName: "技术方案" }),
    ],
    now: NOW,
  });
  assert.deepEqual(timeline.events.map((event) => event.source), [
    "contract", "followup", "project", "gaap", "relate", "relate",
  ]);
  const [contract, followup, created, gaap] = timeline.events;
  assert.equal(contract!.planned, true, "未来的预计签约标计划");
  assert.equal(contract!.dayOnly, true);
  assert.equal(contract!.at, Date.parse("2026-11-30T16:00:00Z"));
  assert.match(contract!.detail ?? "", /甲科技 拓新/);
  assert.equal(followup!.at, parseLocalTime("2026-10-10 09:30:00"), "无时区串按本地时间解析");
  assert.equal(followup!.planned, false);
  assert.equal(created!.at, Date.parse("2026-03-01T02:00:00Z"));
  assert.match(created!.detail ?? "", /潜在商机/);
  assert.equal(gaap!.planned, false);
  assert.equal(timeline.skipped, 0);
  assert.equal(new Set(timeline.events.map((event) => event.key)).size, timeline.events.length, "key 唯一");
});

test("timeline counts unparseable timestamps as skipped instead of inventing dates", () => {
  const timeline = customerTimeline({
    customer: customer({ lastNoteAt: "上周", relatedAt: "" }),
    projects: [project({ createdAt: "not-a-date", expectedContractDate: "2026-13-45" })],
    now: NOW,
  });
  assert.equal(timeline.events.length, 0);
  assert.equal(timeline.skipped, 3);

  const empty = customerTimeline({ customer: customer({}), projects: [], now: NOW });
  assert.deepEqual(empty, { events: [], skipped: 0 });
});

function inspectionBundle(state = "ok"): PplInspectionBundle {
  const rec = (id: string, cid: string | null, customerName: string) => ({
    id, fingerprint: `fp-${id}`, customerName, cid, suggestedProjectName: `${customerName} 合成推荐`,
    opportunityType: "合成", amountYuan: null, blocked: false, blockReason: null,
    dedupe: { status: "new", evidence: null }, changeNote: null,
  });
  return {
    inspection: {
      state, generatedAt: "2026-10-12T01:00:00Z", snapshotGeneratedAt: null, snapshotStale: false, reportCount: 1,
      recommendations: [rec("r-jia", JIA, "甲科技有限公司"), rec("r-yi", YI, "乙股份有限公司"), rec("r-name", null, "甲科技有限公司")],
      summary: {}, error: null,
    },
    decisions: [
      { id: "d1", recommendationId: "r-jia", action: "approve", decidedAt: "2026-10-13T02:00:00Z", note: null, fingerprint: "fp-r-jia" },
      { id: "d2", recommendationId: "r-yi", action: "discard", decidedAt: "2026-10-13T03:00:00Z", note: null, fingerprint: "fp-r-yi" },
      { id: "d3", recommendationId: "r-gone", action: "approve", decidedAt: "2026-10-13T04:00:00Z", note: null, fingerprint: null },
    ],
  };
}

test("timeline joins local inspection records by cid (name fallback) and labels approvals as authorisation only", () => {
  const timeline = customerTimeline({ customer: customer({}), projects: [], inspection: inspectionBundle(), now: NOW });
  const approval = timeline.events.filter((event) => event.source === "approval");
  assert.equal(approval.length, 1, "乙股份的决策与未知推荐的决策不进甲科技时间轴");
  assert.equal(approval[0]!.at, Date.parse("2026-10-13T02:00:00Z"));
  assert.match(approval[0]!.title, /仅授权/);
  assert.match(approval[0]!.title, /未创建/);
  const found = timeline.events.filter((event) => event.source === "inspection");
  assert.equal(found.length, 2, "cid 命中 + 客户名兜底（推荐无 cid）");
  assert.ok(timeline.events.every((event) => !/乙股份/.test(`${event.title}${event.detail ?? ""}`)));

  const failed = customerTimeline({ customer: customer({}), projects: [], inspection: inspectionBundle("failed"), now: NOW });
  assert.equal(failed.events.filter((event) => event.source === "inspection").length, 0, "失败巡检的推荐不作触达");
});

test("timeline surfaces local action-queue triage records using the same keys as the queue", () => {
  const near = project({ id: "SYN-P9", name: "甲科技 临签", stageName: "合同签署", expectedContractDate: "2026-10-17T00:00:00Z" });
  const snap = { ...snapshot([customer({})], [near]), todos: [], agenda: [], mentions: [] };
  const feed = buildActionFeed(snap, { now: NOW, triage: {}, showHandled: true });
  const item = feed.items.find((entry) => entry.kind === "ppl");
  assert.ok(item, "合成项目进入行动队列");
  const triage: TriageMap = setTriageState({}, item.key, "done", NOW - 3_600_000);

  const timeline = customerTimeline({ customer: customer({}), projects: [near], triage, now: NOW });
  const handled = timeline.events.filter((event) => event.source === "triage");
  assert.equal(handled.length, 1);
  assert.equal(handled[0]!.at, NOW - 3_600_000);
  assert.match(handled[0]!.title, /已处理/);
  assert.match(handled[0]!.detail ?? "", /甲科技 临签/);

  const untouched = customerTimeline({ customer: customer({}), projects: [near], triage: {}, now: NOW });
  assert.equal(untouched.events.filter((event) => event.source === "triage").length, 0);
});
