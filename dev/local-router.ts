import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import {
  createFileRegistry,
  openWithDefaultApplication,
  readPreview,
  type FileRegistry,
  type OpenResult,
  type ResolvedFile,
} from "./local-files.ts";
import {
  createSolutionAssistant,
  SolutionAssistantError,
  type SolutionAssistantResult,
} from "./solution-assistant.ts";
import { createSolutionStore, type SolutionStore } from "./solution-store.ts";
import { createCrmBridge, type CrmBridge, type InsightRecord } from "./crm-bridge.ts";
import { createOpsBridge, type OpsBridge } from "./ops-bridge.ts";

/**
 * Router for the local-only endpoints that back the workbench's "open on this Mac",
 * 云栖大会 highlights and 方案助手 features. Never part of the deployed Function.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const HIGHLIGHTS_PATH = join(PROJECT_ROOT, ".local-cache", "yunqi-highlights.json");
const SOLUTIONS_PATH = join(PROJECT_ROOT, ".local-cache", "solutions");

const MAX_BODY_BYTES = 1024;
const DEFAULT_RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:4173", "http://localhost:4173", "http://127.0.0.1:5173", "http://localhost:5173"];
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

interface RateEntry {
  readonly count: number;
  readonly resetAt: number;
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
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
    if (entries.size > 500) {
      for (const [entryKey, entry] of entries) {
        if (entry.resetAt <= timestamp) entries.delete(entryKey);
      }
    }
    return next.count <= config.maxRequests;
  };
}

/** Absolute paths must not reach the browser; the id is enough to reopen the file. */
function redactHighlights(highlights: unknown): unknown {
  if (!highlights || typeof highlights !== "object") return undefined;
  const record = highlights as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return undefined;
  const { absolutePath: _absolutePath, ...safeSource } = source;
  return { ...record, source: safeSource };
}

