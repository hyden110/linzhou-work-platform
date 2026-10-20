import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maskPreview,
  maskWxid,
  missingWechatSnapshotView,
  projectWechatSnapshot,
  WECHAT_MISSING_STEPS,
} from "./wechat/wechat-snapshot.ts";
import { custorgToken, diffCustorgImport, parseCustorgImport } from "./wechat/wechat-custorg.ts";
import { createWechatStore, projectAuditRow, projectBindingEntry } from "./wechat/wechat-store.ts";
import { WechatBridgeError } from "./wechat/wechat-types.ts";
import type { WechatGroupView, WechatSnapshotOkView } from "../src/lib/wechat-model.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：群 id 一律 syn-*@chatroom、群名「合成群X」、客户「甲科技（合成）」、
// 个人 id 一律 wxid_syn*（投影后必须消失）；台账只写临时目录——零真实微信数据。
// ---------------------------------------------------------------------------

const T0 = 1_760_000_000;
const LONG_TEXT = "这是一条非常长的合成消息正文用于验证掩码截断到二十四个字符以内绝不出全文";

function rawGroup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "syn-g1@chatroom",
    name: "合成群A",
    owner: "wxid_synowner",
    memberCount: 12,
    muted: true,
    announcement: "合成群公告全文（不应出桥）",
    people: ["wxid_synmember", "合成成员"],
    custKeys: ["甲科技（合成）"],
    customerStatus: "matched",
    bindNote: "",
    lastMsgAt: T0,
    unread: 3,
    lastSummary: LONG_TEXT,
    msg: { d7: 5, d30: 40, dWin: 60, all: 200 },
    senders: { d7: 3, d30: 8, all: 11 },
    mine: { d7: 1, d30: 4, all: 30, lastAt: T0 - 100 },
    atMe: { all: 3, lastAt: T0 - 50, daysSince: 1, unreplied: true },
    recentAtMe: [{ t: T0 - 50, from: "wxid_synsender", name: "合成同事", text: LONG_TEXT }],
    ...over,
  };
}

function rawSnapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    updatedAt: "2026-10-19T08:00:00.000Z",
    me: { wxid: "wxid_synme", name: "合成我" },
    source: { decryptedDir: "/synthetic/decrypted", dbs: 3, tables: 10, messages: 500, groups: 2, singles: 1, window: 90 },
    stats: {
      groups: 2, groupsActive7: 1, groupsActive30: 2, groupsMine7: 1, custBound: 1,
      atMeAll: 3, atMe30: 2, todos: 1, todosHigh: 1, unread: 4, singleUnreplied: 1, messages: 500,
    },
    groups: [
      rawGroup(),
      rawGroup({ id: "syn-g2@chatroom", name: "合成群B", custKeys: [], customerStatus: "pending", atMe: { all: 0, lastAt: 0, daysSince: null, unreplied: false } }),
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
    ...over,
  };
}

