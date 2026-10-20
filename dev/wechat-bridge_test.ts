import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWechatBridge } from "./wechat-bridge.ts";
import { WECHAT_ROUTES } from "./wechat/wechat-types.ts";
import type { WechatBridge } from "./wechat/wechat-types.ts";
import type { WechatSnapshotOkView } from "../src/lib/wechat-model.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：快照文件写在临时目录（群名「合成群X」、客户「甲科技（合成）」、
// 个人 id wxid_syn*），台账目录同为临时目录——零真实微信数据、零真实用户目录接触。
// ---------------------------------------------------------------------------

const BASE_URL = "http://127.0.0.1:8788";
const T0 = 1_760_000_000;
const LONG_TEXT = "这是一条非常长的合成消息正文用于验证掩码截断到二十四个字符以内绝不出全文";

const RAW_SNAPSHOT = {
  version: 1,
  updatedAt: "2026-10-19T08:00:00.000Z",
  me: { wxid: "wxid_synme", name: "合成我" },
  source: { decryptedDir: "/synthetic/decrypted", dbs: 3, tables: 10, messages: 500, groups: 2, singles: 1, window: 90 },
  stats: {
    groups: 2, groupsActive7: 1, groupsActive30: 2, groupsMine7: 1, custBound: 1,
    atMeAll: 3, atMe30: 2, todos: 1, todosHigh: 1, unread: 4, singleUnreplied: 1, messages: 500,
  },
  groups: [
    {
      id: "syn-g1@chatroom", name: "合成群A", owner: "wxid_synowner", memberCount: 12, muted: true,
      announcement: "合成群公告（不应出桥）", people: ["wxid_synmember"],
      custKeys: ["甲科技（合成）"], customerStatus: "matched", bindNote: "",
      lastMsgAt: T0, unread: 3, lastSummary: LONG_TEXT,
      msg: { d7: 5, d30: 40, dWin: 60, all: 200 }, senders: { d7: 3, d30: 8, all: 11 },
      mine: { d7: 1, d30: 4, all: 30, lastAt: T0 - 100 },
      atMe: { all: 3, lastAt: T0 - 50, daysSince: 1, unreplied: true },
      recentAtMe: [{ t: T0 - 50, from: "wxid_synsender", name: "合成同事", text: LONG_TEXT }],
    },
    {
      id: "syn-g2@chatroom", name: "合成群B", owner: "", memberCount: 5, muted: false,
      custKeys: [], customerStatus: "pending", bindNote: "",
      lastMsgAt: T0 - 900, unread: 1, lastSummary: "合成短摘要",
      msg: { d7: 0, d30: 2, dWin: 2, all: 2 }, senders: { d7: 0, d30: 2, all: 2 },
      mine: { d7: 0, d30: 0, all: 0, lastAt: 0 },
      atMe: { all: 0, lastAt: 0, daysSince: null, unreplied: false }, recentAtMe: [],
    },
  ],
  todos: [{
    groupId: "syn-g1@chatroom", groupName: "合成群A", custKeys: ["甲科技（合成）"], urgency: "high",
    daysSince: 1, at: T0 - 50, from: "wxid_synsender", fromName: "合成同事", text: LONG_TEXT,
  }],
  mentions: [
    { kind: "at", t: T0 - 50, convId: "syn-g1@chatroom", convName: "合成群A", group: true, custKeys: ["甲科技（合成）"], from: "wxid_synsender", fromName: "合成同事", text: LONG_TEXT, unread: true },
    { kind: "single", t: T0 - 60, convId: "wxid_synpeer", convName: "合成联系人", group: false, custKeys: [], from: "wxid_synpeer", fromName: "合成联系人", text: LONG_TEXT, unread: false },
  ],
  singles: [{
    id: "wxid_synpeer", name: "合成联系人", muted: false, msg: { d7: 2, d30: 6, all: 20 },
    lastMsgAt: T0 - 60, unread: 1, lastSummary: LONG_TEXT, unreplied: true,
  }],
  labels: [{ id: 1, name: "合成标签" }],
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wechat-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Harness {
  readonly bridge: WechatBridge;
  readonly dir: string;
  readonly snapshotPath: string;
}

async function makeHarness(dir: string, snapshot: unknown = RAW_SNAPSHOT): Promise<Harness> {
  const snapshotPath = join(dir, "wechat-snapshot.json");
  if (snapshot !== null) await writeFile(snapshotPath, typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot));
  const bridge = createWechatBridge({ dir: join(dir, "ledger"), snapshotPath, now: () => Date.parse("2026-10-19T10:00:00.000Z") });
  return { bridge, dir, snapshotPath };
}

