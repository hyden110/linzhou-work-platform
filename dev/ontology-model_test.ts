import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  currentSchema,
  deriveGraphView,
  emptyEdits,
  knownUidsOf,
  layoutOntologyGraph,
  newUid,
  parseEditsDoc,
  personalSchemaFromOps,
  replay,
  rebuildGraphView,
  tailAudit,
  validateAction,
} from "../src/lib/ontology-model.ts";
import {
  checkConstraints,
  mergePersonal,
  sharedSchemaSnapshot,
  SHARED_CONSTRAINTS,
  SHARED_LINK_TYPES,
  SHARED_OBJECT_TYPES,
} from "../src/lib/ontology-schema.ts";
import {
  BASIS_SEED_COUNT_EXPECTED,
  ONTOLOGY_ACTIONS,
  type AuditLine,
  type EffectiveGraph,
  type GraphNode,
  type OntologyEdits,
} from "./ontology-model-testkit.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：实体只用「甲科技（合成）/乙股份（合成）/张三（合成）/丙实验室（合成）」，
// 绝不含真实客户数据。时钟与 uid 全部注入（FIXED_AT + 序列 uid），零随机零 I/O。
// ---------------------------------------------------------------------------

const FIXED_AT = "2026-10-20T03:00:00.000Z";

function seqUid(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `u${n.toString(16).padStart(8, "0")}`;
  };
}

function ctxWith(gen: () => string) {
  return { at: FIXED_AT, by: "workbench", newUid: gen };
}

function mustApply(
  edits: OntologyEdits,
  action: string,
  payload: Record<string, unknown>,
  key: string | null = null,
  gen: () => string = seqUid(),
) {
  const outcome = applyAction(edits, { action, payload, key: key ?? undefined }, ctxWith(gen));
  assert.equal(outcome.status, "applied", `${action} 应落账：${JSON.stringify(outcome)}`);
  if (outcome.status !== "applied") throw new Error("unreachable");
  return outcome;
}

/** 建两个合成客户 + 一个合成人，返回 {edits, uidA(甲), uidB(乙), uidP(张三)}。 */
function seedThree(gen = seqUid()) {
  let edits = emptyEdits();
  const a = mustApply(edits, "entity.create", { type: "customer", props: { name: "甲科技（合成）", ecid: "E1" } }, "k-a", gen);
  edits = a.edits;
  const b = mustApply(edits, "entity.create", { type: "customer", props: { name: "乙股份（合成）", cid: "C2" } }, "k-b", gen);
  edits = b.edits;
  const p = mustApply(edits, "entity.create", { type: "person", props: { name: "张三（合成）" } }, "k-p", gen);
  edits = p.edits;
  return { edits, uidA: a.uid as string, uidB: b.uid as string, uidP: p.uid as string };
}

// ---------------------------------------------------------------------------
// 1. 动作集与共享注册表（与 donor 完全一致）
// ---------------------------------------------------------------------------

test("action set matches the donor exactly (12 actions)", () => {
  assert.deepEqual(
    [...ONTOLOGY_ACTIONS].sort(),
    [
      "entity.archive", "entity.create", "entity.merge", "entity.rename",
      "entity.retag", "entity.setProp", "entity.split", "link.assert",
      "link.retract", "schema.addConstraint", "schema.addLink", "schema.addType",
    ],
  );
  assert.equal(ONTOLOGY_ACTIONS.length, 12);
});

test("shared schema registry mirrors the donor seed", () => {
  assert.deepEqual(Object.keys(SHARED_OBJECT_TYPES).sort(), ["customer", "group", "objective", "opportunity", "org", "person", "project"]);
  assert.equal(Object.keys(SHARED_LINK_TYPES).length, 10);
  assert.equal(SHARED_LINK_TYPES.manages?.from, "person");
  assert.equal(SHARED_LINK_TYPES.manages?.to, "customer");
  assert.equal(SHARED_CONSTRAINTS.length, BASIS_SEED_COUNT_EXPECTED.constraints);
  const snapshot = sharedSchemaSnapshot();
  assert.equal(Object.keys(snapshot.basis).length, BASIS_SEED_COUNT_EXPECTED.basis);
  assert.equal(snapshot.objectTypes.person?.label, "人");
  snapshot.objectTypes = {} as never; // 快照可被消费方改动……
  assert.ok(SHARED_OBJECT_TYPES.person, "……但常量本体不受影响（深拷贝隔离）");
});

// ---------------------------------------------------------------------------
// 2. mergePersonal / personalSchemaFromOps（只增不删）
// ---------------------------------------------------------------------------

test("mergePersonal adds personal vocabulary but never overrides shared entries", () => {
  const merged = mergePersonal({
    objectTypes: {
      vendor: { label: "供应商" },
      person: { label: "越权覆盖" },
      "Bad Id": { label: "非法 id" },
    },
    linkTypes: {
      supplies: { label: "供货", from: "vendor", to: "customer" },
      dangling: { label: "悬空", from: "vendor", to: "no-such-type" },
      manages: { label: "越权覆盖", from: "person", to: "customer" },
    },
    constraints: [
      { id: "person-name", require: ["hack"] },
      { id: "vendor-name", when: { type: "vendor" }, require: ["name"] },
    ],
  });
  assert.equal(merged.objectTypes.vendor?.label, "供应商", "合法个人类型被采纳");
  assert.equal(merged.objectTypes.person?.label, "人", "共享类型不可被个人层覆盖");
  assert.equal(merged.objectTypes["Bad Id"], undefined, "id 形态不符静默跳过");
  assert.equal(merged.linkTypes.supplies?.label, "供货", "端点已注册的个人链接被采纳");
  assert.equal(merged.linkTypes.dangling, undefined, "端点未注册的链接不采纳");
  assert.equal(merged.linkTypes.manages?.label, "客户销售负责", "共享链接不可被覆盖");
  assert.equal(merged.constraints.filter((c) => c.id === "person-name").length, 1, "约束按 id 去重（共享种子优先）");
  assert.ok(merged.constraints.some((c) => c.id === "vendor-name"), "新约束追加");
  assert.equal(mergePersonal(null).objectTypes.person?.label, "人", "无个人段 = 共享快照");
});

