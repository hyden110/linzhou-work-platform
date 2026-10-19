/**
 * Contract types for the environment health snapshot (F4), ported in spirit
 * from base/sa-workbench scripts/lib/health.js: the snapshot answers one
 * question — "can I still fetch data right now?" — with three independent
 * groups (bridges / cli / caps) that each degrade on their own.
 *
 * 口径偏离（任务指定，区别于静态版能力页）：静态版把未装/未配置项整项隐藏，
 * 体检页则如实显示 unconfigured/missing 灰行 + 修法提示——体检页的价值就在
 * 于暴露缺口。Cookie/BUC 登录类检测按任务范围明确排除，永不出现在本快照。
 */

export type HealthRowState = "ok" | "unconfigured" | "error";
export type HealthCliState = "ok" | "error" | "missing" | "unknown";

export interface HealthBridgeRow {
  readonly name: string;
  readonly state: HealthRowState;
  /** 非敏感 detail：计数/布尔/一句话原因，绝无凭据。 */
  readonly detail: string;
}

export interface HealthCliRow {
  readonly name: string;
  readonly state: HealthCliState;
  /** 只读可得的版本号；拿不到如实空串（state=unknown）。 */
  readonly version: string;
  /** 修法提示（missing）或脱敏后的失败首行（error）。 */
  readonly note: string;
}

export interface HealthCapRow {
  readonly name: string;
  readonly state: HealthRowState;
  /** env 只报 set/unset 布尔，值永不入快照。 */
  readonly set: boolean;
  readonly note: string;
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly fetchedAt: string;
  readonly bridges: readonly HealthBridgeRow[];
  readonly cli: readonly HealthCliRow[];
  readonly caps: readonly HealthCapRow[];
}
