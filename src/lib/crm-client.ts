import type {
  AttributionRecord,
  CrmAiExplainRecord,
  CrmSnapshot,
  InsightRecord,
  RefreshStatus,
} from "./crm-types";

const SAFE_ERRORS = new Set([
  "snapshot_unavailable",
  "not_found",
  "invalid_request",
  "invalid_cid",
  "customer_not_found",
  "busy",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "not_configured",
  "attribution_missing",
  "unconfigured",
]);

export class CrmClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CrmClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string, query?: Record<string, string>): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function request(path: string, init: RequestInit & { query?: Record<string, string> }, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path, init.query), { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new CrmClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERRORS.has(payload.error)
      ? payload.error
      : "unavailable";
    throw new CrmClientError(code);
  }
  return payload;
}

function isSnapshot(value: unknown): value is CrmSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sources)) return false;
  return ["agenda", "todos", "customers", "projects"].every((key) => Array.isArray(value[key]));
}

/** Older schema-1 snapshots predate the dingtalk/overview sections; fill them so the UI can rely on arrays. */
function normalizeSnapshot(value: CrmSnapshot): CrmSnapshot {
  return {
    ...value,
    groups: value.groups ?? [],
    mentions: value.mentions ?? [],
    unread: value.unread ?? [],
    overview: value.overview ?? [],
    top: value.top ?? [],
    mygroups: value.mygroups ?? [],
  };
}

function isRefreshStatus(value: unknown): value is RefreshStatus {
  return isRecord(value) && ["idle", "running", "succeeded", "failed"].includes(String(value.state));
}

function isInsight(value: unknown): value is InsightRecord {
  return isRecord(value) && typeof value.cid === "string" && ["running", "done", "failed"].includes(String(value.state));
}

function isAttribution(value: unknown): value is AttributionRecord {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.cid === "string"
    && ["running", "done", "failed"].includes(String(value.state))
    && typeof value.reportResourceId === "string"
    && Array.isArray(value.rows);
}

function isExplain(value: unknown): value is CrmAiExplainRecord {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.cid === "string"
    && ["running", "done", "failed"].includes(String(value.state));
}

export async function fetchCrmSnapshot(fetchImpl: typeof fetch = fetch): Promise<{ snapshot: CrmSnapshot; refresh: RefreshStatus | null }> {
  const payload = await request("/local/crm/snapshot", { method: "GET" }, fetchImpl);
  if (!isSnapshot(payload.data)) throw new CrmClientError("invalid_response");
  return { snapshot: normalizeSnapshot(payload.data), refresh: isRefreshStatus(payload.refresh) ? payload.refresh : null };
}

export async function fetchRefreshStatus(fetchImpl: typeof fetch = fetch): Promise<RefreshStatus> {
  const payload = await request("/local/crm/refresh", { method: "GET" }, fetchImpl);
  if (!isRefreshStatus(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function startCrmRefresh(fetchImpl: typeof fetch = fetch): Promise<RefreshStatus> {
  const payload = await request("/local/crm/refresh", { method: "POST" }, fetchImpl);
  if (!isRefreshStatus(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function fetchInsight(cid: string, fetchImpl: typeof fetch = fetch): Promise<InsightRecord | null> {
  const payload = await request("/local/fbi/insight", { method: "GET", query: { cid } }, fetchImpl);
  if (payload.data === null) return null;
  if (!isInsight(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function startInsight(cid: string, fetchImpl: typeof fetch = fetch): Promise<InsightRecord> {
  const payload = await request("/local/fbi/insight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cid }),
  }, fetchImpl);
  if (!isInsight(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function fetchAttribution(cid: string, fetchImpl: typeof fetch = fetch): Promise<AttributionRecord | null> {
  const payload = await request("/local/crm/attribution", { method: "GET", query: { cid } }, fetchImpl);
  if (payload.data === null) return null;
  if (!isAttribution(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function startAttribution(
  cid: string,
  options: { force?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<AttributionRecord> {
  const payload = await request("/local/crm/attribution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cid, ...(options.force ? { force: true } : {}) }),
  }, fetchImpl);
  if (!isAttribution(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function fetchExplain(cid: string, fetchImpl: typeof fetch = fetch): Promise<CrmAiExplainRecord | null> {
  const payload = await request("/local/crm/attribution/explain", { method: "GET", query: { cid } }, fetchImpl);
  if (payload.data === null) return null;
  if (!isExplain(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export async function startExplain(
  cid: string,
  options: { force?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CrmAiExplainRecord> {
  const payload = await request("/local/crm/attribution/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cid, ...(options.force ? { force: true } : {}) }),
  }, fetchImpl);
  if (!isExplain(payload.data)) throw new CrmClientError("invalid_response");
  return payload.data;
}

export function crmErrorMessage(error: unknown): string {
  const code = error instanceof CrmClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    snapshot_unavailable: "还没有客户快照，点击“刷新数据”生成第一份。",
    customer_not_found: "快照里没有这个客户，请先刷新鲲鹏数据。",
    busy: "FBI 解读任务较多，请稍后再试。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
    not_configured: "FBI 报表未接入：请在 .env.local 配置 FBI_REPORT_RESOURCE_ID 后重启本机服务。",
    attribution_missing: "请先完成 FBI 产品拆分，再请 CRM AI 助理解读。",
    unconfigured: "CRM AI 助理未配置：请在 .env.local 配置 CRM_AI_OPEN_DINGTALK_ID 后重启本机服务。",
  };
  return messages[code] ?? "请求未完成，请稍后重试。";
}
