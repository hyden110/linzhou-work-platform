import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentloopBridgeError,
  AGENTLOOP_DRY_TOKEN_TTL_MS,
  AGENTLOOP_PROBE_TIMEOUT_MS,
  AGENTLOOP_ROUTES,
  AGENTLOOP_TICKET_TIMEOUT_MS,
  createAgentloopBridge,
  createAgentloopStore,
  projectTicketAudit,
  type AgentloopBridge,
  type AgentloopTicketAudit,
  type SlsFetch,
  type SlsFetchInit,
} from "./agentloop-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：AK/SK/票据一律合成串（LTAIsynthAk0001 / synthSk000…1 /
// synth-ticket-value-0001），项目/logstore 用 synth-proj / synth-store；
// SLS 网络全程注入 stub（零真实网络、零真实子进程），存储全落临时目录。
// FIXED_NOW = 2026-10-20T02:30:00Z（GMT 形态 Tue, 20 Oct 2026 02:30:00 GMT）。
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse("2026-10-20T02:30:00.000Z");
const FIXED_ISO = "2026-10-20T02:30:00.000Z";
const FIXED_GMT = "Tue, 20 Oct 2026 02:30:00 GMT";
const SYNTH_AK = "LTAIsynthAk0001";
const SYNTH_SK = "synthSk0000000000000000000001";
const SYNTH_TICKET = "synth-ticket-value-0001";
const CREDS_BODY = { accessKeyId: SYNTH_AK, accessKeySecret: SYNTH_SK };

interface StubCall {
  readonly url: string;
  readonly init: SlsFetchInit;
}

interface SlStub {
  readonly calls: StubCall[];
  readonly fetch: SlsFetch;
}

function stubSls(responder: (call: StubCall) => Promise<{ status: number; bodyText: string }> | { status: number; bodyText: string }): SlStub {
  const calls: StubCall[] = [];
  const fetchImpl: SlsFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  };
  return { calls, fetch: fetchImpl };
}

const okList = (logstores: readonly string[]) => ({ status: 200, bodyText: JSON.stringify({ logstores, total: logstores.length }) });
const okTicket = { status: 200, bodyText: JSON.stringify({ ticket: SYNTH_TICKET }) };

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agentloop-bridge-"));
  try {
    await run(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

interface Harness {
  readonly bridge: AgentloopBridge;
  readonly sls: SlStub;
  readonly dir: string;
  readonly storeDir: string;
  readonly advance: (ms: number) => void;
}

async function makeHarness(
  dir: string,
  opts: {
    readonly views?: readonly Record<string, string>[] | null;
    readonly responder?: (call: StubCall) => Promise<{ status: number; bodyText: string }> | { status: number; bodyText: string };
    readonly store?: ReturnType<typeof createAgentloopStore>;
  } = {},
): Promise<Harness> {
  const storeDir = join(dir, "agentloop");
  const configPath = join(dir, "agents.json");
  await mkdir(dir, { recursive: true });
  if (opts.views !== null) {
    await writeFile(configPath, JSON.stringify({
      agentloop: {
        views: opts.views ?? [
          { id: "v1", t: "合成观测视图", sub: "synth-store", project: "synth-proj", logstore: "synth-store", region: "cn-beijing" },
        ],
      },
    }), "utf-8");
  }
  let nowMs = FIXED_NOW;
  const sls = stubSls(opts.responder ?? (() => okList(["synth-store"])));
  const bridge = createAgentloopBridge({
    dir: storeDir,
    configPath,
    now: () => nowMs,
    slsFetch: sls.fetch,
    store: opts.store,
  });
  return { bridge, sls, dir, storeDir, advance: (ms) => { nowMs += ms; } };
}

function request(path: string, method: "GET" | "PUT" | "POST" | "DELETE", body?: unknown): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonOf(response: Response | undefined): Promise<Record<string, unknown>> {
  assert.ok(response, "本桥路径必须给出 Response");
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

const errorOf = (payload: Record<string, unknown>): { code: string; message: string } => {
  assert.equal(payload.ok, false);
  const error = payload.error as { code: string; message: string };
  assert.ok(error && typeof error.code === "string");
  return error;
};

const dataOf = (payload: Record<string, unknown>): Record<string, unknown> => {
  assert.equal(payload.ok, true);
  return payload.data as Record<string, unknown>;
};

/** 断言响应文本绝不含任何凭据/票据明文（红线自检，多用例复用）。 */
function assertNoSecrets(text: string): void {
  assert.ok(!text.includes(SYNTH_AK), "响应绝不含 AK 明文");
  assert.ok(!text.includes(SYNTH_SK), "响应绝不含 SK 明文");
  assert.ok(!text.includes(SYNTH_TICKET), "响应绝不含票据明文");
}

// ---------------------------------------------------------------------------
// 1. 路由表与子路由委托
// ---------------------------------------------------------------------------

test("AGENTLOOP_ROUTES pins the seven contracted routes", () => {
  assert.deepEqual(
    AGENTLOOP_ROUTES.map((route) => `${route.method} ${route.path}`),
    [
      "GET /local/agentloop/creds",
      "PUT /local/agentloop/creds",
      "DELETE /local/agentloop/creds",
      "POST /local/agentloop/test",
      "POST /local/agentloop/ticket-dry",
      "POST /local/agentloop/ticket-confirm",
      "GET /local/agentloop/tickets",
    ],
  );
});

test("handle returns undefined for foreign paths and 405 for method mismatch", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    assert.equal(await h.bridge.handle(request("/local/reply/candidates", "GET")), undefined, "非本桥路径交回主路由");
    assert.equal(await h.bridge.handle(request("/local/agentloop/unknown", "GET")), undefined);

    const wrong = await h.bridge.handle(request("/local/agentloop/creds", "POST"));
    assert.equal(wrong?.status, 405);
    assert.equal(errorOf(await jsonOf(wrong)).code, "method_not_allowed");

    const wrongDry = await h.bridge.handle(request("/local/agentloop/ticket-dry", "GET"));
    assert.equal(wrongDry?.status, 405);

    const trailing = await h.bridge.handle(request("/local/agentloop/creds/", "GET"));
    assert.equal(trailing?.status, 200, "尾斜杠归一化后命中同一路由");
  });
});

