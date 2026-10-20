/**
 * Ontology bridge (F8) — 本体管理写路径 + 读侧组装 + 自带子路由。
 *
 * 语义对齐 donor（scripts/lib/ontology/{index.js,actions.js,overlay.js}）：
 * - 动作只写操作日志（edits.json），生效图由 replay 派生；每次成功动作后重建 graph.json；
 * - 幂等键去重：同 key 已落账 → {deduped:true}，不重复执行、不重复审计；
 * - 破坏性动作（merge/split/archive）：body.confirm === 目标 uid（payload.uid）才执行，
 *   闸门先于幂等去重（拿旧 key 也不能绕过确认）；
 * - 审计：每执行一动作追加一行 {at,by:'workbench',key,action,ok}（校验失败也留痕 ok:false；
 *   deduped / confirm 拒绝 / 请求层坏形状不留痕——未进入执行）；审计追加尽力而为，
 *   真身（操作日志）落账成功后不因审计故障回滚；
 * - edits.json 损坏：读写两侧都如实报 ontology_edits_corrupt（409），绝不静默清空；
 * - GET 零副作用：graph.json 缺失/过期时内存重建返回，绝不写盘（写只发生在动作路径）。
 */

import {
  applyAction,
  currentSchema,
  deriveGraphView,
  newUid as defaultNewUid,
  replay,
} from "../../src/lib/ontology-model.ts";
import { checkConstraints } from "../../src/lib/ontology-schema.ts";
import {
  isDestructiveOntologyAction,
  isKnownOntologyAction,
  ONTOLOGY_KEY_MAX,
  type AuditLine,
  type OntologyEdits,
  type OntologyGraphView,
  type OntologyOp,
  type ValidationCode,
} from "../../src/lib/ontology-types.ts";
import { createOntologyStore, DEFAULT_ONTOLOGY_DIR, type OntologyStore } from "./ontology-store.ts";
import {
  ONTOLOGY_AUDIT_TAIL,
  ONTOLOGY_ROUTES,
  OntologyBridgeError,
  type OntologyActionResponse,
  type OntologyBridge,
  type OntologyBridgeOptions,
  type OntologyErrorCode,
  type OntologyStateView,
} from "./ontology-types.ts";

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** 请求体体积上限（本地桥自保；正常动作远小于该值）。 */
const MAX_BODY_BYTES = 64 * 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: OntologyErrorCode): number {
  if (code === "ontology_edits_corrupt") return 409;
  if (code === "ontology_unavailable") return 502;
  if (code === "method_not_allowed") return 405;
  return 400;
}

function codeFor(validationCode: ValidationCode): OntologyErrorCode {
  if (validationCode === "unknown_action") return "ontology_unknown_action";
  if (validationCode === "unknown_uid") return "ontology_unknown_uid";
  return "ontology_invalid_payload";
}

/** 审计行的 key 归一：只有合法幂等键才登记，其余落 null。 */
function auditKeyOf(key: unknown): string | null {
  return typeof key === "string" && key.length > 0 && key.length <= ONTOLOGY_KEY_MAX ? key : null;
}

/** state().ops 投影：剥离 absorbedSnapshot（体积大且 UI 不需要），保留 absorbedKeys。 */
function projectOp(op: OntologyOp): OntologyOp {
  if (!("absorbedSnapshot" in op)) return op;
  const { absorbedSnapshot: _dropped, ...rest } = op as Record<string, unknown>;
  return rest as OntologyOp;
}

