import assert from "node:assert/strict";
import test from "node:test";

import {
  citationIdsFrom,
  createCloudAgentAnswerGenerator,
  normalizeCitationMarks,
  type CloudAgentClient,
} from "./ai_adapter.ts";
import type { AnswerGenerationRequest } from "./retrieval.ts";

const input: AnswerGenerationRequest = {
  query: "零售门店如何落地智能体？",
  mode: "qa",
  requestId: "request-ai-1",
  evidence: [
    {
      documentId: "retail-agent",
      sourceLabel: "案例库",
      title: "零售门店 Agent 案例",
      summary: "建议从库存查询场景开始试点。",
      citations: [
        {
          id: "c1",
          referenceId: "retail-agent:c1",
          locator: { kind: "page", value: "3" },
          text: "先从库存查询场景试点。",
        },
      ],
    },
  ],
};

test("creates a bounded Cloud Agent session and returns cited answer text", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  let statusReads = 0;
  const client: CloudAgentClient = {
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/api/v1/cloud/sessions") return { id: "sess_test" };
      if (options?.method === "POST") return { data: [{ id: "evt_user" }] };
      if (path.endsWith("/events?order=asc&limit=100&types=agent.message")) {
        return {
          data: [{
            id: "evt_answer",
            type: "agent.message",
            content: [{ type: "text", text: "建议先做库存查询试点。[retail-agent:c1]" }],
          }],
          has_more: false,
          next_page: null,
        };
      }
      statusReads += 1;
      return { id: "sess_test", status: statusReads === 1 ? "running" : "idle" };
    },
  };
  const generate = createCloudAgentAnswerGenerator({
    client,
    agent: { type: "agent", id: "agent_test", version: 2 },
    environmentId: "env_test",
    pollIntervalMs: 0,
    maxPolls: 2,
  });

  const result = await generate(input);

  assert.equal(result.answer, "建议先做库存查询试点。[retail-agent:c1]");
  assert.deepEqual(result.citationIds, ["retail-agent:c1"]);
  assert.equal(calls[0].path, "/api/v1/cloud/sessions");
  assert.equal(calls[1].path, "/api/v1/cloud/sessions/sess_test/events");
  const serializedPrompt = JSON.stringify(calls[1].options?.body);
  assert.match(serializedPrompt, /retail-agent:c1/);
  assert.doesNotMatch(serializedPrompt, /vectorText|searchText|QODER_PAT/);
});

test("rejects uncited answers instead of presenting unsupported AI output", async () => {
  const client: CloudAgentClient = {
    request: async (path, options) => {
      if (path === "/api/v1/cloud/sessions") return { id: "sess_test" };
      if (options?.method === "POST") return { data: [{ id: "evt_user" }] };
      if (!path.includes("/events?")) return { id: "sess_test", status: "idle" };
      return {
        data: [{
          id: "evt_answer",
          type: "agent.message",
          content: [{ type: "text", text: "这是一个没有引用的答案。" }],
        }],
        has_more: false,
        next_page: null,
      };
    },
  };
  const generate = createCloudAgentAnswerGenerator({
    client,
    agent: { type: "agent", id: "agent_test", version: 1 },
    environmentId: "env_test",
    pollIntervalMs: 0,
    maxPolls: 1,
  });

  await assert.rejects(() => generate(input), /citation/);
});

test("validates fixed Cloud Agent resource identifiers", () => {
  const client: CloudAgentClient = { request: async () => ({}) };
  assert.throws(() => createCloudAgentAnswerGenerator({
    client,
    agent: { type: "agent", id: "bad", version: 1 },
    environmentId: "env_test",
  }));
  assert.throws(() => createCloudAgentAnswerGenerator({
    client,
    agent: { type: "agent", id: "agent_test", version: 1 },
    environmentId: "bad",
  }));
});

test("binds bare document-ID citations to controlled passages and drops unknown ID marks", () => {
  const request: AnswerGenerationRequest = {
    ...input,
    evidence: [
      ...input.evidence,
      {
        documentId: "1fe3d9125b4fa199",
        sourceLabel: "云栖专题",
        title: "云栖 Qoder 演讲",
        summary: "云栖演讲摘要。",
        citations: [{ id: "c12", referenceId: "1fe3d9125b4fa199:c12", locator: { kind: "slide", value: "12" }, text: "演讲要点。" }],
      },
    ],
  };
  const answer = normalizeCitationMarks(
    "库存先行[retail-agent:c1]。云栖材料未提及（[1fe3d9125b4fa199]、[0123456789abcdef]）。[注]",
    request,
  );

  assert.equal(answer, "库存先行[retail-agent:c1]。云栖材料未提及（[1fe3d9125b4fa199:c12]、）。[注]");
  assert.deepEqual(citationIdsFrom(answer, request), ["retail-agent:c1", "1fe3d9125b4fa199:c12"]);
  assert.equal(
    normalizeCitationMarks("所有云栖文档（如文档1fe3d9125b4fa199）均未提及。", request),
    "所有云栖文档（如文档[1fe3d9125b4fa199:c12]）均未提及。",
  );
  assert.equal(
    normalizeCitationMarks("效果显著[ 1fe3d9125b4fa199:c12 ][[retail-agent:c1]]。", request),
    "效果显著[1fe3d9125b4fa199:c12][retail-agent:c1]。",
  );
});