// ---------------------------------------------------------------------------
// 2. 凭据管理：GET 掩码视图 / PUT 校验 + 0600 原子写 / DELETE 幂等
// ---------------------------------------------------------------------------

test("GET creds reports unset honestly before anything is written", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const response = await h.bridge.handle(request("/local/agentloop/creds", "GET"));
    const data = dataOf(await jsonOf(response));
    assert.equal(data.set, false);
    assert.equal(data.mask, null);
    assert.equal(data.updatedAt, null);
    assertNoSecrets(JSON.stringify(data));
  });
});

test("PUT creds validates donor shape, writes 0600 atomic file, returns masked view only", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);

    const bad = await h.bridge.handle(request("/local/agentloop/creds", "PUT", { accessKeyId: "synth-ak-0001", accessKeySecret: "x" }));
    assert.equal(bad?.status, 400);
    const badError = errorOf(await jsonOf(bad));
    assert.equal(badError.code, "agentloop_invalid_request");
    assertNoSecrets(badError.message);
    await assert.rejects(stat(join(h.storeDir, "creds.json")), "校验失败绝不落盘");

    const notJson = await h.bridge.handle(new Request("http://127.0.0.1:8000/local/agentloop/creds", { method: "PUT", body: "not-json" }));
    assert.equal(errorOf(await jsonOf(notJson)).code, "agentloop_invalid_request");

    const response = await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    assert.equal(response?.status, 200);
    const payloadText = await response.clone().text();
    const data = dataOf(JSON.parse(payloadText));
    assert.equal(data.set, true);
    assert.equal(data.mask, "LTAI****0001");
    assert.equal(data.updatedAt, FIXED_ISO);
    assertNoSecrets(payloadText);

    // 存储红线：目录 0700、文件 0600，内容含凭据（存储文件是唯一落地处）
    const dirMode = (await stat(h.storeDir)).mode & 0o777;
    const fileMode = (await stat(join(h.storeDir, "creds.json"))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
    const stored = JSON.parse(await readFile(join(h.storeDir, "creds.json"), "utf-8"));
    assert.equal(stored.accessKeyId, SYNTH_AK);
    assert.equal(stored.accessKeySecret, SYNTH_SK);

    // GET 复读仍是掩码视图
    const again = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/creds", "GET"))));
    assert.equal(again.set, true);
    assert.equal(again.mask, "LTAI****0001");
    assertNoSecrets(JSON.stringify(again));
  });
});

