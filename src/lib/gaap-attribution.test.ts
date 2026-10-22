import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGaapAttribution,
  reconcileGaapTotals,
  type GaapProductInput,
} from "./gaap-attribution.ts";

function row(level1: string, level2: string | null, current: number | null, previous: number | null): GaapProductInput {
  return { level1, level2, current, previous };
}

function close(actual: number | null, expected: number | null): void {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
}

// --- R2.2 结构化拆分 ---

test("attribution groups products by level1, orders by |diff| desc and conserves sums", () => {
  const result = buildGaapAttribution([
    row("模型服务", "百炼", 1_200_000, 800_000), // +400_000
    row("模型服务", "推理", 450_000, 500_000), // -50_000
    row("计算", null, 600_000, 400_000), // +200_000
    row("存储", null, 500_000, 500_000), // 零变化：不进主表
    row("网络", "CDN", null, 100_000), // 缺当日：不进主表
  ]);
  assert.equal(result.totalDiff, 550_000);
  assert.equal(result.unchangedRows, 1);
  assert.equal(result.incompleteRows, 1);
  assert.deepEqual(result.level1Rows.map((item) => item.level1), ["模型服务", "计算"]);

  const maas = result.level1Rows[0]!;
  close(maas.current, 1_650_000);
  close(maas.previous, 1_300_000);
  close(maas.diff, 350_000);
  close(maas.rate, 350_000 / 1_300_000 * 100);
  close(maas.share, 350_000 / 550_000);
  // 二级明细按 |diff| 降序，share 以客户总变化为分母。
  assert.deepEqual(maas.children.map((child) => child.level2), ["百炼", "推理"]);
  close(maas.children[0]!.diff, 400_000);
  close(maas.children[0]!.share, 400_000 / 550_000);
  close(maas.children[1]!.diff, -50_000);
  close(maas.children[1]!.share, -50_000 / 550_000);

  const compute = result.level1Rows[1]!;
  close(compute.diff, 200_000);
  close(compute.rate, 50);
  close(compute.share, 200_000 / 550_000);
  // 仅一行且未拆二级：一级行即产品行，不展开。
  assert.deepEqual(compute.children, []);
});

test("mixed level2 rows keep a fallback label and stay expandable without fabrication", () => {
  const result = buildGaapAttribution([
    row("模型服务", null, 200_000, 100_000), // 未拆二级 → 回退一级名
    row("模型服务", "百炼", 150_000, 100_000),
  ]);
  const level1 = result.level1Rows[0]!;
  close(level1.current, 350_000);
  close(level1.previous, 200_000);
  close(level1.diff, 150_000);
  assert.deepEqual(level1.children.map((child) => child.level2), ["模型服务", "百炼"]);
  close(level1.children[0]!.diff, 100_000);
  close(level1.children[1]!.diff, 50_000);
});

test("rate is null when previous day is 0; share is null when the customer total change is 0", () => {
  const result = buildGaapAttribution([
    row("A", null, 150_000, 90_000), // +60_000
    row("B", null, 50_000, 100_000), // -50_000
    row("C", null, 40_000, 0), // +40_000，前一日为 0 → 变化率不可展示
    row("D", null, 0, 50_000), // -50_000，使总变化恰为 0
  ]);
  close(result.totalDiff, 0);
  // 总变化为 0：所有贡献度置 null（「贡献度不可计算」），变化额仍如实展示。
  for (const level1 of result.level1Rows) {
    assert.equal(level1.share, null);
    for (const child of level1.children) assert.equal(child.share, null);
  }
  const zeroBase = result.level1Rows.find((item) => item.level1 === "C")!;
  close(zeroBase.diff, 40_000);
  assert.equal(zeroBase.rate, null);
});

test("empty input produces an empty table with zero counters, no fabricated rows", () => {
  const result = buildGaapAttribution([]);
  assert.deepEqual(result.level1Rows, []);
  assert.equal(result.totalDiff, 0);
  assert.equal(result.unchangedRows, 0);
  assert.equal(result.incompleteRows, 0);
});

// --- R2.2 客户层对账（FBI vs 鲲鹏口径差异显式标注） ---

test("reconciliation stays silent within the max(1万, 1%) tolerance and flags beyond it", () => {
  const ok = reconcileGaapTotals(550_000, 545_000);
  assert.equal(ok.gap, 5_000);
  assert.equal(ok.tolerance, 10_000);
  assert.equal(ok.mismatch, false);
  // 边界：gap 恰好等于容差不算差异（严格大于才算）。
  const boundary = reconcileGaapTotals(1_000_000, 990_000);
  assert.equal(boundary.tolerance, 10_000);
  assert.equal(boundary.mismatch, false);
  const beyond = reconcileGaapTotals(1_000_000, 989_000);
  assert.equal(beyond.mismatch, true);
  // 大客户：1% 分母超过 1 万时以 1% 为准。
  const bigCustomer = reconcileGaapTotals(5_000_000, 4_940_000);
  assert.equal(bigCustomer.tolerance, 50_000);
  assert.equal(bigCustomer.mismatch, true);
});

test("reconciliation with a missing side reports gap=null and never claims a mismatch", () => {
  const fbiOnly = reconcileGaapTotals(null, 50_000);
  assert.equal(fbiOnly.gap, null);
  assert.equal(fbiOnly.tolerance, null);
  assert.equal(fbiOnly.mismatch, false);
  const kunpengOnly = reconcileGaapTotals(50_000, null);
  assert.equal(kunpengOnly.gap, null);
  assert.equal(kunpengOnly.mismatch, false);
  const neither = reconcileGaapTotals(null, null);
  assert.equal(neither.mismatch, false);
  // FBI 总变化为 0 时容差退回 1 万：鲲鹏侧仍有 5 万涨跌 → 差异显式标注。
  const zeroFbi = reconcileGaapTotals(0, 50_000);
  assert.equal(zeroFbi.tolerance, 10_000);
  assert.equal(zeroFbi.mismatch, true);
});
