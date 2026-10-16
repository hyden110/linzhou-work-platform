const SAFE_ERRORS = new Set([
  "metrics_unavailable",
  "not_configured",
  "busy",
  "invalid_request",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
]);

export class FbiMetricsClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FbiMetricsClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

/** Cockpit projection of .local-cache/fbi-metrics.json; numbers may be null per day. */
export interface FbiMetrics {
  readonly state: "running" | "done" | "failed";
  readonly generatedAt: string;
  readonly date: string | null;
  readonly dailyGaap: number | null;
  readonly validCustomers: number | null;
  readonly callVolume: number | null;
  readonly moMRate: number | null;
  readonly error: string | null;
}

function isFbiMetrics(value: unknown): value is FbiMetrics {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!["running", "done", "failed"].includes(String(value.state))) return false;
  if (value.date !== null && (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date))) return false;
  if (value.generatedAt !== undefined && typeof value.generatedAt !== "string") return false;
  if (value.error !== null && value.error !== undefined && typeof value.error !== "string") return false;
  return ["dailyGaap", "validCustomers", "callVolume", "moMRate"].every(
    (key) => value[key] === null || value[key] === undefined || typeof value[key] === "number",
  );
}

async function parseResponse(response: Response): Promise<Record<string, unknown> | undefined> {
  const payload: unknown = await response.json().catch(() => undefined);
  return isRecord(payload) ? payload : undefined;
}

/**
 * GET /local/fbi/metrics. Returns null when there is no artifact yet
 * (404 metrics_unavailable) — the cockpit then offers an explicit fetch button.
 * The POST variant can wait on the FBI create step, so it gets a longer timeout.
 */
export async function fetchFbiMetrics(fetchImpl: typeof fetch = fetch): Promise<FbiMetrics | null> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/fbi/metrics"), { method: "GET", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new FbiMetricsClientError("unavailable");
  }
  const payload = await parseResponse(response);
  if (response.status === 404 && payload?.error === "metrics_unavailable") return null;
  if (!response.ok || payload?.ok !== true) {
    const code = typeof payload?.error === "string" && SAFE_ERRORS.has(payload.error) ? payload.error : "unavailable";
    throw new FbiMetricsClientError(code);
  }
  if (!isFbiMetrics(payload.data)) throw new FbiMetricsClientError("invalid_response");
  return payload.data;
}

export async function startFbiMetrics(fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl("/local/fbi/metrics"), {
      method: "POST",
      signal: AbortSignal.timeout(150_000),
    });
  } catch {
    throw new FbiMetricsClientError("unavailable");
  }
  const payload = await parseResponse(response);
  if (!response.ok || payload?.ok !== true) {
    const code = typeof payload?.error === "string" && SAFE_ERRORS.has(payload.error) ? payload.error : "unavailable";
    throw new FbiMetricsClientError(code);
  }
}

export function fbiMetricsErrorMessage(error: unknown): string {
  const code = error instanceof FbiMetricsClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    not_configured: "FBI 报表未配置，请在 .env.local 设置 FBI_REPORT_RESOURCE_ID 后重启本机服务。",
    busy: "FBI 指标正在拉取，请稍候。",
    rate_limited: "请求过于频繁，请稍后再试。",
    invalid_response: "本机服务返回了无法识别的数据。",
  };
  return messages[code] ?? "FBI 指标拉取未完成，请稍后重试。";
}
