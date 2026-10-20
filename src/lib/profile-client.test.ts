import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteProfileSession,
  fetchProfileView,
  profileErrorMessage,
  ProfileClientError,
  putProfilePrefs,
  putProfileSession,
  testProfileSession,
} from "./profile-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：工号 / cookie / 姓名全为合成值（SYN-EMP-0001 / SYN-COOKIE-*），
// fetch 全程 mock，绝不触网。重点断言：白名单投影（敌意 session.value 不入前端）、
// 三态判活结果、{error:{code,message}} 错误折叠与友好文案（绝不回显 Cookie）。
// ---------------------------------------------------------------------------

const SYN_COOKIE = "syn_session_a=SYN-COOKIE-abc123; syn_session_b=SYN-VALUE-xyz789";

const PUBLIC_VIEW = {
  configured: true,
  user: { empId: "SYN-EMP-0001", name: "合成用户" },
  source: { mode: "manual" },
  session: {
    set: true,
    masked: "syn_…共 66 字符",
    count: 2,
    domains: ["aliyun-inc.com", "alibaba-inc.com"],
    updatedAt: "2026-10-21T03:40:00.000Z",
    lastCheck: { ok: true, at: "2026-10-21T03:41:00.000Z", self: true, code: null, note: null, empId: "SYN-EMP-0001" },
    verifiedAt: "2026-10-21T03:41:00.000Z",
    state: "ok",
  },
  prefs: { autoCheckOnOpen: true },
};

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
  contentType: string;
}

function fakeFetch(reply: () => Response, captured: CapturedRequest[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    captured.push({
      url: request.url,
      method: request.method,
      body: request.method === "GET" || request.method === "DELETE" ? "" : await request.text(),
      contentType: request.headers.get("content-type") ?? "",
    });
    return reply();
  }) as unknown as typeof fetch;
}

function okData(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
}

function errorBody(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectError(promise: Promise<unknown>): Promise<ProfileClientError> {
  try {
    await promise;
  } catch (error) {
    return error as ProfileClientError;
  }
  throw new Error("expected the promise to reject");
}

test("fetchProfileView projects the whitelist and drops a hostile session.value", async () => {
  const captured: CapturedRequest[] = [];
  const hostile = { ...PUBLIC_VIEW, session: { ...PUBLIC_VIEW.session, value: SYN_COOKIE } };
  const view = await fetchProfileView(fakeFetch(() => okData(hostile), captured));
  assert.equal(captured[0]!.method, "GET");
  assert.ok(captured[0]!.url.endsWith("/local/profile"));
  assert.equal(view.configured, true);
  assert.equal(view.user.empId, "SYN-EMP-0001");
  assert.equal(view.session.state, "ok");
  assert.equal(view.session.lastCheck?.self, true);
  // 掩码红线：投影后的对象序列化不含合成 cookie 原值，也没有 value 键。
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(SYN_COOKIE));
  assert.ok(!serialized.includes('"value"'));
  assert.ok(!("value" in view.session));
});

test("fetchProfileView rejects garbage payloads with invalid_response", async () => {
  const error = await expectError(fetchProfileView(fakeFetch(() => okData({ nope: true }))));
  assert.equal(error.code, "invalid_response");
});

test("fetchProfileView folds offline / network failure into unavailable", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const error = await expectError(fetchProfileView(offline));
  assert.equal(error.code, "unavailable");
});

test("putProfileSession sends the manual body once and parses supported:false honestly", async () => {
  const captured: CapturedRequest[] = [];
  const result = await putProfileSession(
    { source: "chrome" },
    fakeFetch(() => okData({ supported: false, reason: "chrome 提取未接入", view: null }), captured),
  );
  assert.equal(result.supported, false);
  assert.equal(result.reason, "chrome 提取未接入");
  assert.equal(result.view, null);
  assert.equal(captured[0]!.method, "PUT");
  assert.equal(captured[0]!.contentType, "application/json");

  const captured2: CapturedRequest[] = [];
  const saved = await putProfileSession(
    { source: "manual", empId: "SYN-EMP-0001", value: SYN_COOKIE },
    fakeFetch(() => okData({ supported: true, reason: null, view: PUBLIC_VIEW }), captured2),
  );
  assert.equal(saved.supported, true);
  assert.equal(saved.view?.user.empId, "SYN-EMP-0001");
  const sent = JSON.parse(captured2[0]!.body) as Record<string, unknown>;
  assert.deepEqual(sent, { source: "manual", empId: "SYN-EMP-0001", value: SYN_COOKIE });
});

