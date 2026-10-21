import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchFeishuLedger,
  fetchFeishuLedgerRefresh,
  feishuErrorMessage,
  FeishuClientError,
} from "./feishu-client.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：桥响应用假 fetch 注入（群名「合成群X」、发送人「合成同事」、
// 掩码 id ou…xxxx）——零真实网络、零真实飞书数据。
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

const OK_LEDGER = {
  ok: true,
  data: {
    status: "ok",
    updatedAt: "2026-10-20T08:00:00.000Z",
    cli: { found: true, path: "/Users/syn/.qoderwork/bin/lark-cli", version: "1.2.3" },
    auth: { identity: "user", userName: "合成用户", tokenStatus: "valid", loginCommand: "lark-cli auth login", note: "" },
    summary: { groups: 2, p2p: 1, external: 1, atMe: 3, tasksOpen: 2, tasksDueToday: 1, tasksOverdue: 0 },
    chats: [
      { chatId: "oc_syn_g1", name: "合成群A", mode: "group", external: true, status: "active", ownerIdMasked: "ou…a1b2", peerName: "" },
      { chatId: "oc_syn_topic", name: "合成话题群", mode: "不是枚举值", external: false, status: "", ownerIdMasked: "ou…c3d4", peerName: "" },
      { chatId: "oc_syn_p2p", name: "", mode: "p2p", external: false, status: "", ownerIdMasked: "", peerName: "合成同事" },
      { name: "坏行没有 chatId（合成）" },
      null,
    ],
    atMe: [
      { messageId: "om_syn_1", chatId: "oc_syn_g1", chatName: "合成群A", chatType: "group", senderName: "合成同事", senderIdMasked: "ou…e5f6", createdAt: "2026-10-20T07:59:00.000Z", preview: "这是一条非常长的合成消息正文用于验证…", deleted: false },
      { messageId: "om_syn_2", chatId: "oc_syn_p2p", chatName: "合成同事", chatType: "坏枚举", senderName: "合成同事", senderIdMasked: "ou…e5f6", createdAt: "2026-10-20T07:58:00.000Z", preview: "合成的已撤回消息", deleted: true },
      { messageId: "", chatId: "oc_syn_g1" },
      "整行不是对象",
    ],
    tasks: [
      { guid: "syn-task-1", summary: "合成待办：跟进项目进度", dueAt: "2026-10-20T18:00:00.000Z", createdAt: "2026-10-19T10:00:00.000Z", overdue: false, dueToday: true },
      { guid: "syn-task-2", summary: "合成待办：逾期示例", dueAt: "2026-10-18T18:00:00.000Z", createdAt: "2026-10-17T10:00:00.000Z", overdue: true, dueToday: false },
      { summary: "坏任务没有 guid（合成）" },
    ],
    sectionErrors: { chats: "", atMe: "合成部分失败：任务区抓取超时", tasks: 42 },
  },
};

