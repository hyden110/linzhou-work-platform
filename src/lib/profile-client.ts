/**
 * Browser client for the profile view（个人中心 · Cookie/BUC 会话与判活）—
 * GET/PUT/DELETE /local/profile/*。契约与 dev/profile/profile-types.ts 一致：
 * 成功 {ok:true,data}；失败 {ok:false,error:{code,message}}。客户端只做白名单投影
 * 与稳定错误码折叠（同 agents/report 客户端口径）：桥离线 → unavailable +
 * 「本地桥未启动」文案。红线：session 原值只在 PUT 请求体里出现一次（发给本机桥），
 * 响应投影里绝无 value 字段；错误文案绝不回显 Cookie。
 */

import { composeErrorMessage } from "./error-message.ts";

const PROFILE_TIMEOUT_MS = 10_000;
/** 桥侧判活子进程硬超时 20s，前端留 5s 余量。 */
const TEST_TIMEOUT_MS = 25_000;

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "profile_invalid_request",
  "profile_no_active",
  "profile_corrupt",
  "profile_unavailable",
] as const;

export type ProfileClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class ProfileClientError extends Error {
  readonly code: ProfileClientErrorCode;
  readonly detail: string;

  constructor(code: ProfileClientErrorCode, detail = "") {
    super(code);
    this.name = "ProfileClientError";
    this.code = code;
    this.detail = detail;
  }
}

/* 投影类型与 dev/profile/profile-types.ts 语义一致（白名单字段，绝无 session 原值）。 */

export type SessionSource = "manual" | "chrome" | "auto";

export interface ProfileLastCheck {
  readonly ok: boolean;
  readonly at: string;
  readonly self: boolean | null;
  readonly code: string | null;
  readonly note: string | null;
  readonly empId: string | null;
}

export type SessionState = "unset" | "set" | "ok" | "bad";

export interface ProfileSessionView {
  readonly set: boolean;
  readonly masked: string;
  readonly count: number;
  readonly domains: readonly string[];
  readonly updatedAt: string | null;
  readonly lastCheck: ProfileLastCheck | null;
  readonly verifiedAt: string | null;
  readonly state: SessionState;
}

export type ProfilePrefs = Readonly<Record<string, string | number | boolean | null>>;

export interface ProfilePublicView {
  readonly configured: boolean;
  readonly user: { readonly empId: string; readonly name: string };
  readonly source: { readonly mode: SessionSource };
  readonly session: ProfileSessionView;
  readonly prefs: ProfilePrefs;
}

export interface ProfileSessionPutResult {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly view: ProfilePublicView | null;
}

export type ProfileTestState = "self" | "mismatch" | "failed";

export interface ProfileTestResult {
  readonly state: ProfileTestState;
  readonly empId: string | null;
  readonly name: string | null;
  readonly code: string | null;
  readonly note: string;
  readonly checkedAt: string;
  readonly view: ProfilePublicView;
}

export interface ProfilePrefsResult {
  readonly prefs: ProfilePrefs;
  readonly view: ProfilePublicView;
}

export interface PutSessionInput {
  readonly source: SessionSource;
  readonly value?: string;
  readonly domains?: readonly string[];
  readonly empId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const asNullableText = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

function asSource(value: unknown): SessionSource {
  return value === "chrome" || value === "auto" ? value : "manual";
}

function asState(value: unknown): SessionState {
  return value === "set" || value === "ok" || value === "bad" ? value : "unset";
}

function asLastCheck(value: unknown): ProfileLastCheck | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  return {
    ok: value.ok,
    at: asText(value.at),
    self: typeof value.self === "boolean" ? value.self : null,
    code: asNullableText(value.code),
    note: asNullableText(value.note),
    empId: asNullableText(value.empId),
  };
}

function asPrefs(value: unknown): ProfilePrefs {
  if (!isRecord(value)) return {};
  const prefs: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    const kind = typeof entry;
    if (entry === null || kind === "boolean" || kind === "string"
      || (kind === "number" && Number.isFinite(entry))) {
      prefs[key] = entry as string | number | boolean | null;
    }
  }
  return prefs;
}

