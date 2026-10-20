import { resolve as resolvePath, join } from "node:path";

import { redactNote } from "../health/health-redact.ts";
import { createProfileStore, publicView, type ProfileStore } from "../profile/profile-store.ts";
import { editKey, parseEditKey, requireValidEdits, MAX_EDITS } from "./okr-edits.ts";
import { createDefaultPythonRunner, parseLastJson, type PythonRunOptions, type PythonRunner } from "./okr-runner.ts";
import { createOkrStore, type OkrStore } from "./okr-store.ts";
import {
  OKR_ERROR_STATUS,
  OKR_WRITE_STATES,
  OkrBridgeError,
  type OkrAuditLine,
  type OkrDiffItem,
  type OkrEdit,
  type OkrEditsFile,
  type OkrWriteState,
} from "./okr-types.ts";

/**
 * OKR 桥（CRD 目标完整读写）— 五个 handler 均为 Request → Response，
 * 由交付负责人按 OKR_ROUTES 接线进 dev/local-router.ts（本模块不改共享路由）。
 *
 * 两步确认契约（照 donor scripts/bridge.js /sync-dry、/sync-confirm 红线）：
 * - sync-dry：edits 暂存落盘 + okr_write.py 默认 dry-run（只 find + 逐项差异，
 *   绝不带 --confirm，不落远端）；
 * - sync-confirm：仅勾选键写 edits.confirm.json 后 okr_write.py --confirm；
 *   勾选键含冲突项且未 acceptConflicts → 409 拒绝并返回冲突清单，写通道不启动；
 * - refresh / sync-dry / sync-confirm 共用一把单飞锁（连点 → 429 okr_busy）；
 * - 每次确认写入都追加审计行 {at,keys,acceptConflicts,exitCode}（audit.jsonl）。
 *
 * 会话红线：BUC cookie 只经 execFile env SA_SESSION_COOKIE 注入子进程，
 * 绝不进 argv / 日志 / 响应 / 落盘产物；未配置会话 → 400 profile_no_session。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");

/** fetch_okr.py 硬超时（任务口径 60s）。 */
export const OKR_REFRESH_TIMEOUT_MS = 60_000;
/** okr_write.py 硬超时（donor 240s 同口径：逐 O find + 整树 PUT）。 */
export const OKR_SYNC_TIMEOUT_MS = 240_000;

const SYNC_BODY_MAX_BYTES = 1024 * 1024;
const NOTE_LIMIT = 300;

export interface OkrRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
}

/** 路由表常量（方法 + 路径 + handler 名），供交付负责人在 local-router.ts 接线。 */
export const OKR_ROUTES: readonly OkrRoute[] = [
  { method: "GET", path: "/local/okr", handler: "view" },
  { method: "POST", path: "/local/okr/refresh", handler: "refresh" },
  { method: "GET", path: "/local/okr/edits", handler: "edits" },
  { method: "POST", path: "/local/okr/sync-dry", handler: "syncDry" },
  { method: "POST", path: "/local/okr/sync-confirm", handler: "syncConfirm" },
];

export interface OkrBridgeOptions {
  /** profile 存储根（测试注入 tmp home；默认真实 ~/.sa-workbench）。 */
  readonly home?: string;
  /** OKR 缓存目录（默认 <项目根>/.local-cache/okr）。 */
  readonly cacheDir?: string;
  readonly now?: () => number;
  /** python 子进程 runner（测试注入 stub；默认 execFile python3）。 */
  readonly pythonRunner?: PythonRunner;
  /** tools/okr 脚本目录（默认 <项目根>/tools/okr）。 */
  readonly toolsDir?: string;
}

