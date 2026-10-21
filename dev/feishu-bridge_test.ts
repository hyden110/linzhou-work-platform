import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFeishuBridge,
  defaultFeishuCandidates,
  discoverFeishuCli,
  extractPreview,
  FEISHU_LOGIN_COMMAND,
  FEISHU_ROUTES,
  maskFeishuId,
  runReadonlyJson,
  truncatePreview,
} from "./feishu-bridge.ts";
import type { FeishuLedgerView, FeishuRunner } from "./feishu-bridge.ts";

// ---------------------------------------------------------------------------
// 全合成夹具：注入 runner + 临时目录假 CLI 文件（群名「合成群X」、人名「合成同事」、
// 任务「合成任务：X」、id ou_syn*）——零真实 lark-cli 调用、零网络、零真实用户数据。
// ---------------------------------------------------------------------------

const BASE_URL = "http://127.0.0.1:8788";
/** 本机时区 2026-10-20 12:00 —— dueToday/overdue 边界以此为准。 */
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
const LONG_TEXT = "这是一条非常长的合成消息正文用于验证预览截断到六十个字符以内超出后只追加一个省略号绝不出全文这段文本必须超过六十个字符才能触发截断";

const VERSION_STDOUT = "lark-cli version v1.0.45.1\n";

const AUTH_READY = JSON.stringify({
  identities: {
    user: { status: "ready", available: true, userName: "合成用户", scope: "im:chat:read" },
    bot: { status: "ready", available: true },
  },
  identity: "user",
  note: "Both identities ready.",
  _notice: "未知键应被忽略",
});

const AUTH_EXPIRED = JSON.stringify({
  identities: {
    user: {
      status: "missing", available: false, userName: "合成用户", tokenStatus: "expired",
      openId: "ou_syntheticOPENID00abcd12", scope: "im:chat:read",
    },
    bot: { status: "ready", available: true },
  },
  identity: "bot",
  note: "User identity is missing; run `lark-cli auth login` to enable user identity.",
});

const CHATS_PAYLOAD = JSON.stringify({
  _notice: "合成通知（未知键忽略）",
  data: {
    items: [
      {
        chat_id: "oc_syn_g1", name: "合成群A", description: "合成群描述（不应出桥）",
        owner_id: "ou_synowner0000ef34", external: true, chat_status: "active", chat_mode: "group",
      },
      {
        chat_id: "oc_syn_topic", name: "合成话题群", owner_id: "ou_syntopic0000ab99",
        external: false, chat_status: "active", chat_mode: "topic",
      },
      {
        chat_id: "oc_syn_p2p", name: "合成同事", owner_id: "", external: false,
        chat_status: "active", chat_mode: "p2p", p2p_target_type: "user", p2p_target_id: "ou_synpeer0000wx12",
      },
      { chat_id: "oc_syn_weird", name: "合成未知模式群", chat_mode: "不是枚举值", owner_id: "", external: false, chat_status: "" },
      { name: "坏行没有 chat_id（合成）" },
      "整行不是对象",
    ],
  },
});

const dueSec = (d: Date): string => String(Math.floor(d.getTime() / 1000));
const msStr = (d: Date): string => String(d.getTime());

