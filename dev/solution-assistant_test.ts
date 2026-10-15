import assert from "node:assert/strict";
import test from "node:test";

import type { RetrievalBundle } from "../functions/retrieval.ts";
import {
  createSolutionAssistant,
  parseSolutionRequest,
  retrievalQueries,
  SolutionAssistantError,
} from "./solution-assistant.ts";
import type { SolutionPlan } from "../src/lib/assistant-contract.ts";

function document(
  id: string,
  text: string,
  citationText: string,
  topics: string[] = ["零售与消费"],
): RetrievalBundle["documents"][number] {
  return {
    id,
    source: "cases",
    sourceLabel: "案例库",
    type: "MD",
    title: text,
    modifiedAt: "2026-09-01T00:00:00Z",
    topics,
    location: "本地文件 · 相对路径",
    relativePath: `retail/${id}.md`,
    summary: text,
    citations: [{ id: "c1", locator: { kind: "section", value: "架构总览" }, text: citationText }],
  };
}

function bundle(...documents: RetrievalBundle["documents"]): RetrievalBundle {
  return {
    schemaVersion: 2,
    mode: "safe-retrieval-bundle",
    generatedAt: "2026-10-12T00:00:00Z",
    documentCount: documents.length,
    skippedCount: 0,
    documents,
  };
}

const MATCHING_BUNDLE = bundle(document("doc-1", "零售门店 AI 助手", "零售门店 AI 助手参考架构与数据不出域约束"));
const MULTI_DOC_BUNDLE = bundle(
  document("doc-1", "零售门店 AI 助手", "零售门店 AI 助手参考架构与数据不出域约束"),
  document("doc-2", "零售集团门店 AI 助手落地实践", "零售集团门店 AI 助手落地实践与引用核验"),
);
const UNRELATED_BUNDLE = bundle(document("doc-1", "钢铁冶炼工艺", "高炉热风炉温度控制参数说明", ["制造与工业"]));

const VALID_BODY = {
  requestId: "req-1",
  customer: "零售",
  industry: "",
  goal: "门店 AI 助手",
  constraints: "",
};

function planFrom(evidence: SolutionPlan["evidence"]): SolutionPlan {
  return {
    engine: "qoder-cli",
    title: "零售门店 AI 助手方案",
    summary: "面向门店经营的智能助手，回答绑定受控引用。",
    layers: [
      { name: "接入层", purpose: "统一入口", products: [{ name: "API 网关", role: "鉴权与限流" }] },
      { name: "模型层", purpose: "生成能力", products: [{ name: "阿里云百炼", role: "检索增强问答" }] },
    ],
    flows: [{ name: "问答链路", steps: ["用户提问", "检索证据", "生成回答"] }],
    mapping: [{ need: "可核验问答", product: "阿里云百炼", reason: "回答必须绑定引用" }],
    risks: [{ risk: "幻觉", mitigation: "阈值不足即拒答" }],
    nextSteps: ["确认验收指标"],
    evidence,
    generatedAt: "2026-10-12T01:00:00Z",
  };
}

