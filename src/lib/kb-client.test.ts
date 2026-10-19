import assert from "node:assert/strict";
import test from "node:test";

import {
  KbClientError,
  fetchKbSources,
  kbErrorMessage,
  requestKbSummary,
  searchExternalKb,
  searchKb,
  type KbHit,
} from "./kb-client.ts";

// 合成数据：甲科技 / 乙股份，绝无真实客户数据。

const BRIDGE_HIT: KbHit = {
  sourceId: "aliyundoc",
  sourceName: "阿里云官方文档",
  type: "aliyundoc",
  id: "https://help.aliyun.com/zh/model-studio/overview.md",
  title: "百炼概述",
  space: "大模型服务平台百炼",
  path: "概述",
  url: "https://help.aliyun.com/zh/model-studio/overview",
  snippet: "百炼是面向开发者的模型平台",
  rank: 1,
  score: 0.5,
};

function searchPayload() {
  return {
    ok: true,
    data: {
      q: "百炼",
      hits: [BRIDGE_HIT],
      status: [{ sourceId: "aliyundoc", name: "阿里云官方文档", type: "aliyundoc", ok: true, n: 1, ms: 12 }],
    },
  };
}

test("searchKb issues a GET with the query encoded and validates the payload shape", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json(searchPayload());
  };

  const outcome = await searchKb("百炼", fetchImpl);
  assert.equal(outcome.q, "百炼");
  assert.equal(outcome.hits.length, 1);
  assert.equal(outcome.hits[0]!.title, "百炼概述");
  assert.equal(captured?.method, "GET");
  assert.equal(captured?.url, "http://localhost/local/kb/search?q=%E7%99%BE%E7%82%BC");
  assert.ok(captured?.signal instanceof AbortSignal, "requests carry a timeout signal");

  const malformed: typeof fetch = async () => Response.json({ ok: true, data: { q: "百炼" } });
  await assert.rejects(
    () => searchKb("百炼", malformed),
    (error: unknown) => error instanceof KbClientError && error.code === "invalid_response",
  );
});

test("bridge failures map to safe codes; offline bridge reports 本地桥未启动 without throwing uncaught", async () => {
  const serverError: typeof fetch = async () => Response.json({ ok: false, error: "kb_unavailable" }, { status: 500 });
  await assert.rejects(
    () => searchKb("百炼", serverError),
    (error: unknown) => error instanceof KbClientError && error.code === "kb_unavailable",
  );

  const unknownError: typeof fetch = async () => Response.json({ ok: false }, { status: 503 });
  await assert.rejects(
    () => searchKb("百炼", unknownError),
    (error: unknown) => error instanceof KbClientError && error.code === "unavailable",
  );

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => searchKb("百炼", offline),
    (error: unknown) => error instanceof KbClientError && error.code === "unavailable",
  );

  // 文案：桥离线时提示「本地桥未启动」+ 启动命令，不白屏。
  try {
    await searchKb("百炼", offline);
    assert.fail("must reject");
  } catch (error) {
    assert.match(kbErrorMessage(error), /本地桥未启动/);
    assert.match(kbErrorMessage(error), /npm run dev:function/);
  }
  // 非客户端错误也走兜底文案（unavailable 口径），绝不抛未捕获异常。
  assert.match(kbErrorMessage(new Error("boom")), /本地桥未启动/);
});

test("external search degrades honestly: summary failure keeps hits untouched with empty summary", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/local/kb/search") return Response.json(searchPayload());
    // 摘要器在桥端失败 → 502。
    return Response.json({ ok: false, error: "kb_summary_failed" }, { status: 502 });
  };

  const answer = await searchExternalKb("百炼", fetchImpl);
  assert.equal(answer.hits.length, 1, "检索结果原样返回");
  assert.equal(answer.hits[0]!.title, "百炼概述");
  assert.equal(answer.status.length, 1);
  assert.equal(answer.summary, undefined, "summary 字段空");

  // 摘要成功路径：answer 进入结果。
  const okFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/local/kb/search") return Response.json(searchPayload());
    return Response.json({ ok: true, data: { answer: "可基于百炼构建。", ms: 8, degraded: false } });
  };
  const answered = await searchExternalKb("百炼", okFetch);
  assert.equal(answered.summary, "可基于百炼构建。");
});

test("summary payload sentinel: only title/path/snippet fields are sent — never customer fields", async () => {
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return Response.json({ ok: true, data: { answer: "好的", ms: 1, degraded: false } });
  };

  const adversarial = {
    sourceId: "aliyundoc",
    id: "overview.md",
    title: "百炼概述",
    space: "大模型服务平台百炼",
    sourceName: "阿里云官方文档",
    snippet: "片段",
    path: "概述",
    type: "aliyundoc",
    url: "https://help.aliyun.com/zh/model-studio/overview",
    rank: 1,
    score: 0.5,
    // 越界字段：客户端必须剥掉
    customerName: "甲科技股份有限公司",
    cid: "c-secret-999",
  } as KbHit;

  const answer = await requestKbSummary("百炼怎么接？", [adversarial], fetchImpl);
  assert.equal(answer, "好的");

  assert.ok(capturedBody);
  const payload = JSON.parse(capturedBody!) as { q: string; hits: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(payload).sort(), ["hits", "q"]);
  assert.equal(payload.q, "百炼怎么接？");
  assert.equal(payload.hits.length, 1);
  assert.deepEqual(
    Object.keys(payload.hits[0]!).sort(),
    ["id", "snippet", "source", "sourceId", "space", "title"],
    "payload hits carry title/path/source/snippet only",
  );
  for (const forbidden of ["customerName", "c-secret-999", "甲科技股份有限公司"]) {
    assert.ok(!capturedBody!.includes(forbidden), `${forbidden} must never leave the machine`);
  }
});

test("kb sources fetch maps errors to safe codes", async () => {
  const ok: typeof fetch = async () => Response.json({
    ok: true,
    data: { sources: [{ id: "aliyundoc", type: "aliyundoc", name: "阿里云官方文档", label: "阿里云官方文档", ok: true, spaces: [] }] },
  });
  const sources = await fetchKbSources(ok);
  assert.deepEqual(sources, [{ id: "aliyundoc", name: "阿里云官方文档", label: "阿里云官方文档", ok: true }]);

  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => fetchKbSources(offline),
    (error: unknown) => error instanceof KbClientError && error.code === "unavailable",
  );
  assert.match(kbErrorMessage(new KbClientError("unavailable")), /本地桥未启动/);
  assert.match(kbErrorMessage(new KbClientError("kb_summary_failed")), /摘要/);
});