async function call(bridge: WechatBridge, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const response = await bridge.handle(new Request(BASE_URL + path, init));
  assert.ok(response, "本桥路径必须有响应（不回落 undefined）");
  return { status: response.status, body: await response.json() };
}

test("WECHAT_ROUTES 路由表：七条路由与规格一致", () => {
  assert.deepEqual(
    WECHAT_ROUTES.map((r) => `${r.method} ${r.path}`),
    [
      "GET /local/wechat",
      "GET /local/wechat/bindings",
      "PUT /local/wechat/bindings",
      "DELETE /local/wechat/bindings",
      "POST /local/wechat/custorg-import",
      "GET /local/wechat/custorg",
      "GET /local/wechat/tree",
    ],
  );
});

test("GET /local/wechat：白名单投影 ok——wxid/公告/成员/解密目录不出桥，正文只给 ≤24 字掩码", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "GET", "/local/wechat");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const data = res.body.data as WechatSnapshotOkView;
    assert.equal(data.status, "ok");
    const text = JSON.stringify(res.body);
    for (const secret of ["wxid_synme", "wxid_synowner", "wxid_synsender", "wxid_synpeer", "/synthetic/decrypted", "合成群公告"]) {
      assert.ok(!text.includes(secret), `响应不得包含 ${secret}`);
    }
    assert.ok(!text.includes(LONG_TEXT), "完整消息正文绝不出桥");
    if (data.status !== "ok") return;
    assert.equal(data.groups.length, 2);
    assert.ok(data.groups[0].lastSummaryMasked.length <= 25);
    assert.equal(data.todos[0].urgency, "high");
    assert.equal(data.singles[0].unreplied, true);
    assert.equal(data.stats.custBound, 1);
    assert.equal(data.meName, "合成我");
  });
});

test("GET /local/wechat：快照缺失四态都是 200 status:missing + 修复指引，绝不伪造", async () => {
  await withTempDir(async (dir) => {
    // no-path：配置里没填 snapshotPath
    const noPath = createWechatBridge({ dir: join(dir, "l1"), configPath: join(dir, "absent-agents.json") });
    const r1 = await call(noPath, "GET", "/local/wechat");
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.status, "missing");
    assert.ok(r1.body.data.steps.length >= 3, "给修复指引而非空白");
    assert.ok(String(r1.body.data.missingNote).includes("agents.json"));

    // no-file：配了路径但文件不存在
    const noFile = createWechatBridge({ dir: join(dir, "l2"), snapshotPath: join(dir, "absent.json") });
    const r2 = await call(noFile, "GET", "/local/wechat");
    assert.equal(r2.body.data.status, "missing");
    assert.ok(String(r2.body.data.missingNote).includes("尚未生成"));

    // malformed：文件不是合法 JSON
    const badPath = join(dir, "bad.json");
    await writeFile(badPath, "{ 坏 JSON");
    const bad = createWechatBridge({ dir: join(dir, "l3"), snapshotPath: badPath });
    const r3 = await call(bad, "GET", "/local/wechat");
    assert.equal(r3.body.data.status, "missing");
    assert.ok(String(r3.body.data.missingNote).includes("合法 JSON"));

    // template：.example 空模板（updatedAt null）按未生成处理
    const tplPath = join(dir, "tpl.json");
    await writeFile(tplPath, JSON.stringify({ ...RAW_SNAPSHOT, updatedAt: null }));
    const tpl = createWechatBridge({ dir: join(dir, "l4"), snapshotPath: tplPath });
    const r4 = await call(tpl, "GET", "/local/wechat");
    assert.equal(r4.body.data.status, "missing");
  });
});

