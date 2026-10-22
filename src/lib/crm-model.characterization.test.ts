import assert from "node:assert/strict";
import test from "node:test";

import { GAAP_ALERT_THRESHOLDS, gaapAnomalies, gaapAnomaly } from "./crm-model.ts";
import type { CustomerItem } from "./crm-types.ts";

/**
 * 特征测试（修改前基线，工单 #10074 / R1 阈值参数化改造）。
 * 锁定 gaapAnomaly / gaapAnomalies 在默认阈值下的既有可观察行为：
 * 分档语义、静默条件、边界值、字段投影、低基数屏蔽、推算值推导与集合排序。
 * 本文件在生产代码修改前运行通过；阈值参数化后必须原样通过（行为等价回归）。
 */

function customer(overrides: Partial<CustomerItem>): CustomerItem {
  return {
    cid: "C1", name: "示例科技有限公司", industry: null, area: null, level: null, formal: null, opportunity: null,
    lastMonthGaap: null, yesterdayGaap: null, yesterdayGaapRate: null, lastNoteAt: null, relatedAt: null,
    ...overrides,
  };
}

/** 基线夹具：上月基数 100 万（高于 30 万低基数门槛），涨跌额直接给 yesterdayGaapDiff。 */
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

test("characterization: default thresholds are the documented four constants", () => {
  assert.deepEqual(GAAP_ALERT_THRESHOLDS, {
    absoluteNotice: 50_000,
    absoluteWatch: 300_000,
    rateSevere: 50,
    lowBaseGaap: 300_000,
  });
});

test("characterization: rate tier boundaries 49.9 silent, 50.0/50.1 T3, both directions", () => {
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 49.9, yesterdayGaapDiff: 1_000 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -49.9, yesterdayGaapDiff: -1_000 })), null);
  for (const rate of [50, 50.1]) {
    assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: rate, yesterdayGaapDiff: 1_000 }))?.tier, "T3");
    assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -rate, yesterdayGaapDiff: -1_000 }))?.tier, "T3");
  }
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 50, yesterdayGaapDiff: 1_000 }))?.direction, "up");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -50, yesterdayGaapDiff: -1_000 }))?.direction, "down");
});

test("characterization: absolute tier boundaries 4.99万 silent, 5万 T1, 30万 T2", () => {
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 49_999 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 50_000 }))?.tier, "T1");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 299_999 }))?.tier, "T1");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 5, yesterdayGaapDiff: 300_000 }))?.tier, "T2");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -5, yesterdayGaapDiff: -50_000 }))?.tier, "T1");
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -5, yesterdayGaapDiff: -300_000 }))?.tier, "T2");
  // 环比 20 未达 T3（<50），涨跌额 2 万未达 T1（<5 万）→ 完全静默。
  assert.equal(gaapAnomaly(gaapCustomer({})), null);
});

test("characterization: silent on null rate, zero rate and missing yesterday value", () => {
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: null, yesterdayGaapDiff: 600_000 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 0, yesterdayGaapDiff: 600_000 })), null);
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaap: null, yesterdayGaapRate: 60 })), null);
});

test("characterization: full field projection for a rate-tier alert", () => {
  const alert = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 60, yesterdayGaapDiff: 20_000 }));
  assert.deepEqual(alert && {
    cid: alert.customer.cid, direction: alert.direction, tier: alert.tier, rate: alert.rate,
    diff: alert.diff, basis: alert.basis, lowBase: alert.lowBase, estimatedDiff: alert.estimatedDiff,
  }, {
    cid: "C1", direction: "up", tier: "T3", rate: 60,
    diff: 20_000, basis: 1_000_000, lowBase: false, estimatedDiff: false,
  });
});

test("characterization: multi-hit takes the highest tier", () => {
  // T3（环比 80 ≥ 50）与 T2（|40 万| ≥ 30 万）同时命中 → T3。
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 80, yesterdayGaapDiff: 400_000 }))?.tier, "T3");
  // T3（环比 -55）与 T1（|-6 万| ≥ 5 万）同时命中 → T3。
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: -55, yesterdayGaapDiff: -60_000 }))?.tier, "T3");
  // T3 与 T1 同时命中 → T3。
  assert.equal(gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 120, yesterdayGaapDiff: 60_000 }))?.tier, "T3");
});

test("characterization: low base suppresses absolute tiers and flags rate tiers", () => {
  // 基数 10 万 < 30 万门槛：绝对档（|10 万| ≥ 5 万）不上报。
  assert.equal(gaapAnomaly(gaapCustomer({ lastMonthGaap: 100_000, yesterdayGaapRate: 5, yesterdayGaapDiff: 100_000 })), null);
  // 环比档仍上报并标「低基数」。
  const lowBase = gaapAnomaly(gaapCustomer({ lastMonthGaap: 100_000, yesterdayGaapRate: 60, yesterdayGaapDiff: 100_000 }));
  assert.equal(lowBase?.tier, "T3");
  assert.equal(lowBase?.lowBase, true);
  // 门槛边界：基数恰为 30 万不算低基数（严格小于才屏蔽）。
  const atThreshold = gaapAnomaly(gaapCustomer({ lastMonthGaap: 300_000, yesterdayGaapRate: 5, yesterdayGaapDiff: 50_000 }));
  assert.equal(atThreshold?.tier, "T1");
  assert.equal(atThreshold?.lowBase, false);
  // 基数缺失（null → 0）按低基数处理。
  const noBasis = gaapAnomaly(gaapCustomer({ lastMonthGaap: null, yesterdayGaapRate: 60, yesterdayGaapDiff: 100_000 }));
  assert.equal(noBasis?.lowBase, true);
  assert.equal(noBasis?.basis, null);
});