test("personalSchemaFromOps extracts schema.* ops and skips malformed entries", () => {
  const gen = seqUid();
  let edits = emptyEdits();
  edits = mustApply(edits, "schema.addType", { id: "vendor", type: { label: "供应商" } }, "k-t", gen).edits;
  edits = mustApply(edits, "schema.addLink", { id: "supplies", link: { label: "供货", from: "vendor", to: "customer" } }, "k-l", gen).edits;
  edits = mustApply(edits, "schema.addConstraint", { rule: { id: "vendor-name", when: { type: "vendor" }, require: ["name"] } }, "k-c", gen).edits;
  edits = mustApply(edits, "entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, "k-e", gen).edits;
  const personal = personalSchemaFromOps(edits);
  assert.equal(personal.objectTypes.vendor?.label, "供应商");
  assert.equal(personal.linkTypes.supplies?.from, "vendor");
  assert.equal(personal.constraints.length, 1);
  // 畸形 op（手工构造日志）：无 label 的 addType、无 id 的 addConstraint 不进个人段
  const handcrafted: OntologyEdits = {
    v: 1, uids: {},
    ops: [
      { op: "schema.addType", id: "ghost", type: {}, at: "", by: "", key: null },
      { op: "schema.addConstraint", rule: { nope: true }, at: "", by: "", key: null },
      { op: "schema.addLink", id: "nolink", at: "", by: "", key: null },
    ],
  };
  const empty = personalSchemaFromOps(handcrafted);
  assert.deepEqual(Object.keys(empty.objectTypes), []);
  assert.deepEqual(Object.keys(empty.linkTypes), []);
  assert.deepEqual(empty.constraints, []);
  // currentSchema 合成后 vendor 可注册实体
  assert.ok(currentSchema(edits).objectTypes.vendor);
});

// ---------------------------------------------------------------------------
// 3. validateAction（纯校验：动作输入 + schema 前置 + uid 存在性）
// ---------------------------------------------------------------------------

function stateFor(edits: OntologyEdits) {
  return { schema: currentSchema(edits), knownUids: knownUidsOf(edits) };
}

test("validateAction rejects unknown actions", () => {
  const result = validateAction("entity.destroy", {}, stateFor(emptyEdits()));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unknown_action");
  const notString = validateAction(42, {}, stateFor(emptyEdits()));
  assert.equal(notString.ok, false);
});

test("validateAction entity.create: registered type + props.name required, uid shape guarded", () => {
  const state = stateFor(emptyEdits());
  assert.equal(validateAction("entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, state).ok, true);
  const unregistered = validateAction("entity.create", { type: "vendor", props: { name: "丙实验室（合成）" } }, state);
  assert.equal(unregistered.ok, false);
  if (!unregistered.ok) {
    assert.equal(unregistered.code, "invalid_payload");
    assert.match(unregistered.reason, /已注册对象类型/);
  }
  assert.equal(validateAction("entity.create", { type: "customer", props: {} }, state).ok, false, "缺 props.name 拒绝");
  assert.equal(validateAction("entity.create", { type: "customer", props: { name: "长".repeat(201) } }, state).ok, false, "name 超 200 拒绝");
  assert.equal(validateAction("entity.create", { type: "customer" }, state).ok, false, "props 非对象拒绝");
  assert.equal(validateAction("entity.create", { type: "customer".repeat(10), props: { name: "x" } }, state).ok, false, "type 超 40 拒绝");
  const badUid = validateAction("entity.create", { type: "customer", props: { name: "甲科技（合成）" }, uid: "xyz" }, state);
  assert.equal(badUid.ok, false, "调用方给的 uid 必须是 u+8hex 形态");
  const goodUid = validateAction("entity.create", { type: "customer", props: { name: "甲科技（合成）" }, uid: "u0000abcd" }, state);
  assert.equal(goodUid.ok, true, "合法新 uid 免存在性检查（照 donor 豁免）");
});

test("validateAction enforces uid existence against the registry", () => {
  const { edits, uidA } = seedThree();
  const state = stateFor(edits);
  assert.equal(validateAction("entity.rename", { uid: uidA, name: "甲科技改名（合成）" }, state).ok, true);
  const ghost = validateAction("entity.rename", { uid: "udeadbeef", name: "幽灵" }, state);
  assert.equal(ghost.ok, false);
  if (!ghost.ok) {
    assert.equal(ghost.code, "unknown_uid");
    assert.match(ghost.reason, /udeadbeef/);
  }
  assert.equal(validateAction("entity.rename", { name: "缺 uid" }, state).ok, false);
  assert.equal(validateAction("entity.archive", { uid: uidA }, state).ok, true);
  const badLink = validateAction("link.assert", { fromUid: uidA, toUid: "u0bad000", type: "manages" }, state);
  assert.equal(badLink.ok, false);
  if (!badLink.ok) assert.equal(badLink.code, "unknown_uid");
});

test("validateAction per-action payload rules follow the donor checks", () => {
  const { edits, uidA, uidB, uidP } = seedThree();
  const state = stateFor(edits);
  // setProp：属性键形态
  assert.equal(validateAction("entity.setProp", { uid: uidA, props: { ecid: "E9" } }, state).ok, true);
  assert.equal(validateAction("entity.setProp", { uid: uidA, props: { "bad key!": "x" } }, state).ok, false);
  assert.equal(validateAction("entity.setProp", { uid: uidA }, state).ok, false);
  // retag：已注册 type
  assert.equal(validateAction("entity.retag", { uid: uidA, type: "project" }, state).ok, true);
  assert.equal(validateAction("entity.retag", { uid: uidA, type: "nope" }, state).ok, false);
  // merge：双方必填且不可相同
  assert.equal(validateAction("entity.merge", { uid: uidA, fromUid: uidB }, state).ok, true);
  assert.equal(validateAction("entity.merge", { uid: uidA, fromUid: uidA }, state).ok, false);
  assert.equal(validateAction("entity.merge", { uid: uidA }, state).ok, false);
  // split：absorbedKeys ≥1 且全为非空字符串
  assert.equal(validateAction("entity.split", { uid: uidA, absorbedKeys: [`manual:${uidB}`] }, state).ok, true);
  assert.equal(validateAction("entity.split", { uid: uidA, absorbedKeys: [] }, state).ok, false);
  assert.equal(validateAction("entity.split", { uid: uidA, absorbedKeys: [""] }, state).ok, false);
  // link.assert：不可自环、类型须注册、basis 白名单
  assert.equal(validateAction("link.assert", { fromUid: uidP, toUid: uidA, type: "manages" }, state).ok, true);
  assert.equal(validateAction("link.assert", { fromUid: uidA, toUid: uidA, type: "manages" }, state).ok, false);
  assert.equal(validateAction("link.assert", { fromUid: uidP, toUid: uidA, type: "no-such-link" }, state).ok, false);
  assert.equal(validateAction("link.assert", { fromUid: uidP, toUid: uidA, type: "manages", basis: "guessed" }, state).ok, false);
  assert.equal(validateAction("link.assert", { fromUid: uidP, toUid: uidA, type: "manages", basis: "confirmed" }, state).ok, true);
  // link.retract
  assert.equal(validateAction("link.retract", { fromUid: uidP, toUid: uidA, type: "manages" }, state).ok, true);
  assert.equal(validateAction("link.retract", { fromUid: uidP, toUid: uidA }, state).ok, false);
  // schema.addType / addLink / addConstraint
  assert.equal(validateAction("schema.addType", { id: "vendor", type: { label: "供应商" } }, state).ok, true);
  assert.equal(validateAction("schema.addType", { id: "person", type: { label: "越权" } }, state).ok, false, "共享类型不可覆盖");
  assert.equal(validateAction("schema.addType", { id: "Bad", type: { label: "非法 id" } }, state).ok, false);
  assert.equal(validateAction("schema.addType", { id: "vendor", type: {} }, state).ok, false, "label 必填");
  const withVendor = stateFor(mustApply(edits, "schema.addType", { id: "vendor", type: { label: "供应商" } }, "k-v").edits);
  assert.equal(validateAction("schema.addLink", { id: "supplies", link: { label: "供货", from: "vendor", to: "customer" } }, withVendor).ok, true);
  assert.equal(validateAction("schema.addLink", { id: "manages", link: { label: "越权", from: "person", to: "customer" } }, state).ok, false);
  assert.equal(validateAction("schema.addLink", { id: "dangling", link: { label: "悬空", from: "vendor", to: "customer" } }, state).ok, false, "端点未注册（vendor 尚未加入）");
  assert.equal(validateAction("schema.addConstraint", { rule: { id: "vendor-name" } }, state).ok, true);
  assert.equal(validateAction("schema.addConstraint", { rule: {} }, state).ok, false);
});

// ---------------------------------------------------------------------------
// 4. applyAction（幂等键去重 / uid 铸造 / 不可变）
// ---------------------------------------------------------------------------

test("applyAction dedupes by idempotency key before validation and keeps the log byte-stable", () => {
  const gen = seqUid();
  const first = mustApply(emptyEdits(), "entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, "k-dup", gen);
  const snapshotBefore = JSON.stringify(first.edits);
  // 同 key 再来——即便这次 payload 非法，也直接 deduped（照 donor：去重在校验之前）
  const dup = applyAction(first.edits, { action: "entity.create", payload: { type: "nope" }, key: "k-dup" }, ctxWith(gen));
  assert.equal(dup.status, "deduped");
  if (dup.status === "deduped") {
    assert.equal(dup.key, "k-dup");
    assert.equal(dup.at, FIXED_AT, "返回首次落账时间");
  }
  assert.equal(JSON.stringify(first.edits), snapshotBefore, "入参 edits 未被改动");
  // 无 key 的动作不去重（照 donor：key 可选）
  const noKey1 = mustApply(first.edits, "entity.create", { type: "customer", props: { name: "乙股份（合成）" } }, null, gen);
  const noKey2 = mustApply(noKey1.edits, "entity.create", { type: "customer", props: { name: "乙股份（合成）" } }, null, gen);
  assert.equal(noKey2.edits.ops.length, noKey1.edits.ops.length + 1);
});

test("applyAction rejects malformed keys and propagates validation codes", () => {
  const gen = seqUid();
  const longKey = applyAction(emptyEdits(), { action: "entity.create", payload: { type: "customer", props: { name: "甲科技（合成）" } }, key: "k".repeat(121) }, ctxWith(gen));
  assert.equal(longKey.status, "rejected");
  if (longKey.status === "rejected") assert.equal(longKey.code, "invalid_payload");
  const numKey = applyAction(emptyEdits(), { action: "entity.create", payload: {}, key: 42 }, ctxWith(gen));
  assert.equal(numKey.status, "rejected");
  const unknown = applyAction(emptyEdits(), { action: "entity.nope", payload: {} }, ctxWith(gen));
  assert.equal(unknown.status, "rejected");
  if (unknown.status === "rejected") assert.equal(unknown.code, "unknown_action");
  const ghostUid = applyAction(emptyEdits(), { action: "entity.archive", payload: { uid: "udeadbeef" } }, ctxWith(gen));
  assert.equal(ghostUid.status, "rejected");
  if (ghostUid.status === "rejected") assert.equal(ghostUid.code, "unknown_uid");
});

test("applyAction mints uid/newUid, anchors manual keys and stores the donor op shape", () => {
  const gen = seqUid();
  const created = mustApply(emptyEdits(), "entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, "k-1", gen);
  assert.equal(created.uid, "u00000001", "注入序列铸造 uid");
  assert.equal(created.edits.uids[`manual:${created.uid}`], created.uid, "manual:<uid> 锚进 uids");
  assert.deepEqual(
    { ...created.op, props: undefined },
    { op: "entity.create", at: FIXED_AT, by: "workbench", key: "k-1", uid: "u00000001", type: "customer", props: undefined },
    "op = {op, ...payload, at, by, key}（照 donor Object.assign 形状）",
  );
  assert.deepEqual(created.op.props, { name: "甲科技（合成）" });
  const noKey = mustApply(created.edits, "entity.create", { type: "customer", props: { name: "乙股份（合成）" } }, null, gen);
  assert.equal(noKey.op.key, null, "缺省 key 落 null");
  // split 缺 newUid 时铸造
  const merged = mustApply(noKey.edits, "entity.merge", { uid: "u00000001", fromUid: "u00000002" }, "k-m", gen);
  const split = mustApply(merged.edits, "entity.split", { uid: "u00000001", absorbedKeys: ["manual:u00000002"] }, "k-s", gen);
  assert.equal(split.op.newUid, "u00000003", "split 的 newUid 由动作层铸造（replay 保持确定性）");
  assert.equal(split.uid, "u00000001", "返回 uid 照 donor：op.uid || payload.uid");
});

// ---------------------------------------------------------------------------
// 5. replay（操作日志 → 生效图；冲突只报告不修改）
// ---------------------------------------------------------------------------

test("replay of empty edits yields an honest empty graph", () => {
  const rep = replay(emptyEdits());
  assert.deepEqual(rep.effective.objects, {});
  assert.deepEqual(rep.effective.links, []);
  assert.deepEqual(rep.effective.stats, { objects: {}, links: {}, basis: {} });
  assert.equal(rep.applied, 0);
  assert.deepEqual(rep.conflicts, []);
});

test("replay materializes created entities and props cannot hijack identity", () => {
  const gen = seqUid();
  const created = mustApply(emptyEdits(), "entity.create", {
    type: "customer",
    props: { name: "甲科技（合成）", ecid: "E1", id: "hack", uid: "uhackuid", type: "person", manual: false },
  }, "k-1", gen);
  const rep = replay(created.edits);
  const id = `manual:${created.uid}`;
  const obj = rep.effective.objects[id];
  assert.ok(obj);
  assert.equal(obj.id, id, "props.id 不能劫持实体 id");
  assert.equal(obj.uid, created.uid, "props.uid 不能劫持锚定 uid");
  assert.equal(obj.type, "customer", "props.type 不能劫持动作 type");
  assert.equal(obj.manual, true);
  assert.deepEqual(obj.sources, ["overlay"]);
  assert.equal(obj.name, "甲科技（合成）");
  assert.equal(obj.ecid, "E1");
  assert.equal(rep.applied, 1);
  assert.equal(rep.effective.stats.objects.customer, 1);
  assert.equal(rep.edits.uids[id], created.uid, "富化 edits 带 manual 锚");
});

test("replay applies rename/setProp/retag with aliases and curated marks", () => {
  const gen = seqUid();
  let edits = emptyEdits();
  const created = mustApply(edits, "entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, "k-1", gen);
  edits = created.edits;
  const uid = created.uid as string;
  edits = mustApply(edits, "entity.rename", { uid, name: "甲科技集团（合成）" }, "k-2", gen).edits;
  edits = mustApply(edits, "entity.setProp", { uid, props: { ecid: "E9" } }, "k-3", gen).edits;
  edits = mustApply(edits, "entity.retag", { uid, type: "org" }, "k-4", gen).edits;
  const rep = replay(edits);
  const obj = rep.effective.objects[`manual:${uid}`];
  assert.ok(obj);
  assert.equal(obj.name, "甲科技集团（合成）");
  assert.deepEqual(obj.aliases, ["甲科技（合成）"], "旧名进别名（照 donor）");
  assert.equal(obj.ecid, "E9");
  assert.equal(obj.type, "org");
  assert.equal(obj.curated, true);
  assert.equal(rep.applied, 4);
  assert.deepEqual(rep.conflicts, []);
});

test("replay archive removes the entity plus touching links, later ops conflict honestly", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  edits = mustApply(edits, "link.assert", { fromUid: seed.uidP, toUid: seed.uidA, type: "manages" }, "k-l", gen).edits;
  edits = mustApply(edits, "entity.archive", { uid: seed.uidA }, "k-arch", gen).edits;
  edits = mustApply(edits, "entity.rename", { uid: seed.uidA, name: "改名幽灵" }, "k-post", gen).edits;
  const rep = replay(edits);
  assert.equal(rep.effective.objects[`manual:${seed.uidA}`], undefined, "归档实体从生效图消失");
  assert.deepEqual(rep.effective.links, [], "触到归档实体的链接一并撤销");
  assert.equal(rep.effective.stats.objects.customer, 1, "只剩乙股份");
  assert.equal(rep.conflicts.length, 1);
  assert.equal(rep.conflicts[0]?.op, "entity.rename");
  assert.match(rep.conflicts[0]?.note ?? "", /无活对象/);
});

test("replay link.assert requires registered types, dedupes triples and defaults basis", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  // 未注册类型在动作层就会被拦（见 validateAction 测试）；replay 的冲突面向手工日志
  const handcrafted: OntologyEdits = {
    v: 1,
    uids: edits.uids,
    ops: [
      ...edits.ops,
      { op: "link.assert", fromUid: seed.uidP, toUid: seed.uidA, type: "ghostLink", at: FIXED_AT, by: "workbench", key: null },
    ],
  };
  edits = mustApply(handcrafted, "link.assert", { fromUid: seed.uidP, toUid: seed.uidA, type: "manages" }, "k-1", gen).edits;
  edits = mustApply(edits, "link.assert", { fromUid: seed.uidP, toUid: seed.uidA, type: "manages", basis: "confirmed" }, "k-2", gen).edits;
  const rep = replay(edits);
  assert.equal(rep.effective.links.length, 1, "同三元组去重");
  assert.deepEqual(
    { ...rep.effective.links[0], from: undefined, to: undefined },
    { type: "manages", basis: "confirmed", source: "overlay", from: undefined, to: undefined },
  );
  assert.equal(rep.effective.links[0]?.from, `manual:${seed.uidP}`);
  assert.equal(rep.effective.links[0]?.to, `manual:${seed.uidA}`);
  assert.equal(rep.conflicts.length, 1);
  assert.match(rep.conflicts[0]?.note ?? "", /未注册链接类型/);
});

test("replay link.retract removes the matching triple else reports a conflict", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  edits = mustApply(edits, "link.assert", { fromUid: seed.uidP, toUid: seed.uidA, type: "manages" }, "k-1", gen).edits;
  edits = mustApply(edits, "link.retract", { fromUid: seed.uidP, toUid: seed.uidA, type: "manages" }, "k-2", gen).edits;
  edits = mustApply(edits, "link.retract", { fromUid: seed.uidP, toUid: seed.uidB, type: "manages" }, "k-3", gen).edits;
  const rep = replay(edits);
  assert.deepEqual(rep.effective.links, []);
  assert.equal(rep.conflicts.length, 1);
  assert.match(rep.conflicts[0]?.note ?? "", /无匹配链接可撤销/);
});

test("replay merge folds the absorbed entity into the survivor and enriches the op", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  // 张三 manages 乙股份：验证 merge 后链接改挂 + 端点来源可追溯
  edits = mustApply(edits, "link.assert", { fromUid: seed.uidP, toUid: seed.uidB, type: "manages" }, "k-l", gen).edits;
  edits = mustApply(edits, "entity.merge", { uid: seed.uidA, fromUid: seed.uidB }, "k-m", gen).edits;
  const rep = replay(edits);
  const survivor = rep.effective.objects[`manual:${seed.uidA}`];
  assert.ok(survivor);
  assert.equal(survivor.name, "甲科技（合成）", "存方保名");
  assert.ok((survivor.aliases ?? []).includes("乙股份（合成）"), "被并方名称进别名");
  assert.equal(survivor.cid, "C2", "存方缺失字段从被并方补齐（照 donor）");
  assert.equal(survivor.ecid, "E1", "存方已有字段不被覆盖");
  assert.equal(survivor.curated, true);
  assert.equal(rep.effective.objects[`manual:${seed.uidB}`], undefined, "被并方消失");
  assert.equal(rep.effective.stats.objects.customer, 1, "合并后 customer 只剩存方 1 个");
  assert.equal(rep.effective.stats.objects.person, 1);
  assert.equal(rep.effective.links.length, 1);
  assert.equal(rep.effective.links[0]?.to, `manual:${seed.uidA}`, "链接改挂存方");
  assert.equal(rep.effective.links[0]?.originTo, `manual:${seed.uidB}`, "记录被吸收端点供 split 追溯");
  // uids 重指：被并方全部锚键重指存方 uid（照 donor）
  assert.equal(rep.edits.uids[`manual:${seed.uidB}`], seed.uidA);
  // op 富化：absorbedKeys / absorbedNames / absorbedSnapshot
  const mergeOp = rep.edits.ops.find((o) => o.op === "entity.merge");
  assert.ok(mergeOp);
  assert.deepEqual(mergeOp.absorbedKeys, [`manual:${seed.uidB}`]);
  assert.ok((mergeOp.absorbedNames as string[]).includes("乙股份（合成）"));
  assert.equal((mergeOp.absorbedSnapshot as { name?: string })?.name, "乙股份（合成）");
  assert.deepEqual(rep.conflicts, []);
});

test("replay merge conflicts: same entity or dead counterpart", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  // 手工日志绕过校验层，直接给 replay 喂同实体 merge 与幽灵 fromUid
  const handcrafted: OntologyEdits = {
    v: 1,
    uids: seed.edits.uids,
    ops: [
      ...seed.edits.ops,
      { op: "entity.merge", uid: seed.uidA, fromUid: seed.uidA, at: FIXED_AT, by: "workbench", key: null },
      { op: "entity.merge", uid: seed.uidA, fromUid: "u0gone00", at: FIXED_AT, by: "workbench", key: null },
    ],
  };
  const rep = replay(handcrafted);
  assert.equal(rep.conflicts.length, 2);
  assert.match(rep.conflicts[0]?.note ?? "", /同一实体/);
  assert.match(rep.conflicts[1]?.note ?? "", /无活对象/);
  assert.ok(rep.effective.objects[`manual:${seed.uidA}`], "冲突只报告，不破坏生效图");
});

test("replay split restores the absorbed entity and re-attaches its links", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  edits = mustApply(edits, "link.assert", { fromUid: seed.uidP, toUid: seed.uidB, type: "manages" }, "k-l", gen).edits;
  edits = mustApply(edits, "entity.merge", { uid: seed.uidA, fromUid: seed.uidB }, "k-m", gen).edits;
  const split = mustApply(edits, "entity.split", { uid: seed.uidA, absorbedKeys: [`manual:${seed.uidB}`] }, "k-s", gen);
  const rep = replay(split.edits);
  const newId = `manual:${split.op.newUid}`;
  const restored = rep.effective.objects[newId];
  assert.ok(restored, "拆出的新实体存在");
  assert.equal(restored.name, "乙股份（合成）", "从 merge 快照恢复");
  assert.equal(restored.type, "customer");
  assert.equal(restored.manual, true);
  assert.equal(restored.splitFrom, seed.uidA);
  assert.ok((restored.sources ?? []).includes("overlay"));
  assert.equal(rep.effective.objects[`manual:${seed.uidA}`]?.cid, "C2", "字段合并不回滚（照 donor：split 只拆实体不拆字段）");
  assert.equal(rep.edits.uids[newId], split.op.newUid, "新实体锚进 uids");
  assert.equal(rep.edits.uids[`manual:${seed.uidB}`], split.op.newUid, "被拆键重指新 uid（照 donor）");
  // 由被并键产生的链接改挂新实体（originTo 命中）
  const link = rep.effective.links[0];
  assert.ok(link);
  assert.equal(link.to, newId, "链接改挂拆出实体");
  assert.equal(link.originTo, undefined, "改挂后清除 origin 标记");
  assert.deepEqual(rep.conflicts, []);
});

