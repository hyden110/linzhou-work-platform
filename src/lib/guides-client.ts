/**
 * Browser client for the guides bridge — GET /local/guides +
 * POST /local/guide/check + POST /local/guide/act.
 *
 * Degrade contract mirrors health-client. 步骤定义走白名单投影（多余字段物理
 * 不可达）；act 结果同样白名单化。安全语义：terminal 动作只回显 command 文本
 * 由页面展示、client 绝不代为执行；aitable-provision 的 confirm 必须是严格布尔
 * true 才会写进请求体（勾选框驱动）；confirm_required 错误随包带出确认文案。
 */

const GUIDES_TIMEOUT_MS = 30_000;
const ACT_TIMEOUT_MS = 300_000; /* provision 建表链路较长（多次 dws 往返） */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "guides_invalid_request",
  "guides_not_found",
  "guides_confirm_required",
  "guides_busy",
  "guides_provision_failed",
  "guides_unavailable",
  "method_not_allowed",
] as const;

export type GuidesClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class GuidesClientError extends Error {
  readonly code: GuidesClientErrorCode;
  /** confirm_required 时的二次确认文案（其余错误为空串）。 */
  readonly confirmText: string;

  constructor(code: GuidesClientErrorCode, confirmText = "") {
    super(code);
    this.name = "GuidesClientError";
    this.code = code;
    this.confirmText = confirmText;
  }
}

/* ---------- defs 投影 ---------- */

export type GuideStepKind = "check" | "action" | "input" | "done";

export interface GuideStepCheckView {
  readonly type: string;
  readonly name: string;
  readonly path: string;
  readonly id: string;
  readonly schemas: readonly string[];
}

export interface GuideStepActionView {
  readonly type: string;
  readonly cmd: string;
  readonly group: string;
  readonly schemas: readonly string[];
}

export interface GuideStepFixView {
  readonly cmd: string;
  readonly terminal: boolean;
  readonly label: string;
}

export interface GuideStepView {
  readonly id: string;
  readonly kind: GuideStepKind;
  readonly t: string;
  readonly d: string;
  readonly needConfirm: boolean;
  readonly confirm: string;
  readonly check: GuideStepCheckView | null;
  readonly action: GuideStepActionView | null;
  readonly fix: GuideStepFixView | null;
}

export interface GuideView {
  readonly id: string;
  readonly t: string;
  readonly d: string;
  readonly kind: string;
  readonly steps: readonly GuideStepView[];
}

export interface GuidesDefsView {
  readonly version: string;
  readonly guides: readonly GuideView[];
}

/* ---------- check / act 投影 ---------- */

export interface GuideVerifyResultView {
  readonly id: string;
  readonly ok: boolean;
  readonly note: string;
}

export interface GuideCheckView {
  readonly guide: string;
  readonly step: string;
  readonly state: "ok" | "fail";
  readonly detail: string;
  readonly results: readonly GuideVerifyResultView[] | null;
}

export interface ProvisionConfigView {
  readonly id: string;
  readonly file: string;
  readonly tableCount: number;
  readonly missing: readonly string[];
}

export interface ProvisionPlanView {
  readonly schemaId: string;
  readonly tableName: string;
  readonly action: string;
}

export interface ProvisionView {
  readonly baseId: string;
  readonly baseName: string;
  readonly plan: readonly ProvisionPlanView[];
  readonly configs: readonly ProvisionConfigView[];
}

export interface GuideActView {
  readonly ok: boolean;
  readonly terminal: boolean;
  readonly command: string;
  readonly note: string;
  readonly provision: ProvisionView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function request(path: string, init: RequestInit | undefined, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new GuidesClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    const code = isRecord(error) && typeof error.code === "string" && SAFE_ERROR_SET.has(error.code)
      ? (error.code as GuidesClientErrorCode)
      : "unavailable";
    throw new GuidesClientError(code, isRecord(error) ? str(error.confirm) : "");
  }
  return payload.data;
}

const STEP_KINDS: ReadonlySet<string> = new Set(["check", "action", "input", "done"]);

function asStep(value: unknown): GuideStepView | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string" || !STEP_KINDS.has(value.kind)) {
    return undefined;
  }
  const check = isRecord(value.check)
    ? { type: str(value.check.type), name: str(value.check.name), path: str(value.check.path), id: str(value.check.id), schemas: asStringArray(value.check.schemas) }
    : null;
  const action = isRecord(value.action)
    ? { type: str(value.action.type), cmd: str(value.action.cmd), group: str(value.action.group), schemas: asStringArray(value.action.schemas) }
    : null;
  const fix = isRecord(value.fix)
    ? { cmd: str(value.fix.cmd), terminal: value.fix.terminal === true, label: str(value.fix.label) }
    : null;
  return {
    id: value.id,
    kind: value.kind as GuideStepKind,
    t: str(value.t),
    d: str(value.d),
    needConfirm: value.needConfirm === true,
    confirm: str(value.confirm),
    check,
    action,
    fix,
  };
}