test("deleteProfileSession returns the updated view", async () => {
  const cleared = { ...PUBLIC_VIEW, session: { ...PUBLIC_VIEW.session, set: false, state: "unset", masked: "", count: 0 } };
  const view = await deleteProfileSession(fakeFetch(() => okData(cleared)));
  assert.equal(view.session.set, false);
  assert.equal(view.session.state, "unset");
});

test("testProfileSession surfaces the three honest states", async () => {
  const self = await testProfileSession(fakeFetch(() => okData({
    state: "self", empId: "SYN-EMP-0001", name: "合成用户", code: null,
    note: "BUC 会话有效，且与当前账号一致", checkedAt: "2026-10-21T03:41:00.000Z", view: PUBLIC_VIEW,
  })));
  assert.equal(self.state, "self");
  assert.equal(self.view.user.empId, "SYN-EMP-0001");

  const mismatch = await testProfileSession(fakeFetch(() => okData({
    state: "mismatch", empId: "SYN-EMP-9999", name: "合成他人", code: null,
    note: "会话属于其他账号（SYN-EMP-9999）", checkedAt: "2026-10-21T03:41:00.000Z", view: PUBLIC_VIEW,
  })));
  assert.equal(mismatch.state, "mismatch");
  assert.equal(mismatch.empId, "SYN-EMP-9999");

  const failed = await testProfileSession(fakeFetch(() => okData({
    state: "failed", empId: null, name: null, code: "expired",
    note: "BUC 会话失效（302 → login.alibaba-inc.com）", checkedAt: "2026-10-21T03:41:00.000Z", view: PUBLIC_VIEW,
  })));
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "expired");
});

test("bridge error envelope {error:{code,message}} folds into ProfileClientError with detail", async () => {
  const error = await expectError(putProfileSession(
    { source: "manual", value: SYN_COOKIE },
    fakeFetch(() => errorBody("profile_invalid_request", "Cookie 不能为空", 400)),
  ));
  assert.equal(error.code, "profile_invalid_request");
  assert.equal(error.detail, "Cookie 不能为空");
  const message = profileErrorMessage(error);
  assert.ok(message.includes("Cookie 不能为空"));
  assert.ok(!message.includes(SYN_COOKIE), "错误文案绝不回显 Cookie");

  const corrupt = await expectError(fetchProfileView(fakeFetch(() => errorBody("profile_corrupt", "active.json 损坏", 409))));
  assert.equal(corrupt.code, "profile_corrupt");
  assert.ok(profileErrorMessage(corrupt).includes("~/.sa-workbench"));
});

test("unknown error codes fold into unavailable, never leaking the raw code", async () => {
  const error = await expectError(fetchProfileView(fakeFetch(() => errorBody("stack_trace_dump", "内部路径 /Users/someone", 500))));
  assert.equal(error.code, "unavailable");
});

test("putProfilePrefs merges and returns the new prefs object", async () => {
  const captured: CapturedRequest[] = [];
  const result = await putProfilePrefs(
    { maskEmpId: true },
    fakeFetch(() => okData({ prefs: { autoCheckOnOpen: true, maskEmpId: true }, view: PUBLIC_VIEW }), captured),
  );
  assert.deepEqual(result.prefs, { autoCheckOnOpen: true, maskEmpId: true });
  assert.equal(captured[0]!.method, "PUT");
  assert.deepEqual(JSON.parse(captured[0]!.body), { prefs: { maskEmpId: true } });
});

test("profileErrorMessage has a friendly default for unknown errors", () => {
  assert.ok(profileErrorMessage(new Error("boom")).includes("npm run dev:function"));
});
