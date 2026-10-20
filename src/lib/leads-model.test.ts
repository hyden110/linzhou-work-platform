import assert from "node:assert/strict";
import test from "node:test";

import type { LeadRow } from "./leads-client.ts";
import {
  LEAD_TIER_META,
  actionPlan,
  coopOpportunities,
  filterLeads,
  isOpenLead,
  leadDistribution,
  leadDrawerSections,
  leadKpis,
  needsConfirm,
  primaryOwner,
  tierDistribution,
} from "./leads-model.ts";

// 合成数据：甲科技 / 乙股份 等均为合成线索，无真实企业、CID、金额与联系人信息。

const NOW = Date.parse("2026-10-20T00:00:00.000Z");

const BLANK: LeadRow = {
  id: "", name: "", legal: "", crmName: "", tierLabel: "", tier: "pending", crmState: "", score: null,
  priority: "", province: "", city: "", track: "", trackRaw: "", summary: "", signal: "", round: "",
  amount: "", investors: "", maas: "", maasWhy: "", maasProduct: "", agent: "", agentWhy: "", risk: "",
  aliRel: "", sales: "", team: "", uids: null, cid: "", ecid: "", mentions: null, signalAt: "", radarAt: "",
  news: null, sources: "", founded: "", regCap: "", address: "", founder: "", website: "", entStatus: "",
  isPriority: false,
};

function lead(patch: Partial<LeadRow> & Pick<LeadRow, "id" | "name">): LeadRow {
  return { ...BLANK, ...patch };
}

const ROWS: readonly LeadRow[] = Object.freeze([
  lead({ id: "r1", name: "甲科技有限公司", tier: "A", score: 80, track: "AI Infra/算力", province: "北京", isPriority: true, signalAt: "2026-10-18", maas: "高" }),
  lead({ id: "r2", name: "乙股份有限公司", tier: "A", score: 90, track: "Agent/智能体", province: "浙江", signalAt: "2026-09-01" }),
  lead({ id: "r3", name: "甲科技二号", tier: "B", score: 60, track: "Agent/智能体", province: "北京", isPriority: true, signalAt: "2026-10-15" }),
  lead({ id: "r4", name: "乙股份二号", tier: "A?", score: 70, track: "AI Infra/算力", province: "", signalAt: "" }),
  lead({ id: "r5", name: "甲科技三号", tier: "D", score: 88, track: "Agent/智能体", province: "浙江", maas: "高", sales: "合成跟进人甲(已关联)；合成跟进人乙" }),
  lead({ id: "r6", name: "乙股份三号", tier: "D", score: 95, track: "Agent/智能体", province: "浙江", maas: "中", agent: "低" }),
  lead({ id: "r7", name: "甲科技四号", tier: "pending", score: null, track: "其他", province: "北京", isPriority: true }),
  lead({ id: "r8", name: "乙股份四号", tier: "ME", score: 50, track: "AI Infra/算力", province: "浙江", agent: "高", tierLabel: "★ 我名下" }),
  lead({ id: "r9", name: "甲科技五号", tier: "D", score: 40, track: "其他", province: "北京", agent: "高", sales: "" }),
]);

test("tier helpers classify open / confirm tiers with the donor's 判定口径", () => {
  assert.equal(isOpenLead(ROWS[0]!), true);
  assert.equal(isOpenLead(ROWS[7]!), true, "ME 视为可 Name（已在名下）");
  assert.equal(isOpenLead(ROWS[3]!), false);
  assert.equal(needsConfirm(ROWS[3]!), true);
  assert.equal(needsConfirm(ROWS[6]!), true);
  assert.equal(needsConfirm(ROWS[4]!), false);
  assert.match(LEAD_TIER_META.D.action, /协同/);
  assert.match(LEAD_TIER_META["A?"].action, /核实/);
});

test("leadKpis counts totals, open/confirm splits, priority and 7-day fresh signals", () => {
  const kpis = leadKpis(ROWS, NOW);
  assert.equal(kpis.total, 9);
  assert.equal(kpis.open, 4, "ME + A×2 + B");
  assert.equal(kpis.openDirect, 2);
  assert.equal(kpis.openApply, 1);
  assert.equal(kpis.confirm, 2);
  assert.equal(kpis.confirmManual, 1);
  assert.equal(kpis.confirmPending, 1);
  assert.equal(kpis.priority, 3, "isPriority 标记行：r1 r3 r7（r9 在北京但快照未标优先，不推断）");
  assert.equal(kpis.priorityActionable, 3, "优先省里可做（可 Name 或待确认）的：r1 r3 r7");
  assert.equal(kpis.recent7, 2, "r1 / r3 在 7 天内；坏时间与空串不计");
  const empty = leadKpis([], NOW);
  assert.equal(empty.total, 0);
  assert.equal(empty.recent7, 0);
});

test("tierDistribution returns every tier in canonical order with counts and integer percents", () => {
  const slices = tierDistribution(ROWS);
  assert.deepEqual(slices.map((slice) => slice.tier), ["ME", "A", "B", "B2", "A?", "C", "pending", "D"]);
  const byTier = Object.fromEntries(slices.map((slice) => [slice.tier, slice]));
  assert.equal(byTier.D!.count, 3);
  assert.equal(byTier.D!.percent, 33);
  assert.equal(byTier.B2!.count, 0);
  assert.equal(byTier.B2!.percent, 0);
  assert.equal(byTier.A!.label, LEAD_TIER_META.A.label);
  assert.equal(tierDistribution([]).every((slice) => slice.count === 0 && slice.percent === 0), true);
});

