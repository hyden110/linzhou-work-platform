/**
 * Contracts for the profile bridge（个人中心 · Cookie/BUC 会话与判活）。
 * Semantics ported from base/sa-workbench（搬语义不搬代码）：
 * - scripts/lib/profile.js：activeGet/activeSet（~/.sa-workbench/active.json）、
 *   users/<empId>/profile.json（0600）、publicView() 唯一出站视图（cookie 只给掩码）；
 * - tools/fetch/whoami.py：BUC 判活（CRD /sso/login/user/info），移植到 tools/profile/whoami.py，
 *   cookie 只经环境变量 SA_SESSION_COOKIE 注入子进程，绝不进日志 / 响应；
 * - tools/fetch/sa_cookies.py：chrome/manual/auto 三模式来源语义——本期只实现 manual，
 *   chrome/auto 如实返回 {supported:false}，绝不伪造成功。
 *
 * 红线：session 原值只存在 profile.json（0600）与子进程 env 中；任何响应 / 日志 /
 * 测试输出只出现掩码与元数据（source/domains/updatedAt/lastCheck/verifiedAt/empId/name）。
 */

/** 稳定错误码：路由按 code 映射 400/409/502，message 已过 redact、绝不含 cookie 原值。 */
export type ProfileErrorCode =
  | "profile_invalid_request"
  | "profile_no_active"
  | "profile_corrupt"
  | "profile_unavailable";

export const PROFILE_ERROR_STATUS: Readonly<Record<ProfileErrorCode, number>> = {
  profile_invalid_request: 400,
  profile_no_active: 400,
  profile_corrupt: 409,
  profile_unavailable: 502,
};

export class ProfileBridgeError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileBridgeError";
    this.code = code;
  }
}

/** 会话来源三态（照 donor sa_cookies.cookie_store 的 mode 语义）。 */
export type SessionSource = "manual" | "chrome" | "auto";

/** 最近一次判活结果（写回 profile.session.lastCheck；note 已 redact）。 */
export interface ProfileLastCheck {
  readonly ok: boolean;
  readonly at: string;
  /** true=本人；false=会话有效但非本人；null=判活失败，无法比对。 */
  readonly self: boolean | null;
  readonly code: string | null;
  readonly note: string | null;
  /** 判活返回的 empId（mismatch 时用于界面提示「会话属于谁」）。 */
  readonly empId: string | null;
}

/** profile.json 里的 session 段（value 为唯一敏感字段，绝不出站）。 */
export interface ProfileSessionRecord {
  readonly value: string;
  readonly domains: readonly string[];
  readonly updatedAt: string | null;
  readonly lastCheck: ProfileLastCheck | null;
  readonly verifiedAt: string | null;
}

export type ProfilePrefs = Readonly<Record<string, string | number | boolean | null>>;

/** ~/.sa-workbench/users/<empId>/profile.json 的文档结构。 */
export interface ProfileDoc {
  readonly version: 1;
  readonly user: { readonly empId: string; readonly name: string };
  readonly source: { readonly mode: SessionSource };
  readonly session: ProfileSessionRecord | null;
  readonly prefs: ProfilePrefs;
}

/** session 的公开投影：只有存在性 / 掩码 / 元数据，绝无原值。 */
export interface ProfileSessionView {
  readonly set: boolean;
  readonly masked: string;
  readonly count: number;
  readonly domains: readonly string[];
  readonly updatedAt: string | null;
  readonly lastCheck: ProfileLastCheck | null;
  readonly verifiedAt: string | null;
  readonly state: "unset" | "set" | "ok" | "bad";
}

/** GET /local/profile 的 data：publicView 是唯一出站视图（照 donor 语义）。 */
export interface ProfilePublicView {
  readonly configured: boolean;
  readonly user: { readonly empId: string; readonly name: string };
  readonly source: { readonly mode: SessionSource };
  readonly session: ProfileSessionView;
  readonly prefs: ProfilePrefs;
}

/** PUT /local/profile/session 的 data：chrome/auto 如实 supported:false，绝不伪造成功。 */
export interface ProfileSessionPutResult {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly view: ProfilePublicView | null;
}

/** POST /local/profile/test 的 data：本人 / 非本人 / 失败原因三态。 */
export interface ProfileTestResult {
  readonly state: "self" | "mismatch" | "failed";
  readonly empId: string | null;
  readonly name: string | null;
  readonly code: string | null;
  readonly note: string;
  readonly checkedAt: string;
  readonly view: ProfilePublicView;
}

/** PUT /local/profile/prefs 的 data。 */
export interface ProfilePrefsResult {
  readonly prefs: ProfilePrefs;
  readonly view: ProfilePublicView;
}