test("fetchFeishuLedger: ok 投影——坏行丢弃、未知枚举如实降级、计数透传、GET 只读", async () => {
  const sink: CapturedRequest[] = [];
  const view = await fetchFeishuLedger(fakeFetch(OK_LEDGER, 200, sink));
  assert.equal(sink[0].method, "GET");
  assert.ok(sink[0].url.endsWith("/local/feishu"));
  assert.equal(sink[0].body, undefined, "只读 GET 不带 body");

  assert.equal(view.status, "ok");
  assert.equal(view.updatedAt, "2026-10-20T08:00:00.000Z");
  assert.equal(view.cli.found, true);
  assert.equal(view.cli.path, "/Users/syn/.qoderwork/bin/lark-cli");
  assert.equal(view.auth.identity, "user");
  assert.equal(view.auth.tokenStatus, "valid");

  // summary 计数原样透传
  assert.deepEqual(
    { ...view.summary },
    { groups: 2, p2p: 1, external: 1, atMe: 3, tasksOpen: 2, tasksDueToday: 1, tasksOverdue: 0 },
  );

  assert.equal(view.chats.length, 3, "缺 chatId / null 行丢弃");
  assert.equal(view.chats[0].external, true);
  assert.equal(view.chats[1].mode, "group", "未知 mode 枚举如实降级为 group");
  assert.equal(view.chats[2].peerName, "合成同事");

  assert.equal(view.atMe.length, 2, "缺 messageId / 非对象行丢弃");
  assert.equal(view.atMe[1].chatType, "group", "未知 chatType 枚举如实降级为 group");
  assert.equal(view.atMe[1].deleted, true);

  assert.equal(view.tasks.length, 2, "缺 guid 的 task 行丢弃");
  assert.equal(view.tasks[0].dueToday, true);
  assert.equal(view.tasks[1].overdue, true);

  // sectionErrors 只认字符串值：非字符串键整键丢弃，不半真半假
  assert.equal(view.sectionErrors.atMe, "合成部分失败：任务区抓取超时");
  assert.equal(view.sectionErrors.chats, "");
  assert.ok(!("tasks" in view.sectionErrors), "非字符串的 sectionErrors.tasks 不进投影");
});

test("fetchFeishuLedgerRefresh: 走 /local/feishu/refresh，同口径投影", async () => {
  const sink: CapturedRequest[] = [];
  const view = await fetchFeishuLedgerRefresh(fakeFetch(OK_LEDGER, 200, sink));
  assert.equal(sink[0].method, "GET");
  assert.ok(sink[0].url.endsWith("/local/feishu/refresh"));
  assert.equal(sink[0].body, undefined);
  assert.equal(view.status, "ok");
  assert.equal(view.chats.length, 3);
});

test("fetchFeishuLedger: auth_required / cli_missing 态透传（指引字段一个不丢）", async () => {
  const authRequired = await fetchFeishuLedger(fakeFetch({
    ok: true,
    data: {
      status: "auth_required",
      updatedAt: "2026-10-20T08:00:00.000Z",
      cli: { found: true, path: "/Users/syn/.qoderwork/bin/lark-cli", version: "1.2.3" },
      auth: { identity: "bot", userName: "", tokenStatus: "expired", loginCommand: "lark-cli auth login --recommend", note: "合成提示：user_access_token 已过期。" },
      summary: { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 },
      chats: [], atMe: [], tasks: [], sectionErrors: {},
    },
  }));
  assert.equal(authRequired.status, "auth_required");
  assert.equal(authRequired.auth.identity, "bot");
  assert.equal(authRequired.auth.tokenStatus, "expired");
  assert.equal(authRequired.auth.loginCommand, "lark-cli auth login --recommend");
  assert.ok(authRequired.auth.note.includes("过期"));

  const cliMissing = await fetchFeishuLedger(fakeFetch({
    ok: true,
    data: {
      status: "cli_missing",
      updatedAt: "",
      cli: { found: false, path: "", version: "" },
      auth: { identity: "none", userName: "", tokenStatus: "missing", loginCommand: "", note: "" },
      summary: { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 },
      chats: [], atMe: [], tasks: [], sectionErrors: {},
    },
  }));
  assert.equal(cliMissing.status, "cli_missing");
  assert.equal(cliMissing.cli.found, false);
  assert.equal(cliMissing.auth.identity, "none");
  assert.equal(cliMissing.auth.tokenStatus, "missing", "未知 tokenStatus 也会降级 missing，这里本来就是 missing");

  // 未知 identity 枚举如实降级 none
  const downgraded = await fetchFeishuLedger(fakeFetch({
    ok: true,
    data: {
      status: "auth_required", updatedAt: "", cli: {}, auth: { identity: "不是枚举", tokenStatus: "不是枚举" },
      summary: {}, chats: [], atMe: [], tasks: [], sectionErrors: {},
    },
  }));
  assert.equal(downgraded.auth.identity, "none");
  assert.equal(downgraded.auth.tokenStatus, "missing");
});