test("replay split without a merge record conflicts honestly", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  const split = mustApply(seed.edits, "entity.split", { uid: seed.uidA, absorbedKeys: ["manual:u0never0"] }, "k-s", gen);
  const rep = replay(split.edits);
  assert.equal(rep.conflicts.length, 1);
  assert.equal(rep.conflicts[0]?.op, "entity.split");
  assert.match(rep.conflicts[0]?.note ?? "", /吸收记录/);
});

test("replay honors personal schema added through schema.* ops", () => {
  const gen = seqUid();
  let edits = emptyEdits();
  edits = mustApply(edits, "schema.addType", { id: "vendor", type: { label: "供应商" } }, "k-t", gen).edits;
  edits = mustApply(edits, "schema.addLink", { id: "supplies", link: { label: "供货", from: "vendor", to: "customer" } }, "k-l", gen).edits;
  const vendor = mustApply(edits, "entity.create", { type: "vendor", props: { name: "丙实验室（合成）" } }, "k-v", gen);
  edits = vendor.edits;
  const cust = mustApply(edits, "entity.create", { type: "customer", props: { name: "甲科技（合成）" } }, "k-c", gen);
  edits = cust.edits;
  edits = mustApply(edits, "link.assert", { fromUid: vendor.uid, toUid: cust.uid, type: "supplies" }, "k-a", gen).edits;
  const rep = replay(edits);
  assert.equal(rep.effective.stats.objects.vendor, 1, "个人类型实体可落图");
  assert.equal(rep.effective.links.length, 1);
  assert.equal(rep.effective.links[0]?.type, "supplies");
  assert.deepEqual(rep.conflicts, []);
});

