import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createWorklogBridge,
  WORKLOG_MAX_ENTRIES,
  WORKLOG_ROUTES,
  WorklogBridgeError,
  type SqliteReader,
  type WorklogBridge,
} from "./worklog-bridge.ts";

// ---------------------------------------------------------------------------
// 全合成数据：会话 id 一律 syn-*、标题带「（合成）」、app support 一律临时目录；
// sqlite 只经注入 reader 或临时合成库——零真实扫描、零真实用户库接触。
// 只读红线：临时合成库在扫描前后 sha256/size/mtime 必须逐字节不变，且不产生 -wal/-shm。
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date(2026, 9, 20, 12, 0, 0).getTime(); // 本地正午，避开日界
const DAY = 86_400_000;
const TS_OCT19 = new Date(2026, 9, 19, 9, 0, 0).getTime();
const TS_OCT18 = new Date(2026, 9, 18, 9, 0, 0).getTime();
const TS_OCT10 = new Date(2026, 9, 10, 9, 0, 0).getTime(); // 默认 7 天窗口之外

const BASE_URL = "http://127.0.0.1:8787";

const VSCDB_ROWS_QODER = [
  { value: JSON.stringify([
    { sessionId: "syn-q1", title: "客户环境部署上线与故障排查（合成）", timestamp: TS_OCT19 },
    { sessionId: "syn-q1", title: "后一轮不代表任务（合成）", timestamp: TS_OCT19 + 60_000 },
    { sessionId: "syn-q2", title: "知识库整理与沉淀（合成）", timestamp: TS_OCT10 },
  ]) },
];
const AGENT_ROWS_WORK = [
  { id: "syn-w1", name: "GPU 资源测算与成本报价（合成）", created_at: Math.floor(TS_OCT18 / 1000) },
];

function rowsByPath(appSupport: string): Record<string, readonly Record<string, unknown>[]> {
  return {
    [join(appSupport, "Qoder", "User", "globalStorage", "state.vscdb")]: VSCDB_ROWS_QODER,
    [join(appSupport, "QoderWork", "data", "agents.db")]: AGENT_ROWS_WORK,
  };
}

function fakeOpener(appSupport: string, failPaths: ReadonlySet<string> = new Set()) {
  return (dbPath: string): SqliteReader => {
    if (failPaths.has(dbPath)) throw new Error(`database is locked: ${dbPath}`);
    const rows = rowsByPath(appSupport)[dbPath] ?? [];
    return { all: () => rows, close: () => {} };
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "worklog-bridge-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 在临时 app support 里把 4 个源库路径都放上占位文件（内容由注入 reader 决定）。 */
async function seedFakeSources(appSupport: string): Promise<void> {
  for (const rel of [
    join("Qoder", "User", "globalStorage", "state.vscdb"),
    join("QoderCN", "User", "globalStorage", "state.vscdb"),
    join("QoderWork", "data", "agents.db"),
    join("QwenWorkCN", "data", "agents.db"),
  ]) {
    await mkdir(join(appSupport, rel, ".."), { recursive: true });
    await writeFile(join(appSupport, rel), "synthetic-placeholder");
  }
}

function makeBridge(appSupport: string, opts: { failPaths?: ReadonlySet<string>; opener?: (p: string) => SqliteReader } = {}): WorklogBridge {
  return createWorklogBridge({
    appSupportDir: appSupport,
    now: () => FIXED_NOW,
    loadOpener: async () => opts.opener ?? fakeOpener(appSupport, opts.failPaths),
  });
}

async function getJson(bridge: WorklogBridge, path: string): Promise<{ status: number; body: any }> {
  const response = await bridge.handle(new Request(BASE_URL + path, { method: "GET" }));
  assert.ok(response, `${path} 必须由 worklog 桥闭环`);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

test("WORKLOG_ROUTES exposes the two read-only GET routes", () => {
  assert.deepEqual(WORKLOG_ROUTES, [
    { method: "GET", path: "/local/worklog", operation: "list" },
    { method: "GET", path: "/local/worklog/summary", operation: "summary" },
  ]);
});

test("GET /local/worklog returns classified entries + per-stage counts (default last 7 days)", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const bridge = makeBridge(appSupport);
    const { status, body } = await getJson(bridge, "/local/worklog");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const data = body.data;
    assert.equal(data.status, "ok");
    assert.deepEqual(data.range, { from: "2026-10-14", to: "2026-10-20", days: 7 });
    assert.equal(data.total, 2, "syn-q2（10-10）在默认窗口外");
    const q1 = data.entries.find((e: any) => e.sourceKey === "qoder:Qoder:syn-q1");
    assert.ok(q1);
    assert.equal(q1.title, "客户环境部署上线与故障排查（合成）", "同会话取最早一轮标题");
    assert.equal(q1.stageId, "delivery");
    assert.equal(q1.confidence, "high");
    assert.equal(q1.cluster, "部署与排障");
    assert.equal(q1.date, "2026-10-19");
    const w1 = data.entries.find((e: any) => e.sourceKey === "qoder:QoderWork:syn-w1");
    assert.equal(w1.stageId, "validate");
    assert.equal(data.counts.byStage.delivery, 1);
    assert.equal(data.counts.byStage.validate, 1);
    assert.equal(data.counts.unclassified, 0);
    assert.equal(data.sources.length, 4);
    assert.deepEqual(
      data.sources.map((s: any) => [s.instance, s.status, s.count]),
      [["Qoder", "ok", 1], ["QoderCN", "ok", 0], ["QoderWork", "ok", 1], ["QwenWorkCN", "ok", 0]],
    );
    assert.equal(data.truncated, false);
    assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
  });
});

