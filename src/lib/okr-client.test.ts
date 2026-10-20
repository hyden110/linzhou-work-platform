import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOkrEdits,
  fetchOkrOverview,
  okrErrorMessage,
  OkrClientError,
  refreshOkrSnapshot,
  runOkrSyncConfirm,
  runOkrSyncDry,
  sortProgressDesc,
} from "./okr-client.ts";

// ---------------------------------------------------------------------------
// 合成数据（红线）：目标 id / 文本 / 工号全为合成值，fetch 全程 mock，绝不触网。
// 重点断言：白名单投影（敌意 session.value 不入前端）、逐项差异 / 冲突清单透传、
// {error:{code,message}} 错误折叠与友好文案。
// ---------------------------------------------------------------------------

const O_ID = "0123456789abcdef01234567";
const KR_ID = "abcdef0123456789abcdef01";

const SYN_OVERVIEW = {
  hasSnapshot: true,
  snapshot: {
    generatedAt: "2026-10-20 09:00:00",
    mode: "live",
    period: { id: "p1", name: "FY27", periodType: "FY", start: null, end: null },
    periodsFY: [
      { id: "p1", name: "FY27", periodType: "FY" },
      { id: "p2", name: "FY27 S1", periodType: "FY_S1" },
    ],
    user: { name: "合成真名", nick: "合成花名", dept: "合成部门" },
    audit: { status: "APPROVED", statusLabel: "已通过" },
    totals: { oCount: 1, krCount: 1, crdProgressCount: 2 },
    objectives: [
      {
        idx: "O1",
        id: O_ID,
        title: "合成目标标题",
        displayTitle: "合成目标标题",
        desc: "合成描述",
        weight: 40,
        typeLabel: "业务路径",
        status: 1,
        progress: 30,
        krCount: 1,
        keyResults: [
          { idx: "KR1", id: KR_ID, title: "合成 KR", weight: 100, typeLabel: "承诺型", targetLabel: "7.4 亿", progress: 20, status: 1, indicator: { targetValue: "7.4", unit: "亿", currentValue: "1.5" } },
        ],
        progressRecords: [
          { _id: "r1", description: "较早进展", gmtCreate: "2026-09-01 10:00:00", creatorName: "合成花名" },
          { _id: "r2", content: "最新进展", createdAt: "2026-10-01 10:00:00" },
        ],
        period: { name: "FY27" },
      },
    ],
    hostile: "drop-me",
  },
  edits: [{ kind: "o", oId: O_ID, krId: null, field: "title", from: "旧", to: "新" }],
  exportedAt: "2026-10-21T03:40:00.000Z",
  baseSnapshotAt: "2026-10-20 09:00:00",
  session: {
    user: { empId: "SYN-EMP-0001", name: "合成用户" },
    session: { set: true, masked: "syn_…共 66 字符", state: "ok", value: "SYN-VALUE-xyz789" },
  },
};

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

function fakeFetch(reply: () => Response, captured: CapturedRequest[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    captured.push({
      url: request.url,
      method: request.method,
      body: request.method === "GET" ? "" : await request.text(),
    });
    return reply();
  }) as unknown as typeof fetch;
}

function okData(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
}

function errorBody(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message }, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectError(promise: Promise<unknown>): Promise<OkrClientError> {
  try {
    await promise;
  } catch (error) {
    return error as OkrClientError;
  }
  throw new Error("expected the promise to reject");
}

test("fetchOkrOverview projects the whitelist and drops hostile fields", async () => {
  const captured: CapturedRequest[] = [];
  const overview = await fetchOkrOverview(fakeFetch(() => okData(SYN_OVERVIEW), captured));
  assert.equal(captured[0]!.url.endsWith("/local/okr"), true);
  assert.equal(captured[0]!.method, "GET");
  assert.equal(overview.hasSnapshot, true);
  const snapshot = overview.snapshot!;
  assert.equal(snapshot.objectives.length, 1);
  const objective = snapshot.objectives[0]!;
  assert.equal(objective.title, "合成目标标题");
  assert.equal(objective.keyResults[0]!.indicator?.targetValue, "7.4");
  assert.equal("hostile" in (snapshot as unknown as Record<string, unknown>), false, "敌意多余字段一律丢弃");
  // 敌意 session.value 绝不进入前端状态
  const serialized = JSON.stringify(overview);
  assert.ok(!serialized.includes("SYN-VALUE-xyz789"), "投影里绝无 cookie 分量原值");
  assert.equal(overview.session.masked, "syn_…共 66 字符");
  assert.equal(overview.session.empId, "SYN-EMP-0001");
  assert.deepEqual(overview.edits, [{ kind: "o", oId: O_ID, krId: null, field: "title", from: "旧", to: "新" }]);
});

