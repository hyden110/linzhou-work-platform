/**
 * Ontology model (F8) — 策展层纯函数模型：操作日志 replay 语义 + 动作校验/应用 + 派生图。
 * 语义权威：base/sa-workbench scripts/lib/ontology/{overlay.js,actions.js}（搬语义不搬代码）。
 *
 * 红线：
 * - 策展层真身是操作日志；生效图与 graph.json 都是 replay 派生物，读侧永远可重建；
 * - 不可变更新：replay/applyAction 绝不改动入参，一律返回新对象；
 * - replay 只产出 effective 与 conflicts，冲突只报告不修改、不静默丢；
 * - 无 I/O、无时钟、无随机（at/by/newUid 全部由调用方注入），浏览器与 node --test 共用。
 */

import type {
  ApplyContext,
  ApplyOutcome,
  ActionRequest,
  AuditLine,
  ConstraintRule,
  EffectiveGraph,
  GraphColumn,
  GraphLayout,
  GraphNode,
  GraphNodePosition,
  GraphStats,
  LinkTypeDef,
  ObjectTypeDef,
  OntologyEdits,
  OntologyGraphView,
  OntologyLink,
  OntologyObject,
  OntologyOp,
  OntologySchema,
  OntologyValidationState,
  PersonalSchema,
  ReplayConflict,
  ReplayResult,
  ValidationResult,
} from "./ontology-types.ts";
import {
  isKnownOntologyAction,
  ONTOLOGY_KEY_MAX,
  ONTOLOGY_SCHEMA_ID_PATTERN,
  ONTOLOGY_UID_PATTERN,
} from "./ontology-types.ts";
import { mergePersonal, SHARED_LINK_TYPES, SHARED_OBJECT_TYPES } from "./ontology-schema.ts";

/* 共享词汇 id 集（donor 用共享注册表判断「不可覆盖」，个人扩展不参与该判断）。 */
const SHARED_TYPE_IDS = new Set(Object.keys(SHARED_OBJECT_TYPES));
const SHARED_LINK_IDS = new Set(Object.keys(SHARED_LINK_TYPES));

/** donor STR(v,n)：非空字符串且长度 ≤ n。 */
function str(v: unknown, n = 200): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= n;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 空策展层：{v:1, uids:{}, ops:[]}（照 donor overlay 空文档形状）。 */
export function emptyEdits(): OntologyEdits {
  return { v: 1, uids: {}, ops: [] };
}

/** uid 铸造：u + 8 位十六进制（照 donor overlay.newUid；crypto 在 node 22 与浏览器均有）。 */
export function newUid(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return "u" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * edits.json 读回解析：形态不符（非对象 / uids 值非字符串 / ops 非数组 / op 项缺 op 名）
 * 一律返回 null —— 调用方（桥）据此拒绝写路径并返回错误码，绝不静默清空。
 * 缺省字段宽容（uids/ops 缺失 → 空），op 归一补 at/by/key 缺省值。
 */
export function parseEditsDoc(raw: unknown): OntologyEdits | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;

  const uids: Record<string, string> = {};
  if (doc.uids !== undefined) {
    if (!doc.uids || typeof doc.uids !== "object" || Array.isArray(doc.uids)) return null;
    for (const [k, v] of Object.entries(doc.uids as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      uids[k] = v;
    }
  }

  const ops: OntologyOp[] = [];
  if (doc.ops !== undefined) {
    if (!Array.isArray(doc.ops)) return null;
    for (const item of doc.ops) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const o = item as Record<string, unknown>;
      if (!str(o.op)) return null;
      ops.push({
        ...o,
        op: o.op,
        at: typeof o.at === "string" ? o.at : "",
        by: typeof o.by === "string" ? o.by : "",
        key: typeof o.key === "string" ? o.key : null,
      } as OntologyOp);
    }
  }
  return { v: 1, uids, ops };
}