test("configPath 解析：从 agents.json 的 wechat.snapshotPath 取快照路径（复用既有配置口径）", async () => {
  await withTempDir(async (dir) => {
    const snapshotPath = join(dir, "cfg-snapshot.json");
    await writeFile(snapshotPath, JSON.stringify(RAW_SNAPSHOT));
    const configPath = join(dir, "agents.json");
    await writeFile(configPath, JSON.stringify({ wechat: { snapshotPath } }));
    const bridge = createWechatBridge({ dir: join(dir, "ledger"), configPath });
    const res = await call(bridge, "GET", "/local/wechat");
    assert.equal(res.body.data.status, "ok");
  });
});

test("handle：非本桥路径返回 undefined；本桥路径错方法 405", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    assert.equal(await bridge.handle(new Request(`${BASE_URL}/local/worklog`, { method: "GET" })), undefined);
    assert.equal(await bridge.handle(new Request(`${BASE_URL}/local/agents/wechat`, { method: "GET" })), undefined);
    assert.equal(await bridge.handle(new Request(`${BASE_URL}/local/wechat-x`, { method: "GET" })), undefined);
    const res = await call(bridge, "POST", "/local/wechat");
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, "method_not_allowed");
    const res2 = await call(bridge, "GET", "/local/wechat/");
    assert.equal(res2.status, 200, "尾斜杠归一化");
  });
});

test("PUT /local/wechat/bindings：合法写入 200 + 0600 + 审计；GET 回读一致", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "PUT", "/local/wechat/bindings", {
      groupId: "syn-g2@chatroom", custKeys: ["乙咨询（合成）"], note: "合成项目群",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.total, 1);
    assert.deepEqual(res.body.data.entries[0].custKeys, ["乙咨询（合成）"]);
    const mode = (await stat(join(dir, "ledger", "bindings.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "台账 0600");
    const audit = await readFile(join(dir, "ledger", "audit.jsonl"), "utf-8");
    assert.equal(audit.split("\n").filter(Boolean).length, 1, "审计 append-only 一行");

    const list = await call(bridge, "GET", "/local/wechat/bindings");
    assert.equal(list.body.data.total, 1);
    assert.equal(list.body.data.auditTail[0].op, "bind");
  });
});

test("PUT /local/wechat/bindings：body 白名单校验——群 id 形态 / custKeys 数量与长度 / note 长度", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const cases: { body: unknown; why: string }[] = [
      { body: { groupId: "", custKeys: [] }, why: "缺 groupId" },
      { body: { groupId: "syn-g1", custKeys: [] }, why: "非 chatroom 形态" },
      { body: { groupId: "wxid_personal", custKeys: [] }, why: "个人 wxid 不是群 id" },
      { body: { groupId: "../evil@chatroom", custKeys: [] }, why: "路径穿越字符" },
      { body: { groupId: "syn-g1@chatroom", custKeys: "不是数组" }, why: "custKeys 非数组" },
      { body: { groupId: "syn-g1@chatroom", custKeys: Array.from({ length: 9 }, (_, i) => `客户${i}`) }, why: "超过 8 个客户键" },
      { body: { groupId: "syn-g1@chatroom", custKeys: ["长".repeat(41)] }, why: "客户键超 40 字" },
      { body: { groupId: "syn-g1@chatroom", custKeys: [42] }, why: "客户键非字符串" },
      { body: { groupId: "syn-g1@chatroom", custKeys: [], note: "长".repeat(121) }, why: "备注超 120 字" },
      { body: null, why: "body 非对象" },
    ];
    for (const { body, why } of cases) {
      const res = await call(bridge, "PUT", "/local/wechat/bindings", body);
      assert.equal(res.status, 400, why);
      assert.equal(res.body.error.code, "wechat_invalid_request", why);
    }
    const empty = await call(bridge, "PUT", "/local/wechat/bindings", { groupId: "syn-g1@chatroom", custKeys: [] });
    assert.equal(empty.status, 200, "空 custKeys = 清除人工绑定（donor 口径），合法");
    assert.equal(empty.body.data.entries[0].note, "");
  });
});

