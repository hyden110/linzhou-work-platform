/**
 * Browser client for ontology management (F8) — GET /local/ontology、
 * GET /local/ontology/graph、POST /local/ontology/action。
 *
 * 口径：
 * - 白名单投影：坏行丢弃、坏形状整包 invalid_response，绝不半真半假；
 * - 幂等键由客户端铸造（makeOntologyActionKey），提交重试同键不重复落账；
 * - 破坏性动作（archive/merge/split）必须带 confirm === 目标 uid，桥侧同口径把关；
 * - 错误分层：{error:{code,message}} → OntologyClientError(code, detail)，
 *   ontologyErrorMessage 给中文友好文案。
 */

import type {
  AuditLine,
  ConstraintViolation,
  GraphLinkView,
  GraphNode,
  GraphStats,
  OntologyGraphView,
  OntologyOp,
  OntologySchema,
  ReplayConflict,
} from "./ontology-types.ts";

export type OntologyClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "rate_limited"
  | "origin_not_allowed"
  | "host_not_allowed"
  | "method_not_allowed"
  | "ontology_invalid_request"
  | "ontology_unknown_action"
  | "ontology_confirm_required"
  | "ontology_unknown_uid"
  | "ontology_invalid_payload"
  | "ontology_edits_corrupt"
  | "ontology_unavailable";

const KNOWN_CODES: ReadonlySet<string> = new Set<OntologyClientErrorCode>([
  "unavailable", "invalid_response", "rate_limited", "origin_not_allowed", "host_not_allowed",
  "method_not_allowed", "ontology_invalid_request", "ontology_unknown_action",
  "ontology_confirm_required", "ontology_unknown_uid", "ontology_invalid_payload",
  "ontology_edits_corrupt", "ontology_unavailable",
]);

const ONTOLOGY_TIMEOUT_MS = 10_000;

export class OntologyClientError extends Error {
  readonly code: OntologyClientErrorCode;
  readonly detail: string;

  constructor(code: OntologyClientErrorCode, detail = "") {
    super(code);
    this.name = "OntologyClientError";
    this.code = code;
    this.detail = detail;
  }
}

/** GET /local/ontology 的投影结果（策展态 + schema + 审计尾）。 */
export interface OntologyStateSnapshot {
  readonly v: number;
  readonly opsCount: number;
  readonly uidsCount: number;
  readonly applied: number;
  readonly schema: OntologySchema;
  readonly stats: GraphStats;
  readonly conflicts: readonly ReplayConflict[];
  readonly violations: readonly ConstraintViolation[];
  readonly audit: readonly AuditLine[];
  readonly ops: readonly OntologyOp[];
}

/** POST /local/ontology/action 的请求体（confirm 仅破坏性动作需要）。 */
export interface OntologyActionRequest {
  readonly action: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly key?: string;
  readonly confirm?: string;
}

/** POST /local/ontology/action 的投影结果。 */
export interface OntologyActionOutcome {
  readonly deduped: boolean;
  readonly at: string;
  readonly uid: string | null;
  readonly ops: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ontologyUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(ontologyUrl(path), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ONTOLOGY_TIMEOUT_MS),
    }));
  } catch {
    throw new OntologyClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new OntologyClientError(error.code as OntologyClientErrorCode, asText(error.message));
    }
    throw new OntologyClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new OntologyClientError("invalid_response");
  return payload.data;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function asAuditLine(value: unknown): AuditLine | null {
  if (!isRecord(value)) return null;
  if (typeof value.at !== "string" || typeof value.action !== "string" || typeof value.ok !== "boolean") return null;
  return {
    at: value.at,
    by: typeof value.by === "string" ? value.by : "",
    key: typeof value.key === "string" ? value.key : null,
    action: value.action,
    ok: value.ok,
  };
}

function asOp(value: unknown): OntologyOp | null {
  if (!isRecord(value) || typeof value.op !== "string" || !value.op) return null;
  return value as unknown as OntologyOp;
}

function projectState(data: Record<string, unknown>): OntologyStateSnapshot | null {
  for (const field of ["v", "opsCount", "uidsCount", "applied"]) {
    if (typeof data[field] !== "number") return null;
  }
  if (!isRecord(data.schema) || !isRecord(data.stats)) return null;
  if (!Array.isArray(data.audit) || !Array.isArray(data.ops)
    || !Array.isArray(data.conflicts) || !Array.isArray(data.violations)) return null;
  return {
    v: data.v as number,
    opsCount: data.opsCount as number,
    uidsCount: data.uidsCount as number,
    applied: data.applied as number,
    schema: data.schema as unknown as OntologySchema,
    stats: data.stats as unknown as GraphStats,
    conflicts: data.conflicts.filter(isRecord) as unknown as ReplayConflict[],
    violations: data.violations.filter(isRecord) as unknown as ConstraintViolation[],
    audit: data.audit.map(asAuditLine).filter((line): line is AuditLine => line !== null),
    ops: data.ops.map(asOp).filter((op): op is OntologyOp => op !== null),
  };
}

