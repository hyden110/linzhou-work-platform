/**
 * Ontology schema registry (F8) — Palantir 式声明层：对象类型 / 链接类型 / 可信度 / 约束。
 * 语义权威：base/sa-workbench assets/models/ontology-schema.js（数据逐字对齐，代码重写为 TS）。
 *
 * 单一事实源：validateAction 的类型存在性检查、replay 的链接类型注册检查、
 * checkConstraints 的约束跑批、前端动态表单的类型选项都消费本注册表。
 * 个人扩展：overlay 的 schema.addType / addLink / addConstraint 操作经 mergePersonal()
 * 叠加——只增不删（共享词汇不可被个人层覆盖或移除，防止视图口径分叉）。
 * 约束为数据而非代码：checkConstraints 只实现算子（require/requireAny/enum/typeOf/max/
 * forbidLink/forbidSelf + 内置硬规则），规则本体始终是 JSON 结构。
 */

import type {
  BasisDef,
  ConstraintRule,
  ConstraintViolation,
  EffectiveGraph,
  LinkTypeDef,
  ObjectTypeDef,
  OntologySchema,
  PersonalSchema,
} from "./ontology-types.ts";
import { ONTOLOGY_SCHEMA_ID_PATTERN } from "./ontology-types.ts";

export const SCHEMA_VERSION = "2026-10-17";

/** 共享对象类型（照 donor ontology-schema.js objectTypes 逐字移植）。 */
export const SHARED_OBJECT_TYPES: Readonly<Record<string, ObjectTypeDef>> = {
  person: {
    label: "人",
    key: "我 / 客户销售花名 / 协作关系表记录 ID / dt: 钉钉名 / wx: wxid",
    sources: ["okr", "ppl", "relations", "dingtalk", "wechat"],
    properties: [
      { key: "name", label: "姓名", type: "string", required: true },
      { key: "nick", label: "花名", type: "string" },
      { key: "role", label: "角色", type: "string", enum: ["me", "collaborator", "bte", "contact"] },
      { key: "org", label: "机构", type: "string" },
      { key: "platform", label: "来源平台", type: "string" },
      { key: "wxId", label: "微信 wxid", type: "string" },
    ],
  },
  customer: {
    label: "客户",
    key: "ECID（缺失回退 cid）",
    sources: ["ppl", "custPool", "custProfiles", "alias"],
    properties: [
      { key: "name", label: "客户名", type: "string", required: true },
      { key: "ecid", label: "ECID", type: "string" },
      { key: "cid", label: "CID", type: "string" },
      { key: "profileKey", label: "画像键", type: "string" },
    ],
  },
  opportunity: {
    label: "商机",
    key: "projectId",
    sources: ["ppl"],
    properties: [
      { key: "name", label: "项目名", type: "string" },
      { key: "projectId", label: "projectId", type: "string" },
      { key: "stage", label: "阶段", type: "number" },
      { key: "price", label: "金额（元）", type: "number" },
    ],
  },
  objective: {
    label: "目标",
    key: "OKR idx",
    sources: ["okr"],
    properties: [
      { key: "title", label: "目标标题", type: "string", required: true },
      { key: "idx", label: "编号", type: "string" },
      { key: "progress", label: "进度", type: "number" },
    ],
  },
  group: {
    label: "群",
    key: "group:dt:<cid> / group:wx:<wxid 群>",
    sources: ["dingtalk", "wechat"],
    properties: [
      { key: "name", label: "群名", type: "string", required: true },
      { key: "platform", label: "平台", type: "string", enum: ["dingtalk", "wechat"] },
      { key: "memberCount", label: "成员数", type: "number" },
      { key: "msgCount7", label: "近窗消息数", type: "number" },
      { key: "awaiting", label: "@我待回", type: "number" },
    ],
  },
  org: {
    label: "机构",
    key: "org:<归一名称>",
    sources: ["wechat", "dingtalk"],
    properties: [{ key: "name", label: "机构名", type: "string", required: true }],
  },
  project: {
    label: "项目",
    key: "project:<规范化名称或 projectId>",
    sources: ["wechat", "ppl"],
    properties: [{ key: "name", label: "项目名", type: "string", required: true }],
  },
};