test("DELETE /local/wechat/bindings：解绑成功 200；不存在 404 binding_not_found；坏 id 400", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    await call(bridge, "PUT", "/local/wechat/bindings", { groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"] });
    const res = await call(bridge, "DELETE", "/local/wechat/bindings", { groupId: "syn-g1@chatroom" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 0);
    const gone = await call(bridge, "DELETE", "/local/wechat/bindings", { groupId: "syn-g1@chatroom" });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, "binding_not_found");
    const bad = await call(bridge, "DELETE", "/local/wechat/bindings", { groupId: "syn-g1" });
    assert.equal(bad.status, 400);
  });
});

test("PUT bindings 后 GET /local/wechat：台账覆盖进快照投影（confirmed + custBound 重算）", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    await call(bridge, "PUT", "/local/wechat/bindings", { groupId: "syn-g2@chatroom", custKeys: ["乙咨询（合成）"] });
    const res = await call(bridge, "GET", "/local/wechat");
    const data = res.body.data as WechatSnapshotOkView;
    if (data.status !== "ok") { assert.fail("应 ok"); return; }
    const g2 = data.groups.find((g) => g.id === "syn-g2@chatroom");
    assert.deepEqual(g2?.custKeys, ["乙咨询（合成）"]);
    assert.equal(g2?.customerStatus, "confirmed");
    assert.equal(data.stats.custBound, 2);
  });
});

test("GET /local/wechat/tree：qr-tree 只读分组；快照缺失 → missing + 空树", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "GET", "/local/wechat/tree");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "ok");
    const keys = res.body.data.nodes.map((n: { key: string }) => n.key);
    assert.deepEqual(keys, ["甲科技（合成）", "__unbound"], "客户桶在前、未绑定最后");
    assert.equal(res.body.data.nodes[0].children[0].groupId, "syn-g1@chatroom");

    const missing = createWechatBridge({ dir: join(dir, "l2"), snapshotPath: join(dir, "absent.json") });
    const r2 = await call(missing, "GET", "/local/wechat/tree");
    assert.equal(r2.body.data.status, "missing");
    assert.deepEqual(r2.body.data.nodes, []);
    assert.ok(r2.body.data.steps.length >= 3);
  });
});

test("POST custorg-import：dry 只回 diff 不落盘；confirm 严格 === token 才写（两步闸门）", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const text = "客户,部门,姓名,职位,联系方式\n甲科技（合成）,研发部,合成张三,架构师,\n乙咨询（合成）,交付部,合成李四,,";

    const dry = await call(bridge, "POST", "/local/wechat/custorg-import", { text });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.data.phase, "dry");
    assert.match(dry.body.data.token, /^[0-9a-f]{16}$/);
    assert.equal(dry.body.data.customerCount, 2);
    assert.equal(dry.body.data.rowCount, 2);
    assert.deepEqual(dry.body.data.willImport.map((e: { key: string }) => e.key).sort(), ["乙咨询（合成）", "甲科技（合成）"]);
    const ledgerFiles = await readdir(join(dir, "ledger")).catch(() => [] as string[]);
    assert.ok(!ledgerFiles.includes("custorg.json"), "dry 绝不落盘");

    const token = dry.body.data.token as string;
    const wrongConfirm = await call(bridge, "POST", "/local/wechat/custorg-import", { text, token, confirm: "差点确认" });
    assert.equal(wrongConfirm.status, 409);
    assert.equal(wrongConfirm.body.error.code, "confirm_mismatch");

    const staleText = await call(bridge, "POST", "/local/wechat/custorg-import", { text: `${text}\n丙制造（合成）,厂部,合成王五,,`, token, confirm: token });
    assert.equal(staleText.status, 409, "文本变了 token 不再匹配：拒绝（防 dry/confirm 之间偷换内容）");
    assert.equal(staleText.body.error.code, "confirm_mismatch");

    const confirmed = await call(bridge, "POST", "/local/wechat/custorg-import", { text, token, confirm: token });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.phase, "confirmed");
    assert.equal(confirmed.body.data.totalCustomers, 2);
    assert.equal(confirmed.body.data.totalRows, 2);
    const mode = (await stat(join(dir, "ledger", "custorg.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "custorg 台账 0600");
    const audit = await readFile(join(dir, "ledger", "audit.jsonl"), "utf-8");
    assert.ok(audit.includes("custorg-import"), "导入落审计");
  });
});

