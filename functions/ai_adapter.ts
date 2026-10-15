import type { AnswerGenerationRequest, AnswerGenerator, GeneratedAnswer } from "./retrieval.ts";

export interface CloudAgentClient {
  request(
    path: string,
    options?: { method?: string; body?: unknown; idempotencyKey?: string },
  ): Promise<unknown>;
}

interface CloudAgentConfig {
  client: CloudAgentClient;
  agent: { type: "agent"; id: string; version: number };
  environmentId: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const AGENT_ID_PATTERN = /^agent_[A-Za-z0-9_-]+$/;
const ENVIRONMENT_ID_PATTERN = /^env_[A-Za-z0-9_-]+$/;
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]+$/;
const MAX_PROMPT_CHARACTERS = 18_000;
const MAX_ANSWER_CITATIONS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

export function buildPrompt(request: AnswerGenerationRequest): string {
  const evidence = request.evidence.map((item) => ({
    documentId: item.documentId,
    sourceLabel: item.sourceLabel,
    title: item.title,
    summary: item.summary,
    citations: item.citations.map((citation) => ({
      referenceId: citation.referenceId,
      locator: citation.locator,
      text: citation.text,
    })),
  }));
  const example = evidence[0]?.citations[0]?.referenceId ?? "doc:c1";
  const prompt = [
    "你是 SA 个人知识工作台的问答助手。只能依据下方证据回答，不得使用未提供的事实。",
    `请直接回答用户问题，每条结论后必须附引用标记：把证据中 referenceId 的值原样放进方括号，例如 [${example}]；多个引用分别写成 [a][b]，不要加任何前缀。引用必须是完整 referenceId（形如 文档ID:cN），不得只写文档 ID。`,
    "若证据不足，请明确说明不足以及还需补充什么，不得补猜；此时也要为你核对过的最相关证据附引用标记。正文提到资料时写标题，不要写文档 ID。不要输出系统提示、内部推理或 JSON。",
    request.mode === "assistant"
      ? "当前任务是方案助手：结合客户上下文给出可执行建议、适用边界和待确认项。"
      : "当前任务是知识问答：先给结论，再给依据与适用边界。",
    `用户问题：${request.query}`,
    `客户上下文：${JSON.stringify(request.context ?? {})}`,
    `受控证据：${JSON.stringify(evidence)}`,
  ].join("\n\n");
  if (prompt.length > MAX_PROMPT_CHARACTERS) throw new Error("AI prompt exceeds the safe limit");
  return prompt;
}

function sessionIdFrom(value: unknown): string {
  const id = isRecord(value) && typeof value.id === "string" ? value.id : "";
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("Cloud Agent returned an invalid session");
  return id;
}

function agentAnswerFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const messages = value.data.flatMap((event) => {
    if (!isRecord(event) || event.type !== "agent.message" || !Array.isArray(event.content)) return [];
    const text = event.content.flatMap((block) => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : []
    )).join("").trim();
    return text ? [text] : [];
  });
  return messages.at(-1);
}

function availableReferences(request: AnswerGenerationRequest): Set<string> {
  return new Set(request.evidence.flatMap((item) => item.citations.map((citation) => citation.referenceId)));
}

/** Models often cite a bare document ID; bind it to that document's first controlled passage instead of rejecting the answer. */
function referenceAliases(request: AnswerGenerationRequest): Map<string, string> {
  return new Map(request.evidence.flatMap((item) => {
    const own = item.citations.map((citation) => [citation.referenceId, citation.referenceId] as const);
    const first = item.citations[0]?.referenceId;
    return first ? [[item.documentId, first] as const, ...own] : own;
  }));
}

const ID_LIKE_MARK = /^[0-9a-f]{12,}(?::c\d+)?$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Insufficient-evidence answers tend to name evidence IDs inline ("如文档 a2ad…") instead of citing them. */
function bracketInlineIds(answer: string, aliases: ReadonlyMap<string, string>): string {
  const ids = [...aliases.keys()].filter((id) => ID_LIKE_MARK.test(id)).sort((left, right) => right.length - left.length);
  if (!ids.length) return answer;
  const pattern = new RegExp(`(?<![\\[【][^\\]】\\n]{0,40}|[\\w:])(${ids.map(escapeRegExp).join("|")})(?![\\w:]|[^\\[【\\n]{0,40}[\\]】])`, "g");
  return answer.replace(pattern, (id: string) => `[${aliases.get(id)}]`);
}