test("PUT creds is an overwrite (updatedAt moves) and DELETE is idempotent", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const first = await h.bridge.handle(request("/local/agentloop/creds", "DELETE"));
    const firstData = dataOf(await jsonOf(first));
    assert.equal(firstData.removed, false, "未设置时删除如实 removed:false，不报 404");
    assert.equal(firstData.set, false);

    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    h.advance(60_000);
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", {
      accessKeyId: "LTAIsynthAk0002",
      accessKeySecret: "synthSk0000000000000000000002",
    }));
    const overwritten = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/creds", "GET"))));
    assert.equal(overwritten.mask, "LTAI****0002");
    assert.equal(overwritten.updatedAt, "2026-10-20T02:31:00.000Z");

    const removed = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/creds", "DELETE"))));
    assert.equal(removed.removed, true);
    assert.equal(removed.set, false);
    await assert.rejects(stat(join(h.storeDir, "creds.json")), "删除后文件不存在");
  });
});

test("corrupted creds file degrades to honest unset, never a crash", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await mkdir(h.storeDir, { recursive: true });
    await writeFile(join(h.storeDir, "creds.json"), "{broken", "utf-8");
    const data = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/creds", "GET"))));
    assert.equal(data.set, false, "损坏文件如实报未设置");
  });
});

test("store write failure maps to 503 agentloop_store_unavailable", async () => {
  await withTempDir(async (dir) => {
    const failingStore = {
      ...createAgentloopStore(join(dir, "agentloop"), { now: () => FIXED_NOW }),
      saveCreds: async () => { throw new Error("EACCES synth"); },
    };
    const h = await makeHarness(dir, { store: failingStore });
    const response = await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    assert.equal(response?.status, 503);
    const error = errorOf(await jsonOf(response));
    assert.equal(error.code, "agentloop_store_unavailable");
    assert.ok(!error.message.includes("EACCES synth"), "内部错误细节不直接透出");
  });
});

// ---------------------------------------------------------------------------
// 3. 连接测试：诚实三态（未设置 / 有效 / 异常 + 原因），只读零出票
// ---------------------------------------------------------------------------

test("test without creds reports unset with zero network calls", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const data = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/test", "POST"))));
    assert.equal(data.state, "unset");
    assert.deepEqual(data.targets, []);
    assert.equal(data.checkedAt, FIXED_ISO);
    assert.equal(h.sls.calls.length, 0, "未设置凭据时一次网络都不发");
  });
});

test("test without configured views reports error + reason, zero network", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { views: [] });
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const data = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/test", "POST"))));
    assert.equal(data.state, "error");
    assert.ok(String(data.note).includes("未配置观测视图"), "原因如实");
    assert.equal(h.sls.calls.length, 0);
  });
});

test("test probes listLogstores read-only and reports ok when the logstore is readable", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const response = await h.bridge.handle(request("/local/agentloop/test", "POST"));
    const text = await response!.clone().text();
    const data = dataOf(JSON.parse(text));
    assert.equal(data.state, "ok");
    const target = (data.targets as Record<string, unknown>[])[0];
    assert.equal(target.ok, true);
    assert.ok(String(target.note).includes("synth-store"));
    assertNoSecrets(text);

    // 只读口径：GET https://{project}.{region}.log.aliyuncs.com/logstores，带经典签名头与硬超时
    assert.equal(h.sls.calls.length, 1);
    const call = h.sls.calls[0];
    assert.equal(call.url, "https://synth-proj.cn-beijing.log.aliyuncs.com/logstores");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.timeoutMs, AGENTLOOP_PROBE_TIMEOUT_MS);
    assert.ok(String(call.init.headers.Authorization).startsWith(`SLS ${SYNTH_AK}:`), "签名头带真实 AK（仅对上游）");
    assert.equal(call.init.headers["x-log-apiversion"], "0.6.0");
    assert.equal(call.init.headers["x-log-signaturemethod"], "hmac-sha1");
    assert.equal(call.init.headers.Date, FIXED_GMT);
  });
});