test("POST custorg-import：覆盖 diff（willOverwrite 带双侧行数）+ 合并语义（未出现客户保留）", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const first = "客户,部门,姓名\n甲科技（合成）,研发部,合成张三";
    const dry1 = await call(bridge, "POST", "/local/wechat/custorg-import", { text: first });
    await call(bridge, "POST", "/local/wechat/custorg-import", { text: first, token: dry1.body.data.token, confirm: dry1.body.data.token });

    const second = "客户,部门,姓名\n甲科技（合成）,新研发部,合成张三三\n甲科技（合成）,新研发部,合成张三四\n乙咨询（合成）,交付部,合成李四";
    const dry2 = await call(bridge, "POST", "/local/wechat/custorg-import", { text: second });
    assert.deepEqual(dry2.body.data.willOverwrite, [{ key: "甲科技（合成）", existingRows: 1, incomingRows: 2 }]);
    assert.deepEqual(dry2.body.data.willImport, [{ key: "乙咨询（合成）", existingRows: 0, incomingRows: 1 }]);
    const done = await call(bridge, "POST", "/local/wechat/custorg-import", { text: second, token: dry2.body.data.token, confirm: dry2.body.data.token });
    assert.equal(done.body.data.totalCustomers, 2);
    assert.equal(done.body.data.totalRows, 3);
    const raw = JSON.parse(await readFile(join(dir, "ledger", "custorg.json"), "utf-8"));
    assert.equal(raw.customers["甲科技（合成）"].items.length, 2, "出现的客户整体替换");
  });
});

test("POST custorg-import：空文本/坏文本/超长文本 400；超大 body 400", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const empty = await call(bridge, "POST", "/local/wechat/custorg-import", { text: "  " });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, "wechat_invalid_request");
    const bad = await call(bridge, "POST", "/local/wechat/custorg-import", { text: "部门,姓名\n研发部,合成张三" });
    assert.equal(bad.status, 400, "无有效行如实拒绝，不落盘");
    const noText = await call(bridge, "POST", "/local/wechat/custorg-import", {});
    assert.equal(noText.status, 400);
    const huge = await call(bridge, "POST", "/local/wechat/custorg-import", { text: "客".repeat(50_000) });
    assert.equal(huge.status, 400);
  });
});

test("请求体不是合法 JSON → 400；错误消息不含绝对路径", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const response = await bridge.handle(new Request(`${BASE_URL}/local/wechat/bindings`, {
      method: "PUT",
      body: "{ 坏 JSON",
      headers: { "content-type": "application/json" },
    }));
    assert.ok(response);
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "wechat_invalid_request");
    assert.ok(!String(payload.error.message).includes(dir), "错误消息不泄露服务器绝对路径");
  });
});

test("GET /local/wechat/custorg：空台账如实空数组（不 500、不伪造样例行）", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "GET", "/local/wechat/custorg");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { updatedAt: "", customers: [], totalCustomers: 0, totalRows: 0 });
  });
});

