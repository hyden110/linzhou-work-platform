import assert from "node:assert/strict";
import test from "node:test";

import {
  custorgImportConfirm,
  custorgImportDry,
  deleteWechatBinding,
  fetchWechatBindings,
  fetchWechatCustorg,
  fetchWechatSnapshot,
  fetchWechatTree,
  putWechatBinding,
  wechatErrorMessage,
  WechatClientError,
} from "./wechat-client.ts";
import type { WechatSnapshotOkView } from "./wechat-model.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：桥响应用假 fetch 注入（群名「合成群X」、客户「甲科技（合成）」、
// 掩码 id wxid…xxxxxx）——零真实网络、零真实微信数据。
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function fakeFetch(payload: unknown, status = 200, sink?: CapturedRequest[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === "string" || input instanceof URL
      ? new Request(input.toString(), init)
      : input;
    const raw = await request.clone().text().catch(() => "");
    let body: unknown;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    sink?.push({ method: request.method, url: request.url, body });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

const OK_SNAPSHOT = {
  ok: true,
  data: {
    status: "ok",
    version: 1,
    updatedAt: "2026-10-19T08:00:00.000Z",
    meName: "合成我",
    source: { dbs: 3, tables: 10, messages: 500, groups: 2, singles: 1, window: 90 },
    stats: {
      groups: 2, groupsActive7: 1, groupsActive30: 2, groupsMine7: 1, custBound: 1,
      atMeAll: 3, atMe30: 2, todos: 1, todosHigh: 1, unread: 4, singleUnreplied: 1, messages: 500,
    },
    groups: [
      {
        id: "syn-g1@chatroom", name: "合成群A", memberCount: 12, muted: true, unread: 3,
        lastMsgAt: 1_760_000_000, lastSummaryMasked: "这是一条非常长的合成消息正文用于验…",
        custKeys: ["甲科技（合成）"], customerStatus: "matched", bindNote: "",
        msg: { d7: 5, d30: 40, dWin: 60, all: 200 }, senders: { d7: 3, d30: 8, all: 11 },
        mine: { d7: 1, d30: 4, all: 30, lastAt: 1_759_999_900 },
        atMe: { all: 3, lastAt: 1_759_999_950, daysSince: 1, unreplied: true },
        recentAtMe: [{ t: 1_759_999_950, name: "合成同事", textMasked: "这是一条非常长的合成消息正文用于验…" }],
      },
      { name: "坏行没有 id（合成）" },
      null,
    ],
    todos: [
      { groupId: "syn-g1@chatroom", groupName: "合成群A", custKeys: ["甲科技（合成）"], urgency: "high", daysSince: 1, at: 1_759_999_950, fromName: "合成同事", textMasked: "这是一条非常长的合成消息正文用于验…" },
      { groupId: "", urgency: "not-an-urgency" },
    ],
    mentions: [
      { kind: "at", t: 1_759_999_950, convId: "syn-g1@chatroom", convName: "合成群A", group: true, custKeys: ["甲科技（合成）"], fromName: "合成同事", textMasked: "掩码…", unread: true },
      { kind: "不是枚举值", t: 1 },
    ],
    singles: [
      { idMasked: "wxid…ab12cd", name: "合成联系人", muted: false, msg: { d7: 2, d30: 6, all: 20 }, lastMsgAt: 1_759_999_940, unread: 1, lastSummaryMasked: "掩码…", unreplied: true },
    ],
    labels: [{ id: 1, name: "合成标签" }, { id: "坏行" }],
  },
};

test("fetchWechatSnapshot: ok 投影——坏行丢弃、未知枚举如实降级、白名单字段保留", async () => {
  const view = await fetchWechatSnapshot(fakeFetch(OK_SNAPSHOT));
  assert.equal(view.status, "ok");
  if (view.status !== "ok") return;
  const ok = view as WechatSnapshotOkView;
  assert.equal(ok.groups.length, 1, "缺 id / null 行丢弃");
  assert.equal(ok.groups[0].id, "syn-g1@chatroom");
  assert.equal(ok.groups[0].atMe.unreplied, true);
  assert.equal(ok.todos.length, 1, "缺 groupId / 坏 urgency 的 todo 行丢弃");
  assert.equal(ok.mentions.length, 1, "kind 不在白名单的 mention 丢弃");
  assert.equal(ok.singles.length, 1);
  assert.equal(ok.labels.length, 1, "id 非数字的 label 丢弃");
  assert.equal(ok.stats.custBound, 1);
  assert.equal(ok.meName, "合成我");
  assert.equal(ok.source.window, 90);
});

test("fetchWechatSnapshot: missing 态透传（指引步骤不丢），未知 status → invalid_response", async () => {
  const missing = await fetchWechatSnapshot(fakeFetch({
    ok: true,
    data: { status: "missing", missingNote: "快照文件尚未生成：合成指引。", steps: ["步骤一", "步骤二", "步骤三"] },
  }));
  assert.equal(missing.status, "missing");
  if (missing.status !== "missing") return;
  assert.equal(missing.steps.length, 3);
  assert.ok(missing.missingNote.includes("尚未生成"));

  await assert.rejects(
    () => fetchWechatSnapshot(fakeFetch({ ok: true, data: { status: "半真半假" } })),
    (error: unknown) => error instanceof WechatClientError && error.code === "invalid_response",
  );
  await assert.rejects(
    () => fetchWechatSnapshot(fakeFetch({ ok: true })),
    (error: unknown) => error instanceof WechatClientError && error.code === "invalid_response",
  );
});

test("错误分层：已知错误码保留 code+detail，未知码/网络失败一律 unavailable", async () => {
  await assert.rejects(
    () => fetchWechatBindings(fakeFetch({ ok: false, error: { code: "wechat_busy", message: "台账写入进行中。" } }, 409)),
    (error: unknown) => error instanceof WechatClientError && error.code === "wechat_busy" && error.detail === "台账写入进行中。",
  );
  await assert.rejects(
    () => fetchWechatBindings(fakeFetch({ ok: false, error: { code: "内部私有码" } }, 500)),
    (error: unknown) => error instanceof WechatClientError && error.code === "unavailable",
  );
  const networkFail: typeof fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(
    () => fetchWechatSnapshot(networkFail),
    (error: unknown) => error instanceof WechatClientError && error.code === "unavailable",
  );
});

test("fetchWechatBindings: 台账行白名单投影，坏行/坏审计行丢弃", async () => {
  const view = await fetchWechatBindings(fakeFetch({
    ok: true,
    data: {
      updatedAt: "2026-10-19T10:00:00.000Z",
      entries: [
        { groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "合成项目群", updatedAt: "2026-10-19T09:00:00.000Z" },
        { groupId: "", custKeys: [] },
        { groupId: "syn-g2@chatroom", custKeys: "不是数组" },
      ],
      total: 1,
      auditTail: [
        { at: "2026-10-19T09:00:00.000Z", op: "bind", groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "", customers: 0, rows: 0, ok: true },
        { at: "x", op: "删除库", groupId: "y" },
      ],
    },
  }));
  assert.equal(view.entries.length, 1);
  assert.equal(view.total, 1);
  assert.equal(view.auditTail.length, 1);
  assert.equal(view.auditTail[0].op, "bind");
});

test("putWechatBinding / deleteWechatBinding: 方法、路径与 JSON body 正确", async () => {
  const sink: CapturedRequest[] = [];
  const payload = { ok: true, data: { updatedAt: "t", entries: [], total: 0, auditTail: [] } };
  await putWechatBinding({ groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "合成项目群" }, fakeFetch(payload, 200, sink));
  assert.equal(sink[0].method, "PUT");
  assert.ok(sink[0].url.endsWith("/local/wechat/bindings"));
  assert.deepEqual(sink[0].body, { groupId: "syn-g1@chatroom", custKeys: ["甲科技（合成）"], note: "合成项目群" });

  await deleteWechatBinding("syn-g1@chatroom", fakeFetch(payload, 200, sink));
  assert.equal(sink[1].method, "DELETE");
  assert.deepEqual(sink[1].body, { groupId: "syn-g1@chatroom" });
});

test("custorgImportDry / custorgImportConfirm: dry 只带 text；confirm 自动补 confirm === token；坏 token → invalid_response", async () => {
  const sink: CapturedRequest[] = [];
  const dry = await custorgImportDry("客户,姓名\n甲科技（合成）,合成张三", fakeFetch({
    ok: true,
    data: {
      phase: "dry", token: "0123456789abcdef", customerCount: 1, rowCount: 1,
      willImport: [{ key: "甲科技（合成）", incomingRows: 1, existingRows: 0 }], willOverwrite: [], note: "确认后写入本地 custorg.json。",
    },
  }, 200, sink));
  assert.equal(dry.phase, "dry");
  assert.equal(sink[0].method, "POST");
  assert.deepEqual(sink[0].body, { text: "客户,姓名\n甲科技（合成）,合成张三" }, "dry 绝不带 confirm");
  assert.equal(dry.willImport[0].key, "甲科技（合成）");

  const confirmed = await custorgImportConfirm({ text: "客户,姓名\n甲科技（合成）,合成张三", token: "0123456789abcdef" }, fakeFetch({
    ok: true,
    data: { phase: "confirmed", token: "0123456789abcdef", customerCount: 1, rowCount: 1, totalCustomers: 1, totalRows: 1, updatedAt: "2026-10-19T10:00:00.000Z" },
  }, 200, sink));
  assert.equal(confirmed.phase, "confirmed");
  assert.deepEqual(sink[1].body, { text: "客户,姓名\n甲科技（合成）,合成张三", token: "0123456789abcdef", confirm: "0123456789abcdef" });

  await assert.rejects(
    () => custorgImportDry("x", fakeFetch({ ok: true, data: { phase: "dry", token: "不是十六进制", customerCount: 1, rowCount: 1, willImport: [], willOverwrite: [], note: "" } })),
    (error: unknown) => error instanceof WechatClientError && error.code === "invalid_response",
    "token 形态不符整包拒绝（不半真半假）",
  );
});

test("fetchWechatTree: 节点白名单投影，坏 kind/坏 children 丢弃；missing 态 nodes 空数组透传", async () => {
  const view = await fetchWechatTree(fakeFetch({
    ok: true,
    data: {
      status: "ok", missingNote: "", steps: [],
      nodes: [
        { key: "甲科技（合成）", name: "甲科技（合成）", kind: "cust", groups: 1, awaiting: 1, msgD30: 40, children: [{ groupId: "syn-g1@chatroom", name: "合成群A", custKeys: ["甲科技（合成）"], unreplied: true, atMeAll: 3, msgD30: 40, muted: true }] },
        { key: "坏节点", kind: "root" },
      ],
    },
  }));
  assert.equal(view.status, "ok");
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].children.length, 1);

  const missing = await fetchWechatTree(fakeFetch({ ok: true, data: { status: "missing", missingNote: "尚未生成", steps: ["a", "b", "c"], nodes: [] } }));
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.nodes, []);
});