const ATME_PAYLOAD = JSON.stringify({
  data: {
    items: [
      {
        message_id: "om_syn_1", msg_type: "text", create_time: msStr(new Date(2026, 9, 20, 7, 59, 0)),
        sender: { name: "合成同事", id: "ou_synsender0000aa11", sender_type: "user" },
        content: JSON.stringify({ text: LONG_TEXT }),
        chat_id: "oc_syn_g1", chat_type: "group", chat_name: "合成群A",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_synme0000000000zz99" } }],
        deleted: false, updated: false,
      },
      {
        message_id: "om_syn_2", msg_type: "post", create_time: msStr(new Date(2026, 9, 20, 8, 30, 0)),
        sender: { name: "合成同事乙", open_id: "ou_synsender2000bb22" },
        content: JSON.stringify({ title: "合成富文本标题", content: [[{ tag: "text", text: "合成首段正文" }]] }),
        chat_id: "oc_syn_p2p", chat_type: "p2p", chat_name: "合成同事", deleted: false,
      },
      {
        message_id: "om_syn_3", msg_type: "image", create_time: msStr(new Date(2026, 9, 20, 9, 0, 0)),
        sender: { name: "合成同事", id: "ou_synsender0000aa11" },
        content: JSON.stringify({ image_key: "img_syn_1" }),
        chat_id: "oc_syn_g1", chat_type: "group", chat_name: "合成群A", deleted: false,
      },
      {
        message_id: "om_syn_4", msg_type: "interactive", create_time: msStr(new Date(2026, 9, 20, 9, 30, 0)),
        sender: { name: "合成机器人", id: "ou_synbot0000000cc33" },
        content: JSON.stringify({ title: "合成卡片（正文不应出桥）" }),
        chat_id: "oc_syn_g1", chat_type: "group", chat_name: "合成群A", deleted: true,
      },
      { message_id: "", msg_type: "text", content: "{}" },
      "整行不是对象",
    ],
  },
});

const TASKS_PAYLOAD = JSON.stringify({
  data: {
    items: [
      {
        guid: "syn-task-1", summary: "合成任务：今日零点截止", due: { timestamp: dueSec(new Date(2026, 9, 20, 0, 0, 0)) },
        created_at: msStr(new Date(2026, 9, 19, 10, 0, 0)), completed_at: "",
      },
      {
        guid: "syn-task-2", summary: "合成任务：昨日截止已逾期", due: { timestamp: dueSec(new Date(2026, 9, 19, 23, 59, 59)) },
        created_at: msStr(new Date(2026, 9, 18, 10, 0, 0)), completed_at: "",
      },
      {
        guid: "syn-task-3", summary: "合成任务：明日零点(=今日24点)不算今天", due: { timestamp: dueSec(new Date(2026, 9, 21, 0, 0, 0)) },
        created_at: msStr(new Date(2026, 9, 19, 10, 0, 0)), completed_at: "",
      },
      { guid: "syn-task-4", summary: "合成任务：无截止时间", created_at: msStr(new Date(2026, 9, 19, 11, 0, 0)) },
      { guid: "syn-task-5", summary: "合成任务：已完成混入应丢弃", completed: true, completed_at: "1760000000" },
      { summary: "坏任务没有 guid（合成）" },
      "整行不是对象",
    ],
  },
});

/* ---------------- harness ---------------- */

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "feishu-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 临时目录里的假 CLI 文件（仅用于 fs 存在性发现，绝不执行）。 */
async function fakeCli(dir: string, name = "lark-cli"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\necho synthetic\n", { mode: 0o755 });
  return path;
}

type ScriptEntry = { readonly code: number; readonly stdout: string; readonly stderr: string };

/**
 * 合成 runner：按 argv 前缀路由到脚本；所有调用被记录进 calls。
 * 未脚本化的命令如实回 code 99（测试断言它绝不出现）。
 */
function makeRunner(script: Record<string, ScriptEntry>, calls: string[][] = []): FeishuRunner {
  return async (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    for (const [prefix, entry] of Object.entries(script)) {
      if (key === prefix || key.startsWith(`${prefix} `)) return entry;
    }
    return { code: 99, stdout: "", stderr: `unexpected command: ${key}` };
  };
}

const OK_SCRIPT: Record<string, ScriptEntry> = {
  "--version": { code: 0, stdout: VERSION_STDOUT, stderr: "" },
  "auth status": { code: 0, stdout: AUTH_READY, stderr: "" },
  "im +chat-list": { code: 0, stdout: CHATS_PAYLOAD, stderr: "" },
  "im +messages-search": { code: 0, stdout: ATME_PAYLOAD, stderr: "" },
  "task +get-my-tasks": { code: 0, stdout: TASKS_PAYLOAD, stderr: "" },
};

async function call(bridge: { handle: (r: Request) => Promise<Response | undefined> }, method: string, path: string): Promise<{ status: number; body: any }> {
  const response = await bridge.handle(new Request(BASE_URL + path, { method }));
  assert.ok(response, "本桥路径必须有响应（不回落 undefined）");
  return { status: response.status, body: await response.json() };
}