function asDefs(data: unknown): GuidesDefsView | undefined {
  if (!isRecord(data) || typeof data.version !== "string" || !Array.isArray(data.guides)) return undefined;
  const guides: GuideView[] = [];
  for (const item of data.guides) {
    if (!isRecord(item) || typeof item.id !== "string" || !Array.isArray(item.steps)) return undefined;
    const steps: GuideStepView[] = [];
    for (const raw of item.steps) {
      const step = asStep(raw);
      if (!step) return undefined;
      steps.push(step);
    }
    guides.push({ id: item.id, t: str(item.t), d: str(item.d), kind: str(item.kind) || "base", steps });
  }
  return { version: data.version, guides };
}

function asCheck(data: unknown): GuideCheckView | undefined {
  if (!isRecord(data) || typeof data.guide !== "string" || typeof data.step !== "string") return undefined;
  if (data.state !== "ok" && data.state !== "fail") return undefined;
  let results: GuideVerifyResultView[] | null = null;
  if (Array.isArray(data.results)) {
    results = [];
    for (const item of data.results) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.ok !== "boolean") return undefined;
      results.push({ id: item.id, ok: item.ok, note: str(item.note) });
    }
  }
  return { guide: data.guide, step: data.step, state: data.state, detail: str(data.detail), results };
}

function asProvision(value: unknown): ProvisionView | null {
  if (!isRecord(value) || typeof value.baseId !== "string") return null;
  const plan: ProvisionPlanView[] = Array.isArray(value.plan)
    ? value.plan.filter(isRecord).map((p) => ({ schemaId: str(p.schemaId), tableName: str(p.tableName), action: str(p.action) }))
    : [];
  const configs: ProvisionConfigView[] = Array.isArray(value.configs)
    ? value.configs.filter(isRecord).map((c) => ({
        id: str(c.id),
        file: str(c.file),
        tableCount: typeof c.tableCount === "number" ? c.tableCount : 0,
        missing: asStringArray(c.missing),
      }))
    : [];
  return { baseId: value.baseId, baseName: str(value.baseName), plan, configs };
}

function asAct(data: unknown): GuideActView | undefined {
  if (!isRecord(data) || typeof data.ok !== "boolean") return undefined;
  return {
    ok: data.ok,
    terminal: data.terminal === true,
    command: str(data.command),
    note: str(data.note),
    provision: asProvision(data.provision),
  };
}

/** GET /local/guides —— 指引定义（白名单投影，随包静态模型可作离线兜底）。 */
export async function fetchGuides(fetchImpl: typeof fetch = fetch): Promise<GuidesDefsView> {
  const view = asDefs(await request("/local/guides", undefined, GUIDES_TIMEOUT_MS, fetchImpl));
  if (!view) throw new GuidesClientError("invalid_response");
  return view;
}

/** POST /local/guide/check —— 单步只读检测。 */
export async function checkGuideStep(guide: string, step: string, fetchImpl: typeof fetch = fetch): Promise<GuideCheckView> {
  const view = asCheck(await request(
    "/local/guide/check",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guide, step }) },
    GUIDES_TIMEOUT_MS,
    fetchImpl,
  ));
  if (!view) throw new GuidesClientError("invalid_response");
  return view;
}

export interface GuideActOptions {
  /** 仅当用户勾选确认框时传 true；client 只接受严格布尔，其余值一律不下发。 */
  readonly confirm?: boolean;
}

/** POST /local/guide/act —— terminal 回显 / provision 建表（confirm===true 才下发）。 */
export async function actGuideStep(guide: string, step: string, options: GuideActOptions = {}, fetchImpl: typeof fetch = fetch): Promise<GuideActView> {
  const body: Record<string, unknown> = { guide, step };
  if (options.confirm === true) body.confirm = true;
  const view = asAct(await request(
    "/local/guide/act",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ACT_TIMEOUT_MS,
    fetchImpl,
  ));
  if (!view) throw new GuidesClientError("invalid_response");
  return view;
}

export function guidesErrorMessage(error: unknown): string {
  const code = error instanceof GuidesClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的向导数据。",
    guides_invalid_request: "向导请求参数不完整，请重试。",
    guides_not_found: "指引或步骤不存在，请刷新后重试。",
    guides_confirm_required: "该动作需要勾选二次确认后才能执行。",
    guides_busy: "已有一键建表正在进行中，请等待本轮完成。",
    guides_provision_failed: "一键建表失败，详情见提示（输出已脱敏）。",
    guides_unavailable: "向导执行能力暂时不可用，请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  return messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
}