/** schema.* 操作 → 个人扩展段（照 donor overlay.personalSchema；畸形条目静默跳过）。 */
export function personalSchemaFromOps(edits: OntologyEdits): PersonalSchema {
  const objectTypes: Record<string, ObjectTypeDef> = {};
  const linkTypes: Record<string, LinkTypeDef> = {};
  const constraints: ConstraintRule[] = [];
  for (const op of edits.ops) {
    if (op.op === "schema.addType" && str(op.id) && isRecord(op.type) && str(op.type.label, 40)) {
      objectTypes[op.id] = deepCopy(op.type) as unknown as ObjectTypeDef;
    }
    if (op.op === "schema.addLink" && str(op.id) && isRecord(op.link)) {
      linkTypes[op.id] = deepCopy(op.link) as unknown as LinkTypeDef;
    }
    if (op.op === "schema.addConstraint" && isRecord(op.rule) && str(op.rule.id, 60)) {
      constraints.push(deepCopy(op.rule) as unknown as ConstraintRule);
    }
  }
  return { objectTypes, linkTypes, constraints };
}

/** 当前生效 schema = 共享注册表 + 操作日志里的个人扩展。 */
export function currentSchema(edits: OntologyEdits): OntologySchema {
  return mergePersonal(personalSchemaFromOps(edits));
}

/** 已登记 uid 集合（edits.uids 的值集合；uid 存在性校验的输入）。 */
export function knownUidsOf(edits: OntologyEdits): ReadonlySet<string> {
  return new Set(Object.values(edits.uids));
}

/* ------------------------------------------------------------------ */
/* validateAction（照 donor actions.js ACTIONS 两层校验）                */
/* ------------------------------------------------------------------ */

type Payload = Record<string, unknown>;

function asPayload(payload: unknown): Payload {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Payload) : {};
}

const PROP_KEY_PATTERN = /^[\w-]{1,40}$/;const ACTION_CHECKS: Record<string, (p: Payload, state: OntologyValidationState) => string | null> = {
  "entity.create": (p, state) => {
    if (!str(p.type, 40) || !state.schema.objectTypes[p.type]) return "type 必填且须为已注册对象类型";
    const props = p.props;
    if (!props || typeof props !== "object" || Array.isArray(props) || !str((props as Payload).name, 200)) {
      return "props.name 必填（≤200 字符）";
    }
    if (p.uid !== undefined && (typeof p.uid !== "string" || !ONTOLOGY_UID_PATTERN.test(p.uid))) {
      return "如提供 uid 须为 u+8 位十六进制形态";
    }
    return null;
  },
  "entity.rename": (p) => (typeof p.uid === "string" && p.uid && str(p.name, 200) ? null : "uid 与 name 必填"),
  "entity.setProp": (p) => {
    if (!p.uid || !p.props || typeof p.props !== "object" || Array.isArray(p.props)) return "uid 与 props 对象必填";
    const bad = Object.keys(p.props as Payload).filter((k) => !PROP_KEY_PATTERN.test(k));
    return bad.length ? `属性键不合法：${bad.join(",")}` : null;
  },
  "entity.retag": (p, state) => (p.uid && typeof p.type === "string" && state.schema.objectTypes[p.type] ? null : "uid 与已注册 type 必填"),
  "entity.archive": (p) => (p.uid ? null : "uid 必填"),
  "entity.merge": (p) => (p.uid && p.fromUid && p.uid !== p.fromUid ? null : "uid 与 fromUid 必填且不可相同"),
  "entity.split": (p) => {
    if (!p.uid) return "uid 与 absorbedKeys（≥1 个非空字符串）必填";
    const keys = p.absorbedKeys;
    if (!Array.isArray(keys) || keys.length === 0) return "uid 与 absorbedKeys（≥1 个非空字符串）必填";
    if (keys.some((k) => typeof k !== "string" || k.length === 0)) return "absorbedKeys 须全为非空字符串";
    return null;
  },
  "link.assert": (p, state) => {
    if (!p.fromUid || !p.toUid || p.fromUid === p.toUid) return "fromUid/toUid 必填且不可自环";
    if (!str(p.type, 40) || !state.schema.linkTypes[p.type]) return "type 须为已注册链接类型";
    if (p.basis !== undefined && (typeof p.basis !== "string" || !state.schema.basis[p.basis])) return "basis 不合法";
    return null;
  },
  "link.retract": (p) => (p.fromUid && p.toUid && str(p.type, 40) ? null : "fromUid/toUid/type 必填"),
  "schema.addType": (p) => {
    if (!ONTOLOGY_SCHEMA_ID_PATTERN.test(String(p.id ?? ""))) return "id 须为小写字母开头的 ≤32 位标识";
    if (SHARED_TYPE_IDS.has(String(p.id))) return `共享类型不可被个人层覆盖：${String(p.id)}`;
    if (!p.type || typeof p.type !== "object" || !str((p.type as Payload).label, 40)) return "type.label 必填";
    return null;
  },
  "schema.addLink": (p, state) => {
    if (!ONTOLOGY_SCHEMA_ID_PATTERN.test(String(p.id ?? ""))) return "id 不合法";
    if (SHARED_LINK_IDS.has(String(p.id))) return `共享链接类型不可被个人层覆盖：${String(p.id)}`;
    const l = (p.link ?? {}) as Payload;
    if (typeof l.from !== "string" || typeof l.to !== "string"
      || !state.schema.objectTypes[l.from] || !state.schema.objectTypes[l.to]) {
      return "link.from/to 须为已注册对象类型";
    }
    return null;
  },
  "schema.addConstraint": (p) => {
    const r = (p.rule ?? {}) as Payload;
    return str(r.id, 60) ? null : "rule.id 必填";
  },
};

