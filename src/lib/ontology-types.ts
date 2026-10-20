/**
 * Ontology contracts (F8) — 本体管理（知识本体 CRUD + 图 + 审计）的共享契约层。
 * 语义权威：base/sa-workbench scripts/lib/ontology/{overlay.js,actions.js} 与
 * assets/models/{ontology-schema.js,ontology-model.js}（只搬语义不搬代码）。
 *
 * 口径红线（对齐 donor）：
 * - 策展层真身是操作日志（edits.json 的 ops），图（graph.json）永远是从日志 replay
 *   出来的派生物，读侧可随时重建、可审计；
 * - op 一律挂 uid（u+8hex），uids 把实体键锚到 uid，重建/合并后仍可反解；
 * - 动作集与 donor 完全一致（12 个），merge/split/archive 为破坏性动作，
 *   桥层要求 confirm === 目标 uid 才执行；
 * - 不可变更新：replay/apply 一律返回新对象，绝不改动入参。
 *
 * 本文件只有类型与常量（无行为），被 src/lib/ontology-model.ts、
 * src/lib/ontology-client.ts、dev/ontology/*（经相对路径）共同消费。
 */

/** 动作集：与 donor scripts/lib/ontology/actions.js ACTIONS 完全一致（12 个）。 */
export const ONTOLOGY_ACTIONS = [
  "entity.create",
  "entity.rename",
  "entity.setProp",
  "entity.retag",
  "entity.archive",
  "entity.merge",
  "entity.split",
  "link.assert",
  "link.retract",
  "schema.addType",
  "schema.addLink",
  "schema.addConstraint",
] as const;

export type OntologyAction = (typeof ONTOLOGY_ACTIONS)[number];

/** 破坏性动作：桥层要求 body.confirm === payload.uid（目标 uid）才执行。 */
export const DESTRUCTIVE_ONTOLOGY_ACTIONS: readonly OntologyAction[] = [
  "entity.archive",
  "entity.merge",
  "entity.split",
];

export function isKnownOntologyAction(action: unknown): action is OntologyAction {
  return typeof action === "string"
    && (ONTOLOGY_ACTIONS as readonly string[]).includes(action);
}

export function isDestructiveOntologyAction(action: string): boolean {
  return (DESTRUCTIVE_ONTOLOGY_ACTIONS as readonly string[]).includes(action);
}

/** uid 形态：u + 8 位十六进制（照 donor overlay.newUid）。 */
export const ONTOLOGY_UID_PATTERN = /^u[0-9a-f]{8}$/;

/** 个人 schema 扩展 id 形态：小写字母开头的 ≤32 位标识（照 donor）。 */
export const ONTOLOGY_SCHEMA_ID_PATTERN = /^[a-z][\w-]{0,31}$/;

/** 幂等键上限（照 donor STR(p.key,120)）。 */
export const ONTOLOGY_KEY_MAX = 120;

/* ------------------------------------------------------------------ */
/* schema 注册表（Palantir 式声明层）                                   */
/* ------------------------------------------------------------------ */

export interface SchemaPropertyDef {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly enum?: readonly string[];
}

export interface ObjectTypeDef {
  readonly label: string;
  readonly key?: string;
  readonly sources?: readonly string[];
  readonly properties?: readonly SchemaPropertyDef[];
}

export interface LinkTypeDef {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly source?: string;
}

export interface BasisDef {
  readonly label: string;
  readonly d: string;
}

/** 约束规则是数据不是代码（照 donor ontology-schema.js 口径）；算子在 checkConstraints。 */
export interface ForbidLinkSpec {
  readonly type?: string;
  readonly from: string;
  readonly to: string;
}

export interface ConstraintRule {
  readonly id: string;
  readonly when?: Readonly<Record<string, unknown>>;
  readonly require?: readonly string[];
  readonly requireAny?: readonly string[];
  readonly enum?: Readonly<Record<string, readonly unknown[]>>;
  readonly typeOf?: Readonly<Record<string, string>>;
  readonly max?: number;
  readonly forbidSelf?: boolean;
  readonly forbidLink?: readonly ForbidLinkSpec[];
}

export interface OntologySchema {
  readonly version: string;
  readonly objectTypes: Readonly<Record<string, ObjectTypeDef>>;
  readonly linkTypes: Readonly<Record<string, LinkTypeDef>>;
  readonly basis: Readonly<Record<string, BasisDef>>;
  readonly constraints: readonly ConstraintRule[];
}

/** schema.* 操作提取出的个人扩展段（mergePersonal 的输入）。 */
export interface PersonalSchema {
  readonly objectTypes: Readonly<Record<string, ObjectTypeDef>>;
  readonly linkTypes: Readonly<Record<string, LinkTypeDef>>;
  readonly constraints: readonly ConstraintRule[];
}

/* ------------------------------------------------------------------ */
/* 操作日志（策展层真身）与生效图                                        */
/* ------------------------------------------------------------------ */

