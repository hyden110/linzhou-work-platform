/**
 * Browser client for the datasource registry bridge — GET /local/datasources +
 * POST /local/datasources/refresh.
 *
 * Degrade contract mirrors health-client: an offline bridge maps to
 * DataSourceClientError("unavailable"). Registry rows are projected onto a
 * whitelist (state must be a known enum; unknown fields — credential-shaped or
 * not — are physically unreachable in the result object). 静态目录（通道/能力/
 * env/健康分组/源元数据）以 src/lib/datasource-model.ts 为准随包发布；本 client
 * 只取桥侧动态部分：每源状态 + 组刷新支持度 + 刷新结果。
 */

const REGISTRY_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 180_000; /* leads/dingtalk 组会 await dws 拉取 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "datasource_invalid_request",
  "datasource_busy",
  "datasource_refresh_failed",
  "datasource_unavailable",
  "method_not_allowed",
] as const;

export type DataSourceClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class DataSourceClientError extends Error {
  readonly code: DataSourceClientErrorCode;

  constructor(code: DataSourceClientErrorCode) {
    super(code);
    this.name = "DataSourceClientError";
    this.code = code;
  }
}

export type DataSourceState = "ok" | "stale" | "error" | "missing" | "static" | "unknown";

export interface DataSourceStatusView {
  readonly state: DataSourceState;
  readonly evidence: string;
  readonly fetchedAt: string | null;
}

export interface SourceStatusEntry {
  readonly sys: string;
  readonly status: DataSourceStatusView;
}

export interface RefreshGroupView {
  readonly id: string;
  readonly d: string;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly sourceCount: number;
}

export interface DataSourceRegistryView {
  readonly version: string;
  readonly generatedAt: string;
  readonly groups: readonly RefreshGroupView[];
  readonly statuses: readonly SourceStatusEntry[];
}

export type SourceRefreshState = "started" | "ok" | "failed" | "skipped";

export interface SourceRefreshResultView {
  readonly sys: string;
  readonly state: SourceRefreshState;
  readonly detail: string;
}

export interface DataSourceRefreshView {
  readonly group: string;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly startedAt: string;
  readonly results: readonly SourceRefreshResultView[];
}

const SOURCE_STATES: ReadonlySet<string> = new Set(["ok", "stale", "error", "missing", "static", "unknown"]);
const REFRESH_STATES: ReadonlySet<string> = new Set(["started", "ok", "failed", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

/** 错误信封 {ok:false,error:{code,message}} → 稳定安全码；未知一律 unavailable。 */
function safeErrorCode(payload: unknown): DataSourceClientErrorCode {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string" && SAFE_ERROR_SET.has(payload.error.code)) {
    return payload.error.code as DataSourceClientErrorCode;
  }
  return "unavailable";
}

async function postOrGet(path: string, init: RequestInit | undefined, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DataSourceClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    throw new DataSourceClientError(safeErrorCode(payload));
  }
  return payload.data;
}

/** 白名单投影：任何一行无法投影 → 整包拒绝（invalid_response），绝不半真半假。 */
function asRegistry(data: unknown): DataSourceRegistryView | undefined {
  if (!isRecord(data) || typeof data.version !== "string" || !Array.isArray(data.groups) || !Array.isArray(data.sources)) {
    return undefined;
  }
  const groups: RefreshGroupView[] = [];
  for (const item of data.groups) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.supported !== "boolean") return undefined;
    groups.push({
      id: item.id,
      d: typeof item.d === "string" ? item.d : "",
      supported: item.supported,
      reason: typeof item.reason === "string" ? item.reason : null,
      sourceCount: typeof item.sourceCount === "number" ? item.sourceCount : 0,
    });
  }
  const statuses: SourceStatusEntry[] = [];
  for (const item of data.sources) {
    if (!isRecord(item) || typeof item.sys !== "string" || !isRecord(item.status)) return undefined;
    const status = item.status;
    if (typeof status.state !== "string" || !SOURCE_STATES.has(status.state)) return undefined;
    statuses.push({
      sys: item.sys,
      status: {
        state: status.state as DataSourceState,
        evidence: typeof status.evidence === "string" ? status.evidence : "",
        fetchedAt: typeof status.fetchedAt === "string" ? status.fetchedAt : null,
      },
    });
  }
  return {
    version: data.version,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
    groups,
    statuses,
  };
}

function asRefresh(data: unknown): DataSourceRefreshView | undefined {
  if (!isRecord(data) || typeof data.group !== "string" || typeof data.supported !== "boolean" || !Array.isArray(data.results)) {
    return undefined;
  }
  const results: SourceRefreshResultView[] = [];
  for (const item of data.results) {
    if (!isRecord(item) || typeof item.sys !== "string" || typeof item.state !== "string" || !REFRESH_STATES.has(item.state)) {
      return undefined;
    }
    results.push({ sys: item.sys, state: item.state as SourceRefreshState, detail: typeof item.detail === "string" ? item.detail : "" });
  }
  return {
    group: data.group,
    supported: data.supported,
    reason: typeof data.reason === "string" ? data.reason : null,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
    results,
  };
}

/** GET /local/datasources —— 注册表动态视图（每源状态 + 组刷新支持度）。 */
export async function fetchDataSourceRegistry(fetchImpl: typeof fetch = fetch): Promise<DataSourceRegistryView> {
  const view = asRegistry(await postOrGet("/local/datasources", undefined, REGISTRY_TIMEOUT_MS, fetchImpl));
  if (!view) throw new DataSourceClientError("invalid_response");
  return view;
}

/** POST /local/datasources/refresh —— 只 supported 组会真刷；unsupported 组回诚实原因。 */
export async function refreshDataSourceGroup(group: string, fetchImpl: typeof fetch = fetch): Promise<DataSourceRefreshView> {
  const data = await postOrGet(
    "/local/datasources/refresh",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ group }) },
    REFRESH_TIMEOUT_MS,
    fetchImpl,
  );
  const view = asRefresh(data);
  if (!view) throw new DataSourceClientError("invalid_response");
  return view;
}

export function dataSourceErrorMessage(error: unknown): string {
  const code = error instanceof DataSourceClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的数据源数据。",
    datasource_invalid_request: "刷新请求参数不完整，请重试。",
    datasource_busy: "该组刷新正在进行中，请等待本轮完成。",
    datasource_refresh_failed: "刷新执行失败，详情见逐源结果（输出已脱敏）。",
    datasource_unavailable: "数据源总表暂时不可用，请稍后重试。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  return messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
}
