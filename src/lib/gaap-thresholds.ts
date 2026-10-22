/**
 * GAAP 异动阈值配置（工单 #10074 R1）：四项判定参数的单一事实源。
 *
 * - 判定语义（比例 OR 绝对额、多档取最高、低基数只屏蔽绝对档、推算值标记）不在本模块；
 *   这里只承载「阈值来自哪里」，crm-model 的判定代码不再持有阈值字面量副本。
 * - 配置持久化 localStorage（单人本机工作台，沿用 demo-mode 先例）：设置页校验通过才写入，
 *   读取端（无存储/损坏/越界）一律回退默认值，绝不部分生效。
 * - 订阅广播与 demo-mode 同构：设置页保存/恢复默认后，客户盘面等消费方立即按新阈值重算。
 */

export interface GaapThresholds {
  /** T1 提示档：昨日环比涨跌额绝对值下限（元）。 */
  readonly absoluteNotice: number;
  /** T2 关注档：昨日环比涨跌额绝对值下限（元）。 */
  readonly absoluteWatch: number;
  /** T3 严重档：昨日环比比例绝对值下限（百分点）。 */
  readonly rateSevere: number;
  /** 低基数门槛（元）：上月 GAAP 低于该值时绝对档不上报、环比命中标「低基数」。 */
  readonly lowBaseGaap: number;
}

export type GaapThresholdField = keyof GaapThresholds;

export const GAAP_THRESHOLD_FIELDS: readonly GaapThresholdField[] = [
  "absoluteNotice",
  "absoluteWatch",
  "rateSevere",
  "lowBaseGaap",
];

/** 默认阈值 = 现状硬编码值；R1.3 要求判定语义与默认判定结果保持不变。 */
export const DEFAULT_GAAP_THRESHOLDS: Readonly<GaapThresholds> = {
  absoluteNotice: 50_000,
  absoluteWatch: 300_000,
  rateSevere: 50,
  lowBaseGaap: 300_000,
};

export const GAAP_THRESHOLD_META: Readonly<
  Record<GaapThresholdField, { label: string; unit: string; hint: string }>
> = {
  absoluteNotice: { label: "T1 涨跌额下限", unit: "元", hint: "昨日环比涨跌额绝对值达到该值报 T1 提示档" },
  absoluteWatch: { label: "T2 涨跌额下限", unit: "元", hint: "达到该值报 T2 关注档，必须大于 T1 下限" },
  rateSevere: { label: "T3 环比下限", unit: "%", hint: "昨日环比比例绝对值达到该值报 T3 严重档" },
  lowBaseGaap: { label: "低基数门槛", unit: "元", hint: "上月 GAAP 低于该值只报环比档并标「低基数」" },
};

/** localStorage 键：值只存通过校验的四字段 JSON；读取端对任何非法内容回退默认。 */
export const GAAP_THRESHOLDS_STORAGE_KEY = "sa.settings.gaap-thresholds.v1";

export interface ThresholdStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GaapThresholdsFormResult {
  readonly ok: boolean;
  readonly thresholds: GaapThresholds | null;
  readonly errors: Partial<Record<GaapThresholdField, string>>;
}

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 表单解析 + 校验（R1.1）：字段级错误提示；任一字段非法即整体拒绝（thresholds=null），
 * 调用方保留上一次有效配置，绝不静默兜底或部分生效。
 */
export function parseGaapThresholdsForm(
  raw: Partial<Record<GaapThresholdField, string>>,
): GaapThresholdsFormResult {
  const errors: Partial<Record<GaapThresholdField, string>> = {};
  const parsed: Partial<Record<GaapThresholdField, number>> = {};
  for (const field of GAAP_THRESHOLD_FIELDS) {
    const value = parseNumber(String(raw[field] ?? ""));
    if (value === null) {
      errors[field] = "请输入有效数字";
      continue;
    }
    if (value < 0) {
      errors[field] = "不允许负数";
      continue;
    }
    if (field === "rateSevere" && value <= 0) {
      errors[field] = "必须大于 0";
      continue;
    }
    parsed[field] = value;
  }
  if (parsed.absoluteNotice !== undefined && parsed.absoluteWatch !== undefined
    && parsed.absoluteNotice >= parsed.absoluteWatch) {
    errors.absoluteNotice = "T1 下限必须小于 T2 下限";
    errors.absoluteWatch = "T2 下限必须大于 T1 下限";
  }
  if (Object.keys(errors).length > 0) return { ok: false, thresholds: null, errors };
  return {
    ok: true,
    thresholds: {
      absoluteNotice: parsed.absoluteNotice!,
      absoluteWatch: parsed.absoluteWatch!,
      rateSevere: parsed.rateSevere!,
      lowBaseGaap: parsed.lowBaseGaap!,
    },
    errors: {},
  };
}