function post(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("http://127.0.0.1:8000/local/assistant", {
    method: "POST",
    headers: { host: "127.0.0.1:8000", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface RecordedCall {
  readonly customer: string;
  readonly goal: string;
  readonly referenceIds: string[];
}

function createAssistant(bundle: RetrievalBundle, recorded: RecordedCall[] = [], generate?: unknown) {
  const assistant = createSolutionAssistant({
    loadBundle: async () => bundle,
    generate: (generate ?? (async (request: { input: { customer: string; goal: string }; evidence: SolutionPlan["evidence"] }) => {
      recorded.push({
        customer: request.input.customer,
        goal: request.input.goal,
        referenceIds: request.evidence.map((item) => item.referenceId),
      });
      return planFrom(request.evidence);
    })) as never,
  });
  return assistant;
}

test("parses and bounds the assistant request body", () => {
  assert.equal(parseSolutionRequest(VALID_BODY).goal, "门店 AI 助手");
  assert.equal(parseSolutionRequest({ ...VALID_BODY, industry: undefined }).industry, "");

  for (const body of [
    null,
    [],
    { ...VALID_BODY, requestId: "" },
    { ...VALID_BODY, requestId: "非法 id!" },
    { ...VALID_BODY, customer: "" },
    { ...VALID_BODY, customer: "客".repeat(81) },
    { ...VALID_BODY, goal: "短" },
    { ...VALID_BODY, goal: "长".repeat(501) },
    { ...VALID_BODY, constraints: 42 },
  ]) {
    assert.throws(() => parseSolutionRequest(body), SolutionAssistantError, JSON.stringify(body)?.slice(0, 40));
  }
});

test("returns a plan whose evidence comes from server-side retrieval", async () => {
  const recorded: RecordedCall[] = [];
  const assistant = createAssistant(MATCHING_BUNDLE, recorded);
  const result = await assistant(post(VALID_BODY));

  assert.equal(result.plan.engine, "qoder-cli");
  assert.equal(result.retrieval.status, "results-only");
  assert.equal(result.retrieval.vectorSearch, "keyword-only");
  assert.equal(result.retrieval.resultCount, 1);
  assert.deepEqual(recorded, [{ customer: "零售", goal: "门店 AI 助手", referenceIds: ["doc-1:c1"] }]);
  assert.deepEqual(result.plan.evidence.map((item) => item.referenceId), ["doc-1:c1"]);
  assert.equal(result.plan.evidence[0]!.locator, "section 架构总览");
  assert.equal(JSON.stringify(result).includes("absolutePath"), false);
});

test("still generates a plan when retrieval finds no sufficient evidence", async () => {
  const recorded: RecordedCall[] = [];
  const assistant = createAssistant(UNRELATED_BUNDLE, recorded);
  const result = await assistant(post(VALID_BODY));

  assert.equal(result.retrieval.status, "insufficient-evidence");
  assert.equal(result.retrieval.resultCount, 0);
  assert.deepEqual(recorded[0]!.referenceIds, []);
  assert.equal(result.plan.engine, "qoder-cli");
});

test("rejects invalid bodies, wrong media type and oversized payloads", async () => {
  const assistant = createAssistant(MATCHING_BUNDLE);
  const failure = async (body: unknown, headers: HeadersInit = {}) => assistant(post(body, headers)).then(
    () => undefined,
    (error: SolutionAssistantError) => error,
  );

  assert.equal((await failure({ ...VALID_BODY, goal: "短" }))?.code, "invalid_request");
  assert.equal((await failure({ ...VALID_BODY, goal: `门店 AI 助手 ${"x".repeat(600)}` }))?.code, "invalid_request");
  assert.equal((await failure(VALID_BODY, { "content-type": "text/plain" }))?.status, 415);
  assert.equal((await failure("{ not json"))?.code, "invalid_json");

  const oversized = await failure({ ...VALID_BODY, padding: "x".repeat(9 * 1024) });
  assert.equal(oversized?.status, 413);
  assert.equal(oversized?.code, "payload_too_large");
});

test("derives focused retrieval queries and merges what each recalls", async () => {
  assert.deepEqual(
    retrievalQueries({ ...VALID_BODY, requestId: "req-1", industry: "零售与消费", constraints: "数据不出域" }),
    [
      "零售 门店 AI 助手",
      "零售与消费 门店 AI 助手",
      "门店 AI 助手",
      "零售 零售与消费 门店 AI 助手 数据不出域",
      "零售",
    ],
  );
  assert.deepEqual(
    retrievalQueries({ ...VALID_BODY, requestId: "req-1", goal: "建设门店 AI 助手，并接入企业知识库，要求可核验" }),
    [
      "零售 门店 AI 助手",
      "门店 AI 助手",
      "零售 建设门店 AI 助手，并接入企业知识库，要求可核验",
      "零售",
    ],
  );
  // Filler verbs and the particle 的 are dropped so an out-of-corpus customer name
  // cannot dilute the topic query below the coverage gate.
  assert.deepEqual(
    retrievalQueries({
      requestId: "req-1",
      customer: "某区域零售集团",
      industry: "零售与消费",
      goal: "建设面向门店经营的 AI 助手",
      constraints: "存量系统较多，要求数据不出域",
    }).slice(0, 3),
    ["某区域零售集团 门店经营 AI 助手", "零售与消费 门店经营 AI 助手", "门店经营 AI 助手"],
  );

  const recorded: RecordedCall[] = [];
  const assistant = createAssistant(MULTI_DOC_BUNDLE, recorded);
  const result = await assistant(post(VALID_BODY));

  assert.equal(result.retrieval.status, "results-only");
  assert.equal(result.retrieval.resultCount, 2);
  assert.equal(result.retrieval.queries.length, 3);
  assert.equal(recorded[0]!.referenceIds.length, 2);
  assert.equal(new Set(recorded[0]!.referenceIds.map((id) => id.split(":")[0])).size, 2);
});

test("rate limits repeats and refuses concurrent generation", async () => {
  let release: ((plan: SolutionPlan) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const assistant = createSolutionAssistant({
    loadBundle: async () => MATCHING_BUNDLE,
    rateLimit: { maxRequests: 2, windowMs: 60_000 },
    generate: () => {
      markStarted?.();
      return new Promise<SolutionPlan>((resolve) => {
        release = resolve;
      });
    },
  });

  const first = assistant(post(VALID_BODY));
  await started;
  const busy = await assistant(post({ ...VALID_BODY, requestId: "req-2" })).then(
    () => undefined,
    (error: SolutionAssistantError) => error,
  );
  assert.equal(busy?.status, 429);
  assert.equal(busy?.code, "assistant_busy");

  release?.(planFrom([]));
  assert.equal((await first).plan.engine, "qoder-cli");

  assert.equal((await assistant(post({ ...VALID_BODY, requestId: "req-3" })).then(
    () => undefined,
    (error: SolutionAssistantError) => error,
  ))?.code, "rate_limited");
});

test("reports a safe diagnostic id when the bundle cannot load", async () => {
  const assistant = createSolutionAssistant({
    loadBundle: async () => {
      throw new Error("bundle missing");
    },
    generate: async () => planFrom([]),
  });
  const error = await assistant(post(VALID_BODY)).then(
    () => undefined,
    (thrown: SolutionAssistantError) => thrown,
  );

  assert.equal(error?.status, 503);
  assert.equal(error?.code, "assistant_unavailable");
  assert.match(error?.diagnosticId ?? "", /^sol-[0-9a-f-]{36}$/);
  assert.equal(String(error?.diagnosticId).includes("bundle missing"), false);
});
