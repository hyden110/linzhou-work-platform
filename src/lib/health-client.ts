/**
 * Browser client for the environment health snapshot (F4) — GET /local/health.
 *
 * Degrade contract mirrors cases-client: an offline bridge (npm run dev:function
 * not running) maps to HealthClientError("unavailable") so the panel shows
 * 「本地桥未启动」 instead of a white screen. The snapshot itself is a read-only
 * inventory; rows are projected onto a whitelist so no unknown field (and no
 * credential-shaped field) can reach the browser.
 */

const HEALTH_TIMEOUT_MS = 60_000; /* 桥侧 CLI 探测上限 15s/项（并行）+ 桥聚合余量 */

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "health_unavailable",
  "health_invalid_request",
  "health_invalid_group",
  "health_busy",
] as const;

export type HealthClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class HealthClientError extends Error {
  readonly code: HealthClientErrorCode;

  constructor(code: HealthClientErrorCode) {
    super(code);
    this.name = "HealthClientError";
    this.code = code;
  }
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly fetchedAt: string;
  readonly bridges: readonly HealthBridgeRow[];
  readonly cli: readonly HealthCliRow[];
  readonly caps: readonly HealthCapRow[];
}

export interface HealthBridgeRow {
  readonly name: string;
  readonly state: "ok" | "unconfigured" | "error";
  readonly detail: string;
}

export interface HealthCliRow {
  readonly name: string;
  readonly state: "ok" | "error" | "missing" | "unknown";
  readonly version: string;
  readonly note: string;
}

export interface HealthCapRow {
  readonly name: string;
  readonly state: "ok" | "unconfigured" | "error";
  readonly set: boolean;
  readonly note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function healthUrl(): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL("/local/health", origin);
}

const ROW_STATES = new Set(["ok", "unconfigured", "error"]);
const CLI_STATES = new Set(["ok", "error", "missing", "unknown"]);

function asBridgeRow(value: unknown): HealthBridgeRow | undefined {
  if (!isRecord(value) || typeof value.state !== "string" || !ROW_STATES.has(value.state)) return undefined;
  return {
    name: typeof value.name === "string" ? value.name : "",
    state: value.state as HealthBridgeRow["state"],
    detail: typeof value.detail === "string" ? value.detail : "",
  };
}

function asCliRow(value: unknown): HealthCliRow | undefined {
  if (!isRecord(value) || typeof value.state !== "string" || !CLI_STATES.has(value.state)) return undefined;
  return {
    name: typeof value.name === "string" ? value.name : "",
    state: value.state as HealthCliRow["state"],
    version: typeof value.version === "string" ? value.version : "",
    note: typeof value.note === "string" ? value.note : "",
  };
}

function asCapRow(value: unknown): HealthCapRow | undefined {
  if (!isRecord(value) || typeof value.state !== "string" || !ROW_STATES.has(value.state) || typeof value.set !== "boolean") {
    return undefined;
  }
  return {
    name: typeof value.name === "string" ? value.name : "",
    state: value.state as HealthCapRow["state"],
    set: value.set,
    note: typeof value.note === "string" ? value.note : "",
  };
}