const countCalls = (calls: string[][], prefix: string): number =>
  calls.filter((args) => args.join(" ").startsWith(prefix)).length;

/* ---------------- 路由表 ---------------- */

test("FEISHU_ROUTES 路由表：两条只读 GET（聚合 + refresh）", () => {
  assert.deepEqual(
    FEISHU_ROUTES.map((r) => `${r.method} ${r.path}`),
    ["GET /local/feishu", "GET /local/feishu/refresh"],
  );
  assert.deepEqual(FEISHU_ROUTES.map((r) => r.operation), ["aggregate", "refresh"]);
});

/* ---------------- cli_missing 诚实态 ---------------- */

test("cli_missing：候选全不存在 → 200 status:cli_missing，sections 全空 + 三 sectionErrors，零 runner 调用", async () => {
  await withTempDir(async (dir) => {
    const calls: string[][] = [];
    const bridge = createFeishuBridge({
      candidates: [join(dir, "absent-a"), join(dir, "absent-b")],
      runner: makeRunner({}, calls),
      now: () => NOW,
    });
    const res = await call(bridge, "GET", "/local/feishu");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const data = res.body.data as FeishuLedgerView;
    assert.equal(data.status, "cli_missing");
    assert.deepEqual(data.cli, { found: false, path: "", version: "" });
    assert.equal(data.auth.identity, "none");
    assert.equal(data.auth.tokenStatus, "missing");
    assert.deepEqual(data.chats, []);
    assert.deepEqual(data.atMe, []);
    assert.deepEqual(data.tasks, []);
    assert.deepEqual(data.summary, { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 });
    for (const key of ["chats", "atMe", "tasks"] as const) {
      assert.ok(typeof data.sectionErrors[key] === "string" && data.sectionErrors[key], `${key} 区有诚实说明`);
    }
    assert.equal(calls.length, 0, "CLI 不存在时绝不跑任何命令");
    assert.ok(Number.isFinite(Date.parse(data.updatedAt)), "updatedAt 如实给聚合时间");
    assert.ok(!JSON.stringify(res.body).includes(dir), "响应不含服务器绝对路径");
  });
});

test("CLI 发现：candidates 取第一个存在的文件；defaultFeishuCandidates 顺序 env→qoderwork→qwenworkcn→PATH", async () => {
  await withTempDir(async (dir) => {
    const cliA = await fakeCli(dir, "cli-a");
    const cliB = await fakeCli(dir, "cli-b");
    assert.equal(discoverFeishuCli([join(dir, "absent"), cliB, cliA]), cliB, "第一个存在的胜出");
    assert.equal(discoverFeishuCli([join(dir, "absent")]), "", "全不存在如实空串");

    assert.deepEqual(
      defaultFeishuCandidates({ FEISHU_CLI_PATH: "/syn/env/lark-cli", PATH: `/syn/p1:/syn/p2` }, "/syn/home"),
      [
        "/syn/env/lark-cli",
        join("/syn/home", ".qoderwork", "bin", "lark-cli"),
        join("/syn/home", ".qwenworkcn", "bin", "lark-cli"),
        join("/syn/p1", "lark-cli"),
        join("/syn/p2", "lark-cli"),
      ],
    );
    const noEnv = defaultFeishuCandidates({}, "/syn/home");
    assert.equal(noEnv[0], join("/syn/home", ".qoderwork", "bin", "lark-cli"), "无 env 覆盖时 ~/.qoderwork 打头");
  });
});

/* ---------------- auth_required 诚实态 ---------------- */

