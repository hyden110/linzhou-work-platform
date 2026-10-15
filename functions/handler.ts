import { createCloudAgentAnswerGenerator } from "./ai_adapter.ts";
import { createBailianAnswerGenerator, createBailianQueryEmbedder, validBailianKey } from "./bailian.ts";
import { createCloudAgentsClient } from "./cloud-agents.mjs";
import {
  RetrievalValidationError,
  retrieve,
  validateRetrievalRequest,
  type AnswerGenerator,
  type EmbeddingMetadata,
  type QueryEmbedder,
  type RetrievalBundle,
} from "./retrieval.ts";

interface HandlerDependencies {
  loadBundle: () => Promise<RetrievalBundle>;
  answerGenerator?: AnswerGenerator;
  queryEmbedderFor?: (embedding: EmbeddingMetadata) => QueryEmbedder | undefined;
  maxBodyBytes?: number;
  rateLimit?: { maxRequests: number; windowMs: number };
  allowedOrigins?: readonly string[];
  now?: () => number;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

const CLOUD_AGENTS_ORIGIN = "https://api.qoder.com";
const DEFAULT_BAILIAN_ANSWER_MODEL = "qwen-plus";
const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:4173", "http://localhost:4173"];
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
}

function isRetrievalBundle(value: unknown): value is RetrievalBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RetrievalBundle>;
  return candidate.mode === "safe-retrieval-bundle"
    && Number.isInteger(candidate.schemaVersion)
    && Array.isArray(candidate.documents);
}

async function loadDefaultBundle(): Promise<RetrievalBundle> {
  const module = await import("./retrieval-bundle.json", { with: { type: "json" } });
  const bundle: unknown = module.default;
  if (!isRetrievalBundle(bundle)) throw new Error("retrieval bundle is invalid");
  return bundle;
}

function environment(): Record<string, string | undefined> {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(name: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  const get = (name: string) => runtime.Deno?.env.get(name) ?? runtime.process?.env[name];
  return {
    QODER_PAT: get("QODER_PAT"),
    QODER_AGENT_ID: get("QODER_AGENT_ID"),
    QODER_AGENT_VERSION: get("QODER_AGENT_VERSION"),
    QODER_ENVIRONMENT_ID: get("QODER_ENVIRONMENT_ID"),
    SA_WORKBENCH_ALLOWED_ORIGINS: get("SA_WORKBENCH_ALLOWED_ORIGINS"),
    DASHSCOPE_API_KEY: get("DASHSCOPE_API_KEY"),
    DASHSCOPE_ANSWER_MODEL: get("DASHSCOPE_ANSWER_MODEL"),
  };
}

function configuredAllowedOrigins(): readonly string[] {
  const configured = environment().SA_WORKBENCH_ALLOWED_ORIGINS;
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function configuredBailianAnswerGenerator(): AnswerGenerator | undefined {
  const values = environment();
  if (!validBailianKey(values.DASHSCOPE_API_KEY)) return undefined;
  return createBailianAnswerGenerator({
    apiKey: values.DASHSCOPE_API_KEY,
    model: values.DASHSCOPE_ANSWER_MODEL?.trim() || DEFAULT_BAILIAN_ANSWER_MODEL,
  });
}

function configuredQueryEmbedderFor(): HandlerDependencies["queryEmbedderFor"] {
  const apiKey = environment().DASHSCOPE_API_KEY;
  if (!validBailianKey(apiKey)) return undefined;
  const embedders = new Map<string, QueryEmbedder>();
  return (embedding) => {
    if (embedding.provider !== "bailian") return undefined;
    const key = `${embedding.model}:${embedding.dimensions}`;
    const existing = embedders.get(key);
    if (existing) return existing;
    const created = createBailianQueryEmbedder({ apiKey, model: embedding.model, dimensions: embedding.dimensions });
    embedders.set(key, created);
    return created;
  };
}

function configuredAnswerGenerator(): AnswerGenerator | undefined {
  const values = environment();
  const version = Number(values.QODER_AGENT_VERSION);
  if (!values.QODER_PAT || !values.QODER_AGENT_ID || !values.QODER_ENVIRONMENT_ID || !Number.isInteger(version)) {
    return configuredBailianAnswerGenerator();
  }
  const client = createCloudAgentsClient({
    origin: CLOUD_AGENTS_ORIGIN,
    getToken: () => values.QODER_PAT,
  });
  return createCloudAgentAnswerGenerator({
    client,
    agent: { type: "agent", id: values.QODER_AGENT_ID, version },
    environmentId: values.QODER_ENVIRONMENT_ID,
  });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = request.headers.get("x-real-ip")?.trim() || forwarded || "local";
  return /^[A-Fa-f0-9:.]{1,64}$/.test(candidate) ? candidate : "unknown";
}

function createRateLimiter(config: { maxRequests: number; windowMs: number }, now: () => number) {
  const entries = new Map<string, RateEntry>();
  return (key: string): boolean => {
    const timestamp = now();
    const current = entries.get(key);
    const next = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + config.windowMs }
      : { ...current, count: current.count + 1 };
    entries.set(key, next);
    if (entries.size > 1_000) {
      for (const [entryKey, entry] of entries) {
        if (entry.resetAt <= timestamp) entries.delete(entryKey);
      }
    }
    return next.count <= config.maxRequests;
  };
}

export function createHandler(dependencies: HandlerDependencies) {
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rateLimit = dependencies.rateLimit ?? DEFAULT_RATE_LIMIT;
  const allowedOrigins = new Set(dependencies.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const allowRequest = createRateLimiter(rateLimit, dependencies.now ?? Date.now);

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
    }
    const origin = request.headers.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403);
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return jsonResponse({ ok: false, error: "unsupported_media_type" }, 415);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
    }
    if (!allowRequest(clientKey(request))) {
      return jsonResponse({ ok: false, error: "rate_limited" }, 429, { "Retry-After": "60" });
    }

    let body: unknown;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > maxBodyBytes) {
        return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
      }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }

    let retrievalRequest;
    try {
      retrievalRequest = validateRetrievalRequest(body);
    } catch (error) {
      if (error instanceof RetrievalValidationError) {
        return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      }
      throw error;
    }

    try {
      const bundle = await dependencies.loadBundle();
      if (!isRetrievalBundle(bundle)) throw new Error("retrieval bundle is invalid");
      const embedQuery = bundle.embedding ? dependencies.queryEmbedderFor?.(bundle.embedding) : undefined;
      const data = await retrieve(retrievalRequest, bundle, {
        generateAnswer: dependencies.answerGenerator,
        embedQuery,
      });
      return jsonResponse({ ok: true, data });
    } catch {
      const diagnosticId = `ret-${crypto.randomUUID()}`;
      console.error(JSON.stringify({
        event: "retrieval_request_failed",
        diagnosticId,
        requestId: retrievalRequest.requestId,
      }));
      return jsonResponse({ ok: false, error: "retrieval_unavailable", diagnosticId }, 503);
    }
  };
}

export const handler = createHandler({
  loadBundle: loadDefaultBundle,
  answerGenerator: configuredAnswerGenerator(),
  queryEmbedderFor: configuredQueryEmbedderFor(),
  allowedOrigins: configuredAllowedOrigins(),
});
