import assert from "node:assert/strict";
import test from "node:test";

import { AssistantClientError, assistantErrorMessage, generateSolution } from "./assistant-client.ts";

const REQUEST = {
  requestId: "req-1",
  customer: "某区域零售集团",
  industry: "零售与消费",
  goal: "建设面向门店经营的 AI 助手",
  constraints: "数据不出域",
};

const planData = {
  engine: "qoder-cli",
  title: "门店 AI 助手方案",
  summary: "六层阿里云架构，回答绑定受控引用。",
  layers: [
    { name: "接入层", purpose: "统一入口", products: [{ name: "API 网关", role: "鉴权限流" }] },
    { name: "模型层", purpose: "生成能力", products: [{ name: "阿里云百炼", role: "检索增强问答" }] },
  ],
  flows: [{ name: "问答链路", steps: ["提问", "检索", "生成"] }],
  mapping: [{ need: "可核验", product: "阿里云百炼", reason: "回答绑定引用" }],
  risks: [{ risk: "幻觉", mitigation: "阈值不足即拒答" }],
  nextSteps: ["确认验收指标"],
  evidence: [{
    referenceId: "doc-1:c1",
    title: "连锁门店智慧经营解决方案",
    sourceLabel: "场景库",
    locator: "slide 1",
    text: "门店经营助手分层架构",
  }],
  generatedAt: "2026-10-12T02:00:00Z",
};

const retrievalData = {
  status: "results-only",
  vectorSearch: "keyword-only",
  resultCount: 12,
  queries: ["门店经营 AI 助手", "零售与消费 门店经营 AI 助手"],
};

test("posts to the local assistant route and clamps what it renders", async () => {
  let captured: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      ok: true,
      data: { ...planData, title: `标${"题".repeat(200)}`, layers: [...planData.layers, null, { name: "无产品层" }] },
      retrieval: { ...retrievalData, resultCount: 12.7, queries: ["门店经营 AI 助手", 42, null] },
    });
  };

  const result = await generateSolution(REQUEST, fetchImpl);

  assert.equal(captured?.url, "http://localhost/local/assistant");
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.headers.get("content-type"), "application/json");
  assert.equal(result.plan.engine, "qoder-cli");
  assert.equal(Array.from(result.plan.title).length, 90);
  assert.equal(result.plan.layers.length, 2, "layers without products are dropped");
  assert.equal(result.plan.evidence[0]!.referenceId, "doc-1:c1");
  assert.deepEqual(result.retrieval, {
    status: "results-only",
    vectorSearch: "keyword-only",
    resultCount: 12,
    queries: ["门店经营 AI 助手"],
  });
});

test("rejects a payload that is not a renderable plan", async () => {
  for (const data of [
    undefined,
    { ...planData, engine: "gpt" },
    { ...planData, generatedAt: "不是时间" },
    { ...planData, layers: [planData.layers[0]] },
    { ...planData, title: "" },
  ]) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: true, data, retrieval: retrievalData });
    await assert.rejects(
      () => generateSolution(REQUEST, fetchImpl),
      (error) => error instanceof AssistantClientError && error.code === "invalid_response",
      JSON.stringify(data)?.slice(0, 40),
    );
  }
});

test("maps safe error codes and keeps unknown ones generic", async () => {
  const cases: Array<[string, number, string, string | undefined]> = [
    ["assistant_busy", 429, "assistant_busy", undefined],
    ["rate_limited", 429, "rate_limited", undefined],
    ["内部错误：/Users/linzhou/.qoder", 500, "assistant_unavailable", undefined],
    ["assistant_unavailable", 503, "assistant_unavailable", "sol-1"],
  ];
  for (const [error, status, code, diagnosticId] of cases) {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: false, error, diagnosticId }, { status });
    await assert.rejects(
      () => generateSolution(REQUEST, fetchImpl),
      (thrown) => thrown instanceof AssistantClientError
        && thrown.code === code
        && thrown.diagnosticId === diagnosticId,
      error,
    );
  }
});

test("reports an unreachable local runtime and a timeout distinctly", async () => {
  const offline: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => generateSolution(REQUEST, offline),
    (error) => error instanceof AssistantClientError && error.code === "network_unavailable",
  );
  assert.match(assistantErrorMessage(new AssistantClientError("network_unavailable")), /npm run dev:function/);

  const timedOut: typeof fetch = async () => {
    throw new DOMException("timed out", "TimeoutError");
  };
  await assert.rejects(
    () => generateSolution(REQUEST, timedOut),
    (error) => error instanceof AssistantClientError && error.code === "request_timeout",
  );
  assert.match(assistantErrorMessage(new AssistantClientError("request_timeout")), /超时/);
  assert.equal(
    assistantErrorMessage(new AssistantClientError("assistant_unavailable", "sol-9")).endsWith("sol-9"),
    true,
  );
  assert.match(assistantErrorMessage(new Error("boom")), /暂时不可用/);
});

test("keeps a degraded template plan renderable", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    ok: true,
    data: { ...planData, engine: "template", degraded: "cli-timeout", evidence: [] },
    retrieval: { status: "insufficient-evidence" },
  });

  const result = await generateSolution(REQUEST, fetchImpl);

  assert.equal(result.plan.engine, "template");
  assert.equal(result.plan.degraded, "cli-timeout");
  assert.deepEqual(result.plan.evidence, []);
  assert.deepEqual(result.retrieval, {
    status: "insufficient-evidence",
    vectorSearch: "keyword-only",
    resultCount: 0,
    queries: [],
  });
});