/**
 * 纯校验函数（任务书指定签名）：动作自身输入 + schema 前置 + uid 存在性。
 * 校验口径照 donor actions.js：先 uid 存在性（create 的新 uid / newUid 豁免），再动作输入。
 */
export function validateAction(
  action: unknown,
  payload: unknown,
  state: OntologyValidationState,
): ValidationResult {
  if (typeof action !== "string" || !isKnownOntologyAction(action)) {
    return { ok: false, code: "unknown_action", reason: `未知动作：${String(action).slice(0, 60)}` };
  }
  const p = asPayload(payload);
  for (const field of ["uid", "fromUid", "toUid", "newUid"] as const) {
    const value = p[field];
    if (typeof value !== "string" || !value) continue;
    const exempt = field === "newUid" || (field === "uid" && (action === "entity.create" || action === "schema.addType"));
    if (exempt) continue;
    if (!state.knownUids.has(value)) {
      return { ok: false, code: "unknown_uid", reason: `uid 未在本体登记：${value}` };
    }
  }
  const reason = ACTION_CHECKS[action](p, state);
  if (reason) return { ok: false, code: "invalid_payload", reason };
  return { ok: true };
}

/**
 * 写路径纯核心（donor actions.execute 的落账部分）：
 * key 形态校验 → 幂等键去重（同 key 已落账即 deduped，不重复追加）→ validateAction
 * → 追加 op（entity.create 缺 uid / entity.split 缺 newUid 时经 ctx.newUid 铸造，
 * 并把 manual:<uid> 锚进 uids）→ 返回新 edits。绝不改动入参。
 */
export function applyAction(
  edits: OntologyEdits,
  request: ActionRequest,
  ctx: ApplyContext,
): ApplyOutcome {
  let key: string | null = null;
  if (request.key !== undefined && request.key !== null) {
    if (typeof request.key !== "string" || request.key.length === 0 || request.key.length > ONTOLOGY_KEY_MAX) {
      return { status: "rejected", code: "invalid_payload", reason: `幂等键须为非空字符串且 ≤${ONTOLOGY_KEY_MAX} 字符` };
    }
    key = request.key;
  }
  /* 幂等键去重在先（照 donor：dup 命中直接返回，即便本次 payload 非法）。 */
  if (key !== null) {
    const hit = edits.ops.find((o) => o.key === key);
    if (hit) return { status: "deduped", key, at: hit.at };
  }

  const payload = asPayload(request.payload);
  const state: OntologyValidationState = { schema: currentSchema(edits), knownUids: knownUidsOf(edits) };
  const verdict = validateAction(request.action, payload, state);
  if (!verdict.ok) return { status: "rejected", code: verdict.code, reason: verdict.reason };
  const action = request.action as string;

  const op: Record<string, unknown> = { ...payload, op: action, at: ctx.at, by: ctx.by, key };
  let uids = edits.uids;
  if (action === "entity.create") {
    const uid = typeof op.uid === "string" && op.uid ? op.uid : ctx.newUid();
    op.uid = uid;
    uids = { ...uids, [`manual:${uid}`]: uid };
  }
  if (action === "entity.split" && !(typeof op.newUid === "string" && op.newUid)) {
    op.newUid = ctx.newUid();
  }
  const nextEdits: OntologyEdits = { v: 1, uids, ops: [...edits.ops, op as OntologyOp] };
  const uid = typeof op.uid === "string" && op.uid
    ? op.uid
    : (typeof payload.uid === "string" && payload.uid ? payload.uid : null);
  return { status: "applied", edits: nextEdits, op: op as OntologyOp, uid };
}