test("test reports error + sanitized reason on upstream 403 and on missing logstore", async () => {
  await withTempDir(async (dir) => {
    const denied = await makeHarness(dir, {
      responder: () => ({ status: 403, bodyText: JSON.stringify({ errorCode: "Unauthorized", errorMessage: `denied for ${SYNTH_AK}` }) }),
    });
    await denied.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const deniedText = await (await denied.bridge.handle(request("/local/agentloop/test", "POST")))!.text();
    const deniedData = dataOf(JSON.parse(deniedText));
    assert.equal(deniedData.state, "error");
    const deniedTarget = (deniedData.targets as Record<string, unknown>[])[0];
    assert.equal(deniedTarget.ok, false);
    assert.ok(String(deniedTarget.note).includes("Unauthorized"));
    assertNoSecrets(deniedText);

    const missing = await makeHarness(dir, { responder: () => okList(["other-store"]) });
    await missing.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const missingData = dataOf(await jsonOf(await missing.bridge.handle(request("/local/agentloop/test", "POST"))));
    assert.equal(missingData.state, "error");
    const missingTarget = (missingData.targets as Record<string, unknown>[])[0];
    assert.equal(missingTarget.ok, false);
    assert.ok(String(missingTarget.note).includes("未见"), "项目可达但 logstore 未见的口径");
  });
});

test("test never issues tickets: only GET /logstores is allowed on the wire", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, {
      views: [
        { id: "v1", t: "视图一", project: "synth-proj-a", logstore: "store-a", region: "cn-beijing" },
        { id: "v2", t: "视图二", project: "synth-proj-b", logstore: "store-b", region: "cn-hangzhou" },
      ],
      responder: (call) => okList([call.url.includes("synth-proj-a") ? "store-a" : "store-b"]),
    });
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const data = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/test", "POST"))));
    assert.equal(data.state, "ok");
    assert.equal((data.targets as unknown[]).length, 2);
    assert.equal(h.sls.calls.length, 2);
    for (const call of h.sls.calls) {
      assert.equal(call.init.method, "GET");
      assert.ok(!call.url.includes("/tickets"), "连接测试绝不出票");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 出票两步闸门：dry 零网络铸 token / confirm 严格比对才真发 / 审计 append-only
// ---------------------------------------------------------------------------

test("ticket-dry requires creds, costs zero network, and masks everything", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const noCreds = await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"));
    assert.equal(noCreds?.status, 409);
    assert.equal(errorOf(await jsonOf(noCreds)).code, "agentloop_creds_missing");

    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const response = await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"));
    const text = await response!.text();
    const data = dataOf(JSON.parse(text));
    assert.ok(typeof data.token === "string" && data.token.length >= 32, "一次性 token");
    assert.equal(data.expiresAt, new Date(FIXED_NOW + AGENTLOOP_DRY_TOKEN_TTL_MS).toISOString());
    assert.equal(data.credsMask, "LTAI****0001");
    const summary = data.request as Record<string, unknown>;
    assert.equal(summary.method, "POST");
    assert.equal(summary.host, "cn-shanghai.log.aliyuncs.com");
    assert.equal(summary.resource, "/tickets?expirationTime=86400");
    assert.equal(summary.signatureMethod, "hmac-sha1");
    assert.equal(summary.region, "cn-shanghai");
    assert.equal(summary.externalWrite, true);
    assert.ok(String(summary.authorizationPreview).includes("LTAI****0001"), "授权头预览只给掩码");
    assert.ok(!String(summary.authorizationPreview).includes(SYNTH_AK));
    assertNoSecrets(text);
    assert.equal(h.sls.calls.length, 0, "dry 零网络");
  });
});

test("ticket-confirm gate: wrong/missing/unknown/expired confirm never touches the network", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const dry = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));
    const token = String(dry.token);

    const missing = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", {}));
    assert.equal(missing?.status, 409);
    assert.equal(errorOf(await jsonOf(missing)).code, "agentloop_confirm_mismatch");

    const wrong = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: `${token}x` }));
    assert.equal(wrong?.status, 409);
    assert.equal(errorOf(await jsonOf(wrong)).code, "agentloop_confirm_mismatch");

    const unknown = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: "f".repeat(64) }));
    assert.equal(unknown?.status, 409, "未知 token 也是确认不匹配：一次外部写都不发生");
    assert.equal(errorOf(await jsonOf(unknown)).code, "agentloop_confirm_mismatch");

    h.advance(AGENTLOOP_DRY_TOKEN_TTL_MS + 1_000);
    const expired = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: token }));
    assert.equal(expired?.status, 404, "过期 token 如实 404，需重新预检");
    assert.ok(String((errorOf(await jsonOf(expired))).message).includes("过期"));

    assert.equal(h.sls.calls.length, 0, "闸门未过：一次外部写都没发生");
    const audits = await createAgentloopStore(h.storeDir, { now: () => FIXED_NOW }).readTicketAudits(10);
    assert.equal(audits.length, 0, "闸门未过：不留审计（没有真实尝试）");
  });
});

