/**
 * Guides bridge — 接入向导：GET /local/guides（定义）+ POST /local/guide/check（只读检测）
 * + POST /local/guide/act（terminal 回显 / provision 建表 / refresh 委托）。
 *
 * 子路由模式与 ontology/datasource 桥一致：local-router.ts 禁改，本桥自带
 * handle(request) 并导出 GUIDES_ROUTES 供接线（见 dev/guides-bridge.ts 头注释）。
 *
 * 安全红线：terminal 步只回显命令文本绝不执行；provision 必经 confirm===true
 * 且单飞（并发 → guides_busy）；一切 dws 输出过 redactNote；身份值不回显；
 * detail/note 不含绝对路径。
 */

import { join, resolve as resolvePath } from "node:path";

import { GUIDES_MODEL_VERSION, guideOf, guides, stepOf, type Guide, type GuideStep } from "../../src/lib/guides-model.ts";
import { createDefaultHealthRunner } from "../health/health-cli.ts";
import { redactNote } from "../health/health-redact.ts";
import { actStep } from "./guides-act.ts";
import { checkStep } from "./guides-check.ts";
import {
  DEFAULT_DWS_TIMEOUT_MS,
} from "./aitable-provision.ts";
import {
  GUIDES_ROUTES,
  GuidesBridgeError,
  type GuideActResult,
  type GuideCheckResult,
  type GuideDefsView,
  type GuidesBridge,
  type GuidesBridgeOptions,
  type GuidesErrorCode,
} from "./guides-types.ts";

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** 请求体体积上限：check/act body 只有 {guide,step,confirm}，1KB 足够。 */
const MAX_BODY_BYTES = 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: GuidesErrorCode): number {
  if (code === "guides_not_found") return 404;
  if (code === "guides_busy") return 409;
  if (code === "guides_provision_failed" || code === "guides_unavailable") return 502;
  if (code === "method_not_allowed") return 405;
  return 400; // invalid_request / confirm_required
}

function resolveStep(guideId: unknown, stepId: unknown, kind: "check" | "action"): { guide: Guide; step: GuideStep } {
  const id = typeof guideId === "string" ? guideId.slice(0, 60) : "";
  const guide = guideOf(id);
  if (!guide) throw new GuidesBridgeError("guides_not_found", `未知指引：${id || "(缺 guide)"}`);
  const sid = typeof stepId === "string" ? stepId.slice(0, 60) : "";
  const step = stepOf(guide, sid);
  if (!step || step.kind !== kind) {
    throw new GuidesBridgeError("guides_not_found", `指引「${id}」无${kind === "check" ? "检测" : "动作"}步：${sid || "(缺 step)"}`);
  }
  return { guide, step };
}

export function createGuidesBridge(options: GuidesBridgeOptions = {}): GuidesBridge {
  const env = options.env ?? process.env;
  const dwsBin = options.dwsBin ?? env.DWS_BIN ?? "dws";
  const run = options.run ?? createDefaultHealthRunner();
  const cacheDir = options.cacheDir ?? join(PROJECT_ROOT, ".local-cache");
  const timeoutMs = options.dwsTimeoutMs ?? DEFAULT_DWS_TIMEOUT_MS;
  let inflightProvision: Promise<unknown> | null = null;

  async function defs(): Promise<GuideDefsView> {
    return { version: GUIDES_MODEL_VERSION, guides };
  }

  async function check(body: unknown): Promise<GuideCheckResult> {
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const { guide, step } = resolveStep(record.guide, record.step, "check");
    try {
      return await checkStep(guide, step, { run, dwsBin, cacheDir, timeoutMs, capsView: options.capsView });
    } catch (error) {
      if (error instanceof GuidesBridgeError) throw error;
      throw new GuidesBridgeError(
        "guides_unavailable",
        `检测失败：${redactNote(error instanceof Error ? error.message : error)}`,
      );
    }
  }

  async function act(body: unknown): Promise<GuideActResult> {
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const { guide, step } = resolveStep(record.guide, record.step, "action");
    const deps = { run, dwsBin, cacheDir, timeoutMs, actRefresh: options.actRefresh };
    if (step.action?.type === "aitable-provision") {
      /* 单飞：建表串行化，并发第二个直接 busy（不排队、不伪造成功）。 */
      if (inflightProvision) {
        throw new GuidesBridgeError("guides_busy", "已有一键建表正在进行中，请等待本轮完成");
      }
      const task = actStep(guide, step, record, deps).finally(() => {
        inflightProvision = null;
      });
      inflightProvision = task;
      const outcome = await task;
      return outcome.obj as GuideActResult;
    }
    const outcome = await actStep(guide, step, record, deps);
    return outcome.obj as GuideActResult;
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new GuidesBridgeError("guides_invalid_request", "请求体过大：只需要 {guide, step[, confirm]}。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new GuidesBridgeError("guides_invalid_request", "请求体过大：只需要 {guide, step[, confirm]}。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new GuidesBridgeError("guides_invalid_request", "请求体不是合法 JSON。");
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const route = GUIDES_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非向导路径：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      if (route.operation === "defs") return jsonResponse({ ok: true, data: await defs() });
      if (route.operation === "check") return jsonResponse({ ok: true, data: await check(await readBody(request)) });
      return jsonResponse({ ok: true, data: await act(await readBody(request)) });
    } catch (error) {
      if (error instanceof GuidesBridgeError) {
        const payload: Record<string, unknown> = { code: error.code, message: error.message };
        /* confirm_required 时把二次确认文案随信封带出，供前端确认框展示。 */
        if (error.code === "guides_confirm_required") {
          payload.needConfirm = true;
          payload.confirm = error.confirmText;
        }
        return jsonResponse({ ok: false, error: payload }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "guides_unavailable", message: redactNote("接入向导遇到未知故障，请稍后重试。") } },
        502,
      );
    }
  }

  return { defs, check, act, handle };
}
