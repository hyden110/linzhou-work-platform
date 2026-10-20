import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  assertWithinRoot,
  clipWorklogTitle,
  defaultWorklogSources,
  scanWorklogSource,
  sessionsFromChats,
  sessionsFromLocalHistory,
  type SqliteReader,
} from "./worklog/worklog-collector.ts";

// ---------------------------------------------------------------------------
// 全合成数据：会话 id 一律 syn-*，标题带「（合成）」；sqlite 只经注入的假 reader
// 或临时合成库，零真实扫描、零真实用户库接触。
// ---------------------------------------------------------------------------

const FROM_MS = new Date(2026, 9, 14, 0, 0, 0, 0).getTime();
const TO_MS = new Date(2026, 9, 20, 23, 59, 59, 999).getTime();
const IN_RANGE = new Date(2026, 9, 18, 9, 0, 0).getTime();
const BEFORE = new Date(2026, 9, 10, 9, 0, 0).getTime();
const AFTER = new Date(2026, 9, 21, 9, 0, 0).getTime();
const RANGE = { fromMs: FROM_MS, toMs: TO_MS };

test("clipWorklogTitle strips invisible chars, folds whitespace, clips at 160 (donor口径)", () => {
  assert.equal(clipWorklogTitle("  部署\u200b上线\u00ad  排查（合成） "), "部署上线 排查（合成）", "不可见字符删除、连续空白折成单空格");
  const long = "测".repeat(200);
  const clipped = clipWorklogTitle(long);
  assert.equal(clipped.length, 161, "160 字 + 省略号");
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipWorklogTitle(undefined as unknown as string), "");
  assert.equal(clipWorklogTitle(123 as unknown as string), "123");
});

test("sessionsFromLocalHistory dedups by sessionId keeping earliest turn, filters range", () => {
  const rows = [
    { value: JSON.stringify([
      { sessionId: "syn-s1", title: "后一轮标题（合成）", timestamp: IN_RANGE + 5000 },
      { sessionId: "syn-s1", title: "首轮标题（合成）", timestamp: IN_RANGE },
      { sessionId: "syn-s2", title: "范围外太早（合成）", timestamp: BEFORE },
      { sessionId: "syn-s3", title: "范围外太晚（合成）", timestamp: AFTER },
      { sessionId: "", title: "缺 sessionId（合成）", timestamp: IN_RANGE },
      { sessionId: "syn-s4", title: "", timestamp: IN_RANGE },
    ]) },
    { value: "{ 坏 JSON，跳过" },
    { value: JSON.stringify({ not: "array" }) },
  ];
  const frozen = JSON.parse(JSON.stringify(rows));
  const sessions = sessionsFromLocalHistory(rows, RANGE);
  assert.deepEqual(rows, frozen, "输入不被改动");
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], { sessionId: "syn-s1", ts: IN_RANGE, title: "首轮标题（合成）" },
    "同会话取最早一条的标题代表任务（donor 语义）");
});

test("sessionsFromChats accepts seconds or ms created_at, requires name, filters range", () => {
  const rows = [
    { id: "syn-c1", name: "秒级任务（合成）", created_at: Math.floor(IN_RANGE / 1000) },
    { id: "syn-c2", name: "毫秒任务（合成）", created_at: IN_RANGE + 1000 },
    { id: "syn-c3", name: "", created_at: IN_RANGE },
    { id: "syn-c4", name: "范围外（合成）", created_at: Math.floor(BEFORE / 1000) },
    { id: "syn-c5", name: "坏时间戳（合成）", created_at: "not-a-number" },
  ];
  const sessions = sessionsFromChats(rows, RANGE);
  assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ["syn-c1", "syn-c2"]);
  assert.equal(sessions.find((s) => s.sessionId === "syn-c1")?.ts, Math.floor(IN_RANGE / 1000) * 1000);
});