function asNode(value: unknown): GraphNode | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.uid !== "string"
    || typeof value.type !== "string" || typeof value.name !== "string") return null;
  const props: Record<string, string | number | boolean> = {};
  if (isRecord(value.props)) {
    for (const [k, v] of Object.entries(value.props)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
  }
  return {
    id: value.id,
    uid: value.uid,
    type: value.type,
    name: value.name,
    tags: Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === "string") : [],
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((t): t is string => typeof t === "string") : [],
    props,
    manual: value.manual === true,
    curated: value.curated === true,
  };
}

function asLink(value: unknown): GraphLinkView | null {
  if (!isRecord(value)) return null;
  for (const field of ["type", "from", "to", "fromUid", "toUid", "basis", "source"]) {
    if (typeof value[field] !== "string") return null;
  }
  return {
    type: value.type as string,
    from: value.from as string,
    to: value.to as string,
    fromUid: value.fromUid as string,
    toUid: value.toUid as string,
    basis: value.basis as string,
    source: value.source as string,
  };
}

function projectGraph(data: Record<string, unknown>): OntologyGraphView | null {
  if (typeof data.generatedAt !== "string" || typeof data.lastOpAt !== "string") return null;
  if (typeof data.opsCount !== "number") return null;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.links) || !isRecord(data.stats)) return null;
  return {
    generatedAt: data.generatedAt,
    opsCount: data.opsCount,
    lastOpAt: data.lastOpAt,
    nodes: data.nodes.map(asNode).filter((node): node is GraphNode => node !== null),
    links: data.links.map(asLink).filter((link): link is GraphLinkView => link !== null),
    stats: data.stats as unknown as GraphStats,
  };
}

function projectOutcome(data: Record<string, unknown>): OntologyActionOutcome | null {
  if (typeof data.deduped !== "boolean" || typeof data.at !== "string") return null;
  if (data.deduped) return { deduped: true, at: data.at, uid: null, ops: 0 };
  return {
    deduped: false,
    at: data.at,
    uid: typeof data.uid === "string" ? data.uid : null,
    ops: typeof data.ops === "number" ? data.ops : 0,
  };
}

/* ---------------- 公开入口 ---------------- */

/** GET /local/ontology —— 策展态 + 生效 schema + 审计尾 20 行。 */
export async function fetchOntologyState(fetchImpl: typeof fetch = fetch): Promise<OntologyStateSnapshot> {
  const data = await requestJson("/local/ontology", "GET", undefined, fetchImpl);
  const state = projectState(data);
  if (!state) throw new OntologyClientError("invalid_response");
  return state;
}

/** GET /local/ontology/graph —— 派生图（nodes/links/stats + 新鲜度指纹）。 */
export async function fetchOntologyGraph(fetchImpl: typeof fetch = fetch): Promise<OntologyGraphView> {
  const data = await requestJson("/local/ontology/graph", "GET", undefined, fetchImpl);
  const graph = projectGraph(data);
  if (!graph) throw new OntologyClientError("invalid_response");
  return graph;
}

/** POST /local/ontology/action —— 提交动作（破坏性动作必须带 confirm === 目标 uid）。 */
export async function submitOntologyAction(
  request: OntologyActionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<OntologyActionOutcome> {
  const body: Record<string, unknown> = { action: request.action };
  if (request.payload !== undefined) body.payload = request.payload;
  if (request.key !== undefined) body.key = request.key;
  if (request.confirm !== undefined) body.confirm = request.confirm;
  const data = await requestJson("/local/ontology/action", "POST", body, fetchImpl);
  const outcome = projectOutcome(data);
  if (!outcome) throw new OntologyClientError("invalid_response");
  return outcome;
}

/** 幂等键铸造：随机 128 位（crypto.randomUUID 优先，无则时间戳+随机数兜底）。 */
export function makeOntologyActionKey(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  const random = cryptoRef
    ? Array.from(cryptoRef.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
    : Math.random().toString(16).slice(2);
  return `k-${Date.now().toString(16)}-${random}`;
}

/** 错误 → 中文友好文案（detail 优先附在文案后，方便排查）。 */
export function ontologyErrorMessage(error: unknown): string {
  if (!(error instanceof OntologyClientError)) {
    return "本体服务暂时不可用，请稍后重试。";
  }
  const suffix = error.detail ? `（${error.detail}）` : "";
  switch (error.code) {
    case "ontology_confirm_required":
      return "破坏性动作需要显式确认：请在确认框输入目标 uid 后重新提交。";
    case "ontology_edits_corrupt":
      return "本体策展层文件（edits.json）已损坏，读写已停用；请人工检查该文件后再试。";
    case "ontology_invalid_payload":
      return `动作载荷不符合要求${suffix || "：请检查表单填写。"}`;
    case "ontology_unknown_uid":
      return `引用的 uid 未在本体登记${suffix}。`;
    case "ontology_unknown_action":
      return `未知动作${suffix}。`;
    case "ontology_invalid_request":
      return `请求参数不正确${suffix}。`;
    case "invalid_response":
      return "本地服务返回的数据不符合本体契约，请刷新重试。";
    case "rate_limited":
      return "请求过于频繁，请稍后再试。";
    case "method_not_allowed":
      return "请求方法不被允许，请检查路由接线。";
    case "origin_not_allowed":
    case "host_not_allowed":
      return "请求来源未被本地服务允许，请从工作台页面访问。";
    case "unavailable":
    case "ontology_unavailable":
    default:
      return "无法连接本地服务（dev:function-local-node），请确认开发桥已启动后重试。";
  }
}