/** 结构校验：四字段有限数字、非负、rateSevere>0、notice<watch；存储读取与写入共用。 */
function isThresholds(value: unknown): value is GaapThresholds {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const field of GAAP_THRESHOLD_FIELDS) {
    const item = record[field];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return false;
  }
  const rateSevere = record.rateSevere;
  const absoluteNotice = record.absoluteNotice;
  const absoluteWatch = record.absoluteWatch;
  return typeof rateSevere === "number" && rateSevere > 0
    && typeof absoluteNotice === "number" && typeof absoluteWatch === "number"
    && absoluteNotice < absoluteWatch;
}

/** 读取配置：无存储 / 缺键 / JSON 损坏 / 越界结构一律回退默认值（默认语义与现状一致）。 */
export function readGaapThresholds(storage: ThresholdStorageLike | null | undefined): GaapThresholds {
  if (!storage) return DEFAULT_GAAP_THRESHOLDS;
  try {
    const raw = storage.getItem(GAAP_THRESHOLDS_STORAGE_KEY);
    if (!raw) return DEFAULT_GAAP_THRESHOLDS;
    const parsed: unknown = JSON.parse(raw);
    return isThresholds(parsed) ? parsed : DEFAULT_GAAP_THRESHOLDS;
  } catch {
    return DEFAULT_GAAP_THRESHOLDS;
  }
}

export function thresholdsEqual(a: GaapThresholds, b: GaapThresholds): boolean {
  return GAAP_THRESHOLD_FIELDS.every((field) => a[field] === b[field]);
}

export type GaapThresholdsListener = (thresholds: GaapThresholds) => void;

/* 订阅表用不可变数组 + 重绑方式维护（与 demo-mode 同构，不做原地增删）。 */
let listeners: readonly GaapThresholdsListener[] = [];

/** 订阅阈值变化；返回退订函数（可安全重复调用）。 */
export function subscribeGaapThresholds(listener: GaapThresholdsListener): () => void {
  listeners = [...listeners, listener];
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners = listeners.filter((item) => item !== listener);
  };
}

function notifyGaapThresholds(thresholds: GaapThresholds): void {
  for (const listener of listeners) {
    try {
      listener(thresholds);
    } catch {
      /* 单个订阅者异常不拖垮广播 */
    }
  }
}

/** 设置页「保存」入口：校验通过才落库并广播；与默认值相同时只删键（存的都是自定义值）。 */
export function setGaapThresholds(
  storage: ThresholdStorageLike | null | undefined,
  thresholds: GaapThresholds,
): boolean {
  if (!isThresholds(thresholds)) return false;
  if (thresholdsEqual(thresholds, DEFAULT_GAAP_THRESHOLDS)) {
    if (storage) {
      try {
        storage.removeItem(GAAP_THRESHOLDS_STORAGE_KEY);
      } catch {
        /* 存储不可用：广播仍让本会话生效 */
      }
    }
  } else if (storage) {
    try {
      storage.setItem(GAAP_THRESHOLDS_STORAGE_KEY, JSON.stringify(thresholds));
    } catch {
      /* 隐私模式等存储不可用：本会话内仍由订阅广播与 React state 承载 */
    }
  }
  notifyGaapThresholds(thresholds);
  return true;
}

/** 设置页「恢复默认」入口：删键 + 广播默认值。 */
export function resetGaapThresholds(storage: ThresholdStorageLike | null | undefined): void {
  if (storage) {
    try {
      storage.removeItem(GAAP_THRESHOLDS_STORAGE_KEY);
    } catch {
      /* 存储不可用：广播仍让本会话生效 */
    }
  }
  notifyGaapThresholds(DEFAULT_GAAP_THRESHOLDS);
}

/** 阈值金额展示（元）：≥1 万用「万」格式（与 crm-shared 的 formatGaap 同口径）。 */
export function formatThresholdAmount(value: number): string {
  if (Math.abs(value) >= 10_000) {
    return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
  }
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/**
 * 异动面板口径文案：由同一份阈值动态生成（AC1 禁止与配置各写一套）。
 * 默认阈值输出与改造前硬编码文案逐字一致（特征基线锁定无配置时零视觉回归）。
 */
export function formatThresholdNote(thresholds: GaapThresholds): string {
  return `口径：昨日 GAAP 环比；阈值 T3 环比 ±${thresholds.rateSevere}% / T2 涨跌 ±${formatThresholdAmount(thresholds.absoluteWatch)} / T1 涨跌 ±${formatThresholdAmount(thresholds.absoluteNotice)}，多档取最高档；上月基数低于 ${formatThresholdAmount(thresholds.lowBaseGaap)}只报环比档并标「低基数」。`;
}
