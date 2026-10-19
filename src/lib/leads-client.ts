/**
 * Browser client for the leads radar (F5) — GET /local/leads + POST /local/leads/refresh.
 *
 * 只读语义与静态版一致：线索由外部 lead-radar 写入钉钉 AI 表格，工作台只读拉取、
 * 绝不回写；联系人字段（电话/邮箱/法定代表人）在桥侧白名单外，客户端再做一次
 * 白名单投影双保险。降级契约同 cases/health 客户端：桥 500/离线 → 安全错误码 +
 * 「本地桥未启动」文案，未配置机器保持 configured:false 以便渲染引导文案。
 * 刷新为显式手动触发（12h TTL 低成本口径）：无自动轮询。
 */

const LEADS_TIMEOUT_MS = 660_000; /* 桥侧拉取上限（dws record query 600s）+ 网络余量 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "leads_unavailable",
  "leads_unconfigured",
  "leads_table_missing",
  "leads_table_drift",
  "leads_field_drift",
  "leads_pagination",
  "leads_empty",
  "leads_shrink",
] as const;

export type LeadsClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class LeadsClientError extends Error {
  readonly code: LeadsClientErrorCode;
  readonly detail: string;

  constructor(code: LeadsClientErrorCode, detail = "") {
    super(code);
    this.name = "LeadsClientError";
    this.code = code;
    this.detail = detail;
  }
}

export type LeadTier = "ME" | "A" | "B" | "B2" | "A?" | "C" | "D" | "pending";

export interface LeadNews {
  readonly t: string;
  readonly u: string;
}

/** 快照行字段白名单：与桥侧 FIELD_MAP 快照键一一对应，白名单外字段投影即丢弃。 */
export interface LeadRow {
  readonly id: string;
  readonly name: string;
  readonly legal: string;
  readonly crmName: string;
  readonly tierLabel: string;
  readonly tier: LeadTier;
  readonly crmState: string;
  readonly score: number | null;
  readonly priority: string;
  readonly province: string;
  readonly city: string;
  readonly track: string;
  readonly trackRaw: string;
  readonly summary: string;
  readonly signal: string;
  readonly round: string;
  readonly amount: string;
  readonly investors: string;
  readonly maas: string;
  readonly maasWhy: string;
  readonly maasProduct: string;
  readonly agent: string;
  readonly agentWhy: string;
  readonly risk: string;
  readonly aliRel: string;
  readonly sales: string;
  readonly team: string;
  readonly uids: number | null;
  readonly cid: string;
  readonly ecid: string;
  readonly mentions: number | null;
  readonly signalAt: string;
  readonly radarAt: string;
  readonly news: LeadNews | null;
  readonly sources: string;
  readonly founded: string;
  readonly regCap: string;
  readonly address: string;
  readonly founder: string;
  readonly website: string;
  readonly entStatus: string;
  readonly isPriority: boolean;
}

export interface LeadsSnapshot {
  readonly configured: boolean;
  readonly hasData: boolean;
  readonly configNote: string;
  readonly note: string;
  readonly fetchedAt: string;
  readonly tableName: string;
  readonly url: string;
  readonly radarAt: string;
  readonly radarCmd: string;
  readonly priorityProvinces: readonly string[];
  readonly total: number;
  readonly rows: readonly LeadRow[];
}

export interface LeadsRefreshSummary {
  readonly total: number;
  readonly open: number;
  readonly radarAt: string;
  readonly fetchedAt: string;
}

export interface LeadsRefreshResult {
  readonly summary: LeadsRefreshSummary;
  readonly snapshot: LeadsSnapshot;
}

const TIERS: ReadonlySet<string> = new Set<LeadTier>(["ME", "A", "B", "B2", "A?", "C", "D", "pending"]);

const TEXT_KEYS = [
  "id", "name", "legal", "crmName", "tierLabel", "crmState", "priority", "province", "city",
  "track", "trackRaw", "summary", "signal", "round", "amount", "investors", "maas", "maasWhy",
  "maasProduct", "agent", "agentWhy", "risk", "aliRel", "sales", "team", "cid", "ecid",
  "signalAt", "radarAt", "sources", "founded", "regCap", "address", "founder", "website", "entStatus",
] as const;

const NUM_KEYS = ["score", "uids", "mentions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNews(value: unknown): LeadNews | null {
  if (!isRecord(value)) return null;
  const t = asText(value.t);
  const u = asText(value.u);
  return /^https?:\/\//i.test(u) ? { t, u } : null;
}

function asTier(value: unknown): LeadTier {
  return typeof value === "string" && TIERS.has(value) ? (value as LeadTier) : "pending";
}

