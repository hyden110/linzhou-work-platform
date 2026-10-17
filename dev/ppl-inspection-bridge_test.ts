import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandRunner } from "./crm-bridge.ts";
import { createLocalRouter } from "./local-router.ts";
import { createPplInspectionBridge, projectState } from "./ppl-inspection-bridge.ts";

const NOW = 1_790_000_000_000;

// 全部为合成数据：不出现真实客户、项目、CID 或 BPID。
const REC_OK = {
  id: "r001ab12cd34",
  fingerprint: "fp-r001-aa01",
  customerName: "示例客户甲",
  cid: "990000001",
  suggestedProjectName: "FY27-Q3-示例客户甲-智算-通义",
  opportunityType: "智算-通义",
  amountYuan: 500000,
  blocked: false,
  blockReason: null,
  dedupe: { status: "new", evidence: null },
  changeNote: "示例日报摘要",
  state: "pending",
};

const REC_BLOCKED = {
  id: "r002ef56gh78",
  fingerprint: "fp-r002-bb02",
  customerName: "示例客户乙",
  cid: "990000002",
  suggestedProjectName: "FY27-Q3-示例客户乙-智算-GPU",
  opportunityType: "智算-GPU",
  amountYuan: null,
  blocked: true,
  blockReason: "amount_missing",
  dedupe: { status: "suspected", evidence: [{ projectId: "910000002", projectName: "FY27-Q3-示例客户乙-既有项目", cid: "990000002" }] },
  changeNote: "示例日报摘要",
  state: "pending",
};

function inspectionFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    state: "ok",
    generatedAt: "2026-10-16T09:15:00+08:00",
    snapshotGeneratedAt: "2026-10-15T06:41:13Z",
    snapshotStale: false,
    reportCount: 2,
    recommendations: [structuredClone(REC_OK), structuredClone(REC_BLOCKED)],
    summary: { total: 2, pending: 2, exists: 0, suspected: 1, new: 1, blocked: 1 },
    error: null,
  };
}

async function withCache(handler: (cacheDir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "ppl-bridge-"));
  try {
    await handler(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(await predicate(), "timed out waiting for the bridge to settle");
}

test("inspection is undefined without a product and parses latest.json", async () => {
  await withCache(async (cacheDir) => {
    const bridge = createPplInspectionBridge({ cacheDir, now: () => NOW });
    assert.equal(await bridge.inspection(), undefined);

    await mkdir(join(cacheDir, "ppl-inspection"), { recursive: true });
    await writeFile(join(cacheDir, "ppl-inspection", "latest.json"), JSON.stringify(inspectionFixture()), "utf-8");
    const inspection = await bridge.inspection();
    assert.ok(inspection);
    assert.equal(inspection.state, "ok");
    assert.equal(inspection.reportCount, 2);
    assert.equal(inspection.recommendations.length, 2);
    assert.equal(inspection.recommendations[0]!.fingerprint, "fp-r001-aa01");
    assert.equal(inspection.recommendations[1]!.blocked, true);

    // 缺 id 的坏条目被丢弃，好条目保留。
    const dirty = inspectionFixture() as { recommendations: unknown[] };
    dirty.recommendations = [{ customerName: "无 id 条目" }, REC_OK];
    await writeFile(join(cacheDir, "ppl-inspection", "latest.json"), JSON.stringify(dirty), "utf-8");
    const cleaned = await bridge.inspection();
    assert.equal(cleaned!.recommendations.length, 1);
    assert.equal(cleaned!.recommendations[0]!.id, REC_OK.id);

    await writeFile(join(cacheDir, "ppl-inspection", "latest.json"), "{not json", "utf-8");
    assert.equal(await bridge.inspection(), undefined);
  });
});

test("decide enforces the approval state machine and writes approvals.json 0600", async () => {
  await withCache(async (cacheDir) => {
    await mkdir(join(cacheDir, "ppl-inspection"), { recursive: true });
    await writeFile(join(cacheDir, "ppl-inspection", "latest.json"), JSON.stringify(inspectionFixture()), "utf-8");
    const bridge = createPplInspectionBridge({ cacheDir, now: () => NOW });

    // 金额缺失（blocked）的推荐不能同意——绝不猜金额。
    const blockedApprove = await bridge.decide(REC_BLOCKED.id, "approve");
    assert.deepEqual(blockedApprove, { ok: false, error: "blocked_recommendation" });

    // 放弃允许（不进入创建路径）。
    const discard = await bridge.decide(REC_BLOCKED.id, "discard");
    assert.equal(discard.ok, true);
    if (discard.ok) assert.equal(discard.state, "discarded");

    const approve = await bridge.decide(REC_OK.id, "approve", "同意创建");
    assert.equal(approve.ok, true);
    if (approve.ok) assert.equal(approve.state, "approved");

    // 状态机闸门：同一条目（同指纹）不可二次决策；未知条目/非法 id 拒绝。
    assert.deepEqual(await bridge.decide(REC_OK.id, "approve"), { ok: false, error: "already_decided" });
    assert.deepEqual(await bridge.decide(REC_OK.id, "discard"), { ok: false, error: "already_decided" });
    assert.deepEqual(await bridge.decide("r999zz", "approve"), { ok: false, error: "not_found" });
    assert.deepEqual(await bridge.decide("bad id!!", "approve"), { ok: false, error: "invalid_request" });
    assert.deepEqual(await bridge.decide(REC_OK.id, "maybe" as "approve"), { ok: false, error: "invalid_request" });

    const decisions = await bridge.decisions();
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]!.recommendationId, REC_BLOCKED.id);
    assert.equal(decisions[0]!.action, "discard");
    assert.equal(decisions[0]!.fingerprint, REC_BLOCKED.fingerprint);
    assert.equal(decisions[1]!.recommendationId, REC_OK.id);
    assert.equal(decisions[1]!.action, "approve");
    assert.equal(decisions[1]!.fingerprint, REC_OK.fingerprint);
    assert.equal(decisions[1]!.note, "同意创建");

    const approvalsPath = join(cacheDir, "ppl-inspection", "approvals.json");
    const raw = JSON.parse(await readFile(approvalsPath, "utf-8")) as { schemaVersion: number; decisions: unknown[] };
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.decisions.length, 2);
    assert.equal((await stat(approvalsPath)).mode & 0o777, 0o600);
  });
});