test("replay is deterministic and never mutates its input", () => {
  const gen = seqUid();
  const seed = seedThree(gen);
  let edits = seed.edits;
  edits = mustApply(edits, "entity.merge", { uid: seed.uidA, fromUid: seed.uidB }, "k-m", gen).edits;
  edits = mustApply(edits, "entity.split", { uid: seed.uidA, absorbedKeys: [`manual:${seed.uidB}`] }, "k-s", gen).edits;
  const frozenCopy = JSON.parse(JSON.stringify(edits));
  const first = replay(edits);
  const second = replay(edits);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)), "同输入两次 replay 全等");
  assert.deepEqual(JSON.parse(JSON.stringify(edits)), frozenCopy, "入参 edits 一字节未动（含 ops 富化不回写）");
});

test("replay reports unknown op kinds as conflicts", () => {
  const handcrafted: OntologyEdits = {
    v: 1, uids: {},
    ops: [{ op: "entity.teleport", uid: "u00000001", at: FIXED_AT, by: "workbench", key: null }],
  };
  const rep = replay(handcrafted);
  assert.equal(rep.conflicts.length, 1);
  assert.match(rep.conflicts[0]?.note ?? "", /未知操作类型/);
  assert.equal(rep.applied, 0);
});

// ---------------------------------------------------------------------------
// 6. checkConstraints（约束跑批：只报告不修改）
// ---------------------------------------------------------------------------

