import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorklogEntries,
  classifyWorklogTitle,
  clusterOfWorklogTitle,
  countWorklogBy,
  resolveWorklogRange,
  summarizeWorklog,
  topWorklogEntries,
  WORKLOG_CLUSTERS,
  WORKLOG_CLUSTER_FALLBACK,
  WORKLOG_DEFAULT_DAYS,
  WORKLOG_MAX_RANGE_DAYS,
  WORKLOG_STAGES,
  WORKLOG_STAGE_IDS,
  worklogLocalDate,
} from "./worklog-model.ts";

// ---------------------------------------------------------------------------
// 全合成数据：标题一律带「（合成）」；无 I/O、无时钟依赖（nowMs 显式注入）。
// 本地时区正午构造时间戳，避开 DST/日界，测试机时区无关。
// ---------------------------------------------------------------------------

const NOON_OCT20 = new Date(2026, 9, 20, 12, 0, 0).getTime();

test("WORKLOG_STAGES ports the donor nine-stage lifecycle model", () => {
  assert.equal(WORKLOG_STAGES.length, 9);
  const ids = WORKLOG_STAGES.map((s) => s.id);
  assert.deepEqual(ids, ["insight", "account", "discovery", "solution", "validate", "opportunity", "delivery", "operate", "reuse"]);
  assert.equal(new Set(ids).size, 9, "stage id 唯一");
  assert.ok(WORKLOG_STAGE_IDS.has("delivery") && !WORKLOG_STAGE_IDS.has("nope"));
  for (const stage of WORKLOG_STAGES) {
    assert.ok(stage.name.length > 0 && stage.no.length > 0 && stage.phase.length > 0);
    assert.ok(Array.isArray(stage.keywords) && stage.keywords.length > 0, `${stage.id} 必须带 donor 关键词`);
  }
});

test("classifyWorklogTitle scores donor keywords: long words 4, short 3", () => {
  const delivery = classifyWorklogTitle("客户环境部署上线与故障排查（合成）");
  assert.equal(delivery.stageId, "delivery");
  assert.equal(delivery.confidence, "high", "部署/上线/故障/排查/环境 5 词 ≥10 分");

  const validate = classifyWorklogTitle("GPU 资源测算与成本报价（合成）");
  assert.equal(validate.stageId, "validate");

  const reuse = classifyWorklogTitle("整理知识库与培训材料（合成）");
  assert.equal(reuse.stageId, "reuse");
  assert.equal(reuse.confidence, "medium");
});

test("classifyWorklogTitle is case/whitespace insensitive (donor normalize)", () => {
  const upper = classifyWorklogTitle("POC 验证 环境准备（合成）");
  const lower = classifyWorklogTitle("poc验证环境准备（合成）");
  assert.equal(upper.stageId, "validate");
  assert.deepEqual(upper, lower);
});

test("classifyWorklogTitle returns honest null/low when nothing matches", () => {
  const none = classifyWorklogTitle("随便聊聊今天的天气（合成）");
  assert.equal(none.stageId, null);
  assert.equal(none.confidence, "low");
  const empty = classifyWorklogTitle("");
  assert.equal(empty.stageId, null);
  assert.equal(empty.score, 0);
});

test("clusterOfWorklogTitle ports donor CLUSTERS with 其他模式 fallback", () => {
  assert.equal(clusterOfWorklogTitle("制作汇报 PPT 大纲（合成）"), "材料制作与优化");
  assert.equal(clusterOfWorklogTitle("调研对比与选型分析（合成）"), "调研与选型");
  assert.equal(clusterOfWorklogTitle("数字员工定时任务接入（合成）"), "智能体与自动化");
  assert.equal(clusterOfWorklogTitle("完全无关的一句话（合成）"), WORKLOG_CLUSTER_FALLBACK);
  assert.equal(WORKLOG_CLUSTERS.length, 8);
});

test("countWorklogBy / topWorklogEntries: desc by count, slice at max", () => {
  const counts = countWorklogBy(
    [{ k: "a" }, { k: "a" }, { k: "b" }, { k: "" }] as const,
    (x) => x.k,
  );
  assert.deepEqual(counts, { a: 2, b: 1, 未标记: 1 });
  const top = topWorklogEntries({ a: 2, b: 1, c: 5 }, 2);
  assert.deepEqual(top, [{ name: "c", count: 5 }, { name: "a", count: 2 }]);
});

test("classifyWorklogEntries maps sessions to classified entries without mutating input", () => {
  const input = [
    { sourceKey: "qoder:Qoder:s1", instance: "Qoder", ts: NOON_OCT20, title: "部署上线排查（合成）" },
    { sourceKey: "qoder:QoderWork:s2", instance: "QoderWork", ts: NOON_OCT20 - 86_400_000, title: "整理知识库（合成）" },
  ];
  const frozen = JSON.parse(JSON.stringify(input));
  const entries = classifyWorklogEntries(input);
  assert.deepEqual(input, frozen, "输入不被改动（不可变模式）");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].stageId, "delivery");
  assert.equal(entries[0].date, worklogLocalDate(NOON_OCT20));
  assert.equal(entries[0].cluster, "部署与排障");
  assert.ok(entries[1].stageId === "reuse" || entries[1].stageId === null);
});