async function readHighlights(path: string): Promise<unknown | undefined> {
  try {
    return redactHighlights(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return undefined;
  }
}

function isTrustedHost(request: Request, allowedHosts: ReadonlySet<string>): boolean {
  const host = request.headers.get("host");
  return host !== null && allowedHosts.has(host.toLowerCase());
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return undefined;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface LocalRouterDependencies {
  readonly port: number;
  readonly registry?: FileRegistry;
  readonly highlightsPath?: string;
  readonly allowedOrigins?: readonly string[];
  readonly rateLimit?: { maxRequests: number; windowMs: number };
  readonly now?: () => number;
  readonly openFile?: (resolved: ResolvedFile) => Promise<OpenResult>;
  readonly solutionAssistant?: (request: Request) => Promise<SolutionAssistantResult>;
  readonly solutionStore?: SolutionStore;
  readonly solutionsDir?: string;
  readonly crmBridge?: CrmBridge;
  readonly opsBridge?: OpsBridge;
}

function publicInsight(record: InsightRecord) {
  const { answerMessageId: _answerMessageId, ...visible } = record;
  return visible;
}

export function createLocalRouter(dependencies: LocalRouterDependencies) {
  const registry = dependencies.registry ?? createFileRegistry();
  const openFile = dependencies.openFile ?? openWithDefaultApplication;
  const highlightsPath = dependencies.highlightsPath ?? HIGHLIGHTS_PATH;
  const solutionAssistant = dependencies.solutionAssistant ?? createSolutionAssistant();
  const solutionStore = dependencies.solutionStore
    ?? createSolutionStore(dependencies.solutionsDir ?? SOLUTIONS_PATH);
  const crmBridge = dependencies.crmBridge ?? createCrmBridge();
  const opsBridge = dependencies.opsBridge ?? createOpsBridge();
  const allowedOrigins = new Set(dependencies.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const allowedHosts = new Set([
    `127.0.0.1:${dependencies.port}`,
    `localhost:${dependencies.port}`,
    `[::1]:${dependencies.port}`,
  ]);
  const allowRequest = createRateLimiter(
    dependencies.rateLimit ?? DEFAULT_RATE_LIMIT,
    dependencies.now ?? Date.now,
  );

  return async (request: Request): Promise<Response> => {
    if (!isTrustedHost(request, allowedHosts)) {
      return jsonResponse({ ok: false, error: "host_not_allowed" }, 403);
    }
    const origin = request.headers.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403);
    }
    if (!allowRequest(origin ?? "local")) {
      return jsonResponse({ ok: false, error: "rate_limited" }, 429, { "Retry-After": "60" });
    }

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/local/status" && request.method === "GET") {
      return jsonResponse({ ok: true, data: { localRuntime: true, open: true, preview: true } });
    }

    if (route === "/local/highlights" && request.method === "GET") {
      const highlights = await readHighlights(highlightsPath);
      return highlights
        ? jsonResponse({ ok: true, data: highlights })
        : jsonResponse({ ok: false, error: "highlights_unavailable" }, 404);
    }

    if (route === "/local/crm/snapshot" && request.method === "GET") {
      const snapshot = await crmBridge.snapshot();
      return snapshot
        ? jsonResponse({ ok: true, data: snapshot, refresh: crmBridge.refreshStatus() })
        : jsonResponse({ ok: false, error: "snapshot_unavailable", refresh: crmBridge.refreshStatus() }, 404);
    }

    if (route === "/local/crm/refresh" && (request.method === "GET" || request.method === "POST")) {
      const status = request.method === "POST" ? crmBridge.startRefresh() : crmBridge.refreshStatus();
      return jsonResponse({ ok: true, data: status }, request.method === "POST" ? 202 : 200);
    }

    if (route === "/local/fbi/insight" && request.method === "GET") {
      const record = await crmBridge.insight(url.searchParams.get("cid") ?? "");
      return jsonResponse({ ok: true, data: record ? publicInsight(record) : null });
    }

    if (route === "/local/fbi/insight" && request.method === "POST") {
      const body = await readJsonBody(request);
      const cid = typeof body?.cid === "string" ? body.cid : "";
      if (!cid) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      const result = await crmBridge.startInsight(cid);
      if (!result.ok) {
        const status = result.error === "customer_not_found" ? 404 : result.error === "busy" ? 429 : 400;
        return jsonResponse({ ok: false, error: result.error }, status, status === 429 ? { "Retry-After": "60" } : {});
      }
      return jsonResponse({ ok: true, data: publicInsight(result.record), reused: result.reused }, result.reused ? 200 : 202);
    }

    if (route === "/local/ops/digest" && request.method === "GET") {
      const digest = await opsBridge.digest();
      return digest
        ? jsonResponse({ ok: true, data: digest, refresh: opsBridge.refreshStatus() })
        : jsonResponse({ ok: false, error: "digest_unavailable", refresh: opsBridge.refreshStatus() }, 404);
    }

    if (route === "/local/ops/refresh" && (request.method === "GET" || request.method === "POST")) {
      const status = request.method === "POST" ? opsBridge.startRefresh() : opsBridge.refreshStatus();
      return jsonResponse({ ok: true, data: status }, request.method === "POST" ? 202 : 200);
    }

    if (route === "/local/ops/card" && request.method === "GET") {
      const card = await opsBridge.card();
      return card
        ? jsonResponse({ ok: true, data: card })
        : jsonResponse({ ok: false, error: "digest_unavailable" }, 404);
    }

    if (route === "/local/ops/wechat-links" && request.method === "GET") {
      return jsonResponse({ ok: true, data: { links: await opsBridge.wechatLinks() } });
    }

    if (route === "/local/ops/wechat-links" && request.method === "POST") {
      const body = await readJsonBody(request);
      const url = typeof body?.url === "string" ? body.url : "";
      const result = await opsBridge.registerWechatLink(url);
      if (!result.ok) return jsonResponse({ ok: false, error: "invalid_url" }, 400);
      return jsonResponse({ ok: true, data: result.link }, 201);
    }

    if (route === "/local/preview" && request.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const resolved = await registry.resolve(id);
      if (!resolved) return jsonResponse({ ok: false, error: "not_found" }, 404);
      const contentType = registry.previewable(resolved);
      if (!contentType) return jsonResponse({ ok: false, error: "preview_unsupported" }, 415);
      const bytes = await readPreview(resolved);
      if (!bytes) return jsonResponse({ ok: false, error: "preview_unavailable" }, 500);
      return new Response(bytes, {
        status: 200,
        headers: {
          ...RESPONSE_HEADERS,
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="preview${resolved.extension}"`,
        },
      });
    }

    if (route === "/local/open" && request.method === "POST") {
      const body = await readJsonBody(request);
      const id = typeof body?.id === "string" ? body.id : "";
      if (!id) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      const resolved = await registry.resolve(id);
      if (!resolved) return jsonResponse({ ok: false, error: "not_found" }, 404);
      const result = await openFile(resolved);
      if (!result.ok) return jsonResponse({ ok: false, error: "open_failed" }, 500);
      return jsonResponse({
        ok: true,
        data: {
          id: resolved.id,
          extension: resolved.extension.replace(".", "").toUpperCase(),
          bytes: resolved.bytes,
          preview: registry.previewable(resolved) !== undefined,
        },
      });
    }

    if (route === "/local/solutions" && request.method === "GET") {
      const seriesId = url.searchParams.get("series");
      if (seriesId) {
        const series = await solutionStore.get(seriesId);
        return series
          ? jsonResponse({ ok: true, data: series })
          : jsonResponse({ ok: false, error: "not_found" }, 404);
      }
      return jsonResponse({ ok: true, data: { series: await solutionStore.list() } });
    }

    const solutionVersionRoute = /^\/local\/solutions\/([^/]+)\/([^/]+)$/.exec(route);
    if (solutionVersionRoute && request.method === "DELETE") {
      const remaining = await solutionStore.remove(solutionVersionRoute[1]!, solutionVersionRoute[2]!);
      if (remaining === undefined) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      return jsonResponse({ ok: true, data: { remaining } });
    }

    if (route === "/local/assistant" && request.method === "POST") {
      try {
        const { plan, retrieval, input } = await solutionAssistant(request);
        try {
          const saved = await solutionStore.append({
            key: {
              customer: input.customer,
              industry: input.industry,
              goal: input.goal,
              constraints: input.constraints,
            },
            requestId: input.requestId,
            plan,
            retrieval,
          });
          if (!saved) console.error(JSON.stringify({ event: "solution_history_skipped", requestId: input.requestId }));
        } catch {
          // History is best-effort: a full plan in the response matters more than its archive copy.
          console.error(JSON.stringify({ event: "solution_history_failed", requestId: input.requestId }));
        }
        return jsonResponse({ ok: true, data: plan, retrieval });
      } catch (error) {
        if (!(error instanceof SolutionAssistantError)) throw error;
        return jsonResponse(
          { ok: false, error: error.code, diagnosticId: error.diagnosticId },
          error.status,
          error.status === 429 ? { "Retry-After": "30" } : {},
        );
      }
    }

    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET, POST, DELETE" });
  };
}