export interface OkrBridge {
  readonly view: (request: Request) => Promise<Response>;
  readonly refresh: (request: Request) => Promise<Response>;
  readonly edits: (request: Request) => Promise<Response>;
  readonly syncDry: (request: Request) => Promise<Response>;
  readonly syncConfirm: (request: Request) => Promise<Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const okJson = (data: unknown): Response => jsonResponse({ ok: true, data });

async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new OkrBridgeError("okr_invalid_request", "请求体必须是 application/json");
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("too large");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new OkrBridgeError("okr_invalid_request", `请求体不是合法 JSON 或超过 ${Math.round(maxBytes / 1024)}KB 上限`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OkrBridgeError("okr_invalid_request", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

const asText = (value: unknown, limit = 64): string =>
  typeof value === "string" ? value.slice(0, limit) : "";

const asNullableText = (value: unknown, limit = 200): string | null =>
  typeof value === "string" ? value.slice(0, limit) : value === null || value === undefined ? null : String(value).slice(0, limit);

const asRecordOrNull = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function asState(value: unknown): OkrWriteState {
  return typeof value === "string" && (OKR_WRITE_STATES as readonly string[]).includes(value)
    ? (value as OkrWriteState)
    : "failed";
}

/** donor okr_write.py results 行 → 白名单差异项（note 一律 redact）。 */
function toDiffItem(raw: unknown): OkrDiffItem | null {
  const record = asRecordOrNull(raw);
  if (!record) return null;
  const kind = record.kind === "kr" ? "kr" : "o";
  const oId = asText(record.oId, 24);
  const field = asText(record.field, 20);
  if (!oId || !field) return null;
  const krId = kind === "kr" ? asText(record.krId, 24) || null : null;
  const state = asState(record.state);
  return {
    key: editKey({ oId, krId, field }),
    kind,
    oId,
    krId,
    field,
    before: asNullableText(record.from),
    after: asNullableText(record.to),
    crd: asNullableText(record.crd),
    state,
    conflict: state === "conflict",
    note: redactNote(record.note),
  };
}

function toDiffItems(results: unknown): OkrDiffItem[] {
  if (!Array.isArray(results)) return [];
  return results.map(toDiffItem).filter((item): item is OkrDiffItem => item !== null);
}

/** fetch_okr.py 末行摘要 → 出站白名单投影（绝对路径 / 未知字段不出桥）。 */
function toRefreshSummary(parsed: Record<string, unknown>): Record<string, unknown> {
  const totals = asRecordOrNull(parsed.totals) ?? {};
  const period = asRecordOrNull(parsed.period);
  return {
    generatedAt: asText(parsed.generatedAt, 40),
    mode: asText(parsed.mode, 20) || "live",
    period: period
      ? { id: asText(period.id, 40), name: asText(period.name, 64), periodType: asText(period.periodType, 20) }
      : null,
    totals: {
      oCount: typeof totals.oCount === "number" ? totals.oCount : 0,
      krCount: typeof totals.krCount === "number" ? totals.krCount : 0,
      crdProgressCount: typeof totals.crdProgressCount === "number" ? totals.crdProgressCount : 0,
    },
    sizeKb: typeof parsed.sizeKb === "number" ? parsed.sizeKb : 0,
  };
}

export function createOkrBridge(options: OkrBridgeOptions = {}): OkrBridge {
  const now = options.now ?? Date.now;
  const cacheDir = options.cacheDir ?? join(PROJECT_ROOT, ".local-cache", "okr");
  const toolsDir = options.toolsDir ?? join(PROJECT_ROOT, "tools", "okr");
  const store: OkrStore = createOkrStore(cacheDir);
  const profileStore: ProfileStore = createProfileStore({ home: options.home, now });
  const pythonRunner: PythonRunner = options.pythonRunner ?? createDefaultPythonRunner();

  const timestamp = (): string => new Date(now()).toISOString();

  /** 会话门：无 active / 无 profile / 无 cookie → 400 profile_no_session（诚实引导态）。 */
  async function requireSession(): Promise<{ empId: string; cookie: string; view: ReturnType<typeof publicView> }> {
    const active = await profileStore.readActive();
    if (!active) {
      throw new OkrBridgeError("profile_no_session", "尚未配置 BUC 会话：请先到「个人中心」填写工号并粘贴 Cookie");
    }
    const doc = await profileStore.readProfile(active.empId);
    const cookie = doc?.session?.value ?? "";
    if (!cookie) {
      throw new OkrBridgeError("profile_no_session", "当前账号没有已保存的 BUC 会话 Cookie：请先到「个人中心」完成配置");
    }
    return { empId: active.empId, cookie, view: publicView(doc) };
  }

  /** cookie 只进子进程 env（该进程内存），绝不进 argv / 日志 / 响应。 */
  function childEnv(cookie: string): NodeJS.ProcessEnv {
    return { ...process.env, SA_SESSION_COOKIE: cookie };
  }

  async function runPython(script: string, args: readonly string[], timeoutMs: number, cookie: string) {
    const runOptions: PythonRunOptions = {
      scriptPath: join(toolsDir, script),
      args,
      timeoutMs,
      env: childEnv(cookie),
    };
    return pythonRunner(runOptions);
  }

  /** 单飞锁：refresh / sync-dry / sync-confirm 互斥（同步占位，连点第二次立即 429）。 */
  let inflightTag: string | null = null;
  function acquireLock(tag: string): () => void {
    if (inflightTag !== null) {
      throw new OkrBridgeError("okr_busy", `另一个 OKR 任务（${inflightTag}）正在进行，请稍后重试`);
    }
    inflightTag = tag;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        inflightTag = null;
      }
    };
  }

  async function view(): Promise<Response> {
    const session = await requireSession();
    const snapshot = await store.readSnapshot();
    const staged = await store.readEdits();
    return okJson({
      hasSnapshot: snapshot !== null,
      snapshot,
      edits: staged.edits,
      exportedAt: staged.exportedAt,
      baseSnapshotAt: staged.baseSnapshotAt,
      session: { user: session.view.user, session: session.view.session },
    });
  }

  async function editsView(): Promise<Response> {
    await requireSession();
    const staged = await store.readEdits();
    return okJson({ edits: staged.edits, exportedAt: staged.exportedAt, baseSnapshotAt: staged.baseSnapshotAt });
  }

  async function refresh(): Promise<Response> {
    const release = acquireLock("refresh");
    try {
      const session = await requireSession();
      const result = await runPython("fetch_okr.py", ["--out", store.snapshotPath], OKR_REFRESH_TIMEOUT_MS, session.cookie);
      const parsed = parseLastJson(result.stdout);
      if (result.timedOut) {
        throw new OkrBridgeError("okr_refresh_failed", `OKR 快照刷新超时（>${Math.round(OKR_REFRESH_TIMEOUT_MS / 1000)}s），请稍后重试`);
      }
      if (!parsed || parsed.ok !== true) {
        const reason = parsed
          ? redactNote(parsed.note ?? parsed.code ?? "刷新失败").slice(0, NOTE_LIMIT)
          : redactNote(result.stderr || result.spawnError || "fetch_okr.py 无 JSON 输出").slice(0, NOTE_LIMIT);
        throw new OkrBridgeError("okr_refresh_failed", `OKR 快照刷新失败：${reason || "原因未知"}`);
      }
      return okJson(toRefreshSummary(parsed));
    } finally {
      release();
    }
  }

  async function syncDry(request: Request): Promise<Response> {
    const release = acquireLock("sync-dry");
    try {
      const session = await requireSession();
      const body = await readJsonBody(request, SYNC_BODY_MAX_BYTES);
      const edits = requireValidEdits(body.edits);
      const staged: OkrEditsFile = {
        exportedAt: timestamp(),
        baseSnapshotAt: asText(body.baseSnapshotAt, 40),
        edits,
      };
      await store.writeEdits(staged);
      // donor 红线：dry-run 绝不带 --confirm —— okr_write.py 只 find + 输出差异，不落远端。
      const result = await runPython("okr_write.py", ["--edits", store.editsPath], OKR_SYNC_TIMEOUT_MS, session.cookie);
      const parsed = parseLastJson(result.stdout);
      if (!parsed) {
        const reason = redactNote(result.stderr || result.spawnError || (result.timedOut ? "预检超时" : "okr_write.py 无 JSON 输出")).slice(0, NOTE_LIMIT);
        throw new OkrBridgeError("okr_sync_failed", `OKR 预检失败：${reason || "原因未知"}`);
      }
      const items = toDiffItems(parsed.results);
      await store.writeLastDry(items);
      return okJson({
        mode: "dry-run",
        ok: parsed.ok !== false,
        items,
        note: redactNote(parsed.note).slice(0, NOTE_LIMIT),
      });
    } finally {
      release();
    }
  }

  interface ConfirmPlan {
    readonly selected: readonly OkrEdit[];
    readonly keys: readonly string[];
    readonly acceptConflicts: boolean;
    readonly baseSnapshotAt: string;
  }

  async function planConfirm(body: Record<string, unknown>): Promise<ConfirmPlan> {
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new OkrBridgeError("okr_invalid_request", "没有勾选任何写入项（keys 必须是非空数组）");
    }
    if (body.keys.length > MAX_EDITS) {
      throw new OkrBridgeError("okr_invalid_request", `勾选键超过 ${MAX_EDITS} 条上限`);
    }
    if (body.acceptConflicts !== undefined && typeof body.acceptConflicts !== "boolean") {
      throw new OkrBridgeError("okr_invalid_request", "acceptConflicts 必须是布尔值");
    }
    const acceptConflicts = body.acceptConflicts === true;
    const parsedKeys = body.keys.map(parseEditKey);
    if (parsedKeys.some((key) => key === null)) {
      throw new OkrBridgeError("okr_invalid_request", "keys 含非法键（应为 oId|krId|field，id 为 24 位 hex，字段在白名单内）");
    }
    const staged = await store.readEdits();
    if (staged.edits.length === 0) {
      throw new OkrBridgeError("okr_invalid_request", "尚无预检暂存的编辑：请先执行 sync-dry 逐项过目后再确认");
    }
    const keySet = new Set(parsedKeys.map((key) => `${key!.oId}|${key!.krId ?? ""}|${key!.field}`));
    const stagedByKey = new Map(staged.edits.map((edit) => [editKey(edit), edit]));
    const unknown = [...keySet].filter((key) => !stagedByKey.has(key));
    if (unknown.length > 0) {
      throw new OkrBridgeError("okr_invalid_request", `${unknown.length} 个勾选键不在预检暂存清单中：请重新执行 sync-dry`);
    }
    // 仅勾选键进入写通道；顺序沿用暂存清单，未勾选的项绝不下发。
    const selected = staged.edits.filter((edit) => keySet.has(editKey(edit)));
    const keys = selected.map(editKey);

    const lastDry = await store.readLastDry();
    const conflicts = (lastDry ?? []).filter((item) => item.conflict && keySet.has(item.key));
    if (conflicts.length > 0 && !acceptConflicts) {
      throw new OkrBridgeError(
        "okr_conflict",
        `${conflicts.length} 个勾选项与 CRD 当前值冲突（他人已改）：未确认 acceptConflicts 前拒绝写入`,
        { conflicts: conflicts.map((item) => ({ key: item.key, field: item.field, crd: item.crd, before: item.before, after: item.after })) },
      );
    }
    return { selected, keys, acceptConflicts, baseSnapshotAt: staged.baseSnapshotAt };
  }

