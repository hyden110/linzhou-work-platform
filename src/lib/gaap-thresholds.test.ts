import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GAAP_THRESHOLDS,
  GAAP_THRESHOLD_FIELDS,
  GAAP_THRESHOLD_META,
  GAAP_THRESHOLDS_STORAGE_KEY,
  formatThresholdAmount,
  formatThresholdNote,
  parseGaapThresholdsForm,
  readGaapThresholds,
  resetGaapThresholds,
  setGaapThresholds,
  subscribeGaapThresholds,
  thresholdsEqual,
  type GaapThresholds,
  type ThresholdStorageLike,
} from "./gaap-thresholds.ts";

function memoryStorage(initial: Record<string, string> = {}): ThresholdStorageLike & { dump(): Record<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
    dump: () => Object.fromEntries(store),
  };
}

const CUSTOM: GaapThresholds = {
  absoluteNotice: 10_000,
  absoluteWatch: 200_000,
  rateSevere: 25,
  lowBaseGaap: 500_000,
};

// --- R1.1 表单解析与校验 ---

test("form parse accepts finite non-negative values satisfying cross-field rules", () => {
  const result = parseGaapThresholdsForm({
    absoluteNotice: "10000",
    absoluteWatch: "200000",
    rateSevere: "25.5",
    lowBaseGaap: "0",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.thresholds, {
    absoluteNotice: 10_000,
    absoluteWatch: 200_000,
    rateSevere: 25.5,
    lowBaseGaap: 0,
  });
});

test("form parse rejects empty / non-numeric / negative / zero-rate with field errors and no partial thresholds", () => {
  const result = parseGaapThresholdsForm({
    absoluteNotice: "",
    absoluteWatch: "abc",
    rateSevere: "0",
    lowBaseGaap: "-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.thresholds, null);
  assert.equal(result.errors.absoluteNotice, "请输入有效数字");
  assert.equal(result.errors.absoluteWatch, "请输入有效数字");
  assert.equal(result.errors.rateSevere, "必须大于 0");
  assert.equal(result.errors.lowBaseGaap, "不允许负数");
  // 非有限数字同样按「请输入有效数字」拒绝。
  const nonFinite = parseGaapThresholdsForm({
    absoluteNotice: "Infinity", absoluteWatch: "200000", rateSevere: "50", lowBaseGaap: "300000",
  });
  assert.equal(nonFinite.ok, false);
  assert.equal(nonFinite.errors.absoluteNotice, "请输入有效数字");
});

test("form parse rejects absoluteNotice >= absoluteWatch with errors on both fields", () => {
  const equal = parseGaapThresholdsForm({
    absoluteNotice: "300000", absoluteWatch: "300000", rateSevere: "50", lowBaseGaap: "300000",
  });
  assert.equal(equal.ok, false);
  assert.equal(equal.errors.absoluteNotice, "T1 下限必须小于 T2 下限");
  assert.equal(equal.errors.absoluteWatch, "T2 下限必须大于 T1 下限");
  const inverted = parseGaapThresholdsForm({
    absoluteNotice: "500000", absoluteWatch: "300000", rateSevere: "50", lowBaseGaap: "300000",
  });
  assert.equal(inverted.ok, false);
  assert.equal(inverted.thresholds, null);
  // 相邻值（notice < watch）通过。
  const adjacent = parseGaapThresholdsForm({
    absoluteNotice: "299999", absoluteWatch: "300000", rateSevere: "50", lowBaseGaap: "300000",
  });
  assert.equal(adjacent.ok, true);
});

// --- R1.2 口径文案与金额格式（与配置同一来源） ---

test("formatThresholdNote with defaults reproduces the pre-change hardcoded note verbatim", () => {
  assert.equal(
    formatThresholdNote(DEFAULT_GAAP_THRESHOLDS),
    "口径：昨日 GAAP 环比；阈值 T3 环比 ±50% / T2 涨跌 ±30 万 / T1 涨跌 ±5 万，多档取最高档；上月基数低于 30 万只报环比档并标「低基数」。",
  );
});

test("formatThresholdNote reflects custom thresholds", () => {
  assert.equal(
    formatThresholdNote(CUSTOM),
    "口径：昨日 GAAP 环比；阈值 T3 环比 ±25% / T2 涨跌 ±20 万 / T1 涨跌 ±1 万，多档取最高档；上月基数低于 50 万只报环比档并标「低基数」。",
  );
});

test("formatThresholdAmount mirrors the workbench 万-format", () => {
  assert.equal(formatThresholdAmount(50_000), "5 万");
  assert.equal(formatThresholdAmount(300_000), "30 万");
  assert.equal(formatThresholdAmount(12_345), "1.2 万");
  assert.equal(formatThresholdAmount(1_500_000), "150 万");
  assert.equal(formatThresholdAmount(500), "500");
  assert.equal(formatThresholdAmount(0), "0");
});

// --- R1.2 持久化：读 / 写 / 恢复默认 / 订阅广播 ---

test("readGaapThresholds falls back to defaults without storage, corrupt JSON, or out-of-range values", () => {
  assert.equal(readGaapThresholds(null), DEFAULT_GAAP_THRESHOLDS);
  assert.equal(readGaapThresholds(memoryStorage()), DEFAULT_GAAP_THRESHOLDS);
  assert.equal(readGaapThresholds(memoryStorage({ [GAAP_THRESHOLDS_STORAGE_KEY]: "not-json" })), DEFAULT_GAAP_THRESHOLDS);
  // 越界结构：notice >= watch / rateSevere <= 0 / 负数 / 缺键 / 非数字 —— 一律默认，不部分生效。
  assert.equal(
    readGaapThresholds(memoryStorage({
      [GAAP_THRESHOLDS_STORAGE_KEY]: JSON.stringify({ absoluteNotice: 300_000, absoluteWatch: 300_000, rateSevere: 50, lowBaseGaap: 300_000 }),
    })),
    DEFAULT_GAAP_THRESHOLDS,
  );
  assert.equal(
    readGaapThresholds(memoryStorage({
      [GAAP_THRESHOLDS_STORAGE_KEY]: JSON.stringify({ absoluteNotice: 50_000, absoluteWatch: 300_000, rateSevere: 0, lowBaseGaap: 300_000 }),
    })),
    DEFAULT_GAAP_THRESHOLDS,
  );
  assert.equal(
    readGaapThresholds(memoryStorage({
      [GAAP_THRESHOLDS_STORAGE_KEY]: JSON.stringify({ absoluteNotice: -1, absoluteWatch: 300_000, rateSevere: 50, lowBaseGaap: 300_000 }),
    })),
    DEFAULT_GAAP_THRESHOLDS,
  );
  assert.equal(
    readGaapThresholds(memoryStorage({ [GAAP_THRESHOLDS_STORAGE_KEY]: JSON.stringify({ absoluteNotice: 50_000 }) })),
    DEFAULT_GAAP_THRESHOLDS,
  );
});

test("setGaapThresholds persists validated custom config and broadcasts to subscribers", () => {
  const storage = memoryStorage();
  const seen: GaapThresholds[] = [];
  const unsubscribe = subscribeGaapThresholds((thresholds) => seen.push(thresholds));
  try {
    assert.equal(setGaapThresholds(storage, CUSTOM), true);
    assert.deepEqual(JSON.parse(storage.dump()[GAAP_THRESHOLDS_STORAGE_KEY]!), CUSTOM);
    assert.deepEqual(readGaapThresholds(storage), CUSTOM);
    assert.deepEqual(seen, [CUSTOM]);

    // 非法对象：不落库、不广播。
    const invalid = { ...CUSTOM, rateSevere: 0 };
    assert.equal(setGaapThresholds(storage, invalid), false);
    assert.deepEqual(seen, [CUSTOM]);

    // 与默认值相同的保存：删键（存储只保留自定义值），广播默认。
    assert.equal(setGaapThresholds(storage, DEFAULT_GAAP_THRESHOLDS), true);
    assert.equal(GAAP_THRESHOLDS_STORAGE_KEY in storage.dump(), false);
    assert.deepEqual(seen[seen.length - 1], DEFAULT_GAAP_THRESHOLDS);
  } finally {
    unsubscribe();
  }
});

test("resetGaapThresholds removes the key and broadcasts defaults", () => {
  const storage = memoryStorage({ [GAAP_THRESHOLDS_STORAGE_KEY]: JSON.stringify(CUSTOM) });
  const seen: GaapThresholds[] = [];
  const unsubscribe = subscribeGaapThresholds((thresholds) => seen.push(thresholds));
  try {
    resetGaapThresholds(storage);
    assert.equal(GAAP_THRESHOLDS_STORAGE_KEY in storage.dump(), false);
    assert.deepEqual(seen, [DEFAULT_GAAP_THRESHOLDS]);
  } finally {
    unsubscribe();
  }
});

test("subscribe returns an idempotent unsubscribe; remaining listeners keep receiving", () => {
  const first: GaapThresholds[] = [];
  const second: GaapThresholds[] = [];
  const offFirst = subscribeGaapThresholds((value) => first.push(value));
  subscribeGaapThresholds((value) => second.push(value));
  offFirst();
  offFirst(); // 重复退订安全
  setGaapThresholds(null, CUSTOM);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [CUSTOM]);
});

// --- 元信息完备性（设置页四项配置区由它驱动） ---

test("every threshold field has label, unit and hint metadata", () => {
  for (const field of GAAP_THRESHOLD_FIELDS) {
    const meta = GAAP_THRESHOLD_META[field];
    assert.ok(meta.label.length > 0);
    assert.ok(meta.unit.length > 0);
    assert.ok(meta.hint.length > 0);
  }
  assert.deepEqual(thresholdsEqual(DEFAULT_GAAP_THRESHOLDS, DEFAULT_GAAP_THRESHOLDS), true);
  assert.deepEqual(thresholdsEqual(DEFAULT_GAAP_THRESHOLDS, CUSTOM), false);
});