test("wechatErrorMessage: 错误码 → 可直接展示的诚实中文文案，detail 组合不复读", async () => {
  assert.ok(wechatErrorMessage(new WechatClientError("unavailable")).includes("本地"));
  assert.ok(wechatErrorMessage(new WechatClientError("wechat_busy")).includes("进行中"));
  assert.ok(wechatErrorMessage(new WechatClientError("confirm_mismatch")).includes("token"));
  assert.ok(wechatErrorMessage(new WechatClientError("binding_not_found")).includes("台账"));
  assert.ok(wechatErrorMessage(new WechatClientError("wechat_store_failed")).includes("0600") || wechatErrorMessage(new WechatClientError("wechat_store_failed")).includes("写入"));
  const composed = wechatErrorMessage(new WechatClientError("wechat_invalid_request", "请求体不是合法 JSON。"));
  assert.ok(composed.includes("请求体不是合法 JSON。"), "detail 具体原因不丢");
  assert.ok(composed.length > "请求体不是合法 JSON。".length, "base 概括在前");
  const base = wechatErrorMessage(new WechatClientError("unavailable"));
  const firstSentence = base.split("：")[0];
  assert.equal(
    wechatErrorMessage(new WechatClientError("unavailable", `${firstSentence}：桥侧补充细节`)),
    base,
    "detail 首句与 base 相同则不复读（composeErrorMessage 口径）",
  );
  assert.ok(wechatErrorMessage(new Error("随便什么")).length > 0, "非 WechatClientError 也如实给文案");
});