/** 全有全无：任何一行无法投影 → 整包拒绝（invalid_response），绝不半真半假。 */
function asRows<T>(value: unknown, map: (row: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: T[] = [];
  for (const item of value) {
    const row = map(item);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/** 白名单投影：上行多带的任何字段（含凭据样式字段）物理不可达结果对象。 */
function asSnapshot(value: unknown): HealthSnapshot | undefined {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.bridges) || !Array.isArray(value.cli) || !Array.isArray(value.caps)) {
    return undefined;
  }
  const bridges = asRows(value.bridges, asBridgeRow);
  const cli = asRows(value.cli, asCliRow);
  const caps = asRows(value.caps, asCapRow);
  if (!bridges || !cli || !caps) return undefined;
  return {
    ok: value.ok,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
    bridges,
    cli,
    caps,
  };
}

/** GET /local/health —— 只读体检快照（由用户在体检面板手动触发，不轮询）。 */
export async function fetchHealthSnapshot(fetchImpl: typeof fetch = fetch): Promise<HealthSnapshot> {
  let response: Response;
  try {
    response = await fetchImpl(healthUrl(), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    throw new HealthClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    throw new HealthClientError(safeErrorCode(payload));
  }
  const snapshot = asSnapshot(payload.data);
  if (!snapshot) throw new HealthClientError("invalid_response");
  return snapshot;
}

/** 错误信封兼容两种形状：{error:"code"}（GET 既有接线）与 {error:{code}}（check/renew 子路由）。 */
function safeErrorCode(payload: unknown): HealthClientErrorCode {
  if (isRecord(payload)) {
    const error = payload.error;
    const code = typeof error === "string" ? error : isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (SAFE_ERROR_SET.has(code)) return code as HealthClientErrorCode;
  }
  return "unavailable";
}

/* ---------------- 现场重检（POST /local/health/check）与续期（POST /local/health/renew） ---------------- */

export type HealthGroupName = "bridges" | "cli" | "caps";

export interface HealthCheckSnapshot extends HealthSnapshot {
  /** 各组最近一次现场重检时间（ISO）；沿用上轮的组保持原时间戳。 */
  readonly groupCheckedAt: Readonly<Record<HealthGroupName, string>>;
}

export interface HealthRenewRow {
  readonly key: string;
  readonly state: "ok" | "expired" | "missing" | "error";
  readonly expiresAt: string;
  readonly note: string;
}

export interface HealthRenewResult {
  readonly renewedAt: string;
  readonly results: readonly HealthRenewRow[];
}

const RENEW_ROW_STATES = new Set(["ok", "expired", "missing", "error"]);

function postUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function postLocal(path: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(postUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch {
    throw new HealthClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    throw new HealthClientError(safeErrorCode(payload));
  }
  return payload.data;
}

function asCheckedAt(value: unknown): Readonly<Record<HealthGroupName, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const out = {} as Record<HealthGroupName, string>;
  for (const group of ["bridges", "cli", "caps"] as const) {
    if (typeof value[group] !== "string") return undefined;
    out[group] = value[group];
  }
  return out;
}

/** POST /local/health/check —— 只重跑该组，其余组沿用上轮持久化快照。 */
export async function checkHealthGroup(group: HealthGroupName, fetchImpl: typeof fetch = fetch): Promise<HealthCheckSnapshot> {
  const data = await postLocal("/local/health/check", { group }, fetchImpl);
  const snapshot = asSnapshot(data);
  const groupCheckedAt = isRecord(data) ? asCheckedAt(data.groupCheckedAt) : undefined;
  if (!snapshot || !groupCheckedAt) throw new HealthClientError("invalid_response");
  return { ...snapshot, groupCheckedAt };
}

/** POST /local/health/renew —— 重跑 CLI 登录态子命令；凭据/身份值绝不入结果。 */
export async function renewHealth(keys?: readonly string[], fetchImpl: typeof fetch = fetch): Promise<HealthRenewResult> {
  const data = await postLocal("/local/health/renew", keys === undefined ? {} : { keys: [...keys] }, fetchImpl);
  if (!isRecord(data) || typeof data.renewedAt !== "string" || !Array.isArray(data.results)) {
    throw new HealthClientError("invalid_response");
  }
  const results: HealthRenewRow[] = [];
  for (const item of data.results) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.state !== "string" || !RENEW_ROW_STATES.has(item.state)) {
      throw new HealthClientError("invalid_response");
    }
    results.push({
      key: item.key,
      state: item.state as HealthRenewRow["state"],
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : "",
      note: typeof item.note === "string" ? item.note : "",
    });
  }
  return { renewedAt: data.renewedAt, results };
}

export function healthErrorMessage(error: unknown): string {
  const code = error instanceof HealthClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的体检数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    health_unavailable: "环境体检暂时不可用，请稍后重试；单项缺口会在恢复后如实显示。",
    health_invalid_request: "体检请求参数不完整，请重试。",
    health_invalid_group: "未知的体检组，请刷新页面后重试。",
    health_busy: "已有一轮现场重检正在进行中，请等待其完成。",
  };
  return messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
}
