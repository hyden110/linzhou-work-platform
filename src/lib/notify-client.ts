/**
 * Browser client for the notify bell / inbox (F6) — GET /local/notify/{state,items}、
 * POST /local/notify/{read,test}。无 SSE、无轮询：打开面板时拉取 + 显式刷新；
 * 收件箱由本机桥唯一写入，客户端只做白名单投影；非 http(s) link 一律丢弃（防注入）。
 * kind 中文标签以静态库 scripts/lib/notify/index.js KIND_T 为准（含 reply=待回复）。
 */

const NOTIFY_TIMEOUT_MS = 15_000;

const SAFE_ERRORS = [
  "unavailable",
  "invalid_response",
  "rate_limited",
  "origin_not_allowed",
  "host_not_allowed",
  "method_not_allowed",
  "invalid_request",
  "notify_unavailable",
] as const;

export type NotifyClientErrorCode = (typeof SAFE_ERRORS)[number];

const SAFE_ERROR_SET: ReadonlySet<string> = new Set<string>(SAFE_ERRORS);

export class NotifyClientError extends Error {
  readonly code: NotifyClientErrorCode;
  readonly detail: string;

  constructor(code: NotifyClientErrorCode, detail = "") {
    super(code);
    this.name = "NotifyClientError";
    this.code = code;
    this.detail = detail;
  }
}

export const NOTIFY_KINDS = ["dingtalk", "lead", "cust", "reminder", "reply", "test"] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export const NOTIFY_KIND_LABELS: Readonly<Record<NotifyKind, string>> = {
  dingtalk: "钉钉",
  lead: "线索",
  cust: "客户",
  reminder: "提醒",
  reply: "待回复",
  test: "测试",
};

export interface NotifyItem {
  readonly id: string;
  readonly kind: NotifyKind;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly link: string;
  readonly createdAt: string;
  readonly readAt: string;
  readonly read: boolean;
}

export interface NotifyStateView {
  readonly savedAt: string;
  readonly unread: number;
  readonly total: number;
  readonly items: readonly NotifyItem[];
}

export interface NotifyReadResult {
  readonly marked: number;
  readonly unread: number;
}

export interface NotifyTestResult {
  readonly id: string;
  readonly added: boolean;
}

const KIND_SET: ReadonlySet<string> = new Set<string>(NOTIFY_KINDS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function asItem(value: unknown): NotifyItem | undefined {
  if (!isRecord(value) || !asText(value.id)) return undefined;
  const link = asText(value.link);
  return {
    id: asText(value.id),
    kind: KIND_SET.has(String(value.kind)) ? (value.kind as NotifyKind) : "test",
    title: asText(value.title),
    summary: asText(value.summary),
    source: asText(value.source),
    link: /^https?:\/\//i.test(link) ? link : "",
    createdAt: asText(value.createdAt),
    readAt: asText(value.readAt),
    read: value.read === true,
  };
}

function asView(value: unknown): NotifyStateView | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  return {
    savedAt: asText(value.savedAt),
    unread: typeof value.unread === "number" && Number.isFinite(value.unread) ? value.unread : 0,
    total: typeof value.total === "number" && Number.isFinite(value.total) ? value.total : value.items.length,
    items: value.items.map(asItem).filter((item): item is NotifyItem => item !== undefined),
  };
}

function notifyUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function requestJson(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(notifyUrl(path), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    }));
  } catch {
    throw new NotifyClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    if (isRecord(payload) && typeof payload.error === "string" && SAFE_ERROR_SET.has(payload.error)) {
      throw new NotifyClientError(payload.error as NotifyClientErrorCode, asText(payload.message));
    }
    throw new NotifyClientError("unavailable");
  }
  return payload;
}

/** GET /local/notify/state —— 最近 50 条 + 全量未读数（打开面板/显式刷新时调用）。 */
export async function fetchNotifyState(fetchImpl: typeof fetch = fetch): Promise<NotifyStateView> {
  const payload = await requestJson("/local/notify/state", "GET", undefined, fetchImpl);
  const view = asView(payload.data);
  if (!view) throw new NotifyClientError("invalid_response");
  return view;
}

/** GET /local/notify/items —— 全量收件箱（≤200），供明细页筛选。 */
export async function fetchNotifyItems(fetchImpl: typeof fetch = fetch): Promise<NotifyStateView> {
  const payload = await requestJson("/local/notify/items", "GET", undefined, fetchImpl);
  const view = asView(payload.data);
  if (!view) throw new NotifyClientError("invalid_response");
  return view;
}

/** POST /local/notify/read —— 只动 read 位（ids / all / read:false 还原未读）。 */
export async function markNotifyRead(
  input: { readonly ids?: readonly string[]; readonly all?: boolean; readonly read?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyReadResult> {
  const body: Record<string, unknown> = {};
  if (input.ids !== undefined) body.ids = [...input.ids];
  if (input.all !== undefined) body.all = input.all === true;
  if (input.read !== undefined) body.read = input.read !== false;
  const payload = await requestJson("/local/notify/read", "POST", body, fetchImpl);
  const data = payload.data;
  if (!isRecord(data) || typeof data.marked !== "number") throw new NotifyClientError("invalid_response");
  return {
    marked: data.marked,
    unread: typeof data.unread === "number" ? data.unread : 0,
  };
}

/** POST /local/notify/test —— P0 唯一生产者：显式「测试」消息（不含真实数据）。 */
export async function sendNotifyTest(fetchImpl: typeof fetch = fetch): Promise<NotifyTestResult> {
  const payload = await requestJson("/local/notify/test", "POST", {}, fetchImpl);
  const data = payload.data;
  if (!isRecord(data) || !asText(data.id)) throw new NotifyClientError("invalid_response");
  return { id: asText(data.id), added: data.added === true };
}

/** 未读徽标：0 隐藏、1–99 原数、>99 封顶「99+」。 */
export function notifyUnreadBadge(unread: number): string {
  if (!Number.isFinite(unread) || unread <= 0) return "";
  return unread > 99 ? "99+" : String(unread);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 更早落 YYYY-MM-DD；坏值空串（不猜）。 */
export function notifyRelativeTime(createdAt: string, nowMs: number): string {
  const at = Date.parse(String(createdAt ?? ""));
  if (!Number.isFinite(at)) return "";
  const delta = Math.max(0, nowMs - at);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  const shifted = new Date(at + 8 * 3_600_000);
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${shifted.getUTCDate()}`.padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

export function notifyErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。",
    invalid_response: "本机服务返回了无法识别的消息中心数据。",
    rate_limited: "请求过于频繁，请稍后再试。",
    origin_not_allowed: "当前页面来源未获本机服务授权。",
    host_not_allowed: "本机服务拒绝了该请求来源。",
    method_not_allowed: "请求方式不被本机服务接受。",
    invalid_request: "已读请求参数不合法：需要消息 id 列表或 all。",
    notify_unavailable: "消息中心暂时不可用：收件箱读取失败，请稍后重试。",
  };
  const code = error instanceof NotifyClientError ? error.code : "unavailable";
  const base = messages[code] ?? "本地桥未启动，请确认已在本机运行 npm run dev:function 后重试。";
  const detail = error instanceof NotifyClientError && error.detail ? ` ${error.detail}` : "";
  return `${base}${detail}`;
}
