import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchReplyCandidates,
  fetchReplyHistory,
  fetchReplySends,
  replyErrorMessage,
  ReplyClientError,
  sendReply,
  suggestReply,
} from "./reply-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：会话/群 id 一律 cidSynth*，标题只用「甲科技（合成）」；fetch 全程 mock。
// ---------------------------------------------------------------------------

const GROUP = "cidSynthGroup01";
const CAND_ID = `syn-dt-001:${GROUP}`;

const CANDIDATE = {
  id: CAND_ID,
  title: "甲科技（合成）钉钉群消息",
  createdAt: "2026-10-20T01:00:00.000Z",
  read: false,
  channel: "dingtalk",
  group: GROUP,
  replied: false,
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okData = (data: unknown): Response => jsonRes({ ok: true, data });

function errRes(code: string, message: string, status = 400): Response {
  return jsonRes({ ok: false, error: { code, message } }, status);
}

test("fetchReplyCandidates projects the whitelist and drops bad rows", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData({
      savedAt: "2026-10-20T02:00:00.000Z",
      items: [CANDIDATE, { junk: true }, null, { ...CANDIDATE, id: "", channel: "carrier-pigeon" }],
      quota: { day: "2026-10-20", used: 2, limit: 60, perConvLimit: 6 },
      engine: { available: true, localOnly: true },
    });
  }) as typeof fetch;

  const view = await fetchReplyCandidates(fetchImpl);
  assert.ok(requested.endsWith("/local/reply/candidates"));
  assert.equal(view.items.length, 1, "坏行/空 id 丢弃");
  assert.deepEqual(view.items[0], CANDIDATE);
  assert.deepEqual(view.quota, { day: "2026-10-20", used: 2, limit: 60, perConvLimit: 6 });
  assert.deepEqual(view.engine, { available: true, localOnly: true });
});

test("fetchReplyCandidates rejects a malformed envelope honestly", async () => {
  const fetchImpl = (async () => okData({ nope: true })) as typeof fetch;
  await assert.rejects(
    () => fetchReplyCandidates(fetchImpl),
    (e: unknown) => e instanceof ReplyClientError && e.code === "invalid_response",
  );
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(
    () => fetchReplyCandidates(offline),
    (e: unknown) => e instanceof ReplyClientError && e.code === "unavailable",
  );
});

test("fetchReplyHistory and fetchReplySends project rows with whitelist keys", async () => {
  const historyFetch = (async () => okData({
    rows: [
      { sid: "s1", id: CAND_ID, convTitle: "甲科技（合成）", needReply: true, text: "已收到（合成）", tone: "平实", reason: "客诉", ms: 800, engine: "qodercli", at: "2026-10-20T02:00:00.000Z" },
      { sid: 42 },
    ],
  })) as typeof fetch;
  const rows = await fetchReplyHistory(historyFetch);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "已收到（合成）");

  const sendsFetch = (async () => okData({
    sends: [
      { at: "2026-10-20T02:10:00.000Z", id: CAND_ID, group: GROUP, exitCode: 0, maskedPreview: "已收到（合成）" },
      { at: "2026-10-20T02:05:00.000Z", id: CAND_ID, group: GROUP, exitCode: "ENOENT", maskedPreview: "…" },
      "坏行",
    ],
    total: 2,
  })) as typeof fetch;
  const view = await fetchReplySends(sendsFetch);
  assert.equal(view.sends.length, 2, "坏行丢弃");
  assert.equal(view.sends[1].exitCode, "ENOENT", "ENOENT 如实保留字符串形态");
  assert.equal(view.total, 2);
});

test("suggestReply posts {id} and projects the outcome", async () => {
  let body = "";
  const fetchImpl = (async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(String(input));
    body = await request.text();
    assert.equal(request.method, "POST");
    return okData({
      id: CAND_ID, needReply: true, text: "您好，已收到（合成）", tone: "正式",
      reason: "客户询问进度", ms: 1200, engine: "qodercli", localOnly: true,
      contextProfile: true, quota: { day: "2026-10-20", used: 3, limit: 60, perConvLimit: 6 },
    });
  }) as typeof fetch;

  const outcome = await suggestReply(CAND_ID, fetchImpl);
  assert.deepEqual(JSON.parse(body), { id: CAND_ID });
  assert.equal(outcome.needReply, true);
  assert.equal(outcome.text, "您好，已收到（合成）");
  assert.equal(outcome.contextProfile, true);
  assert.equal(outcome.quota.used, 3);
});

test("sendReply carries confirm through untouched (bridge gate is authoritative)", async () => {
  let body = "";
  const fetchImpl = (async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(String(input));
    body = await request.text();
    return okData({ id: CAND_ID, group: GROUP, exitCode: 0, audited: true, at: "2026-10-20T02:20:00.000Z" });
  }) as typeof fetch;

  const outcome = await sendReply({ id: CAND_ID, text: "您好（合成）", confirm: CAND_ID }, fetchImpl);
  assert.deepEqual(JSON.parse(body), { id: CAND_ID, text: "您好（合成）", confirm: CAND_ID });
  assert.equal(outcome.group, GROUP);
  assert.equal(outcome.audited, true);
});

test("bridge error codes map to ReplyClientError with detail; unknown codes fall back", async () => {
  const cases: Array<[string, number]> = [
    ["engine_missing", 503], ["quota_exceeded", 429], ["no_channel", 409],
    ["confirm_mismatch", 400], ["send_failed", 502], ["reply_not_found", 404],
  ];
  for (const [code, status] of cases) {
    const fetchImpl = (async () => errRes(code, `${code} 详情（合成）`, status)) as typeof fetch;
    await assert.rejects(
      () => suggestReply(CAND_ID, fetchImpl),
      (e: unknown) => e instanceof ReplyClientError && e.code === code && e.detail === `${code} 详情（合成）`,
      code,
    );
  }
  const weird = (async () => errRes("totally_unknown_code", "x", 500)) as typeof fetch;
  await assert.rejects(
    () => suggestReply(CAND_ID, weird),
    (e: unknown) => e instanceof ReplyClientError && e.code === "unavailable",
  );
});

test("replyErrorMessage stays honest for the three key states and never promises cloud fallback", async () => {
  const engine = replyErrorMessage(new ReplyClientError("engine_missing", ""));
  assert.match(engine, /本机/);
  assert.match(engine, /绝不回落云端/);

  const quota = replyErrorMessage(new ReplyClientError("quota_exceeded", ""));
  assert.match(quota, /额度已用完/);
  assert.match(quota, /手动撰写/);

  const channel = replyErrorMessage(new ReplyClientError("no_channel", ""));
  assert.match(channel, /一键复制/);

  const confirm = replyErrorMessage(new ReplyClientError("confirm_mismatch", ""));
  assert.match(confirm, /没有发送任何消息/);

  assert.match(replyErrorMessage(new Error("boom")), /本地桥未启动/);
  assert.match(replyErrorMessage(new ReplyClientError("send_failed", "退出码 3")), /退出码 3/);
});