test("auth_required：user token 过期 → 200 + loginCommand 可复制 + 零数据命令、探针 openId 不出桥", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const calls: string[][] = [];
    const bridge = createFeishuBridge({
      candidates: [cliPath],
      runner: makeRunner({
        "--version": { code: 0, stdout: VERSION_STDOUT, stderr: "" },
        "auth status": { code: 0, stdout: AUTH_EXPIRED, stderr: "" },
      }, calls),
      now: () => NOW,
    });
    const res = await call(bridge, "GET", "/local/feishu");
    assert.equal(res.status, 200);
    const data = res.body.data as FeishuLedgerView;
    assert.equal(data.status, "auth_required");
    assert.equal(data.cli.found, true);
    assert.equal(data.cli.version, "v1.0.45.1", "--version 输出去壳留版本号");
    assert.equal(data.auth.identity, "bot");
    assert.equal(data.auth.tokenStatus, "expired");
    assert.equal(data.auth.userName, "合成用户", "姓名保留（只掩 id 不掩名）");
    assert.equal(data.auth.loginCommand, FEISHU_LOGIN_COMMAND);
    assert.ok(data.auth.loginCommand.includes("--no-wait") && data.auth.loginCommand.includes("--scope"));
    assert.ok(data.auth.note.includes("登录"), "note 指引用户自行登录");
    assert.ok(data.auth.note.includes("不代跑") || data.auth.note.includes("绝不"), "note 说明桥不代跑登录");
    assert.deepEqual(data.chats, []);
    assert.deepEqual(data.atMe, []);
    assert.deepEqual(data.tasks, []);
    assert.deepEqual(data.summary, { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 });
    for (const key of ["chats", "atMe", "tasks"] as const) {
      assert.ok(typeof data.sectionErrors[key] === "string" && data.sectionErrors[key], `${key} 区说明为何没取数`);
    }
    assert.deepEqual(calls.map((args) => args.join(" ")), ["--version", "auth status"], "只跑版本与授权探针，零数据命令");
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("ou_syntheticOPENID00abcd12"), "探针 payload 的 openId 绝不出桥");
  });
});

/* ---------------- ok 态聚合投影 ---------------- */

test("ok 态聚合投影：白名单字段、掩码、≤60 截断、占位符、枚举降级、坏行丢弃、计数自洽", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const calls: string[][] = [];
    const bridge = createFeishuBridge({ candidates: [cliPath], runner: makeRunner(OK_SCRIPT, calls), now: () => NOW });
    const res = await call(bridge, "GET", "/local/feishu");
    assert.equal(res.status, 200);
    const data = res.body.data as FeishuLedgerView;
    assert.equal(data.status, "ok");
    assert.deepEqual(data.sectionErrors, {}, "全区成功不占 sectionErrors 键");
    assert.deepEqual(data.cli, { found: true, path: cliPath, version: "v1.0.45.1" });
    assert.equal(data.auth.identity, "user");
    assert.equal(data.auth.tokenStatus, "valid");
    assert.equal(data.auth.userName, "合成用户");

    // 数据命令 argv 契约（只读、--as user、--complete=false）
    assert.equal(countCalls(calls, "im +chat-list --as user --types p2p,group --sort-type ByActiveTimeDesc --page-size 50 --format json"), 1);
    assert.equal(countCalls(calls, "im +messages-search --as user --is-at-me --query  --page-size 20 --format json"), 1);
    assert.equal(countCalls(calls, "task +get-my-tasks --complete=false --page-limit 2 --format json"), 1);

    // chats：坏行丢弃（缺 chat_id / 非对象）、未知 mode 降级 group、description 不出桥
    assert.equal(data.chats.length, 4);
    assert.deepEqual(data.chats[0], {
      chatId: "oc_syn_g1", name: "合成群A", mode: "group", external: true,
      status: "active", ownerIdMasked: "ou…00ef34", peerName: "",
    });
    assert.equal(data.chats[1].mode, "topic");
    assert.equal(data.chats[2].mode, "p2p");
    assert.equal(data.chats[2].peerName, "合成同事");
    assert.equal(data.chats[2].ownerIdMasked, "", "空 owner 如实空串");
    assert.equal(data.chats[3].mode, "group", "未知 mode 枚举如实降级 group（与前端客户端同口径）");

    // atMe：截断、占位符、post 标题、deleted、坏行丢弃
    assert.equal(data.atMe.length, 4);
    assert.equal(data.atMe[0].preview.length, 61, "60 字 + 省略号");
    assert.ok(data.atMe[0].preview.endsWith("…"));
    assert.ok(LONG_TEXT.startsWith(data.atMe[0].preview.slice(0, 60)));
    assert.equal(data.atMe[0].senderName, "合成同事");
    assert.match(data.atMe[0].senderIdMasked, /^ou…[A-Za-z0-9]{6}$/);
    assert.equal(data.atMe[0].createdAt, new Date(2026, 9, 20, 7, 59, 0).toISOString(), "ms epoch 字符串归一 ISO");
    assert.equal(data.atMe[0].deleted, false);
    assert.equal(data.atMe[1].preview, "合成富文本标题", "post 取标题优先");
    assert.equal(data.atMe[2].preview, "[图片]");
    assert.equal(data.atMe[3].preview, "[卡片]");
    assert.equal(data.atMe[3].deleted, true);

    // summary 与投影行自洽
    assert.deepEqual(data.summary, {
      groups: 3, p2p: 1, external: 1, atMe: 4,
      tasksOpen: 4, tasksDueToday: 1, tasksOverdue: 1,
    });

    // 隐私红线：原始 id / 描述 / 全文 / mentions 内 open_id 一律不出桥
    const text = JSON.stringify(res.body);
    for (const secret of [
      "ou_synowner0000ef34", "ou_synsender0000aa11", "ou_synsender2000bb22",
      "ou_synpeer0000wx12", "ou_synme0000000000zz99", "ou_synbot0000000cc33",
      "合成群描述（不应出桥）", LONG_TEXT,
    ]) {
      assert.ok(!text.includes(secret), `响应不得包含 ${secret}`);
    }
  });
});