function graphOf(objects: Record<string, Record<string, unknown>>, links: Array<Record<string, unknown>> = []): EffectiveGraph {
  return {
    objects: objects as unknown as EffectiveGraph["objects"],
    links: links as unknown as EffectiveGraph["links"],
    stats: { objects: {}, links: {}, basis: {} },
  };
}

test("checkConstraints ports the donor operators plus builtin hard rules", () => {
  const schema = sharedSchemaSnapshot();
  const graph = graphOf(
    {
      "manual:u00000001": { id: "manual:u00000001", type: "person", role: "me" }, // 缺 name → person-name
      "manual:u00000002": { id: "manual:u00000002", type: "person", role: "me", name: "张三（合成）" }, // me-single 超限
      "manual:u00000003": { id: "manual:u00000003", type: "customer", name: "甲科技（合成）" }, // 缺 ecid/cid → customer-key
      "manual:u00000004": { id: "manual:u00000004", type: "ghostType", name: "幽灵" }, // builtin:object-type
    },
    [
      { type: "collaborates", from: "manual:u00000002", to: "manual:u00000002", basis: "fact", source: "test" }, // forbidSelf
      { type: "manages", from: "manual:u00000002", to: "manual:u00000001", basis: "fact", source: "test" }, // person→person ≠ person→customer → builtin:link-endpoint-type
      { type: "ghostLink", from: "manual:u00000002", to: "manual:u00000003", basis: "fact", source: "test" }, // builtin:link-type
      { type: "manages", from: "manual:u00000002", to: "manual:u00000099", basis: "fact", source: "test" }, // builtin:link-endpoint（端点缺失）
    ],
  );
  const violations = checkConstraints(graph, schema);
  const rules = violations.map((v) => v.rule);
  for (const expected of [
    "person-name", "customer-key", "me-single", "no-self-link",
    "builtin:object-type", "builtin:link-type", "builtin:link-endpoint", "builtin:link-endpoint-type",
  ]) {
    assert.ok(rules.includes(expected), `应报告 ${expected}，实际：${rules.join(",")}`);
  }
  assert.ok(violations.every((v) => v.scope === "object" || v.scope === "link"));
  assert.ok(violations.every((v) => typeof v.note === "string" && v.note.length > 0));
});

