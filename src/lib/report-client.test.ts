import assert from "node:assert/strict";
import test from "node:test";

import {
  clockCn,
  fetchReportAutomations,
  fetchReportState,
  fetchReportWeeklyDoc,
  fetchReportWeeklies,
  fetchReportWrites,
  reportErrorMessage,
  saveReportDraftConfirm,
  saveReportDraftDry,
  submitReportConfirm,
  submitReportDry,
  ReportClientError,
  REPORT_WRITABLE_FIELDS,
  REPORT_MAX_TEXT,
} from "./report-client.ts";
import type { ReportSaveCells } from "./report-client.ts";

// ---------------------------------------------------------------------------
// 合成数据：企业只出现「甲科技/乙股份」，ID/触发器全为合成值；
// fetch 全程 mock，绝不触网。重点断言：白名单投影（敌意字段不入前端）、
// 离线/未配置/上游失败的错误码与文案、fresh 透传。
// ---------------------------------------------------------------------------

const STATE = {
  configured: true,
  configNote: "",
  today: "2026-10-20",
  weekday: 2,
  dws: { ok: true, code: "", note: "", fix: "" },
  record: {
    recordId: "rec-syn-01", topic: "合成日报主题", dept: "交付部", workStatus: "正常",
    followup: "跟进甲科技试点", opportunity: "合成商机线索一条", risk: "", other: "",
    modifiedAt: "2026-10-20T09:00:00+08:00",
  },
  recordNote: "",
  submitted: { n: 1, items: [{ title: "合成提交（甲科技日报）", time: "2026-10-20T01:05:00.000Z" }] },
  submittedNote: "今日已提交 1 次。",
  hostile: { sk: "sk-should-never-reach-ui" },
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function okData(data: unknown): Response {
  return jsonRes({ ok: true, data });
}

/** 断言拒绝并返回 ReportClientError（catch 分支类型收窄）。 */
async function expectError(promise: Promise<unknown>): Promise<ReportClientError> {
  try {
    await promise;
  } catch (error) {
    return error as ReportClientError;
  }
  throw new Error("expected the promise to reject");
}

test("fetchReportState projects the whitelist and drops hostile fields", async () => {
  let requested = "";
  const fetchImpl = (async (input: Request | string) => {
    requested = String(input instanceof Request ? input.url : input);
    return okData(STATE);
  }) as unknown as typeof fetch;
  const state = await fetchReportState(fetchImpl);
  assert.equal(requested, "http://localhost/local/report/state");
  assert.equal(state.configured, true);
  assert.equal(state.today, "2026-10-20");
  assert.equal(state.record?.topic, "合成日报主题");
  assert.equal(state.submitted?.n, 1);
  assert.equal(JSON.stringify(state).includes("sk-should-never-reach-ui"), false, "白名单外字段不得进入前端");
});

test("fetchReportState keeps configured:false for the guidance copy", async () => {
  const fetchImpl = (async () => okData({
    configured: false, configNote: "未配置 .local-cache/report.json", today: "2026-10-20", weekday: 2,
    dws: { ok: false, code: "unconfigured", note: "", fix: "" },
    record: null, recordNote: "未配置日报段，今日记录不可读。", submitted: null, submittedNote: "",
  })) as unknown as typeof fetch;
  const state = await fetchReportState(fetchImpl);
  assert.equal(state.configured, false);
  assert.match(state.configNote, /report\.json/);
  assert.equal(state.record, null);
});

test("error codes map to honest copy: offline, unconfigured, upstream", async () => {
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const offlineError = await expectError(fetchReportState(offline));
  assert.equal(offlineError.code, "unavailable");
  assert.match(reportErrorMessage(offlineError), /本地桥未启动/);
  assert.match(reportErrorMessage(offlineError), /npm run dev:function/);

  const unconfigured = (async () => jsonRes({ ok: false, error: "report_unconfigured", message: "node 参数不合法" }, 400)) as unknown as typeof fetch;
  const unconfiguredError = await expectError(fetchReportState(unconfigured));
  assert.equal(unconfiguredError.code, "report_unconfigured");
  assert.equal(unconfiguredError.detail, "node 参数不合法");
  assert.match(reportErrorMessage(unconfiguredError), /report\.json/);

  const upstream = (async () => jsonRes({ ok: false, error: "report_upstream", message: "dws 失败" }, 502)) as unknown as typeof fetch;
  const upstreamError = await expectError(fetchReportState(upstream));
  assert.equal(upstreamError.code, "report_upstream");
  assert.match(reportErrorMessage(upstreamError), /钉钉侧返回失败/);

  const unknownError = (async () => jsonRes({ ok: false, error: "something_new" }, 500)) as unknown as typeof fetch;
  const unknown = await expectError(fetchReportState(unknownError));
  assert.equal(unknown.code, "unavailable", "白名单外错误码一律折叠为 unavailable");

  const badJson = (async () => new Response("{ 不是 JSON", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await expectError(fetchReportState(badJson))).code, "unavailable");

  const badShape = (async () => okData({ configured: "yes" })) as unknown as typeof fetch;
  const shape = await expectError(fetchReportState(badShape));
  assert.equal(shape.code, "invalid_response");
  assert.match(reportErrorMessage(shape), /无法识别/);
});

test("automations and weeklies honor fresh=1 and project their items", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: Request | string) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.includes("/local/report/automations")) {
      return okData({
        configured: true, configNote: "", at: "2026-10-20T02:30:00.000Z",
        jobs: [
          { key: "draft", id: "tr_syn0001", name: "日报初稿（合成）", enabled: true, cond: "每个工作日", lastStatus: "success", lastAt: "2026-10-19T19:00:03+08:00", nextAt: "2026-10-20T19:00:00+08:00", hostile: "x" },
        ],
      });
    }
    return okData({
      at: "2026-10-20T02:30:00.000Z",
      folderUrl: "https://alidocs.dingtalk.com/i/nodes/synfold000000000001",
      items: [
        { name: "20261012-20261023 双周报（合成乙）", nodeId: "synweek0000000000000b", url: "https://alidocs.dingtalk.com/i/nodes/doc-b", created: "", updated: "2026-10-09T10:00:00.000Z" },
      ],
      hasMore: false,
    });
  }) as unknown as typeof fetch;

  const autos = await fetchReportAutomations({ fresh: true }, fetchImpl);
  assert.equal(urls[0], "http://localhost/local/report/automations?fresh=1");
  assert.equal(autos.jobs.length, 1);
  assert.equal(autos.jobs[0].lastStatus, "success");
  assert.equal(JSON.stringify(autos).includes("hostile"), false);

  const weeklies = await fetchReportWeeklies({ fresh: true }, fetchImpl);
  assert.equal(urls[1], "http://localhost/local/report/weeklies?fresh=1");
  assert.equal(weeklies.items.length, 1);
  assert.equal(weeklies.items[0].name, "20261012-20261023 双周报（合成乙）");

  const docUrls: string[] = [];
  const docFetch = (async (input: Request | string) => {
    docUrls.push(String(input instanceof Request ? input.url : input));
    return okData({
      at: "2026-10-20T02:30:00.000Z", nodeId: "synweek0000000000000b",
      name: "20261012-20261023 双周报（合成乙）", url: "https://alidocs.dingtalk.com/i/nodes/doc-b",
      markdown: "# 合成正文", truncated: false, contentHash: "abc123",
    });
  }) as unknown as typeof fetch;
  const doc = await fetchReportWeeklyDoc("synweek0000000000000b", undefined, docFetch);
  assert.equal(docUrls[0], "http://localhost/local/report/weekly?node=synweek0000000000000b");
  assert.equal(doc.markdown, "# 合成正文");
  assert.equal(doc.contentHash, "abc123");
});