test("fetchOkrOverview keeps hasSnapshot:false as an honest empty state", async () => {
  const overview = await fetchOkrOverview(fakeFetch(() => okData({ ...SYN_OVERVIEW, hasSnapshot: false, snapshot: null })));
  assert.equal(overview.hasSnapshot, false);
  assert.equal(overview.snapshot, null);
});

test("client folds unknown error codes to unavailable and keeps stable ones", async () => {
  const noSession = await expectError(fetchOkrOverview(fakeFetch(() => errorBody("profile_no_session", "尚未配置 BUC 会话", 400))));
  assert.equal(noSession.code, "profile_no_session");
  assert.ok(okrErrorMessage(noSession).includes("个人中心"));

  const hostile = await expectError(fetchOkrOverview(fakeFetch(() => errorBody("evil_code", "x", 500))));
  assert.equal(hostile.code, "unavailable");

  const offline = await expectError(fetchOkrOverview((async () => { throw new Error("net"); }) as unknown as typeof fetch));
  assert.equal(offline.code, "unavailable");
  assert.ok(okrErrorMessage(offline).includes("dev:function"));
});

test("refreshOkrSnapshot POSTs /local/okr/refresh and projects the summary", async () => {
  const captured: CapturedRequest[] = [];
  const summary = await refreshOkrSnapshot(fakeFetch(() => okData({
    generatedAt: "2026-10-21 03:40:00", mode: "live",
    period: { id: "p1", name: "FY27", periodType: "FY" },
    totals: { oCount: 2, krCount: 5, crdProgressCount: 3 }, sizeKb: 12.5,
  }), captured));
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.url.endsWith("/local/okr/refresh"), true);
  assert.equal(summary.totals.oCount, 2);
  assert.equal(summary.period?.name, "FY27");
});

test("fetchOkrEdits returns the staged edit list", async () => {
  const staged = await fetchOkrEdits(fakeFetch(() => okData({ edits: SYN_OVERVIEW.edits, exportedAt: SYN_OVERVIEW.exportedAt, baseSnapshotAt: "" })));
  assert.equal(staged.edits.length, 1);
  assert.equal(staged.exportedAt, SYN_OVERVIEW.exportedAt);
});

test("runOkrSyncDry sends {edits, baseSnapshotAt} and projects per-item diffs", async () => {
  const captured: CapturedRequest[] = [];
  const result = await runOkrSyncDry(
    [{ kind: "o", oId: O_ID, krId: null, field: "title", from: "旧", to: "新" }],
    "2026-10-20 09:00:00",
    fakeFetch(() => okData({
      mode: "dry-run",
      ok: true,
      items: [
        { key: `${O_ID}||title`, kind: "o", oId: O_ID, krId: null, field: "title", before: "旧", after: "新", crd: "他人已改", state: "conflict", conflict: true, note: "冲突" },
        { key: `${O_ID}|${KR_ID}|weight`, kind: "kr", oId: O_ID, krId: KR_ID, field: "weight", before: "30", after: "40", crd: "30", state: "pending", conflict: false, note: "" },
      ],
      note: "dry-run：未写任何数据",
    }), captured),
  );
  assert.equal(captured[0]!.method, "POST");
  const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
  assert.equal((body.edits as unknown[]).length, 1);
  assert.equal(body.baseSnapshotAt, "2026-10-20 09:00:00");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.conflict, true);
  assert.equal(result.items[1]!.state, "pending");
});

test("runOkrSyncConfirm sends {keys, acceptConflicts} and surfaces the conflict list on 409", async () => {
  const captured: CapturedRequest[] = [];
  const result = await runOkrSyncConfirm(
    [`${O_ID}|${KR_ID}|weight`],
    false,
    fakeFetch(() => okData({ mode: "confirm", ok: true, wrote: 1, items: [], note: "" }), captured),
  );
  const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
  assert.deepEqual(body.keys, [`${O_ID}|${KR_ID}|weight`]);
  assert.equal(body.acceptConflicts, false);
  assert.equal(result.wrote, 1);

  const conflicts = [{ key: `${O_ID}||title`, field: "title", crd: "他人已改", before: "旧", after: "新" }];
  const error = await expectError(runOkrSyncConfirm(
    [`${O_ID}||title`],
    false,
    fakeFetch(() => errorBody("okr_conflict", "1 个勾选项冲突", 409, { conflicts })),
  ));
  assert.equal(error.code, "okr_conflict");
  assert.deepEqual(error.conflicts, conflicts);
  assert.ok(okrErrorMessage(error).includes("冲突"));
});

test("sortProgressDesc sorts records by time descending (string timestamps)", () => {
  const sorted = sortProgressDesc([
    { id: "a", description: "早", createdAt: "2026-09-01 10:00:00", creator: "" },
    { id: "b", description: "晚", createdAt: "2026-10-01 10:00:00", creator: "" },
    { id: "c", description: "无时间", createdAt: "", creator: "" },
  ]);
  assert.deepEqual(sorted.map((record) => record.id), ["b", "a", "c"]);
});