function okView(view: unknown): WechatSnapshotOkView {
  assert.ok(view && typeof view === "object" && (view as { status?: string }).status === "ok", "应是 ok 投影");
  return view as WechatSnapshotOkView;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wechat-model-"));
  try {
    await run(dir);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---------------- 掩码 ---------------- */

test("maskPreview: 折空白、24 字截断加省略号、wxid 形态词打码、非字符串如实空", () => {
  const masked = maskPreview(LONG_TEXT);
  assert.ok(masked.endsWith("…"), "超长加省略号");
  assert.ok(masked.length <= 25, "≤24 字 + 省略号");
  assert.equal(maskPreview("  合成\n  消息  "), "合成 消息", "空白折叠");
  assert.equal(maskPreview("联系 wxid_synsecret 处理"), "联系 wxid_*** 处理", "正文内 wxid 形态词打码");
  assert.equal(maskPreview(undefined), "");
  assert.equal(maskPreview(123 as unknown), "123");
  assert.equal(maskPreview("短消息"), "短消息", "不超长不加省略号");
});

test("maskWxid: 确定性、不可逆（不含完整原 id）、不同 id 不同指纹", () => {
  const a = maskWxid("wxid_synpeer1");
  const b = maskWxid("wxid_synpeer2");
  assert.equal(a, maskWxid("wxid_synpeer1"), "同 id 稳定同掩码");
  assert.notEqual(a, b, "不同 id 指纹不同");
  assert.ok(!a.includes("wxid_synpeer1"), "掩码不回完整 wxid");
  assert.ok(a.startsWith("wxid"), "wxid 前缀保留通用段");
  assert.equal(maskWxid(""), "", "空 id 如实空");
  assert.equal(maskWxid(null), "", "非字符串如实空");
});

/* ---------------- 快照白名单投影 ---------------- */

test("projectWechatSnapshot: 白名单投影——个人 wxid/群主/成员名单/公告/解密目录一律不出桥", () => {
  const view = okView(projectWechatSnapshot(rawSnapshot(), []));
  const text = JSON.stringify(view);
  for (const secret of ["wxid_synme", "wxid_synowner", "wxid_synsender", "wxid_synpeer", "wxid_synmember", "/synthetic/decrypted", "合成群公告全文"]) {
    assert.ok(!text.includes(secret), `投影不得包含 ${secret}`);
  }
  assert.equal(view.meName, "合成我", "me 只出显示名");
  assert.equal(view.updatedAt, "2026-10-19T08:00:00.000Z");
  assert.equal(view.groups.length, 2);
  const g = view.groups[0] as WechatGroupView & Record<string, unknown>;
  assert.equal(g.id, "syn-g1@chatroom", "群 chatroom id 是台账键，保留");
  assert.equal(g.owner, undefined, "群主 wxid 不出桥");
  assert.equal(g.people, undefined, "成员名单不出桥");
  assert.equal(g.announcement, undefined, "群公告不出桥");
  assert.ok(g.lastSummaryMasked.endsWith("…") && g.lastSummaryMasked.length <= 25, "lastSummary 掩码 ≤24 字");
  assert.equal(g.recentAtMe.length, 1);
  assert.equal((g.recentAtMe[0] as Record<string, unknown>).from, undefined, "recentAtMe 不带发送者 id");
  assert.equal(g.recentAtMe[0].name, "合成同事");
  assert.ok(g.recentAtMe[0].textMasked.length <= 25);
  assert.equal(view.todos.length, 1);
  assert.equal((view.todos[0] as Record<string, unknown>).from, undefined, "todo 不带发送者 id");
  assert.equal(view.todos[0].fromName, "合成同事");
  assert.ok(view.todos[0].textMasked.length <= 25);
  const at = view.mentions.find((m) => m.kind === "at");
  const sg = view.mentions.find((m) => m.kind === "single");
  assert.equal(at?.convId, "syn-g1@chatroom", "群 mention 保留 chatroom id");
  assert.ok(sg && !sg.convId.includes("wxid_synpeer"), "单聊 mention convId 打码");
  assert.equal(view.singles.length, 1);
  assert.ok(!view.singles[0].idMasked.includes("wxid_synpeer"), "单聊 id 打码");
  assert.equal(view.singles[0].name, "合成联系人");
  assert.equal(view.singles[0].unreplied, true);
  assert.deepEqual(view.labels, [{ id: 1, name: "合成标签" }]);
  assert.equal(view.stats.messages, 500);
  assert.equal(view.source.window, 90);
  assert.equal((view.source as Record<string, unknown>).decryptedDir, undefined, "解密目录路径不出桥");
});

test("projectWechatSnapshot: bindings 台账覆盖——有人工绑定 confirmed、空绑定清除回落 pending、custBound 重算", () => {
  const bindings = [
    { groupId: "syn-g2@chatroom", custKeys: ["乙咨询（合成）"], note: "合成项目群", updatedAt: "2026-10-19T09:00:00.000Z" },
  ];
  const view = okView(projectWechatSnapshot(rawSnapshot(), bindings));
  const g2 = view.groups.find((g) => g.id === "syn-g2@chatroom");
  assert.deepEqual(g2?.custKeys, ["乙咨询（合成）"]);
  assert.equal(g2?.customerStatus, "confirmed");
  assert.equal(g2?.bindNote, "合成项目群");
  assert.equal(view.stats.custBound, 2, "覆盖后重算客户群数");

  const cleared = okView(projectWechatSnapshot(rawSnapshot(), [
    { groupId: "syn-g1@chatroom", custKeys: [], note: "", updatedAt: "2026-10-19T09:00:00.000Z" },
  ]));
  const g1 = cleared.groups.find((g) => g.id === "syn-g1@chatroom");
  assert.deepEqual(g1?.custKeys, [], "空 custKeys = 清除人工绑定");
  assert.equal(g1?.customerStatus, "pending", "清除后如实待确认（自动推断等快照重建回落）");
  assert.equal(cleared.stats.custBound, 0, "syn-g1 清除后 syn-g2 本就无绑定 → 计数如实归零");
});

test("projectWechatSnapshot: 坏行丢弃（缺 id / 非对象），坏快照如实 missing", () => {
  const view = okView(projectWechatSnapshot(rawSnapshot({ groups: [rawGroup(), null, { name: "没有id（合成）" }, "坏行"] }), []));
  assert.equal(view.groups.length, 1, "坏行丢弃不猜");

  const template = projectWechatSnapshot(rawSnapshot({ updatedAt: null }), []);
  assert.equal(template.status, "missing", ".example 空模板（无 updatedAt）按未生成处理（donor D() 口径）");
  const broken = projectWechatSnapshot(rawSnapshot({ groups: "不是数组" }), []);
  assert.equal(broken.status, "missing");
  assert.equal(projectWechatSnapshot(null, []).status, "missing");
  assert.equal(projectWechatSnapshot("字符串", []).status, "missing");
});

test("missingWechatSnapshotView: 四种缺失原因都给修复指引而非空白，steps 含配置指向", () => {
  assert.ok(WECHAT_MISSING_STEPS.length >= 3, "指引步骤非空");
  for (const reason of ["no-path", "no-file", "malformed", "template"] as const) {
    const view = missingWechatSnapshotView(reason, "合成备注");
    assert.equal(view.status, "missing");
    if (view.status !== "missing") continue;
    assert.ok(view.steps.length >= 3);
    assert.ok(view.missingNote.length > 0);
  }
  const noPath = missingWechatSnapshotView("no-path", "");
  assert.ok(noPath.status === "missing" && noPath.missingNote.includes("agents.json"), "指引指向 .local-cache/agents.json 配置");
});

/* ---------------- custorg 解析（donor scripts/lib/custorg.js 语义） ---------------- */

test("parseCustorgImport: JSON 三形态 + CSV/TSV，坏行丢弃、字段截断折空白", () => {
  const shapeA = parseCustorgImport(JSON.stringify({
    customers: { "甲科技（合成）": { name: "甲科技", items: [{ dept: "研发部", name: "合成张三", title: "架构师", contact: "synthetic@example.test" }] } },
  }));
  assert.equal(shapeA.ok, true);
  if (shapeA.ok) {
    assert.equal(shapeA.customerCount, 1);
    assert.deepEqual(shapeA.customers["甲科技（合成）"].items[0], { dept: "研发部", name: "合成张三", title: "架构师", contact: "synthetic@example.test" });
  }

  const shapeB = parseCustorgImport(JSON.stringify({ "乙咨询（合成）": [{ dept: "交付部", name: "合成李四" }] }));
  assert.equal(shapeB.ok, true);

  const shapeC = parseCustorgImport(JSON.stringify([
    { customer: "甲科技（合成）", dept: " 研发\n部 ", name: "合成张三", title: "", contact: "" },
    { customer: "", dept: "无客户键", name: "x" },
    { customer: "甲科技（合成）", dept: "", name: "", title: "" },
  ]));
  assert.equal(shapeC.ok, true);
  if (shapeC.ok) {
    assert.equal(shapeC.rowCount, 1, "缺客户键/三字段全空的行丢弃");
    assert.equal(shapeC.customers["甲科技（合成）"].items[0].dept, "研发 部", "空白折叠");
  }

  const csv = parseCustorgImport("客户,部门,姓名,职位,联系方式\n甲科技（合成）,研发部,合成张三,架构师,synthetic@example.test\n乙咨询（合成）,交付部,合成李四,,");
  assert.equal(csv.ok, true);
  if (csv.ok) assert.equal(csv.rowCount, 2);

  const tsv = parseCustorgImport("客户\t姓名\n甲科技（合成）\t合成张三");
  assert.equal(tsv.ok, true);

  const quoted = parseCustorgImport('客户,姓名\n"甲科技（合成）","合成, 张三"');
  assert.equal(quoted.ok, true);
  if (quoted.ok) assert.equal(quoted.customers["甲科技（合成）"].items[0].name, "合成, 张三", "成对引号内逗号不切分");
});

test("parseCustorgImport: 空文本/无有效行/超长文本如实失败并给原因", () => {
  const empty = parseCustorgImport("   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok(empty.note.includes("为空"));

  const noRows = parseCustorgImport(JSON.stringify({ "甲科技（合成）": [] }));
  assert.equal(noRows.ok, false);

  const huge = parseCustorgImport("客".repeat(40_000));
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.ok(huge.note.includes("超过"));

  const badJson = parseCustorgImport("{ 坏 JSON");
  assert.equal(badJson.ok, false);

  const badCsv = parseCustorgImport("部门,姓名\n研发部,合成张三");
  assert.equal(badCsv.ok, false);
  if (!badCsv.ok) assert.ok(badCsv.note.includes("客户"), "缺「客户」列如实报错");
});

test("parseCustorgImport: 每客户 60 行封顶、80 客户封顶（donor DEF 上限）", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ dept: `部门${i}`, name: `合成成员${i}` }));
  const capped = parseCustorgImport(JSON.stringify({ "甲科技（合成）": rows }));
  assert.equal(capped.ok, true);
  if (capped.ok) assert.equal(capped.customers["甲科技（合成）"].items.length, 60);

  const customers: Record<string, unknown> = {};
  for (let i = 0; i < 100; i += 1) customers[`合成客户${String(i).padStart(3, "0")}`] = [{ dept: "d", name: "n" }];
  const many = parseCustorgImport(JSON.stringify(customers));
  assert.equal(many.ok, true);
  if (many.ok) assert.equal(many.customerCount, 80);
});