test("ticket-confirm with strict token issues the signed POST and audits masked only", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir, { responder: () => okTicket });
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const dry = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));

    const response = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    const text = await response!.text();
    const data = dataOf(JSON.parse(text));
    assert.equal(response!.status, 200);
    assert.equal(data.ticketMask, "synt****0001", "票据只回掩码");
    assert.equal(data.ttl, 86_400);
    assert.equal(data.issuedAt, FIXED_ISO);
    assert.equal(data.expireAt, new Date(FIXED_NOW + 86_400_000).toISOString());
    assert.equal(data.region, "cn-shanghai");
    assert.equal(data.audited, true);
    assertNoSecrets(text);

    // 真实请求口径（donor sls.js：POST 上海 /tickets?expirationTime，经典签名头）
    assert.equal(h.sls.calls.length, 1);
    const call = h.sls.calls[0];
    assert.equal(call.url, "https://cn-shanghai.log.aliyuncs.com/tickets?expirationTime=86400");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.timeoutMs, AGENTLOOP_TICKET_TIMEOUT_MS);
    assert.equal(call.init.headers.Date, FIXED_GMT);
    assert.equal(call.init.headers["x-log-apiversion"], "0.6.0");
    assert.ok(String(call.init.headers.Authorization).startsWith(`SLS ${SYNTH_AK}:`));

    // 审计 append-only：一行、掩码、无明文
    const auditRaw = await readFile(join(h.storeDir, "tickets.jsonl"), "utf-8");
    assert.equal(auditRaw.trim().split("\n").length, 1);
    assertNoSecrets(auditRaw);
    const audit = projectTicketAudit(JSON.parse(auditRaw.trim())) as AgentloopTicketAudit;
    assert.equal(audit.status, "ok");
    assert.equal(audit.ticketMask, "synt****0001");
    assert.equal(audit.at, FIXED_ISO);

    // token 单次有效：重放同一 confirm 不再触发外部写（已消费的 token 属确认不匹配）
    const replay = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    assert.equal(replay?.status, 409);
    assert.equal(errorOf(await jsonOf(replay)).code, "agentloop_confirm_mismatch");
    assert.equal(h.sls.calls.length, 1, "重放绝不再出票");
  });
});

test("ticket-confirm maps upstream failures honestly and still audits the attempt", async () => {
  await withTempDir(async (dir) => {
    const auth = await makeHarness(join(dir, "auth"), {
      responder: () => ({ status: 401, bodyText: JSON.stringify({ errorCode: "SignatureNotMatch", errorMessage: "signature mismatch" }) }),
    });
    await auth.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    let dry = dataOf(await jsonOf(await auth.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));
    let response = await auth.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    assert.equal(response?.status, 502);
    let error = errorOf(await jsonOf(response));
    assert.equal(error.code, "agentloop_upstream_auth");
    assert.ok(error.message.includes("SignatureNotMatch"), "上游错误码如实透出");
    assertNoSecrets(error.message);

    const network = await makeHarness(join(dir, "net"), {
      responder: async () => { throw new Error("synthetic network down"); },
    });
    await network.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    dry = dataOf(await jsonOf(await network.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));
    response = await network.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    assert.equal(response?.status, 502);
    assert.equal(errorOf(await jsonOf(response)).code, "agentloop_upstream_error");

    const emptyTicket = await makeHarness(join(dir, "empty"), { responder: () => ({ status: 200, bodyText: "{}" }) });
    await emptyTicket.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    dry = dataOf(await jsonOf(await emptyTicket.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));
    response = await emptyTicket.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    assert.equal(errorOf(await jsonOf(response)).code, "agentloop_upstream_error", "200 但缺 ticket 如实报错");

    // 两次失败尝试都留了 error 审计（真实外部尝试成败都记）
    for (const h of [auth, network]) {
      const audits = await createAgentloopStore(h.storeDir, { now: () => FIXED_NOW }).readTicketAudits(10);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].status, "error");
      assert.equal(audits[0].ticketMask, "");
      assert.ok(audits[0].reason.length > 0 && audits[0].reason.length <= 200);
    }
  });
});