test("defaultWorklogSources ports donor SOURCES: 4 fixed instances under app support", () => {
  const root = join("/tmp", "syn-app-support");
  const sources = defaultWorklogSources(root);
  assert.deepEqual(sources.map((s) => s.instance), ["Qoder", "QoderCN", "QoderWork", "QwenWorkCN"]);
  assert.deepEqual(sources.map((s) => s.kind), ["vscdb", "vscdb", "agents", "agents"]);
  assert.equal(sources[0].dbPath, join(root, "Qoder", "User", "globalStorage", "state.vscdb"));
  assert.equal(sources[2].dbPath, join(root, "QoderWork", "data", "agents.db"));
});

test("assertWithinRoot rejects traversal and outside paths (路径红线)", () => {
  const root = join("/tmp", "syn-app-support");
  assert.equal(assertWithinRoot(root, join(root, "Qoder", "User", "globalStorage", "state.vscdb")), undefined);
  assert.throws(() => assertWithinRoot(root, join(root, "..", "evil.db")), /路径越界/);
  assert.throws(() => assertWithinRoot(root, "/etc/passwd"), /路径越界/);
  assert.throws(() => assertWithinRoot(root, "relative/inside.db"), /绝对路径/);
  assert.throws(() => assertWithinRoot(root, join(root + "-suffix", "x.db")), /路径越界/, "前缀相似目录不算在根内");
});

function fakeReader(byPath: Record<string, readonly Record<string, unknown>[]>): {
  openReader: (dbPath: string) => SqliteReader;
  closed: string[];
} {
  const closed: string[] = [];
  return {
    closed,
    openReader: (dbPath: string) => ({
      all: () => byPath[dbPath] ?? [],
      close: () => { closed.push(dbPath); },
    }),
  };
}

const SYNTH_SOURCE = {
  instance: "Qoder",
  kind: "vscdb" as const,
  dbPath: join("/tmp", "syn-app-support", "Qoder", "User", "globalStorage", "state.vscdb"),
};

test("scanWorklogSource reports honest missing when the db file does not exist", () => {
  const result = scanWorklogSource(SYNTH_SOURCE, RANGE, {
    existsSync: () => false,
    openReader: () => { throw new Error("绝不应打开不存在的库"); },
  });
  assert.equal(result.status, "missing");
  assert.deepEqual(result.sessions, []);
  assert.equal(result.note, "未安装或库文件不存在");
});

test("scanWorklogSource reads via injected reader, closes it, never throws upward", () => {
  const { openReader, closed } = fakeReader({
    [SYNTH_SOURCE.dbPath]: [
      { value: JSON.stringify([{ sessionId: "syn-s1", title: "部署上线（合成）", timestamp: IN_RANGE }]) },
    ],
  });
  const result = scanWorklogSource(SYNTH_SOURCE, RANGE, { existsSync: () => true, openReader });
  assert.equal(result.status, "ok");
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(closed, [SYNTH_SOURCE.dbPath], "reader 必须被关闭");
});

test("scanWorklogSource turns open failures into error status with path-redacted note", () => {
  const result = scanWorklogSource(SYNTH_SOURCE, RANGE, {
    existsSync: () => true,
    openReader: () => { throw new Error(`unable to open database file: ${SYNTH_SOURCE.dbPath}`); },
  });
  assert.equal(result.status, "error");
  assert.ok(result.note && result.note.length > 0);
  assert.ok(!result.note.includes(SYNTH_SOURCE.dbPath), "绝对路径不出桥");
  assert.ok(!result.note.includes("/tmp/syn-app-support"));
});

test("scanWorklogSource rejects a source whose dbPath escapes the root", () => {
  const evil = { instance: "Evil", kind: "vscdb" as const, dbPath: "/etc/syn-outside.db" };
  const result = scanWorklogSource(evil, RANGE, {
    existsSync: () => true,
    openReader: () => { throw new Error("绝不应打开根外库"); },
    root: join("/tmp", "syn-app-support"),
  });
  assert.equal(result.status, "error");
  assert.match(result.note ?? "", /路径越界/);
});