test("fetchWechatCustorg: 台账白名单投影——坏客户/坏行丢弃、计数按投影后重算、name 缺失回落 key", async () => {
  const sink: CapturedRequest[] = [];
  const view = await fetchWechatCustorg(fakeFetch({
    ok: true,
    data: {
      updatedAt: "2026-10-20T10:00:00.000Z",
      totalCustomers: 99, totalRows: 99, // 服务端计数不可信：客户端按投影后实际行数重算
      customers: [
        {
          key: "甲科技（合成）", name: "", rowCount: 5,
          rows: [
            { dept: "研发部", name: "合成张三", title: "架构师", contact: "syn-zhang@example.test" },
            "坏行",
            { dept: "", name: "", title: "", contact: "" },
          ],
        },
        { key: "", name: "无键客户", rows: [{ dept: "研发部", name: "合成李四" }] },
        "整条不是对象",
      ],
    },
  }, 200, sink));
  assert.equal(sink[0].method, "GET");
  assert.ok(sink[0].url.endsWith("/local/wechat/custorg"));
  assert.equal(sink[0].body, undefined, "只读 GET 不带 body");
  assert.equal(view.updatedAt, "2026-10-20T10:00:00.000Z");
  assert.equal(view.customers.length, 1, "无 key 的客户与非对象项整条丢弃");
  assert.equal(view.customers[0].name, "甲科技（合成）", "name 空回落 key");
  assert.deepEqual(view.customers[0].rows, [{ dept: "研发部", name: "合成张三", title: "架构师", contact: "syn-zhang@example.test" }]);
  assert.equal(view.customers[0].rowCount, 1, "rowCount 与投影后明细自洽（不信服务端 5）");
  assert.equal(view.totalCustomers, 1);
  assert.equal(view.totalRows, 1);
});

test("fetchWechatCustorg: 空台账如实空数组，绝不补样例行；桥侧故障走错误码文案", async () => {
  const empty = await fetchWechatCustorg(fakeFetch({ ok: true, data: { updatedAt: "", customers: [], totalCustomers: 0, totalRows: 0 } }));
  assert.deepEqual(empty, { updatedAt: "", customers: [], totalCustomers: 0, totalRows: 0 });

  await assert.rejects(
    () => fetchWechatCustorg(fakeFetch({ ok: false, error: { code: "wechat_unavailable", message: "微信台账服务遇到未知故障，请稍后重试。" } }, 502)),
    (error: unknown) => error instanceof WechatClientError && error.code === "wechat_unavailable",
    "桥侧 502 如实抛错误码（不静默当空台账）",
  );
  assert.ok(wechatErrorMessage(new WechatClientError("wechat_unavailable")).includes("稍后重试"));
});