test("checkConstraints enum/typeOf/requireAny operators and personal rules", () => {
  const schema = mergePersonal({
    objectTypes: {}, linkTypes: {},
    constraints: [{ id: "group-platform-extra", when: { type: "group" }, enum: { platform: ["dingtalk"] } }],
  });
  const graph = graphOf({
    "g1": { id: "g1", type: "group", name: "合成群", platform: "feishu" },
  });
  const notes = checkConstraints(graph, schema).map((v) => `${v.rule}:${v.note}`);
  assert.ok(notes.some((n) => n.startsWith("group-platform:")), "共享 enum 规则命中");
  assert.ok(notes.some((n) => n.startsWith("group-platform-extra:")), "个人 enum 规则命中");
});

// ---------------------------------------------------------------------------
// 7. 派生图视图 + 布局 + parseEditsDoc + newUid + tailAudit
// ---------------------------------------------------------------------------

test("deriveGraphView projects nodes/links with whitelisted fields", () => {
  const gen = seqUid();
  let edits = emptyEdits();
  const a = mustApply(edits, "entity.create", {
    type: "customer",
    props: { name: "甲科技（合成）", ecid: "E1", tags: ["合成", 42, null], nested: { deep: true }, count: 3, flag: true, id: "hack" },
  }, "k-a", gen);
  edits = a.edits;
  const p = mustApply(edits, "entity.create", { type: "person", props: { name: "张三（合成）" } }, "k-p", gen);
  edits = p.edits;
  edits = mustApply(edits, "link.assert", { fromUid: p.uid, toUid: a.uid, type: "manages", basis: "confirmed" }, "k-l", gen).edits;
  const view = rebuildGraphView(edits, FIXED_AT);
  assert.equal(view.nodes.length, 2);
  const nodeA = view.nodes.find((n) => n.uid === a.uid);
  assert.ok(nodeA);
  assert.equal(nodeA.name, "甲科技（合成）");
  assert.equal(nodeA.type, "customer");
  assert.deepEqual(nodeA.tags, ["合成"], "tags 只留字符串项");
  assert.deepEqual(nodeA.props, { ecid: "E1", count: 3, flag: true }, "props 只留原始值，剥内部键（id/nested 不进）");
  assert.equal(nodeA.manual, true);
  assert.equal(view.links.length, 1);
  assert.deepEqual(view.links[0], {
    type: "manages",
    from: `manual:${p.uid}`,
    to: `manual:${a.uid}`,
    fromUid: p.uid,
    toUid: a.uid,
    basis: "confirmed",
    source: "overlay",
  });
  assert.equal(view.opsCount, 3);
  assert.equal(view.lastOpAt, FIXED_AT);
  assert.equal(view.generatedAt, FIXED_AT);
  assert.equal(view.stats.objects.customer, 1);
  // deriveGraphView 独立调用（动作后重建 graph.json 的路径）
  const rep = replay(edits);
  const direct = deriveGraphView(rep.effective, { generatedAt: FIXED_AT, opsCount: 3, lastOpAt: FIXED_AT });
  assert.deepEqual(direct.nodes, view.nodes);
});