/** 单条操作：{op, ...payload, at, by, key}（key 缺省为 null；载荷字段随动作而变）。 */
export interface OntologyOp {
  readonly op: string;
  readonly at: string;
  readonly by: string;
  readonly key: string | null;
  readonly [field: string]: unknown;
}

/** edits.json：{v, uids:{sourceKey:uid}, ops:[...]}（照 donor overlay 存储形状）。 */
export interface OntologyEdits {
  readonly v: 1;
  readonly uids: Readonly<Record<string, string>>;
  readonly ops: readonly OntologyOp[];
}

export interface OntologyObject {
  readonly id: string;
  readonly type: string;
  readonly uid?: string;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly manual?: boolean;
  readonly curated?: boolean;
  readonly sources?: readonly string[];
  readonly splitFrom?: string;
  readonly [prop: string]: unknown;
}

export interface OntologyLink {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly basis: string;
  readonly source: string;
  /** merge 时被吸收端的原始端点（split 时据此把链接改挂回新实体）。 */
  readonly originFrom?: string;
  readonly originTo?: string;
  readonly [prop: string]: unknown;
}

export interface GraphStats {
  readonly objects: Readonly<Record<string, number>>;
  readonly links: Readonly<Record<string, number>>;
  readonly basis: Readonly<Record<string, number>>;
}

export interface EffectiveGraph {
  readonly objects: Readonly<Record<string, OntologyObject>>;
  readonly links: readonly OntologyLink[];
  readonly stats: GraphStats;
}

/** replay 冲突：只报告不修改（照 donor overlay 红线）。 */
export interface ReplayConflict {
  readonly op: string;
  readonly at: string;
  readonly uid?: string;
  readonly note: string;
}

export interface ReplayResult {
  readonly effective: EffectiveGraph;
  readonly conflicts: readonly ReplayConflict[];
  readonly applied: number;
  /** 富化后的操作日志（merge 补 absorbedKeys/absorbedNames 等），供写路径持久化。 */
  readonly edits: OntologyEdits;
}

/* ------------------------------------------------------------------ */
/* 派生图视图（graph.json / GET /local/ontology/graph）                 */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  readonly id: string;
  readonly uid: string;
  readonly type: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly props: Readonly<Record<string, string | number | boolean>>;
  readonly manual: boolean;
  readonly curated: boolean;
}

export interface GraphLinkView {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly fromUid: string;
  readonly toUid: string;
  readonly basis: string;
  readonly source: string;
}

export interface OntologyGraphView {
  readonly generatedAt: string;
  /** 新鲜度指纹：与 edits.ops 对齐才算新鲜（graph.json 只是派生缓存）。 */
  readonly opsCount: number;
  readonly lastOpAt: string;
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLinkView[];
  readonly stats: GraphStats;
}

/** 审计行：每执行一动作追加一行 {at, by:'workbench', key, action, ok}。 */
export interface AuditLine {
  readonly at: string;
  readonly by: string;
  readonly key: string | null;
  readonly action: string;
  readonly ok: boolean;
}

/** 约束违例（照 donor validate.js 输出形状）：只报告不修改。 */
export interface ConstraintViolation {
  readonly rule: string;
  readonly scope: "object" | "link";
  readonly id: string;
  readonly note: string;
}

/* ------------------------------------------------------------------ */
/* 校验 / 应用（写路径纯函数）                                          */
/* ------------------------------------------------------------------ */

export type ValidationCode = "unknown_action" | "unknown_uid" | "invalid_payload";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly reason: string };

export interface OntologyValidationState {
  /** 合并后的 schema（共享 + 个人扩展）。 */
  readonly schema: OntologySchema;
  /** 已登记 uid（edits.uids 的值集合）。 */
  readonly knownUids: ReadonlySet<string>;
}

/** POST /local/ontology/action 的 body 形状：{action, payload, key}。 */
export interface ActionRequest {
  readonly action: unknown;
  readonly payload?: unknown;
  readonly key?: unknown;
}

export interface ApplyContext {
  readonly at: string;
  readonly by: string;
  readonly newUid: () => string;
}

export type ApplyOutcome =
  | {
      readonly status: "applied";
      readonly edits: OntologyEdits;
      readonly op: OntologyOp;
      readonly uid: string | null;
    }
  | { readonly status: "deduped"; readonly key: string; readonly at: string }
  | { readonly status: "rejected"; readonly code: ValidationCode; readonly reason: string };

/* ------------------------------------------------------------------ */
/* SVG 图布局（type 分列网格，无力导）                                   */
/* ------------------------------------------------------------------ */

export interface GraphNodePosition {
  readonly id: string;
  readonly column: string;
  readonly columnIndex: number;
  readonly x: number;
  readonly y: number;
}

export interface GraphColumn {
  readonly type: string;
  readonly x: number;
  readonly count: number;
}

export interface GraphLayout {
  readonly positions: readonly GraphNodePosition[];
  readonly columns: readonly GraphColumn[];
  readonly width: number;
  readonly height: number;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
}