test("projectState honors the latest decision and rejects unknown states", () => {
  const decisions = [
    { id: "d1", recommendationId: REC_OK.id, action: "discard" as const, decidedAt: "2026-10-16T01:00:00.000Z", note: null, fingerprint: REC_OK.fingerprint },
    { id: "d2", recommendationId: REC_OK.id, action: "approve" as const, decidedAt: "2026-10-16T02:00:00.000Z", note: null, fingerprint: REC_OK.fingerprint },
  ];
  assert.equal(projectState("pending", decisions, REC_OK.id, REC_OK.fingerprint), "approved");
  assert.equal(projectState("pending", decisions, REC_BLOCKED.id, REC_BLOCKED.fingerprint), "pending");
  assert.equal(projectState("creating", [], REC_OK.id), "creating");
  assert.equal(projectState("weird-state", [], REC_OK.id), "pending");
  assert.equal(projectState(undefined, [], REC_OK.id), "pending");
});

test("projectState treats a fingerprint mismatch as a fresh pending item", () => {
  // 返工 #2：同 id 但指纹变化（新巡检产物）→ 旧决策不复用。
  const decisions = [
    { id: "d1", recommendationId: REC_OK.id, action: "approve" as const, decidedAt: "2026-10-16T01:00:00.000Z", note: null, fingerprint: REC_OK.fingerprint },
  ];
  assert.equal(projectState("pending", decisions, REC_OK.id, REC_OK.fingerprint), "approved");
  assert.equal(projectState("pending", decisions, REC_OK.id, "fp-r001-zz99"), "pending");
  assert.equal(projectState("pending", decisions, REC_OK.id), "pending");
});

test("startRefresh runs only the inspection script and tracks its status", async () => {
  await withCache(async (cacheDir) => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] });
      return { code: 0, stdout: "{\"state\":\"ok\"}" };
    };
    const bridge = createPplInspectionBridge({ cacheDir, run: runner, now: () => NOW });

    assert.deepEqual(bridge.refreshStatus(), { state: "idle" });
    const started = bridge.startRefresh();
    assert.equal(started.state, "running");
    // running 期间重复触发不会并发再跑。
    assert.equal(bridge.startRefresh().state, "running");
    assert.equal(calls.length, 1);

    await waitFor(() => bridge.refreshStatus().state === "succeeded");
    const finished = bridge.refreshStatus();
    assert.equal(finished.state, "succeeded");
    if (finished.state === "succeeded") assert.equal(finished.error, null);
    assert.equal(calls[0]!.file, "python3");
    assert.ok(calls[0]!.args[0]!.endsWith(join("sync", "ppl_daily_report.py")));
    assert.equal(calls[0]!.args.length, 1, "巡检刷新只允许运行只读巡检脚本本身");
  });

  await withCache(async (cacheDir) => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: "" });
    const bridge = createPplInspectionBridge({ cacheDir, run: runner, now: () => NOW });
    bridge.startRefresh();
    await waitFor(() => bridge.refreshStatus().state === "failed");
    const failed = bridge.refreshStatus();
    if (failed.state === "failed") assert.equal(failed.error, "inspection_failed");
  });
});

const TRUSTED = { host: "127.0.0.1:8000" };