test("actionPlan groups actionable leads by suggested action, priority-first then score", () => {
  const plan = actionPlan(ROWS, 5);
  assert.deepEqual(plan.map((group) => group.tier), ["ME", "A", "B", "A?"], "空组不出现，C/pending/D 不进行动清单");
  const groupA = plan.find((group) => group.tier === "A")!;
  assert.equal(groupA.total, 2);
  assert.equal(groupA.action, LEAD_TIER_META.A.action);
  assert.deepEqual(groupA.items.map((row) => row.id), ["r1", "r2"], "优先省 r1 排在高分 r2 之前");
  const capped = actionPlan(ROWS, 1);
  assert.equal(capped.find((group) => group.tier === "A")!.items.length, 1);
  assert.equal(capped.find((group) => group.tier === "A")!.total, 2, "total 保留真实条数");
  assert.deepEqual(actionPlan([], 5), []);
});

test("coopOpportunities keeps D-tier leads with 高 MaaS or Agent potential, sorted by score", () => {
  const coop = coopOpportunities(ROWS, 8);
  assert.equal(coop.total, 2);
  assert.deepEqual(coop.items.map((item) => item.row.id), ["r5", "r9"]);
  assert.equal(coop.items[0]!.owner, "合成跟进人甲");
  assert.equal(coop.items[1]!.owner, "", "跟进人缺失如实为空串，由视图显示「暂无」");
  assert.equal(coopOpportunities(ROWS, 1).items.length, 1);
  assert.equal(coopOpportunities(ROWS, 1).total, 2);
  assert.equal(primaryOwner("合成跟进人丙（已关联）; 合成跟进人丁"), "合成跟进人丙");
  assert.equal(primaryOwner(""), "");
});

test("leadDistribution aggregates track / region with open counts and priority flag", () => {
  const tracks = leadDistribution(ROWS, "track");
  assert.deepEqual(tracks.map((bucket) => [bucket.key, bucket.count, bucket.open]), [
    ["Agent/智能体", 4, 2],
    ["AI Infra/算力", 3, 2],
    ["其他", 2, 0],
  ]);
  const regions = leadDistribution(ROWS, "region");
  assert.deepEqual(regions.map((bucket) => [bucket.key, bucket.count]), [["北京", 4], ["浙江", 4], ["未知", 1]]);
  assert.equal(regions.find((bucket) => bucket.key === "北京")!.priority, true);
  assert.equal(regions.find((bucket) => bucket.key === "浙江")!.priority, false);
  assert.equal(tracks.every((bucket) => bucket.priority === false), true, "赛道分布不标优先区域");
});

test("filterLeads combines tier group, selects, keyword and sort without mutating input", () => {
  const before = ROWS.map((row) => row.id);
  const base = { tier: "all", track: "", province: "", crmState: "", q: "", sort: "snapshot" } as const;
  assert.deepEqual(filterLeads(ROWS, base).map((row) => row.id), before, "默认保留快照顺序");
  assert.deepEqual(filterLeads(ROWS, { ...base, tier: "open" }).map((row) => row.id), ["r1", "r2", "r3", "r8"]);
  assert.deepEqual(filterLeads(ROWS, { ...base, tier: "confirm" }).map((row) => row.id), ["r4", "r7"]);
  assert.deepEqual(filterLeads(ROWS, { ...base, tier: "D", province: "浙江" }).map((row) => row.id), ["r5", "r6"]);
  assert.deepEqual(filterLeads(ROWS, { ...base, q: "乙股份 二号" }).map((row) => row.id), ["r4"]);
  assert.deepEqual(filterLeads(ROWS, { ...base, track: "其他", sort: "score" }).map((row) => row.id), ["r9", "r7"], "无分排最后");
  assert.deepEqual(
    filterLeads(ROWS, { ...base, tier: "open", sort: "signal" }).map((row) => row.id),
    ["r1", "r3", "r2", "r8"],
    "最新信号倒序，空信号排最后",
  );
  assert.deepEqual(ROWS.map((row) => row.id), before, "输入数组不被原地排序");
});

test("leadDrawerSections fills missing values with — and drops empty notes instead of inventing data", () => {
  const sections = leadDrawerSections(ROWS[4]!);
  assert.deepEqual(sections.map((section) => section.title), ["Name 判定与行动", "价值判断", "拓新信号", "企业信息"]);
  const judge = sections[0]!;
  const fact = (label: string) => judge.facts.find((item) => item.label === label)?.value;
  assert.equal(fact("判定"), LEAD_TIER_META.D.label, "tierLabel 为空回落档位文案");
  assert.equal(fact("建议动作"), LEAD_TIER_META.D.action);
  assert.equal(fact("CID"), "—");
  assert.equal(fact("关联 UID 数"), "—");
  assert.deepEqual(judge.notes.map((note) => note.label), ["跟进人"], "空的跟进团队/阿里关联不出现");
  const meTier = leadDrawerSections(ROWS[7]!)[0]!;
  assert.equal(meTier.facts.find((item) => item.label === "判定")?.value, "★ 我名下");
  const signal = leadDrawerSections(lead({ id: "x", name: "甲科技", mentions: 0, signalAt: "2026-10-18T09:30:00.000Z" }))[2]!;
  assert.equal(signal.facts.find((item) => item.label === "近 14 天提及")?.value, "0 次");
  assert.equal(signal.facts.find((item) => item.label === "最新信号")?.value, "2026-10-18 09:30");
});
