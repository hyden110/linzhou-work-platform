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
import { createPplInspectionBridge, type PplInspectionBridge } from "./ppl-inspection-bridge.ts";
import { createFbiMetricsBridge, type FbiMetricsBridge } from "./fbi-metrics-bridge.ts";
import { createDingtalkBridge, type DingtalkBridge } from "./dingtalk-bridge.ts";
import { createKbBridge, KB_ID_PATTERN, KbBridgeError, type KbBridge } from "./kb-bridge.ts";
import { createCasesBridge, type CasesBridge } from "./cases-bridge.ts";
import { createHealthBridge, type HealthBridge } from "./health-bridge.ts";
import { createLeadsBridge, LeadsSyncError, type LeadsBridge } from "./leads-bridge.ts";
import { createReportBridge, ReportBridgeError, type ReportBridge } from "./report-bridge.ts";
import { createNotifyBridge, NotifyBridgeError, type NotifyBridge } from "./notify-bridge.ts";

/**
 * Router for the local-only endpoints that back the workbench's "open on this Mac",
 * 云栖大会 highlights and 方案助手 features. Never part of the deployed Function.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const HIGHLIGHTS_PATH = join(PROJECT_ROOT, ".local-cache", "yunqi-highlights.json");
const SOLUTIONS_PATH = join(PROJECT_ROOT, ".local-cache", "solutions");

const MAX_BODY_BYTES = 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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

async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return undefined;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) return undefined;
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
  readonly fbiMetricsBridge?: FbiMetricsBridge;
  readonly pplInspectionBridge?: PplInspectionBridge;
  readonly dingtalkBridge?: DingtalkBridge;
  readonly kbBridge?: KbBridge;
  readonly casesBridge?: CasesBridge;
  readonly healthBridge?: HealthBridge;
  readonly leadsBridge?: LeadsBridge;
  readonly reportBridge?: ReportBridge;
  readonly notifyBridge?: NotifyBridge;
}

/** 稳定错误码 → HTTP 状态映射（report）：unconfigured=400（含参数/白名单拒绝），其余 502。 */
function reportFailure(error: unknown): Response {
  if (error instanceof ReportBridgeError) {
    const status = error.code === "report_unconfigured" ? 400 : 502;
    return jsonResponse({ ok: false, error: error.code, message: error.message }, status);
  }
  // F5 评审 P3-1：未知异常兜底 502，避免 500 被客户端误读为「本地桥未启动」。
  return jsonResponse({ ok: false, error: "report_unavailable" }, 502);
}