function asLeadRow(value: unknown): LeadRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = asText(value.id);
  const name = asText(value.name);
  if (!id || !name) return undefined;
  const row: Record<string, unknown> = {};
  for (const key of TEXT_KEYS) row[key] = asText(value[key]);
  for (const key of NUM_KEYS) row[key] = asNum(value[key]);
  return {
    ...(row as unknown as Omit<LeadRow, "tier" | "news" | "isPriority">),
    tier: asTier(value.tier),
    news: asNews(value.news),
    isPriority: value.isPriority === true,
  };
}

function asSnapshot(value: unknown): LeadsSnapshot | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean" || !Array.isArray(value.rows)) return undefined;
  const rows = value.rows.map(asLeadRow).filter((row): row is LeadRow => row !== undefined);
  return {
    configured: value.configured,
    hasData: value.hasData === true,
    configNote: asText(value.configNote),
    note: asText(value.note),
    fetchedAt: asText(value.fetchedAt),
    tableName: asText(value.tableName),
    url: asText(value.url),
    radarAt: asText(value.radarAt),
    radarCmd: asText(value.radarCmd),
    priorityProvinces: Array.isArray(value.priorityProvinces)
      ? value.priorityProvinces.filter((item): item is string => typeof item === "string")
      : [],
    total: typeof value.total === "number" ? value.total : rows.length,
    rows,
  };
}

function asSummary(value: unknown): LeadsRefreshSummary | undefined {
  if (!isRecord(value)) return undefined;
  return {
    total: typeof value.total === "number" ? value.total : 0,
    open: typeof value.open === "number" ? value.open : 0,
    radarAt: asText(value.radarAt),
    fetchedAt: asText(value.fetchedAt),
  };
}

function leadsUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(path: string, method: "GET" | "POST", fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(leadsUrl(path), {
      method,
      signal: AbortSignal.timeout(LEADS_TIMEOUT_MS),
    }));
  } catch {
    throw new LeadsClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new LeadsClientError(payload.error as LeadsClientErrorCode, asText(payload.message));
    }
    throw new LeadsClientError("unavailable");
  }
  return payload;
}

/** GET /local/leads —— 只读快照（未配置机器 configured:false 照常返回）。 */
export async function fetchLeadsSnapshot(fetchImpl: typeof fetch = fetch): Promise<LeadsSnapshot> {
  const payload = await requestJson("/local/leads", "GET", fetchImpl);
  const snapshot = asSnapshot(payload.data);
  if (!snapshot) throw new LeadsClientError("invalid_response");
  return snapshot;
}

/** POST /local/leads/refresh —— 显式触发拉取；护栏拒绝/未配置/dws 失败各自带稳定错误码。 */
export async function refreshLeads(fetchImpl: typeof fetch = fetch): Promise<LeadsRefreshResult> {
  const payload = await requestJson("/local/leads/refresh", "POST", fetchImpl);
  if (!isRecord(payload.data)) throw new LeadsClientError("invalid_response");
  const summary = asSummary(payload.data.summary);
  const snapshot = asSnapshot(payload.data.snapshot);
  if (!summary || !snapshot) throw new LeadsClientError("invalid_response");
  return { summary, snapshot };
}

/** 快照小时龄：供「过旧」灰字提示使用；fetchedAt 缺失/坏值返回 null（不猜）。 */
export function leadsAgeHours(fetchedAt: string, nowMs: number): number | null {
  const at = Date.parse(String(fetchedAt ?? ""));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 3_600_000));
}

export function leadsErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的拓新雷达数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    leads_unavailable: "拓新雷达暂时不可用：dws 缺失或拉取失败；确认 dws 已安装并 dws auth login 后重试。",
    leads_unconfigured: "未配置 .local-cache/leads.json（参考 config/leads.json.example），补 baseId/tableId/viewId 等五个键后再刷新。",
    leads_table_missing: "护栏拒绝：无法读回目标数据表，请核对 baseId/tableId。",
    leads_table_drift: "护栏拒绝：数据表名与配置不符（表名漂移），旧快照未被覆盖。",
    leads_field_drift: "护栏拒绝：必需字段缺失（schema 漂移），旧快照未被覆盖。",
    leads_pagination: "护栏拒绝：AI 表格分页未完整结束，拒绝覆盖快照。",
    leads_empty: "护栏拒绝：AI 表格意外为空，旧快照未被覆盖。",
    leads_shrink: "护栏拒绝：记录数较上次快照腰斩，拒绝覆盖旧快照。",
  };
  const code = error instanceof LeadsClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  const detail = error instanceof LeadsClientError && error.detail ? ` ${error.detail}` : "";
  return `${base}${detail}`;
}