test("fetchFeishuLedger: data 形态不符整包 invalid_response，绝不半真半假", async () => {
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: true, data: { ...OK_LEDGER.data, status: "半真半假" } })),
    (error: unknown) => error instanceof FeishuClientError && error.code === "invalid_response",
    "未知 status → 整包拒绝",
  );
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: true })),
    (error: unknown) => error instanceof FeishuClientError && error.code === "invalid_response",
    "缺 data → 整包拒绝",
  );
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: true, data: "不是对象" })),
    (error: unknown) => error instanceof FeishuClientError && error.code === "invalid_response",
  );
});

test("错误分层：已知错误码保留 code+detail，未知码/网络失败一律 unavailable", async () => {
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: false, error: { code: "feishu_cli_failed", message: "lark-cli 退出码 1。" } }, 502)),
    (error: unknown) => error instanceof FeishuClientError && error.code === "feishu_cli_failed" && error.detail === "lark-cli 退出码 1。",
  );
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: false, error: { code: "auth_required", message: "user 身份未授权。" } }, 401)),
    (error: unknown) => error instanceof FeishuClientError && error.code === "auth_required",
  );
  await assert.rejects(
    () => fetchFeishuLedger(fakeFetch({ ok: false, error: { code: "内部私有码" } }, 500)),
    (error: unknown) => error instanceof FeishuClientError && error.code === "unavailable",
  );
  const networkFail: typeof fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(
    () => fetchFeishuLedger(networkFail),
    (error: unknown) => error instanceof FeishuClientError && error.code === "unavailable",
  );
});

test("feishuErrorMessage: 错误码 → 可直接展示的诚实中文文案，detail 组合不复读", async () => {
  assert.ok(feishuErrorMessage(new FeishuClientError("unavailable")).includes("本地桥未启动"));
  assert.ok(feishuErrorMessage(new FeishuClientError("invalid_response")).includes("无法识别"));

  const cliMissing = feishuErrorMessage(new FeishuClientError("cli_missing"));
  assert.ok(cliMissing.includes("lark-cli"), "cli_missing 点名 lark-cli");
  assert.ok(cliMissing.includes("FEISHU_CLI_PATH"), "cli_missing 给发现顺序");
  assert.ok(cliMissing.includes("~/.qoderwork/bin/lark-cli"));
  assert.ok(cliMissing.includes("~/.qwenworkcn/bin/lark-cli"));
  assert.ok(cliMissing.includes("PATH"));

  const authRequired = feishuErrorMessage(new FeishuClientError("auth_required"));
  assert.ok(authRequired.includes("未授权或已过期"));
  assert.ok(authRequired.includes("登录") && authRequired.includes("刷新"));

  assert.ok(feishuErrorMessage(new FeishuClientError("feishu_cli_failed")).includes("lark-cli 调用失败"));
  assert.ok(feishuErrorMessage(new FeishuClientError("method_not_allowed")).includes("请求方式"));

  const composed = feishuErrorMessage(new FeishuClientError("feishu_cli_failed", "lark-cli 退出码 1。"));
  assert.ok(composed.includes("lark-cli 退出码 1。"), "detail 具体原因不丢");
  assert.ok(composed.length > "lark-cli 退出码 1。".length, "base 概括在前");

  const base = feishuErrorMessage(new FeishuClientError("unavailable"));
  const firstSentence = base.split("：")[0];
  assert.equal(
    feishuErrorMessage(new FeishuClientError("unavailable", `${firstSentence}：桥侧补充细节`)),
    base,
    "detail 首句与 base 相同则不复读（composeErrorMessage 口径）",
  );
  assert.ok(feishuErrorMessage(new Error("随便什么")).length > 0, "非 FeishuClientError 也如实给文案");
});