test("summarizeWorklog aggregates by day (asc) and by stage (all stages, zero-filled)", () => {
  const entries = classifyWorklogEntries([
    { sourceKey: "k1", instance: "Qoder", ts: NOON_OCT20, title: "部署上线排查故障（合成）" },
    { sourceKey: "k2", instance: "Qoder", ts: NOON_OCT20 - 86_400_000, title: "GPU 测算成本报价（合成）" },
    { sourceKey: "k3", instance: "Qoder", ts: NOON_OCT20 - 86_400_000, title: "随便聊聊天气（合成）" },
  ]);
  const summary = summarizeWorklog(entries);
  assert.equal(summary.total, 3);
  assert.equal(summary.byDay.length, 2);
  assert.ok(summary.byDay[0].date < summary.byDay[1].date, "按日升序");
  assert.deepEqual(summary.byDay[1], { date: worklogLocalDate(NOON_OCT20), count: 1 });
  assert.equal(summary.byStage.length, WORKLOG_STAGES.length, "全部环节都在（0 填充，形状稳定）");
  const delivery = summary.byStage.find((s) => s.id === "delivery");
  assert.deepEqual(delivery, { id: "delivery", name: "交付与上线", count: 1, highConfidence: 1 });
  assert.equal(summary.unclassified, 1, "规则打不出环节的条目如实计入未分类");
  assert.ok(summary.byCluster.some((c) => c.name === "部署与排障" && c.count === 1));
});

test("worklogLocalDate renders local-time YYYY-MM-DD (donor localDate)", () => {
  assert.equal(worklogLocalDate(new Date(2026, 9, 20, 0, 30, 0).getTime()), "2026-10-20");
  assert.equal(worklogLocalDate(new Date(2026, 0, 5, 23, 59, 59).getTime()), "2026-01-05");
});

test("resolveWorklogRange defaults to the last 7 local days (to inclusive)", () => {
  const r = resolveWorklogRange(new URLSearchParams(), NOON_OCT20);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.range.to, "2026-10-20");
  assert.equal(r.range.from, "2026-10-14");
  assert.equal(r.range.fromMs, new Date(2026, 9, 14, 0, 0, 0, 0).getTime());
  assert.equal(r.range.toMs, new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
  assert.equal(r.days, WORKLOG_DEFAULT_DAYS);
});

test("resolveWorklogRange accepts days=1..366 and explicit from/to", () => {
  const days = resolveWorklogRange(new URLSearchParams("days=30"), NOON_OCT20);
  assert.ok(days.ok && days.range.from === "2026-09-21" && days.range.to === "2026-10-20");
  const span = resolveWorklogRange(new URLSearchParams("from=2026-09-01&to=2026-09-30"), NOON_OCT20);
  assert.ok(span.ok);
  if (!span.ok) return;
  assert.equal(span.range.fromMs, new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
  assert.equal(span.range.toMs, new Date(2026, 8, 30, 23, 59, 59, 999).getTime());
});

test("resolveWorklogRange rejects invalid params with honest reasons (bridge maps to 400)", () => {
  const bad: Array<[string, string]> = [
    ["days=0", "days 必须是 1~366 的整数"],
    ["days=367", "days 必须是 1~366 的整数"],
    ["days=-1", "days 必须是 1~366 的整数"],
    ["days=1.5", "days 必须是 1~366 的整数"],
    ["days=abc", "days 必须是 1~366 的整数"],
    ["days=7&from=2026-10-01&to=2026-10-02", "days 与 from/to 不能混用"],
    ["from=2026-10-01", "from 与 to 必须同时提供"],
    ["to=2026-10-01", "from 与 to 必须同时提供"],
    ["from=2026-10-02&to=2026-10-01", "from 不能晚于 to"],
    ["from=2026-10-1&to=2026-10-02", "from/to 必须是 YYYY-MM-DD"],
    ["from=2026-02-30&to=2026-03-01", "不是有效日历日期"],
    ["from=2026-13-01&to=2026-13-02", "不是有效日历日期"],
    ["from=2024-01-01&to=2026-10-20", `跨度超过 ${WORKLOG_MAX_RANGE_DAYS} 天`],
  ];
  for (const [query, expectReason] of bad) {
    const r = resolveWorklogRange(new URLSearchParams(query), NOON_OCT20);
    assert.ok(!r.ok, `${query} 必须被拒绝`);
    if (!r.ok) assert.ok(r.reason.includes(expectReason), `${query} → ${r.reason}`);
  }
});