test("custorgToken: sha256 前 16 位十六进制、确定性、随文本变化", () => {
  const t = custorgToken("客户,姓名\n甲科技（合成）,合成张三");
  assert.match(t, /^[0-9a-f]{16}$/);
  assert.equal(t, custorgToken("客户,姓名\n甲科技（合成）,合成张三"));
  assert.notEqual(t, custorgToken("客户,姓名\n乙咨询（合成）,合成张三"));
});

test("diffCustorgImport: 新键 willImport、已有键 willOverwrite（按客户键整体替换语义）", () => {
  const existing = { "甲科技（合成）": { name: "", items: [{ dept: "旧部门", name: "合成旧人", title: "", contact: "" }] } };
  const parsed = parseCustorgImport(JSON.stringify({
    "甲科技（合成）": [{ dept: "新部门", name: "合成新人" }, { dept: "新部门2", name: "合成新人2" }],
    "乙咨询（合成）": [{ dept: "交付部", name: "合成李四" }],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const diff = diffCustorgImport(parsed.customers, existing);
  assert.deepEqual(diff.willOverwrite, [{ key: "甲科技（合成）", existingRows: 1, incomingRows: 2 }]);
  assert.deepEqual(diff.willImport, [{ key: "乙咨询（合成）", existingRows: 0, incomingRows: 1 }]);
});

/* ---------------- store：0600 原子写 + 备份 + 单飞 + 审计 ---------------- */

test("store.putBinding: 首写建 0600 台账，再写留备份，审计 append-only 两行", async () => {
  await withTempDir(async (dir) => {
    const store = createWechatStore(dir, { now: () => Date.parse("2026-10-19T10:00:00.000Z") });
    const first = await store.putBinding({ groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "合成项目群" });
    assert.equal(first.total, 1);
    const mode = (await stat(join(dir, "bindings.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "台账文件 0600");

    await store.putBinding({ groupId: "syn-g2@chatroom", custKeys: ["乙咨询（合成）"], note: "" });
    const backups = await readdir(join(dir, "backup"));
    assert.ok(backups.length >= 1, "写前备份存在");
    const backupMode = (await stat(join(dir, "backup", backups[0]))).mode & 0o777;
    assert.equal(backupMode, 0o600, "备份同样 0600");

    const audit = await readFile(join(dir, "audit.jsonl"), "utf-8");
    const lines = audit.split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "两次写 = 两行审计");
    const row = projectAuditRow(JSON.parse(lines[0]));
    assert.equal(row?.op, "bind");
    assert.equal(row?.groupId, "syn-g1@chatroom");
    assert.equal(row?.ok, true);

    const view = await store.loadBindings();
    assert.equal(view.total, 2);
    assert.deepEqual(view.entries.map((e) => e.groupId).sort(), ["syn-g1@chatroom", "syn-g2@chatroom"]);
  });
});

test("store.putBinding: 同群 upsert；deleteBinding 移除并对不存在如实 binding_not_found", async () => {
  await withTempDir(async (dir) => {
    const store = createWechatStore(dir);
    await store.putBinding({ groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "" });
    const again = await store.putBinding({ groupId: "syn-g1@chatroom", custKeys: [], note: "清绑定" });
    assert.equal(again.total, 1, "同群覆盖不新增");
    assert.deepEqual(again.entries[0].custKeys, []);

    const deleted = await store.deleteBinding("syn-g1@chatroom");
    assert.equal(deleted.total, 0);
    await assert.rejects(
      () => store.deleteBinding("syn-g1@chatroom"),
      (error: unknown) => error instanceof WechatBridgeError && error.code === "binding_not_found",
      "重复解绑如实 404 语义",
    );
    const tail = await store.readAuditTail(10);
    assert.deepEqual(tail.map((r) => r.op), ["unbind", "bind", "bind"], "审计最新在前");
  });
});

test("store: 坏台账如实空表不猜；单飞锁并发第二笔 wechat_busy；写失败 wechat_store_failed", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "bindings.json"), "{ 坏 JSON");
    const store = createWechatStore(dir);
    const view = await store.loadBindings();
    assert.equal(view.total, 0, "损坏台账如实空表");
    const p1 = store.putBinding({ groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "" });
    const p2 = store.putBinding({ groupId: "syn-g2@chatroom", custKeys: [], note: "" });
    await assert.rejects(
      () => p2,
      (error: unknown) => error instanceof WechatBridgeError && error.code === "wechat_busy",
      "在飞写入时第二笔如实 busy",
    );
    await p1;
    const after = await store.loadBindings();
    assert.equal(after.total, 1);
    const backups = await readdir(join(dir, "backup"));
    assert.ok(backups.length >= 1, "坏文件也被备份后才覆盖（可恢复）");

    const brokenFile = join(dir, "not-a-dir");
    await writeFile(brokenFile, "x");
    const brokenStore = createWechatStore(brokenFile);
    await assert.rejects(
      () => brokenStore.putBinding({ groupId: "syn-g3@chatroom", custKeys: [], note: "" }),
      (error: unknown) => error instanceof WechatBridgeError && error.code === "wechat_store_failed",
      "目录不可写如实 store_failed",
    );
  });
});