test("GET /local/wechat/custorg：确认导入后读回——客户按 key 稳定排序、联系人明细可见、计数自洽", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const text = "客户,部门,姓名,职务,联系方式\n乙咨询（合成）,交付部,合成李四,交付经理,syn-li@example.test\n甲科技（合成）,研发部,合成张三,架构师,syn-zhang@example.test";
    const dry = await call(bridge, "POST", "/local/wechat/custorg-import", { text });
    const token = dry.body.data.token as string;
    await call(bridge, "POST", "/local/wechat/custorg-import", { text, token, confirm: token });

    const res = await call(bridge, "GET", "/local/wechat/custorg");
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.totalCustomers, 2);
    assert.equal(data.totalRows, 2);
    assert.ok(data.updatedAt, "台账读回带 updatedAt");
    assert.deepEqual(data.customers.map((c: { key: string }) => c.key), ["甲科技（合成）", "乙咨询（合成）"], "zh 排序稳定（甲 jiǎ < 乙 yǐ）");
    const again = await call(bridge, "GET", "/local/wechat/custorg");
    assert.deepEqual(again.body.data.customers, data.customers, "重复读回顺序一致（可复现）");
    assert.deepEqual(data.customers[0].rows[0], {
      dept: "研发部", name: "合成张三", title: "架构师", contact: "syn-zhang@example.test",
    });
    assert.equal(data.customers[0].name, "甲科技（合成）", "name 缺失回落 key");
    assert.equal(data.customers[0].rowCount, data.customers[0].rows.length, "rowCount 与明细自洽");
  });
});

test("GET /local/wechat/custorg：坏文件/坏行如实降级为空或丢弃，绝不静默重建真相", async () => {
  await withTempDir(async (dir) => {
    const ledgerDir = join(dir, "ledger");
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(join(ledgerDir, "custorg.json"), "{ 坏 JSON");
    const { bridge } = await makeHarness(dir);
    const broken = await call(bridge, "GET", "/local/wechat/custorg");
    assert.equal(broken.status, 200);
    assert.deepEqual(broken.body.data.customers, [], "坏文件如实空台账");

    await writeFile(join(ledgerDir, "custorg.json"), JSON.stringify({
      version: 1, updatedAt: "2026-10-19T10:00:00.000Z",
      customers: {
        "甲科技（合成）": { name: "甲科技（合成）", items: [{ dept: "研发部", name: "合成张三", title: "", contact: "" }, "坏行", { dept: "", name: "", title: "", contact: "" }] },
        "坏客户": "不是对象",
      },
    }));
    const res = await call(bridge, "GET", "/local/wechat/custorg");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.customers.map((c: { key: string }) => c.key), ["甲科技（合成）"], "坏客户键丢弃");
    assert.equal(res.body.data.customers[0].rowCount, 1, "空行/坏行丢弃，只留有效联系人");
    assert.equal(res.body.data.totalRows, 1);
  });
});

test("GET /local/wechat/custorg 只接受 GET：POST 同路径 405 且如实列出允许方法", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const res = await call(bridge, "POST", "/local/wechat/custorg", {});
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, "method_not_allowed");
    assert.ok(String(res.body.error.message).includes("GET"), "405 消息给出允许方法");
  });
});

test("POST custorg-import：CSV 表头同义词（职称/手机）与主名（职位/联系方式）等价，列名之外的内容不猜", async () => {
  await withTempDir(async (dir) => {
    const { bridge } = await makeHarness(dir);
    const alias = "客户,部门,姓名,职称,手机\n甲科技（合成）,研发部,合成张三,架构师,13800000000";
    const dry = await call(bridge, "POST", "/local/wechat/custorg-import", { text: alias });
    assert.equal(dry.status, 200);
    const token = dry.body.data.token as string;
    await call(bridge, "POST", "/local/wechat/custorg-import", { text: alias, token, confirm: token });
    const res = await call(bridge, "GET", "/local/wechat/custorg");
    assert.deepEqual(res.body.data.customers[0].rows[0], {
      dept: "研发部", name: "合成张三", title: "架构师", contact: "13800000000",
    }, "职称→title、手机→contact（只按列名映射）");

    /* 无「客户」列时如实 400，绝不把首列当客户键猜。 */
    const noCust = await call(bridge, "POST", "/local/wechat/custorg-import", { text: "部门,姓名\n研发部,合成张三" });
    assert.equal(noCust.status, 400);
    assert.ok(String(noCust.body.error.message).includes("客户"), "错误消息点明缺哪一列");
  });
});