/** 白名单投影：敌意多余字段（如 session.value）一律丢弃，绝不进入前端状态。 */
function asView(value: unknown): ProfilePublicView | undefined {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.session)) return undefined;
  const session = value.session;
  return {
    configured: value.configured === true,
    user: { empId: asText(value.user.empId), name: asText(value.user.name) },
    source: { mode: asSource(isRecord(value.source) ? value.source.mode : undefined) },
    session: {
      set: session.set === true,
      masked: asText(session.masked),
      count: typeof session.count === "number" && Number.isFinite(session.count) ? session.count : 0,
      domains: Array.isArray(session.domains) ? session.domains.filter((d): d is string => typeof d === "string") : [],
      updatedAt: asNullableText(session.updatedAt),
      lastCheck: asLastCheck(session.lastCheck),
      verifiedAt: asNullableText(session.verifiedAt),
      state: asState(session.state),
    },
    prefs: asPrefs(value.prefs),
  };
}

function profileUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  method: "GET" | "PUT" | "DELETE" | "POST",
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetchImpl(new Request(profileUrl(path), init));
  } catch {
    throw new ProfileClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const code = error && typeof error.code === "string" && SAFE_ERROR_SET.has(error.code)
      ? (error.code as ProfileClientErrorCode)
      : "unavailable";
    throw new ProfileClientError(code, error ? asText(error.message) : "");
  }
  return payload;
}

/** GET /local/profile —— publicView（掩码后的会话元数据，绝无原值）。 */
export async function fetchProfileView(fetchImpl: typeof fetch = fetch): Promise<ProfilePublicView> {
  const payload = await requestJson("GET", "/local/profile", undefined, PROFILE_TIMEOUT_MS, fetchImpl);
  const view = asView(payload.data);
  if (!view) throw new ProfileClientError("invalid_response");
  return view;
}

/** PUT /local/profile/session —— manual 保存；chrome/auto 返回 supported:false（诚实拒绝）。 */
export async function putProfileSession(
  input: PutSessionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProfileSessionPutResult> {
  const payload = await requestJson("PUT", "/local/profile/session", input, PROFILE_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data || typeof data.supported !== "boolean") throw new ProfileClientError("invalid_response");
  const view = asView(data.view) ?? null;
  if (data.supported === true && !view) throw new ProfileClientError("invalid_response");
  return { supported: data.supported, reason: asNullableText(data.reason), view };
}

/** DELETE /local/profile/session —— 清除本机保存的会话原值。 */
export async function deleteProfileSession(fetchImpl: typeof fetch = fetch): Promise<ProfilePublicView> {
  const payload = await requestJson("DELETE", "/local/profile/session", undefined, PROFILE_TIMEOUT_MS, fetchImpl);
  const view = asView(payload.data);
  if (!view) throw new ProfileClientError("invalid_response");
  return view;
}

/** POST /local/profile/test —— BUC 判活三态（self / mismatch / failed），超时上限 25s。 */
export async function testProfileSession(fetchImpl: typeof fetch = fetch): Promise<ProfileTestResult> {
  const payload = await requestJson("POST", "/local/profile/test", undefined, TEST_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  const view = data ? asView(data.view) : undefined;
  if (!data || !view || (data.state !== "self" && data.state !== "mismatch" && data.state !== "failed")) {
    throw new ProfileClientError("invalid_response");
  }
  return {
    state: data.state,
    empId: asNullableText(data.empId),
    name: asNullableText(data.name),
    code: asNullableText(data.code),
    note: asText(data.note),
    checkedAt: asText(data.checkedAt),
    view,
  };
}

/** PUT /local/profile/prefs —— 偏好不可变合并，返回合并后的新对象。 */
export async function putProfilePrefs(
  prefs: Record<string, string | number | boolean | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<ProfilePrefsResult> {
  const payload = await requestJson("PUT", "/local/profile/prefs", { prefs }, PROFILE_TIMEOUT_MS, fetchImpl);
  const data = isRecord(payload.data) ? payload.data : undefined;
  const view = data ? asView(data.view) : undefined;
  if (!data || !view) throw new ProfileClientError("invalid_response");
  return { prefs: asPrefs(data.prefs), view };
}

export function profileErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的个人中心数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    profile_invalid_request: "输入未通过校验（工号 / Cookie / 域名白名单 / 参数形态）。",
    profile_no_active: "尚无活动账号：先填写工号并粘贴 Cookie 完成配置。",
    profile_corrupt: "本机 profile 文件损坏，已拒绝读写：请人工检查 ~/.sa-workbench 后重试。",
    profile_unavailable: "个人中心暂时不可用（本机存储或子进程异常），详情见桥日志。",
  };
  const code = error instanceof ProfileClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  return composeErrorMessage(base, error instanceof ProfileClientError ? error.detail : "");
}
