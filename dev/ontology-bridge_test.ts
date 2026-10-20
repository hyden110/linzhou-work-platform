import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createOntologyBridge,
  DEFAULT_ONTOLOGY_DIR,
  ONTOLOGY_AUDIT_TAIL,
  ONTOLOGY_ROUTES,
  OntologyBridgeError,
  type OntologyBridge,
} from "./ontology-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：实体只用「甲科技（合成）/乙股份（合成）/丙实验室（合成）/张三（合成）」，
// 绝不含真实客户数据；存储一律落临时目录（.local-cache 零接触）。
// 时钟与 uid 全部注入（FIXED_NOW + 序列 uid），零随机、可复算。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T03:00:00.000Z");
const FIXED_AT = "2026-10-20T03:00:00.000Z";

function seqUid(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `u${n.toString(16).padStart(8, "0")}`;
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ontology-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeBridge(dir: string, gen: () => string = seqUid(), extra: Record<string, unknown> = {}): OntologyBridge {
  return createOntologyBridge({ dir, now: () => FIXED_NOW, newUid: gen, ...extra });
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

async function readBytes(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function auditLines(dir: string): Promise<Json[]> {
  try {
    const raw = await readBytes(join(dir, "audit.jsonl"));
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Json);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { host: "127.0.0.1:8000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://127.0.0.1:8000${path}`, init);
}

async function routedJson(response: Response): Promise<Json> {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as Json;
}

function createPayload(name: string, type = "customer"): Json {
  return { type, props: { name } };
}

/** 走桥公开 action() 造一个实体，返回响应（默认 uid 由注入序列铸造）。 */
async function createEntity(
  bridge: OntologyBridge,
  name: string,
  key: string | null,
  type = "customer",
): Promise<Json> {
  const body: Json = { action: "entity.create", payload: createPayload(name, type) };
  if (key !== null) body.key = key;
  return (await bridge.action(body)) as Json;
}

async function expectBridgeError(
  run: () => Promise<unknown>,
  code: string,
): Promise<OntologyBridgeError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof OntologyBridgeError, `应为 OntologyBridgeError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.name, "OntologyBridgeError");
    return error;
  }
  assert.fail(`预期抛出 ${code}，实际成功返回`);
}

// ---------------------------------------------------------------------------
// 1. 路由表与默认目录（接线契约）
// ---------------------------------------------------------------------------

test("ONTOLOGY_ROUTES matches the task contract and the default dir lives under .local-cache", () => {
  assert.deepEqual(
    ONTOLOGY_ROUTES.map((r) => ({ ...r })),
    [
      { method: "GET", path: "/local/ontology", operation: "state" },
      { method: "GET", path: "/local/ontology/graph", operation: "graph" },
      { method: "POST", path: "/local/ontology/action", operation: "action" },
    ],
  );
  assert.equal(ONTOLOGY_AUDIT_TAIL, 20);
  assert.ok(
    DEFAULT_ONTOLOGY_DIR.endsWith(join(".local-cache", "ontology")),
    `默认目录应落在项目根 .local-cache/ontology，实际 ${DEFAULT_ONTOLOGY_DIR}`,
  );
  assert.ok(!DEFAULT_ONTOLOGY_DIR.includes(`${join("dev", "ontology")}`), "默认目录不得误挂在 dev/ 下");
});

// ---------------------------------------------------------------------------
// 2. 空策展层：读侧诚实且零副作用
// ---------------------------------------------------------------------------

test("fresh state is an honest empty curation layer and reads create no files", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const state = await bridge.state();
    assert.equal(state.v, 1);
    assert.equal(state.opsCount, 0);
    assert.equal(state.uidsCount, 0);
    assert.equal(state.applied, 0);
    assert.deepEqual(state.ops, []);
    assert.deepEqual(state.audit, []);
    assert.deepEqual(state.conflicts, []);
    assert.deepEqual(state.violations, []);
    assert.deepEqual(state.stats, { objects: {}, links: {}, basis: {} });
    assert.equal(Object.keys(state.schema.objectTypes).length, 7, "共享注册表 7 类对象");
    assert.equal(Object.keys(state.schema.linkTypes).length, 10, "共享注册表 10 类链接");

    const graph = await bridge.graph();
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.links, []);
    assert.equal(graph.opsCount, 0);
    assert.equal(graph.generatedAt, FIXED_AT, "注入时钟决定 generatedAt");

    assert.deepEqual(await readdir(dir), [], "GET 读侧不得创建任何文件");
  });
});

// ---------------------------------------------------------------------------
// 3. 写路径：三文件落账 + 原子写 + 权限
// ---------------------------------------------------------------------------

test("a successful create lands edits/audit/graph with 0600 files, 0700 dir and no tmp residue", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const res = await createEntity(bridge, "甲科技（合成）", "k-1");
    assert.equal(res.deduped, false);
    assert.equal(res.uid, "u00000001", "注入序列铸造 uid");
    assert.equal(res.at, FIXED_AT);
    assert.equal(res.ops, 1);
    assert.deepEqual(res.stats, { objects: { customer: 1 }, links: {}, basis: {} });

    const edits = await readJson(join(dir, "edits.json"));
    assert.equal(edits.v, 1);
    assert.deepEqual(edits.uids, { "manual:u00000001": "u00000001" });
    assert.deepEqual(edits.ops, [
      {
        op: "entity.create",
        type: "customer",
        props: { name: "甲科技（合成）" },
        uid: "u00000001",
        at: FIXED_AT,
        by: "workbench",
        key: "k-1",
      },
    ]);

    const audit = await auditLines(dir);
    assert.deepEqual(audit, [{ at: FIXED_AT, by: "workbench", key: "k-1", action: "entity.create", ok: true }]);

    const graph = await readJson(join(dir, "graph.json"));
    assert.equal(graph.opsCount, 1);
    assert.equal(graph.lastOpAt, FIXED_AT);
    assert.equal((graph.nodes as Json[]).length, 1);
    assert.equal((graph.nodes as Json[])[0]?.name, "甲科技（合成）");

    assert.equal((await stat(dir)).mode & 0o777, 0o700, "目录 0700");
    for (const file of ["edits.json", "audit.jsonl", "graph.json"]) {
      assert.equal(await fileMode(join(dir, file)), 0o600, `${file} 0600`);
    }
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "原子写不得残留 tmp 文件");
  });
});

// ---------------------------------------------------------------------------
// 4. 幂等键去重（同 key 不重复执行、不重复审计、字节稳定）
// ---------------------------------------------------------------------------

test("replaying the same idempotency key returns deduped and changes no bytes", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await createEntity(bridge, "甲科技（合成）", "k-1");
    const editsBefore = await readBytes(join(dir, "edits.json"));
    const auditBefore = await readBytes(join(dir, "audit.jsonl"));
    const graphBefore = await readBytes(join(dir, "graph.json"));

    const dup = (await bridge.action({
      action: "entity.create",
      payload: createPayload("乙股份（合成）"),
      key: "k-1",
    })) as Json;
    assert.deepEqual(dup, { deduped: true, key: "k-1", at: FIXED_AT }, "命中幂等键返回首次落账时间");

    assert.equal(await readBytes(join(dir, "edits.json")), editsBefore, "edits.json 一字节未动");
    assert.equal(await readBytes(join(dir, "audit.jsonl")), auditBefore, "去重不重复审计");
    assert.equal(await readBytes(join(dir, "graph.json")), graphBefore, "graph.json 一字节未动");
  });
});

// ---------------------------------------------------------------------------
// 5. 校验失败：错误码 + 审计留痕 ok:false + 不落 op
// ---------------------------------------------------------------------------

test("validation failures throw typed errors, audit ok:false and never append ops", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const created = await createEntity(bridge, "甲科技（合成）", "k-1");
    const editsBefore = await readBytes(join(dir, "edits.json"));
    const graphBefore = await readBytes(join(dir, "graph.json"));

    // rename 缺 name → invalid_payload
    const invalid = await expectBridgeError(
      () => bridge.action({ action: "entity.rename", payload: { uid: created.uid }, key: "k-bad1" }),
      "ontology_invalid_payload",
    );
    assert.ok(invalid.message.length > 0, "错误必须带可展示中文文案");

    // 幽灵 uid → unknown_uid
    await expectBridgeError(
      () => bridge.action({ action: "entity.rename", payload: { uid: "udeadbeef", name: "改名幽灵" }, key: "k-bad2" }),
      "ontology_unknown_uid",
    );

    assert.equal(await readBytes(join(dir, "edits.json")), editsBefore, "校验失败不落 op");
    assert.equal(await readBytes(join(dir, "graph.json")), graphBefore, "校验失败不重建图");

    const audit = await auditLines(dir);
    assert.equal(audit.length, 3, "成功 1 行 + 校验失败 2 行（留痕 ok:false）");
    assert.deepEqual(audit[1], { at: FIXED_AT, by: "workbench", key: "k-bad1", action: "entity.rename", ok: false });
    assert.deepEqual(audit[2], { at: FIXED_AT, by: "workbench", key: "k-bad2", action: "entity.rename", ok: false });
  });
});

test("unknown actions are rejected at the request layer without audit noise", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await expectBridgeError(
      () => bridge.action({ action: "entity.destroy", payload: {} }),
      "ontology_unknown_action",
    );
    assert.deepEqual(await auditLines(dir), [], "未知动作未进入执行层，不留审计");
  });
});

// ---------------------------------------------------------------------------
// 6. 破坏性动作 confirm 闸门（先于幂等去重）
// ---------------------------------------------------------------------------

test("destructive actions demand confirm === target uid and the gate runs before dedupe", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    const a = await createEntity(bridge, "甲科技（合成）", "k-1");
    const b = await createEntity(bridge, "乙股份（合成）", "k-2");
    const uidA = a.uid as string;
    const uidB = b.uid as string;
    const editsBefore = await readBytes(join(dir, "edits.json"));

    // archive：缺 confirm / 错 confirm 都拒绝，且不留审计
    await expectBridgeError(
      () => bridge.action({ action: "entity.archive", payload: { uid: uidA }, key: "k-arch" }),
      "ontology_confirm_required",
    );
    await expectBridgeError(
      () => bridge.action({ action: "entity.archive", payload: { uid: uidA }, key: "k-arch", confirm: "u0wrong0" }),
      "ontology_confirm_required",
    );
    // 闸门先于去重：即便 key 已被用过，confirm 不对也必须报 confirm 而不是 deduped
    await expectBridgeError(
      () => bridge.action({ action: "entity.archive", payload: { uid: uidA }, key: "k-1", confirm: "u0wrong0" }),
      "ontology_confirm_required",
    );
    assert.equal(await readBytes(join(dir, "edits.json")), editsBefore, "confirm 拒绝不落 op");
    assert.equal((await auditLines(dir)).length, 2, "confirm 拒绝不留审计（未进入执行）");

    // 正确 confirm → 放行
    const archived = (await bridge.action({
      action: "entity.archive",
      payload: { uid: uidB },
      key: "k-arch",
      confirm: uidB,
    })) as Json;
    assert.equal(archived.deduped, false);

    // merge 同样要 confirm === 存方 uid
    await expectBridgeError(
      () => bridge.action({ action: "entity.merge", payload: { uid: uidA, fromUid: uidB } }),
      "ontology_confirm_required",
    );
    // split 同样要 confirm === payload.uid
    await expectBridgeError(
      () => bridge.action({ action: "entity.split", payload: { uid: uidA, absorbedKeys: [] } }),
      "ontology_confirm_required",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. edits.json 损坏：读写两侧如实报错，绝不静默清空
// ---------------------------------------------------------------------------

test("corrupt edits.json is reported as ontology_edits_corrupt everywhere and never cleared", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    for (const corrupt of ["not json{{{", JSON.stringify({ v: 1, uids: {}, ops: "nope" })]) {
      const file = join(dir, "edits.json");
      await writeFile(file, corrupt, { mode: 0o600 });

      await expectBridgeError(() => bridge.state(), "ontology_edits_corrupt");
      await expectBridgeError(() => bridge.graph(), "ontology_edits_corrupt");
      await expectBridgeError(
        () => bridge.action({ action: "entity.create", payload: createPayload("甲科技（合成）") }),
        "ontology_edits_corrupt",
      );
      assert.equal(await readBytes(file), corrupt, "损坏文件原样保留，绝不静默清空");

      const response = await bridge.handle(req("GET", "/local/ontology"));
      assert.ok(response);
      assert.equal(response.status, 409, "损坏映射 409");
      const body = await routedJson(response);
      assert.equal(body.ok, false);
      assert.equal((body.error as Json).code, "ontology_edits_corrupt");
      assert.ok(!(JSON.stringify(body) as string).includes(dir), "错误响应不得泄露绝对路径");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. I/O 故障分层：目录不可用 → ontology_unavailable（502）
// ---------------------------------------------------------------------------

test("unusable storage surfaces as ontology_unavailable and maps to 502", async () => {
  await withTempDir(async (dir) => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "占位文件（合成）");
    const bridge = makeBridge(join(blocker, "ontology"), seqUid());
    await expectBridgeError(() => bridge.state(), "ontology_unavailable");
    const response = await bridge.handle(req("GET", "/local/ontology"));
    assert.ok(response);
    assert.equal(response.status, 502);
    const body = await routedJson(response);
    assert.equal((body.error as Json).code, "ontology_unavailable");
  });
});

// ---------------------------------------------------------------------------
// 9. handle() 子路由：命中/未命中/方法不匹配/body 校验
// ---------------------------------------------------------------------------

test("handle routes the three contracted endpoints with ok/data envelopes", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);

    const stateRes = await bridge.handle(req("GET", "/local/ontology"));
    assert.ok(stateRes);
    assert.equal(stateRes.status, 200);
    const stateBody = await routedJson(stateRes);
    assert.equal(stateBody.ok, true);
    assert.equal((stateBody.data as Json).v, 1);

    // 尾斜杠与查询串都要归一到同一路由
    const slashRes = await bridge.handle(req("GET", "/local/ontology/?fresh=1"));
    assert.ok(slashRes, "尾斜杠 + 查询串仍命中 state 路由");
    assert.equal(slashRes.status, 200);

    const graphRes = await bridge.handle(req("GET", "/local/ontology/graph"));
    assert.ok(graphRes);
    assert.equal(graphRes.status, 200);
    const graphBody = await routedJson(graphRes);
    assert.deepEqual((graphBody.data as Json).nodes, []);

    const actionRes = await bridge.handle(
      req("POST", "/local/ontology/action", {
        action: "entity.create",
        payload: createPayload("甲科技（合成）"),
        key: "k-http",
      }),
    );
    assert.ok(actionRes);
    assert.equal(actionRes.status, 200);
    const actionBody = await routedJson(actionRes);
    assert.equal((actionBody.data as Json).deduped, false);
    assert.equal((actionBody.data as Json).uid, "u00000001");

    assert.equal(await bridge.handle(req("GET", "/local/notify")), undefined, "非本体路径返回 undefined 交主路由");
    assert.equal(await bridge.handle(req("GET", "/local/ontology-graph")), undefined, "前缀相似但未登记的路径不劫持");
  });
});

test("handle rejects wrong methods with 405 and bad bodies with 400", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);

    for (const [method, path] of [
      ["POST", "/local/ontology"],
      ["GET", "/local/ontology/action"],
      ["DELETE", "/local/ontology/graph"],
    ] as const) {
      const res = await bridge.handle(req(method, path));
      assert.ok(res);
      assert.equal(res.status, 405, `${method} ${path} 应 405`);
      const body = await routedJson(res);
      assert.equal((body.error as Json).code, "method_not_allowed");
    }

    for (const raw of ["not json", "[1,2]", "{}", '{"action":42}']) {
      const res = await bridge.handle(req("POST", "/local/ontology/action", raw));
      assert.ok(res);
      assert.equal(res.status, 400, `body ${raw} 应 400`);
      const body = await routedJson(res);
      assert.equal((body.error as Json).code, "ontology_invalid_request");
    }

    const unknown = await bridge.handle(
      req("POST", "/local/ontology/action", { action: "entity.nope", payload: {} }),
    );
    assert.ok(unknown);
    assert.equal(unknown.status, 400);
    assert.equal(((await routedJson(unknown)).error as Json).code, "ontology_unknown_action");

    const huge = await bridge.handle(
      req("POST", "/local/ontology/action", {
        action: "entity.create",
        payload: { type: "customer", props: { name: "x".repeat(70 * 1024) } },
      }),
    );
    assert.ok(huge);
    assert.equal(huge.status, 400, "超过体积上限的请求体拒绝");
    assert.equal(((await routedJson(huge)).error as Json).code, "ontology_invalid_request");
  });
});

// ---------------------------------------------------------------------------
// 10. 审计尾 20 行
// ---------------------------------------------------------------------------

test("state serves the audit tail (last 20 of 25) and honors auditTailLimit", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    for (let i = 1; i <= 25; i += 1) {
      await createEntity(bridge, `合成实体 ${i}`, `k-${i}`);
    }
    const state = await bridge.state();
    assert.equal(state.audit.length, ONTOLOGY_AUDIT_TAIL, "审计尾固定 20 行");
    assert.equal(state.audit[0]?.key, "k-6", "尾 20 = 第 6..25 条");
    assert.equal(state.audit[19]?.key, "k-25");
    assert.equal(state.opsCount, 25);
    assert.equal((await auditLines(dir)).length, 25, "文件保留全量 append-only 审计");
    assert.ok(state.audit.every((l) => l.by === "workbench"), "审计行 by 一律 workbench");

    const limited = makeBridge(dir, seqUid(), { auditTailLimit: 5 });
    assert.equal((await limited.state()).audit.length, 5);
  });
});

// ---------------------------------------------------------------------------
// 11. graph.json 只是派生缓存：损坏/过期诚实重建，GET 零写入
// ---------------------------------------------------------------------------

test("graph reads rebuild honestly from the op log and never write", async () => {
  await withTempDir(async (dir) => {
    const bridge = makeBridge(dir);
    await createEntity(bridge, "甲科技（合成）", "k-1");
    const graphFile = join(dir, "graph.json");

    // 缓存损坏 → 从日志重建，且 GET 不落盘
    await writeFile(graphFile, "garbage{{{", { mode: 0o600 });
    const rebuilt = await bridge.graph();
    assert.equal(rebuilt.nodes.length, 1, "派生物可从真身（操作日志）随时重建");
    assert.equal(rebuilt.nodes[0]?.name, "甲科技（合成）");
    assert.equal(await readBytes(graphFile), "garbage{{{", "读侧不得写盘");

    // 指纹过期（opsCount 不符）→ 同样重建
    await writeFile(
      graphFile,
      JSON.stringify({ generatedAt: FIXED_AT, opsCount: 0, lastOpAt: "", nodes: [], links: [], stats: { objects: {}, links: {}, basis: {} } }),
      { mode: 0o600 },
    );
    const stale = await bridge.graph();
    assert.equal(stale.opsCount, 1);
    assert.equal(stale.nodes.length, 1);

    // 指纹新鲜 → 缓存原样返回（信任缓存契约）
    await writeFile(
      graphFile,
      JSON.stringify({ generatedAt: "2020-01-01T00:00:00.000Z", opsCount: 1, lastOpAt: FIXED_AT, nodes: [], links: [], stats: { objects: {}, links: {}, basis: {} } }),
      { mode: 0o600 },
    );
    const cached = await bridge.graph();
    assert.equal(cached.generatedAt, "2020-01-01T00:00:00.000Z", "新鲜缓存直接供给");
  });
});

// ---------------------------------------------------------------------------
// 12. 全生命周期：schema 扩展 → 建实体 → 断链 → 合并 → 拆分
// ---------------------------------------------------------------------------

test("full lifecycle through the bridge keeps conflicts and violations empty", async () => {
  await withTempDir(async (dir) => {
    const gen = seqUid();
    const bridge = makeBridge(dir, gen);
    await bridge.action({ action: "schema.addType", payload: { id: "vendor", type: { label: "供应商" } }, key: "k-t" });
    await bridge.action({
      action: "schema.addLink",
      payload: { id: "supplies", link: { label: "供货", from: "vendor", to: "customer" } },
      key: "k-l",
    });
    const vendor = await createEntity(bridge, "丙实验室（合成）", "k-v", "vendor");
    const cust = (await bridge.action({
      action: "entity.create",
      payload: { type: "customer", props: { name: "甲科技（合成）", ecid: "E1" } },
      key: "k-c",
    })) as Json;
    await bridge.action({
      action: "link.assert",
      payload: { fromUid: vendor.uid, toUid: cust.uid, type: "supplies", basis: "confirmed" },
      key: "k-a",
    });

    const state = await bridge.state();
    assert.equal(state.opsCount, 5);
    assert.deepEqual(state.conflicts, []);
    assert.deepEqual(state.violations, []);
    assert.ok(state.schema.objectTypes.vendor, "个人类型并入生效 schema");
    assert.ok(state.schema.linkTypes.supplies, "个人链接并入生效 schema");

    const graph = await bridge.graph();
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.links.length, 1);
    assert.equal(graph.links[0]?.type, "supplies");
    assert.equal(graph.stats.basis.confirmed, 1);

    // merge（confirm 闸门放行）→ 图折叠；ops 投影剥离 absorbedSnapshot、保留 absorbedKeys
    const other = (await bridge.action({
      action: "entity.create",
      payload: { type: "customer", props: { name: "乙股份（合成）", cid: "C2" } },
      key: "k-b",
    })) as Json;
    await bridge.action({
      action: "entity.merge",
      payload: { uid: cust.uid, fromUid: other.uid },
      key: "k-m",
      confirm: cust.uid,
    });
    const mergedState = await bridge.state();
    const mergeOp = mergedState.ops.find((o) => o.op === "entity.merge");
    assert.ok(mergeOp, "state 投影保留 merge 操作");
    assert.deepEqual(mergeOp.absorbedKeys, [`manual:${other.uid}`], "absorbedKeys 供 split 表单使用");
    assert.equal("absorbedSnapshot" in mergeOp, false, "快照体积大且 UI 不需要，投影剥离");
    assert.equal(mergedState.conflicts.length, 0);

    // split → 拆回乙股份
    await bridge.action({
      action: "entity.split",
      payload: { uid: cust.uid, absorbedKeys: [`manual:${other.uid}`] },
      key: "k-s",
      confirm: cust.uid,
    });
    const splitState = await bridge.state();
    assert.deepEqual(splitState.conflicts, []);
    assert.deepEqual(splitState.violations, []);
    const splitGraph = await bridge.graph();
    const names = splitGraph.nodes.map((n) => n.name).sort();
    assert.deepEqual(names, ["丙实验室（合成）", "乙股份（合成）", "甲科技（合成）"].sort(), "拆回后三实体齐全");

    // 磁盘上的 edits.json 持久化了富化 op（absorbedSnapshot 落盘，供 split 恢复）
    const edits = await readJson(join(dir, "edits.json"));
    const diskMerge = (edits.ops as Json[]).find((o) => o.op === "entity.merge");
    assert.ok(diskMerge?.absorbedSnapshot, "富化后的 merge 快照随日志持久化");
  });
});
