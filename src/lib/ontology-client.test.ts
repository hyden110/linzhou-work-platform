import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOntologyGraph,
  fetchOntologyState,
  makeOntologyActionKey,
  ontologyErrorMessage,
  OntologyClientError,
  submitOntologyAction,
} from "./ontology-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：实体只用「甲科技（合成）/张三（合成）」等合成值；fetch 全程 mock，零网络。
// ---------------------------------------------------------------------------

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okData = (data: unknown): Response => jsonRes({ ok: true, data });

const SCHEMA = {
  version: "2026-10-17",
  objectTypes: { customer: { label: "客户" } },
  linkTypes: { manages: { label: "管理", from: "person", to: "customer" } },
  basis: { confirmed: { label: "已确认", d: "人工确认" } },
  constraints: [],
};

const STATE_DATA = {
  v: 1,
  opsCount: 2,
  uidsCount: 2,
  applied: 2,
  schema: SCHEMA,
  stats: { objects: { customer: 1, person: 1 }, links: { manages: 1 }, basis: { confirmed: 1 } },
  conflicts: [],
  violations: [],
  audit: [
    { at: "2026-10-20T03:00:00.000Z", by: "workbench", key: "k-1", action: "entity.create", ok: true },
    { broken: true },
  ],
  ops: [
    { op: "entity.create", uid: "u00000001", type: "customer", at: "2026-10-20T03:00:00.000Z", by: "workbench", key: "k-1" },
    "坏行",
  ],
};

const NODE = {
  id: "manual:u00000001",
  uid: "u00000001",
  type: "customer",
  name: "甲科技（合成）",
  tags: [],
  aliases: [],
  props: { ecid: "E1" },
  manual: true,
  curated: false,
};

test("fetchOntologyState GETs the state route and projects with the whitelist", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData(STATE_DATA);
  }) as unknown as typeof fetch;

  const state = await fetchOntologyState(fetchImpl);
  assert.equal(requested, "http://localhost/local/ontology");
  assert.equal(state.opsCount, 2);
  assert.equal(state.schema.version, "2026-10-17");
  assert.equal(state.audit.length, 1, "坏审计行丢弃");
  assert.equal(state.audit[0]?.action, "entity.create");
  assert.equal(state.ops.length, 1, "坏 op 行丢弃");
  assert.equal(state.stats.objects.customer, 1);
});

test("fetchOntologyState rejects half-truth envelopes with invalid_response", async () => {
  for (const bad of [okData(undefined), okData("nope"), okData({ ...STATE_DATA, opsCount: "3" })]) {
    const fetchImpl = (async () => bad) as unknown as typeof fetch;
    const error = await fetchOntologyState(fetchImpl).catch((reason: unknown) => reason);
    assert.ok(error instanceof OntologyClientError);
    assert.equal(error.code, "invalid_response", "整包形状不符必须整包拒绝，不半真半假");
  }
});

test("fetchOntologyGraph GETs the graph route and drops broken nodes", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData({
      generatedAt: "2026-10-20T03:00:00.000Z",
      opsCount: 1,
      lastOpAt: "2026-10-20T03:00:00.000Z",
      nodes: [NODE, { broken: true }],
      links: [{ type: "manages", from: "manual:u00000002", to: "manual:u00000001", fromUid: "u00000002", toUid: "u00000001", basis: "confirmed", source: "overlay" }],
      stats: { objects: { customer: 1 }, links: { manages: 1 }, basis: { confirmed: 1 } },
    });
  }) as unknown as typeof fetch;

  const graph = await fetchOntologyGraph(fetchImpl);
  assert.equal(requested, "http://localhost/local/ontology/graph");
  assert.equal(graph.nodes.length, 1, "坏节点丢弃");
  assert.equal(graph.nodes[0]?.name, "甲科技（合成）");
  assert.equal(graph.links.length, 1);
  assert.equal(graph.opsCount, 1);
});

test("submitOntologyAction POSTs the full body and projects both outcomes", async () => {
  let url = "";
  let method = "";
  let body = "";
  const fetchImpl = (async (input: Request | string) => {
    const request = input as Request;
    url = request.url;
    method = request.method;
    body = await request.text();
    return okData({ deduped: false, at: "2026-10-20T03:00:00.000Z", uid: "u00000001", ops: 1, stats: {} });
  }) as unknown as typeof fetch;

  const outcome = await submitOntologyAction(
    { action: "entity.create", payload: { type: "customer", props: { name: "甲科技（合成）" } }, key: "k-1", confirm: "u00000001" },
    fetchImpl,
  );
  assert.equal(url, "http://localhost/local/ontology/action");
  assert.equal(method, "POST");
  assert.deepEqual(JSON.parse(body), {
    action: "entity.create",
    payload: { type: "customer", props: { name: "甲科技（合成）" } },
    key: "k-1",
    confirm: "u00000001",
  });
  assert.deepEqual(outcome, { deduped: false, at: "2026-10-20T03:00:00.000Z", uid: "u00000001", ops: 1 });

  const dupFetch = (async () => okData({ deduped: true, key: "k-1", at: "2026-10-20T02:00:00.000Z" })) as unknown as typeof fetch;
  const dup = await submitOntologyAction({ action: "entity.create", key: "k-1" }, dupFetch);
  assert.equal(dup.deduped, true);
  assert.equal(dup.at, "2026-10-20T02:00:00.000Z", "幂等命中返回首次落账时间");
  assert.equal(dup.uid, null);
});

test("client errors map bridge codes through and network faults fall back to unavailable", async () => {
  const gated = (async () => jsonRes({ ok: false, error: { code: "ontology_confirm_required", message: "破坏性动作需要输入目标 uid 确认" } }, 400)) as unknown as typeof fetch;
  const error = await submitOntologyAction({ action: "entity.archive", payload: { uid: "u00000001" } }, gated).catch((reason: unknown) => reason);
  assert.ok(error instanceof OntologyClientError);
  assert.equal(error.code, "ontology_confirm_required", "已知错误码透传");
  assert.match(error.detail, /确认/);

  const unknownCode = (async () => jsonRes({ ok: false, error: { code: "wat", message: "?" } }, 400)) as unknown as typeof fetch;
  const mapped = await fetchOntologyState(unknownCode).catch((reason: unknown) => reason);
  assert.ok(mapped instanceof OntologyClientError);
  assert.equal(mapped.code, "unavailable", "未知错误码回落 unavailable");

  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const net = await fetchOntologyGraph(offline).catch((reason: unknown) => reason);
  assert.ok(net instanceof OntologyClientError);
  assert.equal(net.code, "unavailable");
});

test("ontologyErrorMessage gives friendly Chinese copy per error code", () => {
  assert.match(ontologyErrorMessage(new OntologyClientError("ontology_confirm_required")), /确认/);
  assert.match(ontologyErrorMessage(new OntologyClientError("ontology_edits_corrupt")), /edits\.json/);
  assert.match(ontologyErrorMessage(new OntologyClientError("unavailable")), /本地服务/);
  assert.match(ontologyErrorMessage(new OntologyClientError("ontology_invalid_payload", "名字不能为空")), /名字不能为空|参数|载荷/);
  assert.ok(ontologyErrorMessage("不是错误对象").length > 0, "任意输入都有兜底文案");
});

test("makeOntologyActionKey is unique across 1000 draws", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const key = makeOntologyActionKey();
    assert.equal(typeof key, "string");
    assert.ok(key.length >= 16 && key.length <= 120, "键长在桥侧上限内");
    seen.add(key);
  }
  assert.equal(seen.size, 1000);
});
