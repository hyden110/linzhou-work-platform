/**
 * Ontology bridge contracts (F8) — 本体管理本地桥的错误码、路由表与视图契约。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * ONTOLOGY_ROUTES 常量供接线——集成方只需在 local-router 里
 * `const routed = await ontologyBridge.handle(request); if (routed) return routed;`
 * 即可挂载全部三条路由（405/错误映射都在子路由内闭环）。
 *
 * 错误分层：所有失败响应为 {ok:false, error:{code, message}}；code 为下方稳定错误码，
 * message 为可直接展示的中文文案（不含绝对路径、不含凭据）。
 */

import type {
  AuditLine,
  ConstraintViolation,
  GraphStats,
  OntologyGraphView,
  OntologyOp,
  OntologySchema,
  ReplayConflict,
} from "../../src/lib/ontology-types.ts";

/** 稳定错误码：路由按 code 映射 400/405/409/502。 */
export type OntologyErrorCode =
  | "ontology_invalid_request"
  | "ontology_unknown_action"
  | "ontology_confirm_required"
  | "ontology_unknown_uid"
  | "ontology_invalid_payload"
  | "ontology_edits_corrupt"
  | "ontology_unavailable"
  | "method_not_allowed";

export class OntologyBridgeError extends Error {
  readonly code: OntologyErrorCode;

  constructor(code: OntologyErrorCode, message: string) {
    super(message);
    this.name = "OntologyBridgeError";
    this.code = code;
  }
}

/** 路由表（供接线）：三条路由与任务书一一对应。 */
export const ONTOLOGY_ROUTES = [
  { method: "GET", path: "/local/ontology", operation: "state" },
  { method: "GET", path: "/local/ontology/graph", operation: "graph" },
  { method: "POST", path: "/local/ontology/action", operation: "action" },
] as const;

export type OntologyRoute = (typeof ONTOLOGY_ROUTES)[number];

/** GET /local/ontology 的审计尾行数（任务口径：尾 20 行）。 */
export const ONTOLOGY_AUDIT_TAIL = 20;

/**
 * GET /local/ontology 的 data：策展态（v/ops/uids 计数 + 富化 ops 投影 + replay 统计 +
 * 冲突 + 约束违例）+ 生效 schema（共享+个人扩展）+ 审计尾 20 行。
 * ops 投影剥离 absorbedSnapshot（体积大且 UI 不需要），保留 absorbedKeys 供 split 表单。
 */
export interface OntologyStateView {
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

/** POST /local/ontology/action 的 data：幂等命中 deduped:true；执行成功带落账结果。 */
export type OntologyActionResponse =
  | { readonly deduped: true; readonly key: string; readonly at: string }
  | {
      readonly deduped: false;
      readonly at: string;
      readonly uid: string | null;
      readonly ops: number;
      readonly stats: GraphStats;
    };

export interface OntologyBridgeOptions {
  /** 存储目录（缺省 .local-cache/ontology；测试注入临时目录）。 */
  readonly dir?: string;
  readonly now?: () => number;
  /** uid 铸造注入（测试用确定性序列）。 */
  readonly newUid?: () => string;
  readonly auditTailLimit?: number;
}

export interface OntologyBridge {
  /** GET /local/ontology —— 策展态 + schema + 审计尾；edits.json 损坏 → ontology_edits_corrupt。 */
  readonly state: () => Promise<OntologyStateView>;
  /** GET /local/ontology/graph —— 派生图；graph.json 缺失/过期内存重建（派生物诚实可重建）。 */
  readonly graph: () => Promise<OntologyGraphView>;
  /** POST /local/ontology/action —— body {action,payload,key,confirm?}；失败抛 OntologyBridgeError。 */
  readonly action: (body: unknown) => Promise<OntologyActionResponse>;
  /** 子路由：命中 ONTOLOGY_ROUTES 返回 Response；非本体路径返回 undefined（供主路由委托）。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}

/** 派生图端点的 data 即 OntologyGraphView（graph.json 同形状）。 */
export type OntologyGraphResponse = OntologyGraphView;