test("tasks 投影：dueToday/overdue 按本机时区当天 [00:00,24:00) 判定；completed/坏行丢弃", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const bridge = createFeishuBridge({ candidates: [cliPath], runner: makeRunner(OK_SCRIPT), now: () => NOW });
    const data = await bridge.aggregate();
    assert.equal(data.tasks.length, 4, "completed=true 与缺 guid 的行丢弃");
    const [t1, t2, t3, t4] = data.tasks;
    assert.equal(t1.guid, "syn-task-1");
    assert.equal(t1.dueToday, true, "今日 00:00 整落在 [00:00,24:00) 内");
    assert.equal(t1.overdue, false);
    assert.equal(t1.dueAt, new Date(2026, 9, 20, 0, 0, 0).toISOString(), "秒级 timestamp 归一 ISO");
    assert.equal(t2.overdue, true, "昨日截止 → 逾期");
    assert.equal(t2.dueToday, false);
    assert.equal(t3.dueToday, false, "明日 00:00（=今日 24:00）不算今天");
    assert.equal(t3.overdue, false);
    assert.equal(t4.dueAt, "", "无截止如实空串");
    assert.equal(t4.dueToday, false);
    assert.equal(t4.overdue, false, "无截止绝不算逾期");
    assert.equal(t1.createdAt, new Date(2026, 9, 19, 10, 0, 0).toISOString());
  });
});

/* ---------------- section 隔离与错误卫生 ---------------- */

test("section 隔离：atMe 非零退出 / chats 坏 JSON / tasks 超时——互不拖累，status 仍 ok", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const bridge = createFeishuBridge({
      candidates: [cliPath],
      now: () => NOW,
      runner: makeRunner({
        ...OK_SCRIPT,
        "im +chat-list": { code: 0, stdout: "{ 坏 JSON", stderr: "" },
        "im +messages-search": { code: 1, stdout: "", stderr: "synthetic failure" },
        "task +get-my-tasks": { code: 124, stdout: "", stderr: "" },
      }),
    });
    const res = await call(bridge, "GET", "/local/feishu");
    const data = res.body.data as FeishuLedgerView;
    assert.equal(data.status, "ok", "分区失败不推翻整体诚实态");
    assert.deepEqual(data.chats, []);
    assert.deepEqual(data.atMe, []);
    assert.deepEqual(data.tasks, []);
    assert.ok(String(data.sectionErrors.chats).includes("JSON"), "坏 JSON 如实说明");
    assert.ok(String(data.sectionErrors.atMe).includes("退出码 1"), "非零退出带退出码");
    assert.ok(String(data.sectionErrors.tasks).includes("超时"), "超时约定码 124 如实说明");
    assert.deepEqual(data.summary, { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 });
  });
});