test("GET /local/worklog?days=30 widens the window honestly", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const { body } = await getJson(makeBridge(appSupport), "/local/worklog?days=30");
    assert.equal(body.data.total, 3);
    assert.equal(body.data.range.from, "2026-09-21");
    assert.ok(body.data.entries.some((e: any) => e.sourceKey === "qoder:Qoder:syn-q2"));
  });
});

test("invalid range params map to 400 worklog_invalid_request", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const bridge = makeBridge(appSupport);
    for (const query of ["days=0", "days=abc", "days=7&from=2026-10-01&to=2026-10-02", "from=2026-10-01", "from=2026-10-02&to=2026-10-01", "from=2026-02-30&to=2026-03-01"]) {
      const { status, body } = await getJson(bridge, `/local/worklog?${query}`);
      assert.equal(status, 400, query);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "worklog_invalid_request");
      assert.ok(body.error.message.length > 0);
      assert.ok(!body.error.message.includes(dir), "错误消息不带绝对路径");
    }
    const summary = await getJson(bridge, "/local/worklog/summary?days=999");
    assert.equal(summary.status, 400);
    assert.equal(summary.body.error.code, "worklog_invalid_request");
  });
});

test("wrong method maps to 405; non-worklog paths return undefined (主路由委托契约)", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const bridge = makeBridge(appSupport);
    const post = await bridge.handle(new Request(BASE_URL + "/local/worklog", { method: "POST" }));
    assert.equal(post?.status, 405);
    const body = JSON.parse(await post!.text());
    assert.equal(body.error.code, "method_not_allowed");
    for (const path of ["/local/notify/items", "/local/worklog-x", "/local", "/local/worklog/summary/extra"]) {
      assert.equal(await bridge.handle(new Request(BASE_URL + path)), undefined, path);
    }
    const slashed = await getJson(bridge, "/local/worklog/");
    assert.equal(slashed.status, 200, "尾斜杠归一化后仍命中");
  });
});

test("all sources missing → honest 200 status:missing, never fabricated entries", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "empty-app-support");
    await mkdir(appSupport, { recursive: true });
    const bridge = createWorklogBridge({
      appSupportDir: appSupport,
      now: () => FIXED_NOW,
      existsSync,
      loadOpener: async () => () => { throw new Error("missing 源绝不应被打开"); },
    });
    const { status, body } = await getJson(bridge, "/local/worklog");
    assert.equal(status, 200);
    assert.equal(body.data.status, "missing");
    assert.deepEqual(body.data.entries, []);
    assert.equal(body.data.total, 0);
    assert.ok(body.data.sources.every((s: any) => s.status === "missing" && s.count === 0));
    assert.ok(body.data.missingNote.length > 0, "缺失态给可展示的诚实说明");
    const summary = await getJson(bridge, "/local/worklog/summary");
    assert.equal(summary.body.data.status, "missing");
    assert.equal(summary.body.data.total, 0);
  });
});

test("one source failing → status:partial with redacted note; all failing → 502 worklog_scan_failed", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const workDb = join(appSupport, "QoderWork", "data", "agents.db");
    const partial = makeBridge(appSupport, { failPaths: new Set([workDb]) });
    const { body } = await getJson(partial, "/local/worklog");
    assert.equal(body.data.status, "partial");
    assert.equal(body.data.total, 1, "健康源的条目照常返回");
    const failed = body.data.sources.find((s: any) => s.instance === "QoderWork");
    assert.equal(failed.status, "error");
    assert.ok(failed.note.length > 0 && !failed.note.includes(workDb) && !failed.note.includes(dir));

    const allFail = makeBridge(appSupport, {
      failPaths: new Set([
        join(appSupport, "Qoder", "User", "globalStorage", "state.vscdb"),
        join(appSupport, "QoderCN", "User", "globalStorage", "state.vscdb"),
        workDb,
        join(appSupport, "QwenWorkCN", "data", "agents.db"),
      ]),
    });
    const { status, body: failedBody } = await getJson(allFail, "/local/worklog");
    assert.equal(status, 502);
    assert.equal(failedBody.error.code, "worklog_scan_failed");
  });
});

