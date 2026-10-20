/**
 * Datasource bridge — 数据源管理总表：注册表 + 每源实时状态 + 组刷新。
 *
 * 子路由模式与 ontology-bridge 一致：local-router.ts 禁改，本桥自带 handle(request)
 * 并导出 DATASOURCE_ROUTES 供接线（见 dev/datasource-bridge.ts 头注释）。
 *
 * 诚实红线：状态全部从既有桥只读产物派生，缺失即 missing；unsupported 组返回
 * {supported:false, reason} 绝不伪造成功；响应不含绝对路径、不含凭据值。
 */

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import {
  DATASOURCE_MODEL_VERSION,
  caps,
  channels,
  envSections,
  groups,
  healthGroups,
  sources,
  sourcesOfGroup,
} from "../../src/lib/datasource-model.ts";
import { createCrmBridge } from "../crm-bridge.ts";
import { createDingtalkBridge } from "../dingtalk-bridge.ts";
import { createKbBridge } from "../kb-bridge.ts";
import { createOpsBridge } from "../ops-bridge.ts";
import { createPplInspectionBridge } from "../ppl-inspection-bridge.ts";
import { createLeadsBridge } from "../leads-bridge.ts";
import { redactNote } from "../health/health-redact.ts";
import { isSupportedGroup, runGroupRefresh, unsupportedReason } from "./datasource-refresh.ts";
import {
  deriveStatus,
  parseCrm,
  parseHealth,
  parseKb,
  parseLeads,
  parseOntology,
  parseOps,
  type ArtifactBundle,
} from "./datasource-status.ts";
import {
  DATASOURCE_ROUTES,
  DataSourceBridgeError,
  type DataSourceBridge,
  type DataSourceBridgeOptions,
  type DataSourceProbes,
  type DataSourceRefreshDeps,
  type DataSourceRefreshView,
  type DataSourceRegistryView,
  type RefreshGroupView,
} from "./datasource-types.ts";

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** 请求体体积上限：刷新 body 只有 {group}，1KB 足够（与 local-router 同口径）。 */
const MAX_BODY_BYTES = 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: DataSourceBridgeError["code"]): number {
  if (code === "datasource_busy") return 409;
  if (code === "datasource_refresh_failed" || code === "datasource_unavailable") return 502;
  if (code === "method_not_allowed") return 405;
  return 400;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** 探针守卫：任何探针抛错都降级为「产物缺失」，绝不拖垮整表。 */
async function guarded<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe();
  } catch {
    return undefined;
  }
}

function defaultProbes(cacheDir: string): DataSourceProbes {
  const crmBridge = createCrmBridge();
  const opsBridge = createOpsBridge();
  const pplBridge = createPplInspectionBridge();
  const leadsBridge = createLeadsBridge();
  const kbBridge = createKbBridge();
  const dingtalkBridge = createDingtalkBridge();
  return {
    crmSnapshot: crmBridge.snapshot,
    opsDigest: opsBridge.digest,
    pplInspection: pplBridge.inspection,
    leadsSnapshot: () => leadsBridge.snapshot(),
    kbSources: () => kbBridge.sources(),
    dingtalkWrites: dingtalkBridge.writes,
    /* 健康快照默认读持久化产物（现场重检落盘），绝不在总表 GET 里重跑 CLI 探测。 */
    healthSnapshot: async () => readJsonFile(join(cacheDir, "health.json")),
    ontologyGraph: async () => readJsonFile(join(cacheDir, "ontology", "graph.json")),
  };
}

function defaultRefreshDeps(): DataSourceRefreshDeps {
  const crmBridge = createCrmBridge();
  const opsBridge = createOpsBridge();
  const pplBridge = createPplInspectionBridge();
  const leadsBridge = createLeadsBridge();
  const dingtalkBridge = createDingtalkBridge();
  return {
    crmStatus: () => crmBridge.refreshStatus(),
    crmStart: () => crmBridge.startRefresh(),
    opsStatus: () => opsBridge.refreshStatus(),
    opsStart: () => opsBridge.startRefresh(),
    pplStatus: () => pplBridge.refreshStatus(),
    pplStart: () => pplBridge.startRefresh(),
    leadsRefresh: async () => {
      const result = await leadsBridge.refresh();
      return { summary: result.summary };
    },
    dingtalkStartSummary: () => dingtalkBridge.startSummary(),
  };
}