  async function syncConfirm(request: Request): Promise<Response> {
    const release = acquireLock("sync-confirm");
    try {
      const session = await requireSession();
      const body = await readJsonBody(request, SYNC_BODY_MAX_BYTES);
      const plan = await planConfirm(body);
      const confirmFile: OkrEditsFile = {
        exportedAt: timestamp(),
        baseSnapshotAt: plan.baseSnapshotAt,
        edits: plan.selected,
      };
      await store.writeConfirmEdits(confirmFile);
      const args = ["--edits", store.confirmPath, "--confirm", ...(plan.acceptConflicts ? ["--accept-conflicts"] : [])];
      const result = await runPython("okr_write.py", args, OKR_SYNC_TIMEOUT_MS, session.cookie);
      const parsed = parseLastJson(result.stdout);
      // 审计：无论成败都追加一行（keys 为业务键，绝无 cookie）。
      const audit: OkrAuditLine = { at: timestamp(), keys: plan.keys, acceptConflicts: plan.acceptConflicts, exitCode: result.exitCode };
      await store.appendAudit(audit);
      if (!parsed) {
        const reason = redactNote(result.stderr || result.spawnError || (result.timedOut ? "写入超时" : "okr_write.py 无 JSON 输出")).slice(0, NOTE_LIMIT);
        throw new OkrBridgeError("okr_sync_failed", `OKR 确认写入无结果输出：${reason || "原因未知"}（确认文件已保留：edits.confirm.json）`);
      }
      const items = toDiffItems(parsed.results);
      const hasFailed = items.some((item) => item.state === "failed");
      // donor 语义：全部成功才清理确认文件；有失败项保留供排查。
      if (!hasFailed) await store.removeConfirmEdits();
      return okJson({
        mode: "confirm",
        ok: parsed.ok !== false && !hasFailed,
        wrote: typeof parsed.wrote === "number" ? parsed.wrote : 0,
        items,
        note: redactNote(parsed.note).slice(0, NOTE_LIMIT),
      });
    } finally {
      release();
    }
  }

  /** 未知异常兜底：502 + 通用文案；详细上下文（已过 redact）只进桥日志，不进响应。 */
  function failure(error: unknown): Response {
    if (error instanceof OkrBridgeError) {
      return jsonResponse(
        { ok: false, error: { code: error.code, message: error.message }, ...error.details },
        OKR_ERROR_STATUS[error.code],
      );
    }
    const message = redactNote(error instanceof Error ? error.message : String(error));
    console.error(JSON.stringify({ event: "okr_bridge_error", message }));
    return jsonResponse(
      { ok: false, error: { code: "okr_unavailable", message: "OKR 操作失败（本机存储或子进程异常），详情见桥日志" } },
      502,
    );
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
    view: wrap(() => view()),
    refresh: wrap(() => refresh()),
    edits: wrap(() => editsView()),
    syncDry: wrap(syncDry),
    syncConfirm: wrap(syncConfirm),
  };
}