test("section 隔离：单区失败不拖累其他区（atMe 挂、chats/tasks 仍 ok）", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const bridge = createFeishuBridge({
      candidates: [cliPath],
      now: () => NOW,
      runner: makeRunner({ ...OK_SCRIPT, "im +messages-search": { code: 3, stdout: "", stderr: "boom" } }),
    });
    const data = await bridge.aggregate();
    assert.equal(data.status, "ok");
    assert.equal(data.chats.length, 4, "chats 区不受影响");
    assert.equal(data.tasks.length, 4, "tasks 区不受影响");
    assert.deepEqual(data.atMe, []);
    assert.ok(String(data.sectionErrors.atMe).length > 0);
    assert.equal(data.sectionErrors.chats, undefined, "成功区不占键");
    assert.equal(data.summary.atMe, 0);
  });
});

test("错误卫生：stderr 里的绝对路径、lark token、JWT 一律脱敏后才进 sectionErrors", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const dirty = "Error: /Users/synthetic/secret/lark-cli failed with token t-gSYNTOKEN123456ABCDEF and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW4ifQ.fakesig for ou_synuser00zz99xx";
    const bridge = createFeishuBridge({
      candidates: [cliPath],
      now: () => NOW,
      runner: makeRunner({ ...OK_SCRIPT, "im +chat-list": { code: 1, stdout: "", stderr: dirty } }),
    });
    const res = await call(bridge, "GET", "/local/feishu");
    const text = JSON.stringify(res.body);
    for (const secret of [
      "/Users/synthetic/secret", "t-gSYNTOKEN123456ABCDEF",
      "eyJhbGciOiJIUzI1NiJ9", "ou_synuser00zz99xx",
    ]) {
      assert.ok(!text.includes(secret), `sectionErrors 不得包含 ${secret}`);
    }
    assert.ok(String(res.body.data.sectionErrors.chats).includes("退出码 1"), "诚实保留失败事实");
  });
});

test("只读闸门：runReadonlyJson 拒绝白名单外 argv（auth login / 发信命令根本到不了 runner）", async () => {
  const calls: string[][] = [];
  const runner = makeRunner({}, calls);
  for (const forbidden of [
    ["auth", "login"],
    ["im", "+messages-send", "--text", "hi"],
    ["im", "message", "create"],
    ["auth", "status", "--verify", "extra"],
  ]) {
    const result = await runReadonlyJson(runner, forbidden);
    assert.equal(result.ok, false, `${forbidden.join(" ")} 必须被拒绝`);
    if (!result.ok) assert.ok(result.note.includes("白名单"));
  }
  assert.equal(calls.length, 0, "被拒命令零执行");
  const allowed = await runReadonlyJson(makeRunner({ "auth status": { code: 0, stdout: AUTH_READY, stderr: "" } }), ["auth", "status"]);
  assert.equal(allowed.ok, true);
});

/* ---------------- 缓存与单飞 ---------------- */

test("缓存单飞：并发两请求只跑一轮；TTL 内命中缓存；refresh 破缓存重跑", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const calls: string[][] = [];
    const bridge = createFeishuBridge({ candidates: [cliPath], runner: makeRunner(OK_SCRIPT, calls), now: () => NOW });

    const [a, b] = await Promise.all([
      call(bridge, "GET", "/local/feishu"),
      call(bridge, "GET", "/local/feishu"),
    ]);
    assert.equal(a.body.data.status, "ok");
    assert.deepEqual(b.body.data, a.body.data, "并发第二个请求复用同一在飞结果");
    assert.equal(countCalls(calls, "auth status"), 1, "单飞：只跑一轮探针");
    assert.equal(countCalls(calls, "im +chat-list"), 1);

    await call(bridge, "GET", "/local/feishu");
    assert.equal(countCalls(calls, "auth status"), 1, "TTL(300s) 内命中缓存零重跑");

    const refreshed = await call(bridge, "GET", "/local/feishu/refresh");
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.status, "ok");
    assert.equal(countCalls(calls, "auth status"), 2, "refresh 清缓存重跑一轮");
    assert.equal(countCalls(calls, "task +get-my-tasks"), 2);
  });
});

