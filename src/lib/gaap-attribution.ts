/**
 * GAAP 产品级归因（工单 #10074 R2）：纯函数，输入为 FBI 报表行的最小投影。
 *
 * 口径（需求 R2.2，不伪造数据）：
 * - 变化额 = 当日 GAAP − 前一日 GAAP；任一侧缺失的产品行不进主表、单独计数（缺数明示）。
 * - 变化率 = 变化额 ÷ 前一日 GAAP；前一日缺失或为 0 时不展示（null）。
 * - 贡献度 = 产品变化额 ÷ 客户总变化额；总变化为 0 或不可得时全部置 null（「贡献度不可计算」）。
 * - 一级产品为主行（按 |变化额| 降序）；二级产品行作为可展开明细；无变化产品不进主表。
 * - FBI（业绩分成口径）与鲲鹏异动卡（主关联人归属口径）数值不强行对齐，
 *   对账差异超过容差时显式标注「口径差异」（reconcileGaapTotals）。
 */

/** FBI 报表行的最小输入：桥解析后交给本模块；字段语义见上。 */
export interface GaapProductInput {
  readonly level1: string;
  readonly level2: string | null;
  readonly current: number | null;
  readonly previous: number | null;
}

/** 两侧均有数的完整输入行（Required<T> 不会从联合类型中剔除 null，需显式声明）。 */
interface CompleteGaapRow {
  readonly level1: string;
  readonly level2: string | null;
  readonly current: number;
  readonly previous: number;
}

/** 完整（两侧均有数）且有变化的产品行：主表与明细的唯一数据来源。 */
export interface GaapProductSplit {
  readonly level1: string;
  /** 二级产品名；报表未拆二级时回退一级产品名（不伪造层级）。 */
  readonly level2: string;
  readonly current: number;
  readonly previous: number;
  /** 变化额（元，带符号）。 */
  readonly diff: number;
  /** 变化率（百分点，带符号）；前一日为 0 时 null。 */
  readonly rate: number | null;
  /** 贡献度 = diff ÷ 客户总变化额（带符号，可超过 ±100%）；总变化为 0 时 null。 */
  readonly share: number | null;
}

export interface GaapLevel1Split {
  readonly level1: string;
  readonly current: number;
  readonly previous: number;
  readonly diff: number;
  readonly rate: number | null;
  readonly share: number | null;
  /** 二级明细；仅一行且未拆二级时为空数组（一级行即产品行本身，不再展开）。 */
  readonly children: readonly GaapProductSplit[];
}

export interface GaapAttribution {
  /** 客户总变化额（元，带符号）= 全部完整产品行的 diff 之和。 */
  readonly totalDiff: number;
  /** 一级产品主行，按 |变化额| 降序（同幅按名称 zh-CN 字典序稳定排序）。 */
  readonly level1Rows: readonly GaapLevel1Split[];
  /** 当日/前一日有缺失侧的输入行数：不进主表，UI 需明示「缺数未计入」。 */
  readonly incompleteRows: number;
  /** 完整但零变化的输入行数：不进主表，UI 需明示「无变化不展示」。 */
  readonly unchangedRows: number;
}

function rateOf(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

/**
 * 构建「客户 × 产品」拆分。守恒口径：level1Rows 的 current/previous/diff 均为组内
 * 完整且有变化行的求和，children 与一级行同源同和，不重复计数、不虚构产品行。
 */
export function buildGaapAttribution(rows: readonly GaapProductInput[]): GaapAttribution {
  const changed: CompleteGaapRow[] = [];
  let incompleteRows = 0;
  let unchangedRows = 0;
  for (const row of rows) {
    if (row.current === null || row.previous === null) {
      incompleteRows += 1;
      continue;
    }
    if (row.current - row.previous === 0) {
      unchangedRows += 1;
      continue;
    }
    changed.push({ level1: row.level1, level2: row.level2, current: row.current, previous: row.previous });
  }
  const totalDiff = changed.reduce((sum, row) => sum + row.current - row.previous, 0);
  const shareOf = (diff: number): number | null => (totalDiff === 0 ? null : diff / totalDiff);

  const groups = new Map<string, CompleteGaapRow[]>();
  for (const row of changed) {
    groups.set(row.level1, [...(groups.get(row.level1) ?? []), row]);
  }
  const level1Rows = [...groups.entries()].map(([level1, groupRows]) => {
    const current = groupRows.reduce((sum, row) => sum + row.current, 0);
    const previous = groupRows.reduce((sum, row) => sum + row.previous, 0);
    const diff = current - previous;
    const expandable = groupRows.length > 1 || groupRows.some((row) => row.level2 !== null);
    const children = expandable
      ? groupRows
        .map((row) => ({
          level1,
          level2: row.level2 ?? level1,
          current: row.current,
          previous: row.previous,
          diff: row.current - row.previous,
          rate: rateOf(row.current, row.previous),
          share: shareOf(row.current - row.previous),
        }))
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.level2.localeCompare(b.level2, "zh-CN"))
      : [];
    return { level1, current, previous, diff, rate: rateOf(current, previous), share: shareOf(diff), children };
  });
  level1Rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.level1.localeCompare(b.level1, "zh-CN"));
  return { totalDiff, level1Rows, incompleteRows, unchangedRows };
}

export interface GaapReconciliation {
  readonly fbiTotalDiff: number | null;
  readonly kunpengDiff: number | null;
  /** 绝对差（元）；任一侧缺失为 null（无法对账，不视为口径差异）。 */
  readonly gap: number | null;
  /** 对账容差（元）= max(1 万, FBI 客户总变化额的 1%)；任一侧缺失为 null。 */
  readonly tolerance: number | null;
  /** |gap| > tolerance 时 true → UI 显示「口径差异」提示（两侧口径本就不同，属推断项）。 */
  readonly mismatch: boolean;
}

/**
 * FBI 客户总变化 vs 鲲鹏异动卡涨跌额对账：只计算与判定差异，不强行对齐数值；
 * 容差默认建议值（需求 R2.2）：绝对差 > max(1 万元, 客户变化额的 1%)。
 */
export function reconcileGaapTotals(
  fbiTotalDiff: number | null,
  kunpengDiff: number | null,
): GaapReconciliation {
  if (fbiTotalDiff === null || kunpengDiff === null) {
    return { fbiTotalDiff, kunpengDiff, gap: null, tolerance: null, mismatch: false };
  }
  const gap = fbiTotalDiff - kunpengDiff;
  const tolerance = Math.max(10_000, Math.abs(fbiTotalDiff) * 0.01);
  return { fbiTotalDiff, kunpengDiff, gap, tolerance, mismatch: Math.abs(gap) > tolerance };
}