function groupViews(): readonly RefreshGroupView[] {
  return groups.map((g) => ({
    id: g.id,
    d: g.d,
    supported: isSupportedGroup(g.id),
    reason: isSupportedGroup(g.id) ? null : unsupportedReason(g.id),
    sourceCount: sourcesOfGroup(g.id).length,
  }));
}

export function createDataSourceBridge(options: DataSourceBridgeOptions = {}): DataSourceBridge {
  const now = options.now ?? Date.now;
  const cacheDir = join(PROJECT_ROOT, ".local-cache");
  const probes = options.probes ?? defaultProbes(cacheDir);
  const refreshDeps = options.refreshDeps ?? defaultRefreshDeps();
  const inflight = new Map<string, Promise<DataSourceRefreshView>>();

  async function collectArtifacts(): Promise<ArtifactBundle> {
    const [crm, ops, ppl, leads, kb, dingtalkWrites, health, ontology] = await Promise.all([
      guarded(probes.crmSnapshot),
      guarded(probes.opsDigest),
      guarded(probes.pplInspection),
      guarded(probes.leadsSnapshot),
      guarded(probes.kbSources),
      guarded(probes.dingtalkWrites),
      guarded(probes.healthSnapshot),
      guarded(probes.ontologyGraph),
    ]);
    return {
      crm: parseCrm(crm),
      ops: parseOps(ops),
      ppl: ppl !== undefined,
      leads: parseLeads(leads),
      kb: parseKb(kb),
      dingtalkWrites: Array.isArray(dingtalkWrites) ? dingtalkWrites : undefined,
      health: parseHealth(health),
      ontology: parseOntology(ontology),
    };
  }

  async function registry(): Promise<DataSourceRegistryView> {
    const artifacts = await collectArtifacts();
    return {
      version: DATASOURCE_MODEL_VERSION,
      generatedAt: new Date(now()).toISOString(),
      channels,
      groups: groupViews(),
      caps,
      envSections,
      healthGroups,
      sources: sources.map((source) => ({ ...source, status: deriveStatus(source, artifacts) })),
    };
  }

  async function refresh(body: unknown): Promise<DataSourceRefreshView> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DataSourceBridgeError("datasource_invalid_request", "请求体必须是 JSON 对象：{group}。");
    }
    const group = (body as Record<string, unknown>).group;
    if (typeof group !== "string" || !group || group.length > 60 || !groups.some((g) => g.id === group)) {
      throw new DataSourceBridgeError("datasource_invalid_request", "group 必须是注册表登记的刷新组 id。");
    }
    const existing = inflight.get(group);
    if (existing) {
      throw new DataSourceBridgeError("datasource_busy", `「${group}」组刷新正在进行中，请等待本轮完成`);
    }
    const task = runGroupRefresh(group, sourcesOfGroup(group), refreshDeps, now).finally(() => {
      inflight.delete(group);
    });
    inflight.set(group, task);
    return task;
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new DataSourceBridgeError("datasource_invalid_request", "请求体过大：刷新只需要 {group}。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new DataSourceBridgeError("datasource_invalid_request", "请求体过大：刷新只需要 {group}。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new DataSourceBridgeError("datasource_invalid_request", "请求体不是合法 JSON。");
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const route = DATASOURCE_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非数据源路径：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      if (route.operation === "registry") return jsonResponse({ ok: true, data: await registry() });
      return jsonResponse({ ok: true, data: await refresh(await readBody(request)) });
    } catch (error) {
      if (error instanceof DataSourceBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "datasource_unavailable", message: redactNote("数据源总表遇到未知故障，请稍后重试。") } },
        502,
      );
    }
  }

  return { registry, refresh, handle };
}