/** 共享链接类型（照 donor linkTypes 逐字移植）。 */
export const SHARED_LINK_TYPES: Readonly<Record<string, LinkTypeDef>> = {
  hasOpportunity: { label: "有商机", from: "customer", to: "opportunity", source: "ppl" },
  manages: { label: "客户销售负责", from: "person", to: "customer", source: "ppl" },
  collaborates: { label: "协作", from: "person", to: "person", source: "relations" },
  touched: { label: "近期触达", from: "person", to: "customer", source: "worklog" },
  owns: { label: "承接目标", from: "person", to: "objective", source: "okr" },
  memberOf: { label: "群成员", from: "person", to: "group", source: "dingtalk" },
  awaitingMe: { label: "@我待回", from: "group", to: "person", source: "dingtalk" },
  activeIn: { label: "活跃于", from: "person", to: "group", source: "wechat" },
  belongsTo: { label: "归属机构", from: "person", to: "org", source: "wechat" },
  bindsCustomer: { label: "绑定客户", from: "group", to: "customer", source: "dingtalk" },
};

/** 可信度词汇（照 donor basis 逐字移植）。 */
export const BASIS: Readonly<Record<string, BasisDef>> = {
  fact: { label: "事实", d: "源系统字段直接给出" },
  confirmed: { label: "人工确认", d: "别名表 / overlay link.assert 登记" },
  aligned: { label: "对齐", d: "客户画像 / 客户池名称精确命中，按 ECID 归一" },
  inferred: { label: "推断", d: "名称互含且仅一个候选，未经确认" },
};

/** 约束种子（照 donor constraints 逐字移植；个人可经 overlay 追加同构规则）。 */
export const SHARED_CONSTRAINTS: readonly ConstraintRule[] = [
  { id: "person-name", when: { type: "person" }, require: ["name"] },
  { id: "customer-key", when: { type: "customer" }, requireAny: ["ecid", "cid"] },
  { id: "group-platform", when: { type: "group" }, enum: { platform: ["dingtalk", "wechat"] } },
  { id: "me-single", when: { type: "person", role: "me" }, max: 1 },
  { id: "no-self-link", forbidSelf: true },
  { id: "no-person-to-group-manages", forbidLink: [{ type: "manages", from: "person", to: "group" }] },
];

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 共享注册表快照（深拷贝，消费方改动不影响常量本体）。 */
export function sharedSchemaSnapshot(): OntologySchema {
  return {
    version: SCHEMA_VERSION,
    objectTypes: deepCopy(SHARED_OBJECT_TYPES),
    linkTypes: deepCopy(SHARED_LINK_TYPES),
    basis: deepCopy(BASIS),
    constraints: deepCopy(SHARED_CONSTRAINTS),
  };
}

/**
 * 个人扩展叠加：只增不删（照 donor mergePersonal）。
 * - id 形态不符（非小写字母开头 ≤32 位）→ 静默跳过；
 * - 共享类型/链接已存在 → 不覆盖；
 * - 个人链接的 from/to 未注册为对象类型 → 不采纳；
 * - 约束按 id 去重（共享种子优先）。
 */
export function mergePersonal(personal?: PersonalSchema | null): OntologySchema {
  const out = sharedSchemaSnapshot();
  if (!personal || typeof personal !== "object") return out;
  const objectTypes = out.objectTypes as Record<string, ObjectTypeDef>;
  const linkTypes = out.linkTypes as Record<string, LinkTypeDef>;
  const constraints = out.constraints as ConstraintRule[];

  for (const [id, def] of Object.entries(personal.objectTypes ?? {})) {
    if (ONTOLOGY_SCHEMA_ID_PATTERN.test(id) && !objectTypes[id] && def && typeof def === "object") {
      objectTypes[id] = deepCopy(def);
    }
  }
  for (const [id, def] of Object.entries(personal.linkTypes ?? {})) {
    if (
      ONTOLOGY_SCHEMA_ID_PATTERN.test(id)
      && !linkTypes[id]
      && def && typeof def === "object"
      && objectTypes[def.from] && objectTypes[def.to]
    ) {
      linkTypes[id] = deepCopy(def);
    }
  }
  for (const rule of personal.constraints ?? []) {
    if (rule && typeof rule === "object" && typeof rule.id === "string" && rule.id
      && !constraints.some((x) => x.id === rule.id)) {
      constraints.push(deepCopy(rule));
    }
  }
  return out;
}

/**
 * 约束跑批（照 donor validate.js check 移植）：规则算子 + 内置硬规则。
 * 输出 violations 只报告不修改，处置在人（UI/动作层）。
 */