export function createOntologyBridge(options: OntologyBridgeOptions = {}): OntologyBridge {
  const dir = options.dir ?? DEFAULT_ONTOLOGY_DIR;
  const now = options.now ?? (() => Date.now());
  const newUid = options.newUid ?? defaultNewUid;
  const auditTailLimit = options.auditTailLimit ?? ONTOLOGY_AUDIT_TAIL;
  const store: OntologyStore = createOntologyStore(dir, { now });

  /** 审计追加尽力而为：真身已落账（或已如实拒绝）后，审计故障不改变结果。 */
  async function audit(line: AuditLine): Promise<void> {
    await store.appendAudit(line).catch(() => {});
  }

  async function state(): Promise<OntologyStateView> {
    const edits: OntologyEdits = await store.loadEdits();
    const rep = replay(edits);
    const schema = currentSchema(edits);
    const violations = checkConstraints(rep.effective, schema);
    const auditTail = await store.readAuditTail(auditTailLimit);
    return {
      v: rep.edits.v,
      opsCount: rep.edits.ops.length,
      uidsCount: Object.keys(rep.edits.uids).length,
      applied: rep.applied,
      schema,
      stats: rep.effective.stats,
      conflicts: rep.conflicts,
      violations,
      audit: auditTail,
      ops: rep.edits.ops.map(projectOp),
    };
  }

  async function graph(): Promise<OntologyGraphView> {
    const edits = await store.loadEdits();
    const lastOpAt = edits.ops.length ? (edits.ops[edits.ops.length - 1]?.at ?? "") : "";
    const cached = await store.loadGraph();
    if (cached && cached.opsCount === edits.ops.length && cached.lastOpAt === lastOpAt) {
      return cached; // 指纹新鲜：缓存直接供给
    }
    // 缺失/损坏/过期：从操作日志诚实重建（内存里，GET 不写盘）
    return deriveGraphView(replay(edits).effective, {
      generatedAt: new Date(now()).toISOString(),
      opsCount: edits.ops.length,
      lastOpAt,
    });
  }

  async function action(body: unknown): Promise<OntologyActionResponse> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new OntologyBridgeError("ontology_invalid_request", "请求体必须是 JSON 对象：{action, payload, key, confirm?}。");
    }
    const request = body as Record<string, unknown>;
    if (typeof request.action !== "string" || !request.action) {
      throw new OntologyBridgeError("ontology_invalid_request", "缺少动作：body.action 必须为非空字符串。");
    }
    if (!isKnownOntologyAction(request.action)) {
      throw new OntologyBridgeError("ontology_unknown_action", `未知动作：${request.action.slice(0, 60)}（可用动作见前端动作面板）。`);
    }
    const actionName = request.action;
    const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
      ? (request.payload as Record<string, unknown>)
      : {};

    const edits = await store.loadEdits(); // 损坏 → ontology_edits_corrupt（写路径拒绝启动）

    /* 破坏性动作 confirm 闸门（先于幂等去重：拿旧 key 也不能绕过确认）。 */
    if (isDestructiveOntologyAction(actionName)) {
      const target = typeof payload.uid === "string" ? payload.uid : "";
      if (typeof request.confirm !== "string" || !target || request.confirm !== target) {
        throw new OntologyBridgeError(
          "ontology_confirm_required",
          "破坏性动作需要显式确认：请在 confirm 中输入目标 uid 后重试。",
        );
      }
    }

    const at = new Date(now()).toISOString();
    const outcome = applyAction(edits, { action: actionName, payload, key: request.key }, { at, by: "workbench", newUid });

    if (outcome.status === "deduped") {
      return { deduped: true, key: outcome.key, at: outcome.at }; // 不重复执行、不重复审计
    }
    if (outcome.status === "rejected") {
      await audit({ at, by: "workbench", key: auditKeyOf(request.key), action: actionName, ok: false });
      throw new OntologyBridgeError(codeFor(outcome.code), outcome.reason);
    }

    /* 落账成功：replay 富化（absorbedKeys/快照）→ 持久化真身 → 重建派生图 → 审计。 */
    const rep = replay(outcome.edits);
    await store.saveEdits(rep.edits);
    const view = deriveGraphView(rep.effective, {
      generatedAt: at,
      opsCount: rep.edits.ops.length,
      lastOpAt: outcome.op.at,
    });
    await store.saveGraph(view);
    await audit({ at, by: "workbench", key: outcome.op.key, action: actionName, ok: true });
    return { deduped: false, at, uid: outcome.uid, ops: rep.edits.ops.length, stats: rep.effective.stats };
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new OntologyBridgeError("ontology_invalid_request", "请求体过大：本体动作远不需要这么多内容。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new OntologyBridgeError("ontology_invalid_request", "请求体过大：本体动作远不需要这么多内容。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new OntologyBridgeError("ontology_invalid_request", "请求体不是合法 JSON。");
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
    const route = ONTOLOGY_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非本体路径：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      if (route.operation === "state") return jsonResponse({ ok: true, data: await state() });
      if (route.operation === "graph") return jsonResponse({ ok: true, data: await graph() });
      return jsonResponse({ ok: true, data: await action(await readBody(request)) });
    } catch (error) {
      if (error instanceof OntologyBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "ontology_unavailable", message: "本体服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { state, graph, action, handle };
}