test("layoutOntologyGraph arranges type columns as a deterministic grid", () => {
  const node = (id: string, type: string): GraphNode => ({
    id, uid: id, type, name: id, tags: [], aliases: [], props: {}, manual: true, curated: false,
  });
  const nodes = [node("c1", "customer"), node("p1", "person"), node("c2", "customer")];
  const layout = layoutOntologyGraph(nodes);
  assert.deepEqual(layout.columns.map((c) => c.type), ["customer", "person"], "列序 = type 首次出现序");
  assert.deepEqual(layout.columns.map((c) => c.count), [2, 1]);
  const pos = Object.fromEntries(layout.positions.map((p) => [p.id, p]));
  assert.equal(pos.c1?.columnIndex, 0);
  assert.equal(pos.c2?.columnIndex, 0);
  assert.equal(pos.p1?.columnIndex, 1);
  assert.equal(pos.c1?.y, pos.p1?.y, "各列首行同高");
  assert.ok((pos.c2?.y ?? 0) > (pos.c1?.y ?? 0), "同列纵向排布");
  assert.ok((pos.p1?.x ?? 0) > (pos.c1?.x ?? 0), "列间横向排布");
  assert.equal(layout.width, 24 * 2 + 2 * 180, "缺省参数下的画布宽");
  assert.equal(layout.height, 40 * 2 + 2 * 64, "缺省参数下的画布高（按最高列）");
  // 两次布局全等（确定性）+ 自定义参数生效
  assert.deepEqual(layoutOntologyGraph(nodes), layout);
  const custom = layoutOntologyGraph(nodes, { columnWidth: 100, rowHeight: 50, paddingX: 0, paddingY: 0 });
  assert.equal(custom.width, 200);
  assert.equal(custom.positions[1]?.x, 100 + (100 - custom.nodeWidth) / 2);
  // 空图
  const empty = layoutOntologyGraph([]);
  assert.deepEqual(empty.columns, []);
  assert.deepEqual(empty.positions, []);
  assert.equal(empty.width, 48);
});

