import assert from "node:assert/strict";
import test from "node:test";

import {
  clockCn,
  fetchReportAutomations,
  fetchReportState,
  fetchReportWeeklyDoc,
  fetchReportWeeklies,
  reportErrorMessage,
  ReportClientError,
} from "./report-client.ts";

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
