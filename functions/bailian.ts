import { buildPrompt, citationIdsFrom, normalizeCitationMarks } from "./ai_adapter.ts";
import type { AnswerGenerator } from "./retrieval.ts";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY_PATTERN = /^sk-[A-Za-z0-9._-]{16,}$/;

export interface BailianConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface QueryEmbedderConfig extends BailianConfig {
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

export interface AnswerGeneratorConfig extends BailianConfig {
  model: string;
  timeoutMs?: number;
}

export type QueryEmbedder = (text: string) => Promise<Float32Array>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validBailianKey(value: string | undefined): value is string {
  return typeof value === "string" && API_KEY_PATTERN.test(value);
}

export async function bailianPost(
  config: BailianConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Bailian request failed (HTTP ${response.status})`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Bailian response is invalid");
  return payload;
}

export function createBailianQueryEmbedder(config: QueryEmbedderConfig): QueryEmbedder {
  if (!validBailianKey(config.apiKey) || !Number.isInteger(config.dimensions) || config.dimensions < 64) {
    throw new Error("Bailian embedding configuration is invalid");
  }
  const timeoutMs = config.timeoutMs ?? 4_000;
  return async (text) => {
    const payload = await bailianPost(config, "/embeddings", {
      model: config.model,
      input: [text],
      dimensions: config.dimensions,
      encoding_format: "float",
    }, timeoutMs);
    const first = Array.isArray(payload.data) ? payload.data[0] : undefined;
    const embedding = isRecord(first) ? first.embedding : undefined;
    if (!Array.isArray(embedding) || embedding.length !== config.dimensions
      || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Bailian embedding response is invalid");
    }
    return Float32Array.from(embedding as number[]);
  };
}

function completionText(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === "string" ? content.trim() : "";
}

export function createBailianAnswerGenerator(config: AnswerGeneratorConfig): AnswerGenerator {
  if (!validBailianKey(config.apiKey) || !config.model.trim()) {
    throw new Error("Bailian answer configuration is invalid");
  }
  const timeoutMs = config.timeoutMs ?? 45_000;
  return async (request) => {
    const payload = await bailianPost(config, "/chat/completions", {
      model: config.model,
      messages: [{ role: "user", content: buildPrompt(request) }],
      temperature: 0.2,
      max_tokens: 1_500,
      enable_thinking: false,
    }, timeoutMs);
    const raw = completionText(payload);
    if (!raw) throw new Error("Bailian answer is missing");
    const answer = normalizeCitationMarks(raw, request);
    const citationIds = citationIdsFrom(answer, request);
    if (!citationIds.length) throw new Error("Bailian answer has no valid citation");
    return { answer, citationIds };
  };
}