/** 稳定错误码 → HTTP 状态映射（notify）：invalid_request=400，其余 502。 */
function notifyFailure(error: unknown): Response {
  if (error instanceof NotifyBridgeError) {
    const status = error.code === "notify_invalid_request" ? 400 : 502;
    const code = error.code === "notify_invalid_request" ? "invalid_request" : "notify_unavailable";
    return jsonResponse({ ok: false, error: code, message: error.message }, status);
  }
  return jsonResponse({ ok: false, error: "notify_unavailable" }, 502);
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
  const fbiMetricsBridge = dependencies.fbiMetricsBridge ?? createFbiMetricsBridge();
  const pplInspectionBridge = dependencies.pplInspectionBridge ?? createPplInspectionBridge();
  const dingtalkBridge = dependencies.dingtalkBridge ?? createDingtalkBridge();
  const kbBridge = dependencies.kbBridge ?? createKbBridge();
  const casesBridge = dependencies.casesBridge ?? createCasesBridge();
  const healthBridge = dependencies.healthBridge ?? createHealthBridge({
    crmSnapshot: crmBridge.snapshot,
    dingtalkWrites: dingtalkBridge.writes,
    fbiMetrics: fbiMetricsBridge.metrics,
    pplInspection: pplInspectionBridge.inspection,
    kbConfig: kbBridge.config,
    opsDigest: opsBridge.digest,
  });
  const leadsBridge = dependencies.leadsBridge ?? createLeadsBridge();
  const reportBridge = dependencies.reportBridge ?? createReportBridge();
  const notifyBridge = dependencies.notifyBridge ?? createNotifyBridge();
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

    if (route === "/local/fbi/metrics" && request.method === "GET") {
      const metrics = await fbiMetricsBridge.metrics();
      return metrics
        ? jsonResponse({ ok: true, data: metrics, status: fbiMetricsBridge.status() })
        : jsonResponse({ ok: false, error: "metrics_unavailable", status: fbiMetricsBridge.status() }, 404);
    }

    if (route === "/local/fbi/metrics" && request.method === "POST") {
      const result = await fbiMetricsBridge.start();
      if (!result.ok) {
        const status = result.error === "busy" ? 429 : 400;
        return jsonResponse({ ok: false, error: result.error, status: fbiMetricsBridge.status() }, status);
      }
      return jsonResponse({ ok: true, data: fbiMetricsBridge.status() }, 202);
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

    if (route === "/local/ppl/inspection" && request.method === "GET") {
      const inspection = await pplInspectionBridge.inspection();
      const decisions = await pplInspectionBridge.decisions();
      return inspection
        ? jsonResponse({ ok: true, data: inspection, decisions, refresh: pplInspectionBridge.refreshStatus() })
        : jsonResponse({ ok: false, error: "inspection_unavailable", refresh: pplInspectionBridge.refreshStatus() }, 404);
    }

    if (route === "/local/ppl/refresh" && (request.method === "GET" || request.method === "POST")) {
      const status = request.method === "POST" ? pplInspectionBridge.startRefresh() : pplInspectionBridge.refreshStatus();
      return jsonResponse({ ok: true, data: status }, request.method === "POST" ? 202 : 200);
    }

    if (route === "/local/ppl/approval" && request.method === "POST") {
      const body = await readJsonBody(request);
      const recommendationId = typeof body?.recommendationId === "string" ? body.recommendationId : "";
      const action = body?.action;
      if (action !== "approve" && action !== "discard") {
        return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      }
      const note = typeof body?.note === "string" ? body.note : undefined;
      const result = await pplInspectionBridge.decide(recommendationId, action, note);
      if (!result.ok) {
        const status = result.error === "not_found" ? 404
          : result.error === "already_decided" ? 409
            : result.error === "blocked_recommendation" ? 422 : 400;
        return jsonResponse({ ok: false, error: result.error }, status);
      }
      return jsonResponse({ ok: true, data: result.decision }, 201);
    }

    if (route === "/local/dingtalk/todo" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      const result = await dingtalkBridge.createTodo(body);
      if (!result.ok) {
        const status = result.error === "busy" ? 429
          : result.error === "dws_missing" ? 503
            : result.error === "invalid_request" || result.error === "user_id_unavailable" ? 400
              : 502;
        return jsonResponse(
          { ok: false, error: result.error, write: result.record ?? null },
          status,
          status === 429 ? { "Retry-After": "5" } : {},
        );
      }
      return jsonResponse(
        { ok: true, data: result.record, reused: result.reused },
        result.reused ? 200 : 202,
      );
    }

    if (route === "/local/dingtalk/todo/writes" && request.method === "GET") {
      return jsonResponse({ ok: true, data: { writes: await dingtalkBridge.writes() } });
    }

    if (route === "/local/dingtalk/summary" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? undefined;
      if (date !== undefined && !DATE_PATTERN.test(date)) {
        return jsonResponse({ ok: false, error: "invalid_date" }, 400);
      }
      const summary = await dingtalkBridge.summary(date);
      return summary
        ? jsonResponse({ ok: true, data: summary, refresh: await dingtalkBridge.summaryStatus() })
        : jsonResponse({ ok: false, error: "summary_not_found" }, 404);
    }

    if (route === "/local/dingtalk/summary" && request.method === "POST") {
      const body = await readJsonBody(request);
      const date = typeof body?.date === "string" ? body.date : undefined;
      if (date !== undefined && !DATE_PATTERN.test(date)) {
        return jsonResponse({ ok: false, error: "invalid_date" }, 400);
      }
      const result = await dingtalkBridge.startSummary(date);
      if (!result.ok) return jsonResponse({ ok: false, error: result.error ?? "invalid_date" }, 400);
      return jsonResponse({ ok: true, data: result.status, reused: result.reused }, 202);
    }

    if (route === "/local/dingtalk/summary/status" && request.method === "GET") {
      return jsonResponse({ ok: true, data: await dingtalkBridge.summaryStatus() });
    }

    if (route === "/local/dingtalk/daily-messages" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? "";
      const chatId = url.searchParams.get("chatId") ?? "";
      if (!DATE_PATTERN.test(date) || !chatId) {
        return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      }
      const data = await dingtalkBridge.dailyMessages(date, chatId);
      return data
        ? jsonResponse({ ok: true, data })
        : jsonResponse({ ok: false, error: "message_cache_unavailable" }, 404);
    }

    // 统一知识检索（F2）：全部只读端点。桥侧负责多源扇出、RRF 融合与摘要降级；
    // 绝对路径不出桥，摘要么输入只含标题/路径/摘要片段。
    if (route === "/local/kb/sources" && request.method === "GET") {
      return jsonResponse({ ok: true, data: { sources: await kbBridge.sources() } });
    }

    if (route === "/local/kb/search" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query || query.length > 200) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      const onlyParam = url.searchParams.get("sources");
      const only = onlyParam !== null ? onlyParam.split(",").filter((id) => KB_ID_PATTERN.test(id)) : undefined;
      try {
        const outcome = await kbBridge.search(query, only);
        return jsonResponse({ ok: true, data: outcome });
      } catch (error) {
        if (!(error instanceof KbBridgeError)) throw error;
        return jsonResponse({ ok: false, error: "kb_unavailable" }, 502);
      }
    }

    if (route === "/local/kb/read" && request.method === "GET") {
      const sourceId = url.searchParams.get("source") ?? "";
      const id = url.searchParams.get("id") ?? "";
      if (!sourceId || !id || !KB_ID_PATTERN.test(sourceId)) {
        return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      }
      try {
        return jsonResponse({ ok: true, data: await kbBridge.read(sourceId, id) });
      } catch (error) {
        if (!(error instanceof KbBridgeError)) throw error;
        const status = error.code === "source_not_found" ? 404 : 502;
        return jsonResponse({ ok: false, error: error.code }, status);
      }
    }

    if (route === "/local/kb/summary" && request.method === "POST") {
      const body = await readJsonBody(request, 16 * 1024);
      const query = typeof body?.q === "string" ? body.q.trim().slice(0, 200) : "";
      const hits = Array.isArray(body?.hits) ? body.hits : [];
      if (!query || !hits.length) return jsonResponse({ ok: false, error: "invalid_request" }, 400);
      try {
        return jsonResponse({ ok: true, data: await kbBridge.summary(query, hits) });
      } catch (error) {
        if (!(error instanceof KbBridgeError)) throw error;
        return jsonResponse({ ok: false, error: error.code }, 502);
      }
    }

    if (route === "/local/ops/push" && request.method === "POST") {
      const result = await opsBridge.pushCard();
      if (!result.ok) {
        const status = result.error === "digest_unavailable" ? 404
          : result.error === "recipient_not_configured" || result.error === "push_disabled" ? 400
            : 500;
        return jsonResponse({ ok: false, error: result.error }, status);
      }
      return jsonResponse({ ok: true, data: result.preview }, result.preview.mode === "sent" ? 200 : 202);
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

    // 已发布案例库（F3）：只读端点。桥侧负责配置降级与渠道 last-error，
    // 缺配置如实返回 configured:false，绝不造数据。
    if (route === "/local/cases" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await casesBridge.snapshot() });
      } catch {
        return jsonResponse({ ok: false, error: "cases_unavailable" }, 502);
      }
    }

    // 环境与健康体检（F4）：只读快照，回答「现在还能不能取到数」。
    // CLI 探测由用户在体检面板手动触发（前端不自动轮询）；桥内零写盘，
    // env 只报 set/unset，子进程输出回传前一律过 redact。
    if (route === "/local/health" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await healthBridge.snapshot() });
      } catch {
        return jsonResponse({ ok: false, error: "health_unavailable" }, 502);
      }
    }

    // 拓新雷达（F5）：钉钉 AI 表格「拓新企业清单」只读桥。GET 读本机快照；
    // POST /refresh 显式触发 dws 拉取（12h TTL 低成本口径，无自动轮询），绝不回写。
    // 未配置 → 400 leads_unconfigured；护栏拒绝（表名漂移/字段漂移/空表/腰斩/分页不完整）
    // → 409 带稳定错误码且旧快照原样保留；dws 缺失/失败 → 502 leads_unavailable。
    if (route === "/local/leads" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await leadsBridge.snapshot() });
      } catch {
        return jsonResponse({ ok: false, error: "leads_unavailable" }, 502);
      }
    }

    if (route === "/local/leads/refresh" && request.method === "POST") {
      try {
        return jsonResponse({ ok: true, data: await leadsBridge.refresh() });
      } catch (error) {
        // 评审 P3-1：非 LeadsSyncError（如快照写的原生 fs 错误）映射 502
        // leads_unavailable，避免落 500 被客户端误读为「本地桥未启动」。
        if (!(error instanceof LeadsSyncError)) {
          return jsonResponse({ ok: false, error: "leads_unavailable" }, 502);
        }
        const status = error.code === "leads_unconfigured" ? 400
          : error.code === "leads_unavailable" ? 502 : 409;
        return jsonResponse({ ok: false, error: error.code, message: error.message }, status);
      }
    }

    // 日周报（F6）：全只读。当日草稿 / outbox 提交状态 / 双周报目录与正文 /
    // QoderWake 定时任务状态；save / draft / send 等写动作本批不提供（POST 落 405）。
    if (route === "/local/report/state" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await reportBridge.state() });
      } catch (error) {
        return reportFailure(error);
      }
    }

    if (route === "/local/report/automations" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await reportBridge.automations({ fresh: url.searchParams.get("fresh") === "1" }) });
      } catch (error) {
        return reportFailure(error);
      }
    }

    if (route === "/local/report/weeklies" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await reportBridge.weeklies({ fresh: url.searchParams.get("fresh") === "1" }) });
      } catch (error) {
        return reportFailure(error);
      }
    }

    if (route === "/local/report/weekly" && request.method === "GET") {
      try {
        const node = url.searchParams.get("node") ?? "";
        return jsonResponse({ ok: true, data: await reportBridge.weekly(node, { fresh: url.searchParams.get("fresh") === "1" }) });
      } catch (error) {
        return reportFailure(error);
      }
    }

    // 消息中心（F6）：收件箱只读拉取 + 已读位切换 + 测试消息生产者。
    // 无 SSE、无轮询：端上打开面板时拉取 + 显式刷新；真实事件源待后续批次接入。
    if (route === "/local/notify/state" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await notifyBridge.state() });
      } catch (error) {
        return notifyFailure(error);
      }
    }

    if (route === "/local/notify/items" && request.method === "GET") {
      try {
        return jsonResponse({ ok: true, data: await notifyBridge.items() });
      } catch (error) {
        return notifyFailure(error);
      }
    }

    if (route === "/local/notify/read" && request.method === "POST") {
      try {
        const body = await readJsonBody(request) ?? {};
        return jsonResponse({ ok: true, data: await notifyBridge.markRead(body) });
      } catch (error) {
        return notifyFailure(error);
      }
    }

    if (route === "/local/notify/test" && request.method === "POST") {
      try {
        return jsonResponse({ ok: true, data: await notifyBridge.enqueueTest() });
      } catch (error) {
        return notifyFailure(error);
      }
    }

    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET, POST, DELETE" });
  };
}
