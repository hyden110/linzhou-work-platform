import { redactNote } from "../health/health-redact.ts";
import {
  blankProfile,
  createProfileStore,
  normalizeDomains,
  publicView,
  sanitizePrefs,
  sessionValueProblem,
  SESSION_SOURCES,
  validEmp,
  type ProfileStore,
} from "./profile-store.ts";
import {
  PROFILE_ERROR_STATUS,
  ProfileBridgeError,
  type ProfileDoc,
  type ProfileLastCheck,
  type ProfilePrefsResult,
  type ProfilePublicView,
  type ProfileSessionPutResult,
  type ProfileTestResult,
} from "./profile-types.ts";
import {
  createDefaultWhoamiRunner,
  defaultWhoamiPath,
  WHOAMI_TIMEOUT_MS,
  type WhoamiRunner,
} from "./profile-whoami.ts";

/**
 * 个人中心桥（Cookie/BUC 会话与判活）— 五个 handler 均为 Request → Response，
 * 由交付负责人按 PROFILE_ROUTES 接线进 dev/local-router.ts（本模块不改共享路由）。
 *
 * 契约：
 * - 成功 {ok:true, data}；失败 {ok:false, error:{code, message}}（code 见 ProfileErrorCode，
 *   状态映射 400/409/502）；
 * - chrome/auto 提取本期未接入：PUT session 如实返回 {supported:false, reason:'chrome 提取未接入'}，
 *   绝不伪造成功、绝不落存储；
 * - 判活（POST test）三态：self / mismatch / failed；cookie 只经 env SA_SESSION_COOKIE
 *   注入子进程，响应 / 日志 / 落盘 note 一律过掩码与 redact。
 */

export const CHROME_UNSUPPORTED_REASON = "chrome 提取未接入";

const SESSION_BODY_MAX_BYTES = 16 * 1024;
const PREFS_BODY_MAX_BYTES = 4 * 1024;

export interface ProfileRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
}

/** 路由表常量（方法 + 路径 + handler 名），供交付负责人在 local-router.ts 接线。 */
export const PROFILE_ROUTES: readonly ProfileRoute[] = [
  { method: "GET", path: "/local/profile", handler: "view" },
  { method: "PUT", path: "/local/profile/session", handler: "putSession" },
  { method: "DELETE", path: "/local/profile/session", handler: "deleteSession" },
  { method: "POST", path: "/local/profile/test", handler: "testSession" },
  { method: "PUT", path: "/local/profile/prefs", handler: "putPrefs" },
];

export interface ProfileBridgeOptions {
  readonly home?: string;
  readonly now?: () => number;
  /** 判活子进程 runner（测试注入 stub；默认 execFile python3 + tools/profile/whoami.py）。 */
  readonly whoamiRunner?: WhoamiRunner;
  readonly whoamiPath?: string;
}