test("cacheTtlMs=0：每次 GET 都重跑（TTL 可注入）", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const calls: string[][] = [];
    const bridge = createFeishuBridge({ candidates: [cliPath], runner: makeRunner(OK_SCRIPT, calls), now: () => NOW, cacheTtlMs: 0 });
    await bridge.aggregate();
    await bridge.aggregate();
    assert.equal(countCalls(calls, "auth status"), 2);
  });
});

/* ---------------- handle 边界 ---------------- */

test("handle：非本桥路径返回 undefined；错方法 405；尾斜杠归一化", async () => {
  await withTempDir(async (dir) => {
    const cliPath = await fakeCli(dir);
    const bridge = createFeishuBridge({ candidates: [cliPath], runner: makeRunner(OK_SCRIPT), now: () => NOW });
    for (const path of ["/local/worklog", "/local/feishu-x", "/local/feishux", "/local/feishu/refresh-x", "/local/wechat"]) {
      assert.equal(await bridge.handle(new Request(BASE_URL + path, { method: "GET" })), undefined, `${path} 交回主路由`);
    }
    const wrong = await call(bridge, "POST", "/local/feishu");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.body.error.code, "method_not_allowed");
    assert.ok(String(wrong.body.error.message).includes("GET"), "405 消息给出允许方法");
    const trailing = await call(bridge, "GET", "/local/feishu/");
    assert.equal(trailing.status, 200, "尾斜杠归一化");
    assert.equal(trailing.body.data.status, "ok");
  });
});

/* ---------------- 纯函数口径 ---------------- */

test("maskFeishuId：长 id 前 2 + … + 末 6；短 id 用指纹；空/非字符串如实空", () => {
  assert.equal(maskFeishuId("ou_synowner0000ef34"), "ou…00ef34");
  assert.equal(maskFeishuId("oc_chatid"), "oc…chatid");
  assert.match(maskFeishuId("ou_ab"), /^ou…[0-9a-f]{6}$/, "≤8 位短 id 不裸露原文，用指纹");
  assert.ok(!maskFeishuId("ou_ab123456").includes("ab123456"));
  assert.equal(maskFeishuId(""), "");
  assert.equal(maskFeishuId(undefined), "");
  assert.equal(maskFeishuId(42), "");
});

test("extractPreview / truncatePreview：占位符、text/post 抽取、折空白、60 字截断", () => {
  assert.equal(extractPreview("text", JSON.stringify({ text: "合成 短文\n带换行" })), "合成 短文 带换行", "折空白");
  assert.equal(extractPreview("text", "裸字符串内容"), "裸字符串内容", "content 非 JSON 时如实按文本处理");
  assert.equal(extractPreview("post", JSON.stringify({ title: "标题优先", content: [[{ tag: "text", text: "首段" }]] })), "标题优先");
  assert.equal(
    extractPreview("post", JSON.stringify({ content: [[{ tag: "text", text: "无标题取首段" }, { tag: "at", text: "" }]] })),
    "无标题取首段",
  );
  assert.equal(extractPreview("post", JSON.stringify({})), "[富文本]", "空 post 给占位不猜");
  assert.equal(extractPreview("image", "{}"), "[图片]");
  assert.equal(extractPreview("file", "{}"), "[文件]");
  assert.equal(extractPreview("audio", "{}"), "[语音]");
  assert.equal(extractPreview("video", "{}"), "[视频]");
  assert.equal(extractPreview("interactive", "{}"), "[卡片]");
  assert.equal(extractPreview("sticker", "{}"), "[表情]");
  assert.equal(extractPreview("merge_forward", "{}"), "[消息]", "未知类型统一占位");
  assert.equal(extractPreview("text", JSON.stringify({ text: LONG_TEXT })).length, 61);
  assert.equal(truncatePreview("短文本"), "短文本");
  assert.equal(truncatePreview(`${"长".repeat(61)}`).slice(-1), "…");
});