export function checkConstraints(graph: EffectiveGraph, schema: OntologySchema): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  const objects = (graph?.objects ?? {}) as Record<string, Record<string, unknown>>;
  const links = (graph?.links ?? []) as unknown as Array<Record<string, unknown>>;
  const rules = schema?.constraints ?? [];
  const linkTypes = schema?.linkTypes ?? {};
  const objectTypes = schema?.objectTypes ?? {};
  const list = Object.keys(objects).map((k) => objects[k] as Record<string, unknown>);

  const matchWhen = (o: Record<string, unknown>, when?: Readonly<Record<string, unknown>>): boolean => {
    if (!when) return true;
    return Object.keys(when).every((k) => String(o[k]) === String(when[k]));
  };
  const empty = (v: unknown): boolean => v == null || v === "";
  const push = (rule: string, scope: "object" | "link", id: string, note: string): void => {
    out.push({ rule, scope, id, note });
  };

  for (const r of rules) {
    if (r.forbidSelf) {
      for (const l of links) {
        if (l.from === l.to) push(r.id || "forbidSelf", "link", `${String(l.from)}→${String(l.type)}`, `自环链接：${String(l.type)}`);
      }
      continue;
    }
    if (Array.isArray(r.forbidLink)) {
      for (const f of r.forbidLink) {
        for (const l of links) {
          const a = objects[String(l.from)];
          const b = objects[String(l.to)];
          if (!a || !b) continue;
          if ((!f.type || l.type === f.type) && a.type === f.from && b.type === f.to) {
            push(r.id || "forbidLink", "link", `${String(l.from)}→${String(l.to)}`, `禁止的链接组合：${String(a.type)} -${String(l.type)}→ ${String(b.type)}`);
          }
        }
      }
      continue;
    }
    const hit = r.when ? list.filter((o) => matchWhen(o, r.when)) : list;
    for (const o of hit) {
      const id = String(o.id ?? "");
      for (const p of r.require ?? []) {
        if (empty(o[p])) push(r.id, "object", id, `缺必备属性 ${p}`);
      }
      if ((r.requireAny ?? []).length > 0 && (r.requireAny ?? []).every((p) => empty(o[p]))) {
        push(r.id, "object", id, `requireAny 全空：${(r.requireAny ?? []).join("/")}`);
      }
      for (const [p, allowed] of Object.entries(r.enum ?? {})) {
        if (!empty(o[p]) && !(allowed as readonly unknown[]).includes(o[p] as never)) {
          push(r.id, "object", id, `${p}=${String(o[p])} 不在枚举 ${allowed.join("/")}`);
        }
      }
      for (const [p, js] of Object.entries(r.typeOf ?? {})) {
        if (!empty(o[p]) && typeof o[p] !== js) push(r.id, "object", id, `${p} 类型应为 ${js}`);
      }
    }
    if (typeof r.max === "number" && hit.length > r.max) {
      push(r.id, "object", "(count)", `命中 ${hit.length} 个对象，超过上限 ${r.max}`);
    }
  }

  /* 内置硬规则：链接类型注册 / 端点存在 / 端点类型匹配 linkTypes 定义（schema 数据错配也报）。 */
  for (const l of links) {
    const def = linkTypes[String(l.type)];
    if (!def) {
      push("builtin:link-type", "link", String(l.type), "未注册的链接类型");
      continue;
    }
    const a = objects[String(l.from)];
    const b = objects[String(l.to)];
    if (!a || !b) {
      push("builtin:link-endpoint", "link", `${String(l.from)}→${String(l.to)}`, "链接端点对象缺失");
      continue;
    }
    if (a.type !== def.from || b.type !== def.to) {
      push("builtin:link-endpoint-type", "link", `${String(l.from)}→${String(l.to)}`, `${String(l.type)} 端点类型应为 ${def.from}→${def.to}，实为 ${String(a.type)}→${String(b.type)}`);
    }
  }
  /* 对象类型须已注册（个人扩展经 mergePersonal 进注册表后即合法）。 */
  for (const o of list) {
    if (!objectTypes[String(o.type)]) push("builtin:object-type", "object", String(o.id ?? ""), `未注册的对象类型 ${String(o.type)}`);
  }

  return out;
}

export { ONTOLOGY_SCHEMA_ID_PATTERN };