test("node:sqlite unavailable → 503 worklog_sqlite_unavailable (诚实失败，不伪造)", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const bridge = createWorklogBridge({ appSupportDir: appSupport, now: () => FIXED_NOW, loadOpener: async () => null });
    const { status, body } = await getJson(bridge, "/local/worklog");
    assert.equal(status, 503);
    assert.equal(body.error.code, "worklog_sqlite_unavailable");
    assert.ok(body.error.message.includes("22.5"), "说明 Node 版本要求");
  });
});

test("GET /local/worklog/summary aggregates by day and by stage/cluster", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const { status, body } = await getJson(makeBridge(appSupport), "/local/worklog/summary?days=30");
    assert.equal(status, 200);
    const data = body.data;
    assert.equal(data.total, 3);
    assert.deepEqual(data.byDay, [
      { date: "2026-10-10", count: 1 },
      { date: "2026-10-18", count: 1 },
      { date: "2026-10-19", count: 1 },
    ]);
    assert.equal(data.byStage.length, 9, "全部环节零填充，形状稳定");
    const delivery = data.byStage.find((s: any) => s.id === "delivery");
    assert.deepEqual(delivery, { id: "delivery", name: "交付与上线", count: 1, highConfidence: 1 });
    assert.ok(data.byCluster.some((c: any) => c.name === "测算与报价" && c.count === 1));
    assert.equal(data.unclassified, 0);
  });
});

test("entries are sorted ts desc and capped at WORKLOG_MAX_ENTRIES with truncated flag", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const many = Array.from({ length: WORKLOG_MAX_ENTRIES + 5 }, (_, i) => ({
      id: `syn-bulk-${i}`,
      name: `批量任务 ${i}（合成）`,
      created_at: Math.floor((TS_OCT18 + i * 1000) / 1000),
    }));
    const workDb = join(appSupport, "QoderWork", "data", "agents.db");
    const bridge = createWorklogBridge({
      appSupportDir: appSupport,
      now: () => FIXED_NOW,
      loadOpener: async () => (dbPath: string) => ({
        all: () => (dbPath === workDb ? many : (rowsByPath(appSupport)[dbPath] ?? [])),
        close: () => {},
      }),
    });
    const { body } = await getJson(bridge, "/local/worklog?days=30");
    assert.equal(body.data.truncated, true);
    assert.equal(body.data.entries.length, WORKLOG_MAX_ENTRIES);
    const tsList = body.data.entries.map((e: any) => e.ts);
    assert.deepEqual(tsList, [...tsList].sort((a, b) => b - a), "最近活跃在前");
  });
});

test("红线：默认 opener 走真 node:sqlite 只读扫描——源库字节/mtime 不变、无 -wal/-shm 残留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worklog-readonly-"));
  tempDirs.push(dir);
  const appSupport = join(dir, "app-support");
  const dbDir = join(appSupport, "Qoder", "User", "globalStorage");
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "state.vscdb");

  // 测试自建合成库（仅此临时文件允许写；随后关闭，扫描阶段零写入）
  const setup = new DatabaseSync(dbPath);
  setup.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  setup.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    "lingma.chat.localHistory.syn",
    JSON.stringify([{ sessionId: "syn-ro1", title: "只读红线验证任务（合成）", timestamp: TS_OCT19 }]),
  );
  setup.close();

  const before = await stat(dbPath);
  const beforeBytes = await readFile(dbPath);
  const beforeSha = createHash("sha256").update(beforeBytes).digest("hex");

  const bridge = createWorklogBridge({ appSupportDir: appSupport, now: () => FIXED_NOW, existsSync });
  const { status, body } = await getJson(bridge, "/local/worklog?days=30");
  assert.equal(status, 200);
  assert.equal(body.data.status, "ok");
  const entry = body.data.entries.find((e: any) => e.sourceKey === "qoder:Qoder:syn-ro1");
  assert.ok(entry, "真 sqlite 只读扫描应取到合成会话");
  assert.equal(entry.title, "只读红线验证任务（合成）");

  const after = await stat(dbPath);
  const afterBytes = await readFile(dbPath);
  assert.equal(createHash("sha256").update(afterBytes).digest("hex"), beforeSha, "源库内容逐字节不变");
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs, "源库 mtime 不变");
  const leftovers = (await readdir(dbDir)).filter((f) => f !== "state.vscdb");
  assert.deepEqual(leftovers, [], "不得产生 -wal/-shm 等副作用文件");
});

test("bridge-level API: list()/summary() throw WorklogBridgeError with stable codes", async () => {
  await withTempDir(async (dir) => {
    const appSupport = join(dir, "app-support");
    await seedFakeSources(appSupport);
    const bridge = makeBridge(appSupport);
    await assert.rejects(
      () => bridge.list(new URLSearchParams("days=nope")),
      (e: unknown) => e instanceof WorklogBridgeError && e.code === "worklog_invalid_request",
    );
    const view = await bridge.list(new URLSearchParams("days=7"));
    assert.equal(view.status, "ok");
    const summary = await bridge.summary(new URLSearchParams("days=7"));
    assert.equal(summary.byDay.length, 2);
  });
});