function get(path: string): Request {
  return new Request(`http://127.0.0.1:8000${path}`, { method: "GET", headers: TRUSTED });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    method: "POST",
    headers: { ...TRUSTED, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("router serves ppl inspection read-only and approval only through POST", async () => {
  await withCache(async (cacheDir) => {
    await mkdir(join(cacheDir, "ppl-inspection"), { recursive: true });
    const router = createLocalRouter({
      port: 8000,
      pplInspectionBridge: createPplInspectionBridge({ cacheDir, now: () => NOW }),
    });

    // 无产物：404 诚实标注，不编造数据。
    assert.equal((await router(get("/local/ppl/inspection"))).status, 404);

    await writeFile(join(cacheDir, "ppl-inspection", "latest.json"), JSON.stringify(inspectionFixture()), "utf-8");
    const listed = await router(get("/local/ppl/inspection"));
    assert.equal(listed.status, 200);
    const payload = await listed.json() as {
      data: { reportCount: number; recommendations: Array<{ id: string; fingerprint: string | null }> };
      decisions: unknown[];
      refresh: { state: string };
    };
    assert.equal(payload.data.reportCount, 2);
    assert.equal(payload.data.recommendations[0]!.fingerprint, "fp-r001-aa01");
    assert.deepEqual(payload.decisions, []);
    assert.equal(payload.refresh.state, "idle");

    // 同意 blocked 推荐 → 422；同意可用推荐 → 201；重复 → 409；未知 → 404；非法动作 → 400。
    assert.equal((await router(post("/local/ppl/approval", { recommendationId: REC_BLOCKED.id, action: "approve" }))).status, 422);
    const approved = await router(post("/local/ppl/approval", { recommendationId: REC_OK.id, action: "approve" }));
    assert.equal(approved.status, 201);
    const approvedPayload = await approved.json() as { data: { action: string; fingerprint: string | null } };
    assert.equal(approvedPayload.data.action, "approve");
    assert.equal(approvedPayload.data.fingerprint, REC_OK.fingerprint);
    assert.equal((await router(post("/local/ppl/approval", { recommendationId: REC_OK.id, action: "discard" }))).status, 409);
    assert.equal((await router(post("/local/ppl/approval", { recommendationId: "r999zz", action: "approve" }))).status, 404);
    assert.equal((await router(post("/local/ppl/approval", { recommendationId: REC_OK.id, action: "maybe" }))).status, 400);

    // 决策只经 POST：GET /local/ppl/approval 直接被方法检查挡下（405），不存在读取型副作用。
    assert.equal((await router(get("/local/ppl/approval"))).status, 405);

    const after = await router(get("/local/ppl/inspection"));
    const afterPayload = await after.json() as { decisions: Array<{ recommendationId: string; action: string }> };
    assert.deepEqual(afterPayload.decisions.map((decision) => [decision.recommendationId, decision.action]), [[REC_OK.id, "approve"]]);
  });
});

test("router accepts a new decision when the same id carries a new fingerprint", async () => {
  await withCache(async (cacheDir) => {
    const inspectionDir = join(cacheDir, "ppl-inspection");
    await mkdir(inspectionDir, { recursive: true });
    const latestPath = join(inspectionDir, "latest.json");
    await writeFile(latestPath, JSON.stringify(inspectionFixture()), "utf-8");
    const router = createLocalRouter({
      port: 8000,
      pplInspectionBridge: createPplInspectionBridge({ cacheDir, now: () => NOW }),
    });

    const first = await router(post("/local/ppl/approval", { recommendationId: REC_OK.id, action: "approve" }));
    assert.equal(first.status, 201);

    // 同 id 换指纹（新巡检产物：金额/主题变化）→ 旧决策不复用，可再次决策（非 409）。
    const rotated = inspectionFixture() as { recommendations: Array<Record<string, unknown>> };
    rotated.recommendations[0]!.fingerprint = "fp-r001-zz99";
    await writeFile(latestPath, JSON.stringify(rotated), "utf-8");
    const second = await router(post("/local/ppl/approval", { recommendationId: REC_OK.id, action: "discard" }));
    assert.equal(second.status, 201);

    const listed = await (await router(get("/local/ppl/inspection"))).json() as {
      decisions: Array<{ recommendationId: string; action: string; fingerprint: string | null }>;
    };
    assert.deepEqual(
      listed.decisions.map((decision) => [decision.recommendationId, decision.action, decision.fingerprint]),
      [[REC_OK.id, "approve", REC_OK.fingerprint], [REC_OK.id, "discard", "fp-r001-zz99"]],
    );
  });
});

test("router refresh is 202 and reports the running status", async () => {
  await withCache(async (cacheDir) => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: "" });
    const bridge = createPplInspectionBridge({ cacheDir, run: runner, now: () => NOW });
    const router = createLocalRouter({ port: 8000, pplInspectionBridge: bridge });

    const status = await router(get("/local/ppl/refresh"));
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { data: { state: string } }).data.state, "idle");

    const started = await router(post("/local/ppl/refresh", {}));
    assert.equal(started.status, 202);
    assert.equal((await started.json() as { data: { state: string } }).data.state, "running");

    await waitFor(() => bridge.refreshStatus().state === "succeeded");
    const settled = await router(get("/local/ppl/refresh"));
    assert.equal((await settled.json() as { data: { state: string } }).data.state, "succeeded");
  });
});