// ---------------------------------------------------------------------------
// 评审 P3-1 回归：北京时间显示（clockCn）
// ---------------------------------------------------------------------------

test("clockCn renders wall clock in UTC+8 and keeps naive Beijing strings as-is", () => {
  assert.equal(clockCn("2026-10-20T02:30:00.000Z"), "2026-10-20 10:30", "UTC ISO 换算到北京墙钟");
  assert.equal(clockCn("2026-10-20T19:00:00+08:00"), "2026-10-20 19:00", "自带 +08:00 的串不受影响");
  assert.equal(clockCn("2026-10-20T14:30"), "2026-10-20 14:30", "不带时区的本地串按北京墙钟原样截切");
  assert.equal(clockCn("2026-10-20 14:30:00"), "2026-10-20 14:30", "空格分隔的 dws 形态同样处理");
  assert.equal(clockCn(""), "");
  assert.equal(clockCn("not-a-date"), "not-a-date", "解析失败原样返回不吞字段");
});

// ---------------------------------------------------------------------------
// F6-P1 日报回写客户端：两步 dry→confirm。fetch 全程 mock，绝不触网。
// 重点断言：POST 方法/URL/body 白名单收敛、写投影（敌意字段不入前端）、
// record_conflict 冲突清单、写错误码文案、未知码/离线/坏 JSON 折叠为 unavailable。
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** 捕获请求（method/url/body）后按 responder 返回合成响应。 */
function writeFetch(responder: (call: CapturedCall) => Response) {
  const calls: CapturedCall[] = [];
  const impl = (async (input: Request | string) => {
    const req = input instanceof Request ? input : new Request(input);
    const call: CapturedCall = { method: req.method, url: req.url, body: await req.text() };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function errRes(code: string, message: string, data?: unknown, status = 400): Response {
  return jsonRes({ ok: false, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);
}

test("write client constants mirror the server whitelist and cap", () => {
  assert.deepEqual([...REPORT_WRITABLE_FIELDS], ["topic", "followup", "opportunity", "risk", "other"]);
  assert.equal(REPORT_MAX_TEXT, 4000);
});

test("saveReportDraftDry POSTs only whitelisted cells and projects the diff", async () => {
  const { impl, calls } = writeFetch(() => okData({
    token: "tok-syn-1", recordId: "rec-syn-01", at: "2026-10-20T02:30:00.000Z", today: "2026-10-20",
    diff: [
      { key: "topic", fieldId: "fld-topic", before: "合成日报主题", after: "合成日报主题（改）", changed: true },
      { key: "risk", fieldId: "fld-risk", before: "", after: "合成风险一条", changed: true },
      { key: "dept", fieldId: "fld-dept", before: "交付部", after: "研发部", changed: true }, // 敌意：非白名单，须被投影丢弃
    ],
  }));
  const cells = { topic: "合成日报主题（改）", risk: "合成风险一条", dept: "研发部", workStatus: "x" } as unknown as ReportSaveCells;
  const dry = await saveReportDraftDry({ recordId: "rec-syn-01", cells }, impl);

  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://localhost/local/report/save-dry");
  const sent = JSON.parse(calls[0].body) as { recordId: string; cells: Record<string, unknown> };
  assert.equal(sent.recordId, "rec-syn-01");
  assert.deepEqual(Object.keys(sent.cells), ["topic", "risk"], "非白名单 dept/workStatus 不得上行");

  assert.equal(dry.token, "tok-syn-1");
  assert.equal(dry.recordId, "rec-syn-01");
  assert.deepEqual(dry.diff.map((item) => item.key), ["topic", "risk"], "敌意 diff（dept）须被投影丢弃");
  assert.equal(dry.diff[0].changed, true);
  assert.equal(JSON.stringify(dry).includes("fld-dept"), false);
});

test("saveReportDraftConfirm POSTs the token and projects the updated whitelist", async () => {
  const { impl, calls } = writeFetch(() => okData({
    recordId: "rec-syn-01", verified: true, at: "2026-10-20T02:31:00.000Z",
    updated: ["topic", "risk", "dept"], audited: true, note: "已保存并回读一致。", // 敌意 updated.dept 须丢弃
  }));
  const done = await saveReportDraftConfirm("tok-syn-1", impl);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://localhost/local/report/save-confirm");
  assert.deepEqual(JSON.parse(calls[0].body), { confirm: "tok-syn-1" });
  assert.equal(done.verified, true);
  assert.deepEqual([...done.updated], ["topic", "risk"]);
  assert.equal(done.audited, true);
});

test("submitReportDry projects channel/cooldown/alreadySubmitted for open and blocked", async () => {
  const open = writeFetch(() => okData({
    token: "tok-syn-2", at: "2026-10-20T02:30:00.000Z", today: "2026-10-20", blocked: false, cooldownRemainMs: 0,
    alreadySubmitted: null, channel: { available: true, enabled: true, lastStatus: "success", nextAt: "2026-10-20T19:00:00+08:00", note: "" },
    note: "可提交。",
  }));
  const openDry = await submitReportDry(open.impl);
  assert.equal(open.calls[0].method, "POST");
  assert.equal(open.calls[0].url, "http://localhost/local/report/submit-dry");
  assert.equal(openDry.blocked, false);
  assert.equal(openDry.channel.available, true);
  assert.equal(openDry.alreadySubmitted, null);

  const blocked = writeFetch(() => okData({
    token: "tok-syn-3", at: "2026-10-20T02:30:00.000Z", today: "2026-10-20", blocked: true, cooldownRemainMs: 120000,
    alreadySubmitted: { n: 1, items: [{ title: "合成提交（甲科技日报）", time: "2026-10-20T01:05:00.000Z" }] },
    channel: { available: false, enabled: true, lastStatus: "", nextAt: "", note: "SSH 通道不可用" },
    note: "今日已提交。",
  }));
  const blockedDry = await submitReportDry(blocked.impl);
  assert.equal(blockedDry.blocked, true);
  assert.equal(blockedDry.cooldownRemainMs, 120000);
  assert.equal(blockedDry.alreadySubmitted?.n, 1);
  assert.equal(blockedDry.channel.available, false);
});

test("submitReportConfirm POSTs the token and projects the honest result", async () => {
  const { impl, calls } = writeFetch(() => okData({
    at: "2026-10-20T02:32:00.000Z", executed: true, runId: "run-syn-01", sessionId: "ses-syn-01",
    verified: true, submittedN: 1, audited: true, note: "已触发并回读到 outbox。",
  }));
  const done = await submitReportConfirm("tok-syn-2", impl);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://localhost/local/report/submit-confirm");
  assert.deepEqual(JSON.parse(calls[0].body), { confirm: "tok-syn-2" });
  assert.equal(done.executed, true);
  assert.equal(done.runId, "run-syn-01");
  assert.equal(done.verified, true);
  assert.equal(done.submittedN, 1);
});

test("fetchReportWrites GETs and projects the audit tail with exitCode passthrough", async () => {
  const { impl, calls } = writeFetch(() => okData({
    total: 55,
    writes: [
      { at: "2026-10-20T02:32:00.000Z", op: "submit", phase: "run", target: "tr_syn0003", exitCode: 0, executed: true, ok: true, verified: false, maskedPreview: "合成…" },
      { at: "2026-10-20T02:31:00.000Z", op: "submit", phase: "verify", target: "tr_syn0003", exitCode: null, executed: true, ok: true, verified: true, maskedPreview: "" },
      { at: "2026-10-20T02:30:00.000Z", op: "save", phase: "update", target: "rec-syn-01", exitCode: "no_key", executed: false, ok: false, verified: false, maskedPreview: "已脱敏" },
      { at: "2026-10-20T02:29:00.000Z", op: "delete", phase: "bogus", target: "x", exitCode: 1, executed: true, ok: false, verified: false, maskedPreview: "" }, // 敌意 op/phase 须被规范化
    ],
  }));
  const view = await fetchReportWrites(impl);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://localhost/local/report/writes");
  assert.equal(view.total, 55);
  assert.equal(view.writes.length, 4);
  assert.equal(view.writes[0].exitCode, 0, "数字 exitCode 透传");
  assert.equal(view.writes[1].exitCode, null, "null exitCode 透传");
  assert.equal(view.writes[2].exitCode, "no_key", "字符串 exitCode 透传");
  assert.equal(view.writes[3].op, "save", "非白名单 op 规范化为 save");
  assert.equal(view.writes[3].phase, "update", "非白名单 phase 规范化为 update");
});

test("record_conflict surfaces structured conflicts so the UI can refresh", async () => {
  const { impl } = writeFetch(() => errRes("record_conflict", "记录已被外部更新（可能初稿任务刚跑完）：本次未覆盖任何内容。", {
    expectedRecordId: "rec-syn-01",
    currentRecordId: "rec-syn-02",
    current: { topic: "最新主题", dept: "交付部", workStatus: "正常", followup: "", opportunity: "", risk: "", other: "", modifiedAt: "2026-10-20T02:29:00.000Z" },
  }, 409));
  const error = await expectError(saveReportDraftConfirm("tok-syn-stale", impl));
  assert.equal(error.code, "record_conflict");
  assert.equal(error.conflicts?.expectedRecordId, "rec-syn-01");
  assert.equal(error.conflicts?.currentRecordId, "rec-syn-02");
  assert.equal(error.conflicts?.current.topic, "最新主题");
  assert.match(reportErrorMessage(error), /外部更新|未覆盖/);
});

test("write error codes map to honest copy (cooldown/dws_missing/already_submitted/confirm_stale/unconfigured)", async () => {
  const cooldown = writeFetch(() => errRes("cooldown", "距上次提交不足 5 分钟冷却。", undefined, 429));
  const cooldownError = await expectError(submitReportConfirm("tok", cooldown.impl));
  assert.equal(cooldownError.code, "cooldown");
  assert.match(reportErrorMessage(cooldownError), /冷却|不会自动重发/);

  const missing = writeFetch(() => errRes("dws_missing", "未找到 dws CLI。", undefined, 503));
  const missingError = await expectError(saveReportDraftConfirm("tok", missing.impl));
  assert.equal(missingError.code, "dws_missing");
  assert.match(reportErrorMessage(missingError), /未找到 dws CLI|未写入|未执行/);

  const dup = writeFetch(() => errRes("already_submitted", "今日已提交过日报。", undefined, 409));
  const dupError = await expectError(submitReportConfirm("tok", dup.impl));
  assert.equal(dupError.code, "already_submitted");
  assert.match(reportErrorMessage(dupError), /不重复发送/);

  const stale = writeFetch(() => errRes("confirm_stale", "确认码已过期。", undefined, 409));
  const staleError = await expectError(saveReportDraftConfirm("tok", stale.impl));
  assert.equal(staleError.code, "confirm_stale");
  assert.match(reportErrorMessage(staleError), /过期|一次性/);

  const unconfigured = writeFetch(() => errRes("report_unconfigured", "未配置 .local-cache/report.json。", undefined, 400));
  const unconfiguredError = await expectError(saveReportDraftDry({ recordId: "rec-syn-01", cells: { topic: "x" } }, unconfigured.impl));
  assert.equal(unconfiguredError.code, "report_unconfigured");
  assert.match(reportErrorMessage(unconfiguredError), /report\.json/);
});

test("unknown write code, offline, and bad JSON all fold to unavailable", async () => {
  const unknown = writeFetch(() => errRes("brand_new_code", "上游原文", undefined, 500));
  const unknownError = await expectError(saveReportDraftConfirm("tok", unknown.impl));
  assert.equal(unknownError.code, "unavailable", "白名单外写错误码一律折叠为 unavailable");

  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal((await expectError(submitReportDry(offline))).code, "unavailable");
  assert.equal((await expectError(fetchReportWrites(offline))).code, "unavailable");

  const badJson = writeFetch(() => new Response("{ 不是 JSON", { status: 200 }));
  assert.equal((await expectError(saveReportDraftConfirm("tok", badJson.impl))).code, "unavailable");

  const badShape = writeFetch(() => okData({ token: "" })); // 缺 token → 投影失败
  assert.equal((await expectError(submitReportDry(badShape.impl))).code, "invalid_response");
});