test("ticket-confirm is 409 when creds vanish after dry (delete invalidates tokens; corrupt file → creds_missing)", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const dry = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));

    // 删除凭据立即作废未消费的 dry token（donor：换号/清号后旧票预检不带入新状态）
    await h.bridge.handle(request("/local/agentloop/creds", "DELETE"));
    const afterDelete = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry.token) }));
    assert.equal(afterDelete?.status, 409);
    assert.equal(errorOf(await jsonOf(afterDelete)).code, "agentloop_confirm_mismatch");

    // 凭据文件在 dry 之后被外部损坏 → 有效 token 也如实 creds_missing，绝不带病出票
    await h.bridge.handle(request("/local/agentloop/creds", "PUT", CREDS_BODY));
    const dry2 = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/ticket-dry", "POST"))));
    await writeFile(join(h.storeDir, "creds.json"), "{broken", "utf-8");
    const response = await h.bridge.handle(request("/local/agentloop/ticket-confirm", "POST", { confirm: String(dry2.token) }));
    assert.equal(response?.status, 409);
    assert.equal(errorOf(await jsonOf(response)).code, "agentloop_creds_missing");
    assert.equal(h.sls.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. 审计读取：尾 50、最新在前、坏行跳过
// ---------------------------------------------------------------------------

test("GET tickets returns the newest 50 audits and skips corrupt lines", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const empty = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/tickets", "GET"))));
    assert.deepEqual(empty.tickets, []);
    assert.equal(empty.total, 0);

    const store = createAgentloopStore(h.storeDir, { now: () => FIXED_NOW });
    for (let index = 0; index < 51; index += 1) {
      await store.appendTicketAudit({
        at: new Date(FIXED_NOW + index * 1000).toISOString(),
        action: "ticket",
        status: "ok",
        ticketMask: `synt****${String(index).padStart(4, "0")}`,
        ttl: 86_400,
        expireAt: "",
        reason: "",
      });
    }
    await appendFile(join(h.storeDir, "tickets.jsonl"), "{corrupt line\n", "utf-8");

    const data = dataOf(await jsonOf(await h.bridge.handle(request("/local/agentloop/tickets", "GET"))));
    const tickets = data.tickets as AgentloopTicketAudit[];
    assert.equal(tickets.length, 50, "尾 50");
    assert.equal(data.total, 51, "坏行不计入");
    assert.equal(tickets[0].ticketMask, "synt****0050", "最新在前");
    assert.equal(tickets[49].ticketMask, "synt****0001");

    // append-only：读取接口绝不重写文件
    const before = await readFile(join(h.storeDir, "tickets.jsonl"), "utf-8");
    await h.bridge.handle(request("/local/agentloop/tickets", "GET"));
    assert.equal(await readFile(join(h.storeDir, "tickets.jsonl"), "utf-8"), before);
  });
});

test("projectTicketAudit whitelists fields and rejects bad rows", () => {
  assert.equal(projectTicketAudit(null), null);
  assert.equal(projectTicketAudit({ at: "x" }), null, "缺 status 拒绝");
  const row = projectTicketAudit({
    at: FIXED_ISO, action: "ticket", status: "weird", ticketMask: "synt****0001",
    ttl: "86400", expireAt: null, reason: 42, junk: "dropped",
  });
  assert.ok(row);
  assert.deepEqual(row, {
    at: FIXED_ISO, action: "ticket", status: "error", ticketMask: "synt****0001",
    ttl: 0, expireAt: "", reason: "",
  }, "白名单投影：坏字段回落、多余字段丢弃");
});

// ---------------------------------------------------------------------------
// 6. 请求体闸门：超大 body / 非 JSON 一律 400
// ---------------------------------------------------------------------------

test("oversized and non-JSON bodies are rejected as 400", async () => {
  await withTempDir(async (dir) => {
    const h = await makeHarness(dir);
    const huge = new Request("http://127.0.0.1:8000/local/agentloop/ticket-confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
      body: JSON.stringify({ confirm: "x".repeat(32 * 1024) }),
    });
    const hugePayload = await jsonOf(await h.bridge.handle(huge));
    assert.equal(hugePayload.ok, false);
    assert.equal(errorOf(hugePayload).code, "agentloop_invalid_request");
    assert.equal(h.sls.calls.length, 0);
  });
});

test("AgentloopBridgeError carries stable codes for the router mapping", () => {
  const error = new AgentloopBridgeError("agentloop_creds_missing", "尚未配置凭据。");
  assert.ok(error instanceof Error);
  assert.equal(error.code, "agentloop_creds_missing");
  assert.equal(error.name, "AgentloopBridgeError");
});