test("parseEditsDoc normalizes valid docs and rejects corrupt shapes with null", () => {
  const valid = parseEditsDoc({
    v: 1,
    uids: { "manual:u00000001": "u00000001" },
    ops: [{ op: "entity.archive", uid: "u00000001", extra: 1 }],
  });
  assert.ok(valid);
  assert.deepEqual(valid.ops[0], { op: "entity.archive", uid: "u00000001", extra: 1, at: "", by: "", key: null });
  assert.equal(valid.v, 1);
  // 缺省字段宽容
  const minimal = parseEditsDoc({});
  assert.ok(minimal);
  assert.deepEqual(minimal.uids, {});
  assert.deepEqual(minimal.ops, []);
  // 损坏形态一律 null（调用方拒绝写路径，绝不静默清空）
  assert.equal(parseEditsDoc(null), null);
  assert.equal(parseEditsDoc("nope"), null);
  assert.equal(parseEditsDoc([]), null);
  assert.equal(parseEditsDoc({ ops: "not-an-array" }), null);
  assert.equal(parseEditsDoc({ uids: { a: 42 } }), null);
  assert.equal(parseEditsDoc({ ops: [{ noOpField: true }] }), null);
  assert.equal(parseEditsDoc({ ops: [{ op: "" }] }), null);
});

test("newUid matches the donor shape and stays unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const uid = newUid();
    assert.match(uid, /^u[0-9a-f]{8}$/);
    seen.add(uid);
  }
  assert.equal(seen.size, 500);
});

test("tailAudit takes the last N lines", () => {
  const lines: AuditLine[] = Array.from({ length: 25 }, (_, i) => ({
    at: FIXED_AT, by: "workbench", key: `k-${i + 1}`, action: "entity.create", ok: true,
  }));
  const tail = tailAudit(lines, 20);
  assert.equal(tail.length, 20);
  assert.equal(tail[0]?.key, "k-6");
  assert.equal(tail[19]?.key, "k-25");
  assert.deepEqual(tailAudit(lines, 0), []);
  assert.deepEqual(tailAudit([], 20), []);
});

test("emptyEdits and knownUidsOf expose the honest empty curation layer", () => {
  const edits = emptyEdits();
  assert.deepEqual(edits, { v: 1, uids: {}, ops: [] });
  assert.equal(knownUidsOf(edits).size, 0);
  const seeded = seedThree();
  assert.equal(knownUidsOf(seeded.edits).size, 3);
});