test("store.saveCustorgMerge: 按客户键合并（未出现的保留、出现的整体替换），0600 + 审计", async () => {
  await withTempDir(async (dir) => {
    const store = createWechatStore(dir);
    const first = parseCustorgImport(JSON.stringify({ "甲科技（合成）": [{ dept: "研发部", name: "合成张三" }] }));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const saved = await store.saveCustorgMerge(first.customers, { customers: 1, rows: 1 });
    assert.equal(saved.totalCustomers, 1);
    const mode = (await stat(join(dir, "custorg.json"))).mode & 0o777;
    assert.equal(mode, 0o600);

    const second = parseCustorgImport(JSON.stringify({
      "甲科技（合成）": [{ dept: "新研发部", name: "合成张三三" }],
      "乙咨询（合成）": [{ dept: "交付部", name: "合成李四" }],
    }));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const merged = await store.saveCustorgMerge(second.customers, { customers: 2, rows: 2 });
    assert.equal(merged.totalCustomers, 2);
    assert.equal(merged.totalRows, 2, "甲被整体替换成 1 行 + 乙 1 行");
    const loaded = await store.loadCustorg();
    assert.equal(loaded.customers["甲科技（合成）"].items[0].dept, "新研发部");

    const tail = await store.readAuditTail(10);
    assert.equal(tail[0].op, "custorg-import");
    assert.equal(tail[0].customers, 2);
    assert.equal(tail[0].rows, 2);
  });
});

test("projectBindingEntry: 白名单投影，坏行返回 null", () => {
  const ok = projectBindingEntry({ groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "n", updatedAt: "2026" });
  assert.equal(ok?.groupId, "syn-g1@chatroom");
  assert.equal(projectBindingEntry(null), null);
  assert.equal(projectBindingEntry({ groupId: "", custKeys: [] }), null, "缺 groupId 丢弃");
  assert.equal(projectBindingEntry({ groupId: "syn-g1@chatroom", custKeys: "不是数组" }), null);
  const deep = projectBindingEntry({ groupId: "syn-g1@chatroom", custKeys: ["甲", 42, { a: 1 }, "乙"], note: 7, updatedAt: "t" });
  assert.deepEqual(deep?.custKeys, ["甲", "乙"], "非字符串键剔除");
});