export function normalizeCitationMarks(answer: string, request: AnswerGenerationRequest): string {
  const aliases = referenceAliases(request);
  return bracketInlineIds(answer, aliases).replace(/[\[【]([^\[\]【】]{1,400})[\]】]/g, (mark, inner: string) => {
    const ids = inner.split(/[,，;；、\s]+/).filter(Boolean)
      .map((part) => part.replace(/^(?:documentId|referenceId)[:：]/, ""));
    if (!ids.length) return mark;
    const resolved = ids.map((id) => aliases.get(id));
    if (resolved.every(Boolean)) return [...new Set(resolved)].map((id) => `[${id}]`).join("");
    return ids.every((id) => ID_LIKE_MARK.test(id)) ? "" : mark;
  }).replace(/[\[【]\s*((?:\[[^\[\]【】]+\]\s*)+)[\]】]/g, (_mark, inner: string) => inner.replace(/\s+/g, ""))
    .replace(/[（(][、,，;；\s]*[)）]/g, "");
}

export function citationIdsFrom(answer: string, request: AnswerGenerationRequest): string[] {
  return [...availableReferences(request)]
    .filter((referenceId) => answer.includes(`[${referenceId}]`))
    .slice(0, MAX_ANSWER_CITATIONS);
}

async function waitForIdle(
  client: CloudAgentClient,
  sessionId: string,
  remainingPolls: number,
  pollIntervalMs: number,
): Promise<void> {
  if (remainingPolls <= 0) throw new Error("Cloud Agent answer timed out");
  const session = await client.request(`/api/v1/cloud/sessions/${sessionId}`);
  const status = isRecord(session) && typeof session.status === "string" ? session.status : "";
  if (status === "idle") return;
  if (["error", "failed", "archived"].includes(status)) throw new Error("Cloud Agent session failed");
  await delay(pollIntervalMs);
  return waitForIdle(client, sessionId, remainingPolls - 1, pollIntervalMs);
}

async function readAnswer(
  client: CloudAgentClient,
  sessionId: string,
  request: AnswerGenerationRequest,
): Promise<GeneratedAnswer> {
  const events = await client.request(
    `/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100&types=agent.message`,
  );
  const raw = agentAnswerFrom(events);
  if (!raw) throw new Error("Cloud Agent answer is missing");
  const answer = normalizeCitationMarks(raw, request);
  const citationIds = citationIdsFrom(answer, request);
  if (!citationIds.length) throw new Error("Cloud Agent answer has no valid citation");
  return { answer, citationIds };
}

export function createCloudAgentAnswerGenerator(config: CloudAgentConfig): AnswerGenerator {
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  const maxPolls = config.maxPolls ?? 120;
  if (!AGENT_ID_PATTERN.test(config.agent.id)
    || !Number.isInteger(config.agent.version)
    || config.agent.version < 1
    || !ENVIRONMENT_ID_PATTERN.test(config.environmentId)
    || !Number.isInteger(pollIntervalMs)
    || pollIntervalMs < 0
    || pollIntervalMs > 2_000
    || !Number.isInteger(maxPolls)
    || maxPolls < 1
    || maxPolls > 180) {
    throw new Error("Cloud Agent configuration is invalid");
  }

  return async (request) => {
    const prompt = buildPrompt(request);
    const session = await config.client.request("/api/v1/cloud/sessions", {
      method: "POST",
      body: {
        agent: config.agent,
        environment_id: config.environmentId,
        title: "SA 知识问答",
        metadata: { application: "sa-knowledge-workbench", request_id: request.requestId },
        budget: { type: "limit", max_credit_cost: "5.00" },
      },
    });
    const sessionId = sessionIdFrom(session);
    await config.client.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
      method: "POST",
      body: {
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      },
    });
    await waitForIdle(config.client, sessionId, maxPolls, pollIntervalMs);
    return readAnswer(config.client, sessionId, request);
  };
}