/* ------------------------------------------------------------------ */
/* replay（照 donor overlay.replay 移植，基点为空图：V2 无上游派生源）    */
/* ------------------------------------------------------------------ */

/** create/setProp 时 props 不得劫持的身份键。 */
const IDENTITY_KEYS = new Set(["id", "uid", "type", "manual", "sources", "splitFrom", "curated"]);

function stripIdentity(props: Payload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!IDENTITY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * 操作日志 replay → 生效图。冲突进 conflicts 不静默丢；merge 富化 op
 * （absorbedKeys/absorbedNames/absorbedSnapshot）并返回富化后的新 edits 供持久化。
 */
export function replay(edits: OntologyEdits, schema?: OntologySchema): ReplayResult {
  const activeSchema = schema ?? currentSchema(edits);
  const uids: Record<string, string> = { ...edits.uids };
  const ops: Record<string, unknown>[] = edits.ops.map((o) => ({ ...o }));
  const objects: Record<string, Record<string, unknown>> = {};
  let links: Record<string, unknown>[] = [];
  const conflicts: ReplayConflict[] = [];
  /** merge 时捕获的被并方快照（V2 无上游派生原件，split 从这里恢复）。 */
  const absorbedSnapshots = new Map<string, Record<string, unknown>>();
  let applied = 0;

  const liveIdOf = (uid: unknown): string | null => {
    if (typeof uid !== "string" || !uid) return null;
    const keys = Object.keys(uids).filter((k) => uids[k] === uid);
    const manual = keys.filter((k) => k.startsWith("manual:") && objects[k]);
    if (manual.length) return manual[0] as string;
    const live = keys.filter((k) => objects[k]);
    return live.length ? (live[0] as string) : null;
  };
  const resolve = (uid: unknown, op: Record<string, unknown>): string | null => {
    const id = liveIdOf(uid);
    if (!id) {
      conflicts.push({ op: String(op.op), at: typeof op.at === "string" ? op.at : "", uid: String(uid ?? ""), note: "uid 无活对象（源消失或已归档）" });
      return null;
    }
    return id;
  };

  for (const op of ops) {
    const kind = typeof op.op === "string" ? op.op : "";
    const at = typeof op.at === "string" ? op.at : "";
    if (!kind) continue;
    if (kind.startsWith("schema.")) { applied += 1; continue; }

    if (kind === "entity.create") {
      const uid = typeof op.uid === "string" && op.uid ? op.uid : "";
      if (!uid) {
        conflicts.push({ op: kind, at, note: "entity.create 缺 uid（写路径应铸造）" });
        continue;
      }
      const id = `manual:${uid}`;
      uids[id] = uid;
      const props = op.props && typeof op.props === "object" && !Array.isArray(op.props) ? (op.props as Payload) : {};
      objects[id] = { ...props, id, uid, type: String(op.type ?? ""), manual: true, sources: ["overlay"] };
      applied += 1;
      continue;
    }

    if (kind === "entity.rename" || kind === "entity.setProp" || kind === "entity.retag") {
      const id = resolve(op.uid, op);
      if (!id) continue;
      const o = objects[id] as Record<string, unknown>;
      if (kind === "entity.rename") {
        const next = String(op.name ?? "");
        if (typeof o.name === "string" && o.name && o.name !== next) {
          o.aliases = uniqueStrings([...(Array.isArray(o.aliases) ? o.aliases : []), o.name]);
        }
        o.name = next;
      }
      if (kind === "entity.setProp") {
        const props = op.props && typeof op.props === "object" && !Array.isArray(op.props) ? (op.props as Payload) : {};
        Object.assign(o, stripIdentity(props));
      }
      if (kind === "entity.retag") o.type = String(op.type ?? "");
      o.curated = true;
      applied += 1;
      continue;
    }

    if (kind === "entity.archive") {
      const id = resolve(op.uid, op);
      if (!id) continue;
      delete objects[id];
      links = links.filter((l) => l.from !== id && l.to !== id);
      applied += 1;
      continue;
    }

    if (kind === "entity.merge") {
      const to = resolve(op.uid, op);
      let from = liveIdOf(op.fromUid);
      const take = Array.isArray(op.absorbedKeys) ? (op.absorbedKeys as unknown[]).filter((k): k is string => typeof k === "string") : [];
      if (!from) {
        /* 源 id 漂移回退：按 merge 时记录的 absorbedKeys / absorbedNames 找回被并方（照 donor）。 */
        const byKey = take.find((k) => objects[k]);
        const byName = byKey ? undefined : Object.keys(objects).find((k) => {
          const names = Array.isArray(op.absorbedNames) ? (op.absorbedNames as unknown[]) : [];
          return names.includes(objects[k]?.name as never);
        });
        from = byKey ?? byName ?? null;
        if (!from) {
          conflicts.push({
            op: kind, at, uid: String(op.fromUid ?? ""),
            note: take.length ? "被并方源键与名称均未在当轮派生图命中" : "uid 无活对象（源消失或已归档）",
          });
          continue;
        }
      }
      if (!to) continue;
      if (to === from) {
        conflicts.push({ op: kind, at, uid: String(op.uid ?? ""), note: "merge 双方同一实体" });
        continue;
      }
      const a = objects[to] as Record<string, unknown>;
      const b = objects[from] as Record<string, unknown>;
      /* 富化 op：吸收键/名称/快照（split 的恢复来源；随日志持久化）。 */
      const absorbedKeys = uniqueStrings([...take, from]);
      op.absorbedKeys = absorbedKeys;
      op.absorbedNames = uniqueStrings([
        ...(Array.isArray(op.absorbedNames) ? op.absorbedNames : []),
        b.name,
        ...(Array.isArray(b.aliases) ? b.aliases : []),
      ]);
      op.absorbedSnapshot = deepCopy(b);
      absorbedSnapshots.set(from, deepCopy(b));

      if (typeof b.name === "string" && b.name && b.name !== a.name) {
        a.aliases = uniqueStrings([...(Array.isArray(a.aliases) ? a.aliases : []), b.name]);
      }
      if (Array.isArray(b.aliases)) {
        a.aliases = uniqueStrings([...(Array.isArray(a.aliases) ? a.aliases : []), ...b.aliases]);
      }
      for (const k of Object.keys(b)) {
        if (a[k] == null || a[k] === "") a[k] = b[k];
      }
      a.curated = true;
      /* 链接改挂存方并记录被吸收端点（origin*），供 split 追溯改挂。 */
      for (const l of links) {
        if (l.from === from) { l.from = to; l.originFrom = from; }
        if (l.to === from) { l.to = to; l.originTo = from; }
      }
      /* 同三元组去重（overlay 人工边优先，照 donor 语义）。 */
      const seen = new Map<string, Record<string, unknown>>();
      for (const l of links) {
        const triple = `${String(l.type)}|${String(l.from)}|${String(l.to)}`;
        const prev = seen.get(triple);
        if (!prev) seen.set(triple, l);
        else if (l.source === "overlay" && prev.source !== "overlay") seen.set(triple, l);
      }
      links = [...seen.values()];
      delete objects[from];
      /* 被并方全部锚键重指存方 uid（含 manual 键），重建后仍可反解（照 donor）。 */
      for (const k of Object.keys(uids)) {
        if (uids[k] === op.fromUid) uids[k] = String(op.uid);
      }
      for (const k of absorbedKeys) uids[k] = String(op.uid);
      applied += 1;
      continue;
    }

    if (kind === "entity.split") {
      /* 撤销式拆分：把 merge 吸收的源键恢复为独立实体（V2 从 merge 快照恢复）。 */
      const uid = typeof op.newUid === "string" && op.newUid ? op.newUid : "";
      if (!uid) {
        conflicts.push({ op: kind, at, note: "entity.split 缺 newUid（写路径应铸造）" });
        continue;
      }
      const id = `manual:${uid}`;
      const take = Array.isArray(op.absorbedKeys) ? (op.absorbedKeys as unknown[]).filter((k): k is string => typeof k === "string") : [];
      const restored: Record<string, Record<string, unknown>> = {};
      for (const k of take) {
        const snapshot = absorbedSnapshots.get(k);
        if (snapshot) restored[k] = deepCopy(snapshot);
      }
      if (!take.length || !Object.keys(restored).length) {
        conflicts.push({ op: kind, at, uid, note: "absorbedKeys 无对应吸收记录（未被合并过或已拆分）" });
        continue;
      }
      const firstKey = take.find((k) => restored[k]) as string;
      const first = restored[firstKey] as Record<string, unknown>;
      objects[id] = {
        ...first,
        id,
        uid,
        manual: true,
        splitFrom: String(op.uid ?? ""),
        sources: [...(Array.isArray(first.sources) ? (first.sources as string[]) : []), "overlay"],
      };
      uids[id] = uid;
      for (const k of Object.keys(restored)) {
        if (k !== id) uids[k] = uid;
      }
      /* 存方身上由被拆键产生的链接（origin* 命中）改挂新实体并清除 origin 标记。 */
      const targetLive = liveIdOf(op.uid);
      const restoredKeys = new Set([...take, ...Object.keys(restored)]);
      if (targetLive) {
        for (const l of links) {
          if (l.from === targetLive && typeof l.originFrom === "string" && restoredKeys.has(l.originFrom)) {
            l.from = id;
            delete l.originFrom;
          }
          if (l.to === targetLive && typeof l.originTo === "string" && restoredKeys.has(l.originTo)) {
            l.to = id;
            delete l.originTo;
          }
        }
      }
      applied += 1;
      continue;
    }

    if (kind === "link.assert") {
      const from = resolve(op.fromUid, op);
      const to = resolve(op.toUid, op);
      if (!from || !to) continue;
      if (!activeSchema.linkTypes[String(op.type)]) {
        conflicts.push({ op: kind, at, uid: String(op.fromUid ?? ""), note: `未注册链接类型 ${String(op.type)}` });
        continue;
      }
      if (!links.some((l) => l.type === op.type && l.from === from && l.to === to)) {
        links.push({
          type: String(op.type),
          from,
          to,
          basis: typeof op.basis === "string" && op.basis ? op.basis : "confirmed",
          source: "overlay",
        });
      }
      applied += 1;
      continue;
    }

    if (kind === "link.retract") {
      const from = resolve(op.fromUid, op);
      const to = resolve(op.toUid, op);
      if (!from || !to) continue;
      const before = links.length;
      links = links.filter((l) => !(l.type === op.type && l.from === from && l.to === to));
      if (links.length === before) {
        conflicts.push({ op: kind, at, uid: String(op.fromUid ?? ""), note: "无匹配链接可撤销" });
      } else {
        applied += 1;
      }
      continue;
    }

    conflicts.push({ op: kind, at, note: "未知操作类型" });
  }

  /* uid 落到每个生效对象，供 UI 稳定引用（照 donor）。 */
  for (const id of Object.keys(objects)) {
    const uid = uids[id];
    if (uid) objects[id].uid = uid;
  }
  const stats: GraphStats = { objects: {}, links: {}, basis: {} };
  const statsObjects = { ...stats.objects } as Record<string, number>;
  const statsLinks = { ...stats.links } as Record<string, number>;
  const statsBasis = { ...stats.basis } as Record<string, number>;
  for (const o of Object.values(objects)) {
    const t = String(o.type ?? "");
    statsObjects[t] = (statsObjects[t] ?? 0) + 1;
  }
  for (const l of links) {
    const t = String(l.type ?? "");
    const b = String(l.basis ?? "");
    statsLinks[t] = (statsLinks[t] ?? 0) + 1;
    statsBasis[b] = (statsBasis[b] ?? 0) + 1;
  }
  const effective: EffectiveGraph = {
    objects: objects as unknown as EffectiveGraph["objects"],
    links: links as unknown as readonly OntologyLink[],
    stats: { objects: statsObjects, links: statsLinks, basis: statsBasis },
  };
  return {
    effective,
    conflicts,
    applied,
    edits: { v: 1, uids, ops: ops as unknown as readonly OntologyOp[] },
  };
}

/* ------------------------------------------------------------------ */
/* 派生图视图（graph.json / GET graph 的同一形状）                       */
/* ------------------------------------------------------------------ */

/** 视图投影时从 props 剥离的键（身份/展示字段各有专位）。 */
const VIEW_RESERVED_KEYS = new Set([
  "id", "uid", "type", "name", "aliases", "tags", "manual", "curated", "sources", "splitFrom",
]);

function endpointUid(effective: EffectiveGraph, id: string): string {
  const obj = effective.objects[id] as OntologyObject | undefined;
  if (obj?.uid) return obj.uid;
  return id.startsWith("manual:") ? id.slice("manual:".length) : "";
}

/** 生效图 → 派生图视图（nodes/links 白名单投影；tags 只留字符串、props 只留原始值）。 */
export function deriveGraphView(
  effective: EffectiveGraph,
  meta: { generatedAt: string; opsCount?: number; lastOpAt?: string },
): OntologyGraphView {
  const nodes: GraphNode[] = Object.keys(effective.objects).map((key) => {
    const o = effective.objects[key] as OntologyObject & Record<string, unknown>;
    const props: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(o)) {
      if (VIEW_RESERVED_KEYS.has(k)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
    return {
      id: typeof o.id === "string" && o.id ? o.id : key,
      uid: typeof o.uid === "string" ? o.uid : "",
      type: typeof o.type === "string" ? o.type : "",
      name: typeof o.name === "string" ? o.name : "",
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
      aliases: Array.isArray(o.aliases) ? o.aliases.filter((t): t is string => typeof t === "string") : [],
      props,
      manual: o.manual === true,
      curated: o.curated === true,
    };
  });
  const links = effective.links.map((l) => ({
    type: l.type,
    from: l.from,
    to: l.to,
    fromUid: endpointUid(effective, l.from),
    toUid: endpointUid(effective, l.to),
    basis: l.basis,
    source: l.source,
  }));
  return {
    generatedAt: meta.generatedAt,
    opsCount: meta.opsCount ?? 0,
    lastOpAt: meta.lastOpAt ?? "",
    nodes,
    links,
    stats: effective.stats,
  };
}

/** replay + deriveGraphView 一步到位（每次成功动作后重建 graph.json 用）。 */
export function rebuildGraphView(edits: OntologyEdits, generatedAt: string): OntologyGraphView {
  const rep = replay(edits);
  const lastOp = edits.ops[edits.ops.length - 1];
  return deriveGraphView(rep.effective, {
    generatedAt,
    opsCount: edits.ops.length,
    lastOpAt: lastOp?.at ?? "",
  });
}

/* ------------------------------------------------------------------ */
/* SVG 图布局（type 分列网格，无力导、无随机）                            */
/* ------------------------------------------------------------------ */

const LAYOUT_DEFAULTS = {
  columnWidth: 180,
  rowHeight: 64,
  nodeWidth: 150,
  nodeHeight: 44,
  paddingX: 24,
  paddingY: 40,
} as const;

/**
 * 节点按 type 分列网格：列序 = type 在 nodes 中首次出现序（确定性），列内按输入序纵排。
 */
export function layoutOntologyGraph(
  nodes: readonly GraphNode[],
  options?: Partial<typeof LAYOUT_DEFAULTS>,
): GraphLayout {
  const cfg = { ...LAYOUT_DEFAULTS, ...(options ?? {}) };
  const columnTypes: string[] = [];
  for (const n of nodes) {
    if (!columnTypes.includes(n.type)) columnTypes.push(n.type);
  }
  const rowCounter = new Map<string, number>();
  const positions: GraphNodePosition[] = nodes.map((n) => {
    const columnIndex = columnTypes.indexOf(n.type);
    const rowIndex = rowCounter.get(n.type) ?? 0;
    rowCounter.set(n.type, rowIndex + 1);
    return {
      id: n.id,
      column: n.type,
      columnIndex,
      x: cfg.paddingX + columnIndex * cfg.columnWidth + (cfg.columnWidth - cfg.nodeWidth) / 2,
      y: cfg.paddingY + rowIndex * cfg.rowHeight,
    };
  });
  const columns: GraphColumn[] = columnTypes.map((type, index) => ({
    type,
    x: cfg.paddingX + index * cfg.columnWidth,
    count: rowCounter.get(type) ?? 0,
  }));
  const maxRows = columns.reduce((m, c) => Math.max(m, c.count), 0);
  return {
    positions,
    columns,
    width: cfg.paddingX * 2 + columns.length * cfg.columnWidth,
    height: cfg.paddingY * 2 + maxRows * cfg.rowHeight,
    nodeWidth: cfg.nodeWidth,
    nodeHeight: cfg.nodeHeight,
  };
}

/** 审计尾：取最后 limit 行（limit ≤ 0 → 空；读侧宽容由 store 的坏行过滤负责）。 */
export function tailAudit(lines: readonly AuditLine[], limit: number): AuditLine[] {
  if (limit <= 0) return [];
  return lines.slice(Math.max(0, lines.length - limit));
}