test("characterization: diff derivation from rate marks estimated and locks the formula", () => {
  // 旧快照无 yesterdayGaapDiff：diff = yesterdayGaap × r ÷ (1+r)。
  const estimated = gaapAnomaly(gaapCustomer({ yesterdayGaapDiff: undefined, yesterdayGaap: 1_600, yesterdayGaapRate: 60 }));
  assert.equal(estimated?.estimatedDiff, true);
  assert.equal(estimated?.diff, 600);
  assert.equal(estimated?.tier, "T3");
  // 推算值同样参与分档：diff = 300 万 × 0.2 ÷ 1.2 = 50 万 ≥ 30 万 → T2。
  const estimatedT2 = gaapAnomaly(gaapCustomer({ yesterdayGaapDiff: undefined, yesterdayGaap: 3_000_000, yesterdayGaapRate: 20 }));
  assert.equal(estimatedT2?.estimatedDiff, true);
  assert.equal(estimatedT2?.diff, 500_000);
  assert.equal(estimatedT2?.tier, "T2");
  // rate ≤ -100 无法反推：diff 为 null，但环比档照常上报。
  const unrecoverable = gaapAnomaly(gaapCustomer({ yesterdayGaapDiff: undefined, yesterdayGaap: 1_000, yesterdayGaapRate: -100 }));
  assert.equal(unrecoverable?.tier, "T3");
  assert.equal(unrecoverable?.diff, null);
  assert.equal(unrecoverable?.estimatedDiff, true);
  // 鲲鹏自带 diff 时不推算。
  const explicit = gaapAnomaly(gaapCustomer({ yesterdayGaapRate: 60, yesterdayGaapDiff: 20_000 }));
  assert.equal(explicit?.estimatedDiff, false);
  assert.equal(explicit?.diff, 20_000);
});

test("characterization: anomaly set is exactly the expected customers, ordered by tier, |rate|, then name", () => {
  const alerts = gaapAnomalies([
    gaapCustomer({ cid: "C1", name: "甲公司", yesterdayGaapRate: -80, yesterdayGaapDiff: -30_000 }),
    gaapCustomer({ cid: "C2", name: "乙公司", yesterdayGaapRate: 120, yesterdayGaapDiff: 10_000 }),
    gaapCustomer({ cid: "C3", name: "丙公司", yesterdayGaapRate: 8, yesterdayGaapDiff: 310_000 }),
    gaapCustomer({ cid: "C4", name: "丁公司", yesterdayGaapRate: 3, yesterdayGaapDiff: 51_000 }),
    gaapCustomer({ cid: "C5", name: "戊公司", yesterdayGaapRate: null }),
    gaapCustomer({ cid: "C6", name: "己公司", yesterdayGaapRate: 0 }),
    gaapCustomer({ cid: "C7", name: "庚公司", yesterdayGaapRate: 10, yesterdayGaapDiff: 1_000 }),
    gaapCustomer({ cid: "C8", name: "辛公司", yesterdayGaapRate: 90, yesterdayGaap: null }),
  ]);
  // 集合完全相等（不漏不误报）；顺序 = 档位降序、同档 |rate| 降序。
  assert.deepEqual(alerts.map((alert) => [alert.customer.cid, alert.tier, alert.direction]), [
    ["C2", "T3", "up"],
    ["C1", "T3", "down"],
    ["C3", "T2", "up"],
    ["C4", "T1", "up"],
  ]);
});

test("characterization: same tier and |rate| ties break by customer name (zh-CN)", () => {
  const alerts = gaapAnomalies([
    gaapCustomer({ cid: "C2", name: "乙公司", yesterdayGaapRate: 60, yesterdayGaapDiff: 60_000 }),
    gaapCustomer({ cid: "C1", name: "甲公司", yesterdayGaapRate: -60, yesterdayGaapDiff: -60_000 }),
    gaapCustomer({ cid: "C3", name: "丙公司", yesterdayGaapRate: 6, yesterdayGaapDiff: 60_000 }),
    gaapCustomer({ cid: "C4", name: "丁公司", yesterdayGaapRate: -6, yesterdayGaapDiff: 60_000 }),
  ]);
  // T3 同 |rate|=60：甲公司 < 乙公司（zh-CN localeCompare）；T1 同 |rate|=6：丙公司 < 丁公司。
  assert.deepEqual(alerts.map((alert) => alert.customer.cid), ["C1", "C2", "C3", "C4"]);
});

test("characterization: duplicated customers are not deduplicated", () => {
  const doubled = gaapAnomalies([
    gaapCustomer({ cid: "C1", name: "甲公司", yesterdayGaapRate: 60, yesterdayGaapDiff: 60_000 }),
    gaapCustomer({ cid: "C1", name: "甲公司", yesterdayGaapRate: 60, yesterdayGaapDiff: 60_000 }),
  ]);
  assert.equal(doubled.length, 2);
});