export interface ProfileBridge {
  readonly view: (request: Request) => Promise<Response>;
  readonly putSession: (request: Request) => Promise<Response>;
  readonly deleteSession: (request: Request) => Promise<Response>;
  readonly testSession: (request: Request) => Promise<Response>;
  readonly putPrefs: (request: Request) => Promise<Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const okJson = (data: unknown): Response => jsonResponse({ ok: true, data });

async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ProfileBridgeError("profile_invalid_request", "请求体必须是 application/json");
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("too large");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProfileBridgeError("profile_invalid_request", `请求体不是合法 JSON 或超过 ${Math.round(maxBytes / 1024)}KB 上限`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileBridgeError("profile_invalid_request", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 未知异常兜底：502 + 通用文案；详细上下文（已过 redact）只进桥日志，不进响应。 */
function failure(error: unknown): Response {
  if (error instanceof ProfileBridgeError) {
    return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, PROFILE_ERROR_STATUS[error.code]);
  }
  const message = redactNote(error instanceof Error ? error.message : String(error));
  console.error(JSON.stringify({ event: "profile_bridge_error", message }));
  return jsonResponse(
    { ok: false, error: { code: "profile_unavailable", message: "个人中心操作失败（本机存储或子进程异常），详情见桥日志" } },
    502,
  );
}

export function createProfileBridge(options: ProfileBridgeOptions = {}): ProfileBridge {
  const now = options.now ?? Date.now;
  const store: ProfileStore = createProfileStore({ home: options.home, now });
  const whoamiPath = options.whoamiPath ?? defaultWhoamiPath();
  const whoamiRunner = options.whoamiRunner ?? createDefaultWhoamiRunner();

  const timestamp = (): string => new Date(now()).toISOString();

  /** 读活动账号 + profile；无 active → null；损坏 → 抛 profile_corrupt（拒绝后续写）。 */
  async function activeDoc(): Promise<{ empId: string; doc: ProfileDoc } | null> {
    const active = await store.readActive();
    if (!active) return null;
    const doc = (await store.readProfile(active.empId)) ?? blankProfile(active.empId);
    return { empId: active.empId, doc };
  }

  async function writeSessionUpdate(
    doc: ProfileDoc,
    empId: string,
    session: ProfileDoc["session"],
    name?: string,
  ): Promise<ProfileDoc> {
    const next: ProfileDoc = {
      ...doc,
      user: name ? { ...doc.user, name } : doc.user,
      session,
    };
    await store.writeProfile(empId, next);
    return next;
  }

  async function view(): Promise<Response> {
    const current = await activeDoc();
    return okJson(publicView(current ? current.doc : null));
  }

  async function putSession(request: Request): Promise<Response> {
    const body = await readJsonBody(request, SESSION_BODY_MAX_BYTES);
    const source = body.source;
    if (typeof source !== "string" || !SESSION_SOURCES.includes(source)) {
      throw new ProfileBridgeError("profile_invalid_request", "source 必须是 manual / chrome / auto");
    }
    if (source !== "manual") {
      // 诚实拒绝：chrome/auto 的真实提取本期未接入，绝不伪造成功、不落任何存储。
      const result: ProfileSessionPutResult = { supported: false, reason: CHROME_UNSUPPORTED_REASON, view: null };
      return okJson(result);
    }

    const problem = sessionValueProblem(body.value);
    if (problem) throw new ProfileBridgeError("profile_invalid_request", problem);
    const value = String(body.value).trim();
    const domains = normalizeDomains(body.domains);
    if (!domains.ok) throw new ProfileBridgeError("profile_invalid_request", domains.reason);

    const active = await store.readActive();
    let empId = active?.empId ?? null;
    if (body.empId !== undefined) {
      if (!validEmp(body.empId)) {
        throw new ProfileBridgeError("profile_invalid_request", "工号不合法（1-32 位字母 / 数字 / _ / -）");
      }
      empId = body.empId as string;
    }
    if (!empId) {
      throw new ProfileBridgeError("profile_no_active", "尚无活动账号：请先填写工号再粘贴 Cookie");
    }

    const existing = await store.readProfile(empId); // 损坏 → profile_corrupt，绝不覆盖
    const doc: ProfileDoc = {
      version: 1,
      user: { empId, name: existing?.user.name ?? "" },
      source: { mode: "manual" },
      session: { value, domains: domains.domains, updatedAt: timestamp(), lastCheck: null, verifiedAt: null },
      prefs: existing?.prefs ?? {},
    };
    await store.writeProfile(empId, doc);
    await store.setActive(empId);
    const result: ProfileSessionPutResult = { supported: true, reason: null, view: publicView(doc) };
    return okJson(result);
  }

  async function deleteSession(): Promise<Response> {
    const active = await store.readActive();
    if (!active) throw new ProfileBridgeError("profile_no_active", "尚无活动账号，无可清除的会话");
    const doc = (await store.readProfile(active.empId)) ?? blankProfile(active.empId);
    const next: ProfileDoc = { ...doc, session: null };
    await store.writeProfile(active.empId, next);
    return okJson(publicView(next));
  }

  function testResult(state: ProfileTestResult["state"], fields: Omit<ProfileTestResult, "state">): Response {
    const result: ProfileTestResult = { state, ...fields };
    return okJson(result);
  }

  async function testSession(): Promise<Response> {
    const checkedAt = timestamp();
    const current = await activeDoc();
    if (!current) {
      return testResult("failed", {
        empId: null, name: null, code: "no_active", note: "尚无活动账号：先粘贴 Cookie 完成配置",
        checkedAt, view: publicView(null),
      });
    }
    const { empId, doc } = current;
    const session = doc.session;
    if (!session || !session.value) {
      return testResult("failed", {
        empId: null, name: null, code: "no_session", note: "当前账号没有已保存的会话 Cookie",
        checkedAt, view: publicView(doc),
      });
    }

    const outcome = await whoamiRunner({
      whoamiPath,
      timeoutMs: WHOAMI_TIMEOUT_MS,
      // cookie 只进子进程 env（该进程内存），绝不进 argv / 日志 / 响应。
      env: { ...process.env, SA_SESSION_COOKIE: session.value },
    });
    // 双保险：runner 回传（含测试 stub）一律过 redact + 白名单校验后才可落盘 / 出站。
    const safeNote = redactNote(outcome.note).slice(0, 200);
    const safeName = outcome.ok ? redactNote(outcome.name ?? "").slice(0, 64) || null : null;
    const safeEmpId = outcome.ok && validEmp(outcome.empId) ? (outcome.empId as string) : null;

    if (outcome.ok && safeEmpId === empId) {
      const lastCheck: ProfileLastCheck = { ok: true, at: checkedAt, self: true, code: null, note: null, empId };
      const next = await writeSessionUpdate(doc, empId, { ...session, lastCheck, verifiedAt: checkedAt }, safeName ?? undefined);
      return testResult("self", {
        empId, name: next.user.name || null, code: null, note: "BUC 会话有效，且与当前账号一致",
        checkedAt, view: publicView(next),
      });
    }

    if (outcome.ok && safeEmpId) {
      const lastCheck: ProfileLastCheck = {
        ok: true, at: checkedAt, self: false, code: null, note: null, empId: safeEmpId,
      };
      const next = await writeSessionUpdate(doc, empId, { ...session, lastCheck });
      return testResult("mismatch", {
        empId: safeEmpId, name: safeName, code: null,
        note: `会话属于其他账号（${safeEmpId}），与当前账号 ${empId} 不一致`,
        checkedAt, view: publicView(next),
      });
    }

    const code = outcome.ok ? "no_emp" : outcome.code ?? "error";
    const note = outcome.ok ? "判活返回中无合法工号（openId）" : safeNote || "判活失败（子进程未给出原因）";
    const lastCheck: ProfileLastCheck = { ok: false, at: checkedAt, self: null, code, note, empId: null };
    const next = await writeSessionUpdate(doc, empId, { ...session, lastCheck, verifiedAt: null });
    return testResult("failed", { empId: null, name: null, code, note, checkedAt, view: publicView(next) });
  }

  async function putPrefs(request: Request): Promise<Response> {
    const body = await readJsonBody(request, PREFS_BODY_MAX_BYTES);
    const incoming = sanitizePrefs(body.prefs);
    if (!incoming) {
      throw new ProfileBridgeError("profile_invalid_request", "prefs 只接受扁平的 布尔 / 字符串 / 数字 / null 键值（≤50 键）");
    }
    const active = await store.readActive();
    if (!active) throw new ProfileBridgeError("profile_no_active", "尚无活动账号：先完成会话配置再保存偏好");
    const doc = (await store.readProfile(active.empId)) ?? blankProfile(active.empId);
    // 不可变合并：返回新对象，旧 doc / 旧 prefs 原样保留。
    const prefs = { ...doc.prefs, ...incoming };
    const next: ProfileDoc = { ...doc, prefs };
    await store.writeProfile(active.empId, next);
    const result: ProfilePrefsResult = { prefs, view: publicView(next) };
    return okJson(result);
  }

  const wrap = (handler: (request: Request) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      try {
        return await handler(request);
      } catch (error) {
        return failure(error);
      }
    };

  return {
    view: wrap(view),
    putSession: wrap(putSession),
    deleteSession: wrap(() => deleteSession()),
    testSession: wrap(() => testSession()),
    putPrefs: wrap(putPrefs),
  };
}

export type { ProfilePublicView, ProfileSessionPutResult, ProfileTestResult, ProfilePrefsResult };
