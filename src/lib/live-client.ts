/**
 * Browser client for the live event bus (SSE) — GET /local/events。
 * donor: assets/components/live.js（EventSource 单例 + 离页断流）。
 *
 * 行为：
 * - 建连 `/local/events?topics=<csv>`，逐 topic 监听；断线指数退避重连（1s 起、上限 30s），
 *   重连 URL 带 `since=<lastEventId>` 续传（桥侧环形缓冲重放）；
 * - document.hidden 暂停断流（避免 bfcache/后台页占满浏览器对桥的 6 条 HTTP/1.1 连接），
 *   恢复可见立即重连并复位退避；
 * - status 回调：open / reconnecting / closed；close() 永久终止。
 * 诚实原则：data 非法 JSON 时按原始字符串下发（不吞、不造）；外部输入一律先验证。
 */

export type LiveStatus = "open" | "reconnecting" | "closed";

export interface LiveClientEvent {
  readonly topic: string;
  readonly id: number | null;
  readonly data: unknown;
}

export interface LiveMessageEvent {
  readonly data?: unknown;
  readonly lastEventId?: string;
}

/** EventSource 的最小结构子集（浏览器 EventSource 可直接满足；测试注入假实现）。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: LiveMessageEvent) => void): void;
  close(): void;
}

/** document 的最小结构子集（测试注入假 visibility）。 */
export interface LiveVisibilityLike {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export const LIVE_EVENTS_URL = "/local/events";
export const LIVE_RETRY_BASE_MS = 1_000;
export const LIVE_RETRY_MAX_MS = 30_000;
/** hello 是 SSE 首帧事件名，恒定转发给 onEvent。 */
const HELLO_EVENT = "hello";

export interface LiveClientOptions {
  readonly topics: readonly string[];
  readonly onEvent: (event: LiveClientEvent) => void;
  readonly onStatus?: (status: LiveStatus) => void;
  readonly baseUrl?: string;
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  readonly visibility?: LiveVisibilityLike;
  readonly setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeoutImpl?: (handle: unknown) => void;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface LiveClient {
  close(): void;
  getStatus(): LiveStatus;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as EventSourceLike;
}

function defaultVisibility(): LiveVisibilityLike | undefined {
  return typeof document === "undefined" ? undefined : (document as LiveVisibilityLike);
}

function parseEventId(lastEventId: string | undefined): number | null {
  if (typeof lastEventId !== "string" || !/^\d+$/.test(lastEventId)) return null;
  return Number(lastEventId);
}

function parseData(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // 非法 JSON：如实按字符串下发
  }
}

export function createLiveClient(options: LiveClientOptions): LiveClient {
  const topics = options.topics;
  if (!Array.isArray(topics) || topics.length === 0 || topics.some((topic) => typeof topic !== "string" || !topic)) {
    throw new TypeError("live-client: topics 必须为非空字符串数组");
  }
  if (typeof options.onEvent !== "function") {
    throw new TypeError("live-client: onEvent 必须为函数");
  }

  const baseUrl = options.baseUrl ?? LIVE_EVENTS_URL;
  const factory = options.eventSourceFactory ?? defaultFactory;
  const visibility = options.visibility ?? defaultVisibility();
  const setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const retryBaseMs = options.retryBaseMs ?? LIVE_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? LIVE_RETRY_MAX_MS;

  let status: LiveStatus = "closed";
  let userClosed = false;
  let paused = false;
  let attempts = 0;
  let generation = 0;
  let source: EventSourceLike | undefined;
  let retryTimer: unknown;
  let lastEventId: number | null = null;

  function setStatus(next: LiveStatus): void {
    status = next;
    options.onStatus?.(next);
  }

  function buildUrl(): string {
    const query = `topics=${encodeURIComponent(topics.join(","))}`;
    return lastEventId === null ? `${baseUrl}?${query}` : `${baseUrl}?${query}&since=${lastEventId}`;
  }

  function clearRetryTimer(): void {
    if (retryTimer !== undefined) {
      clearTimeoutImpl(retryTimer);
      retryTimer = undefined;
    }
  }

  function closeSource(): void {
    source?.close();
    source = undefined;
  }

  function scheduleRetry(): void {
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempts);
    attempts += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = undefined;
      if (!userClosed && !paused) connect();
    }, delay);
  }

  function handleMessage(topic: string, message: LiveMessageEvent): void {
    const id = parseEventId(message.lastEventId);
    if (id !== null) lastEventId = id;
    options.onEvent({ topic, id, data: parseData(message.data) });
  }

  function connect(): void {
    if (userClosed || paused) return;
    generation += 1;
    const current = generation;
    clearRetryTimer();
    closeSource();
    let created: EventSourceLike;
    try {
      created = factory(buildUrl());
    } catch {
      // 工厂失败等同断线：走同一退避通道，不吞错也不炸页面。
      if (current !== generation || userClosed) return;
      setStatus("reconnecting");
      scheduleRetry();
      return;
    }
    source = created;
    const stale = (): boolean => current !== generation || userClosed;

    created.addEventListener("open", () => {
      if (stale()) return;
      attempts = 0;
      setStatus("open");
    });
    created.addEventListener("error", () => {
      if (stale()) return;
      closeSource();
      setStatus("reconnecting");
      scheduleRetry();
    });
    for (const topic of [...topics, HELLO_EVENT]) {
      created.addEventListener(topic, (message) => {
        if (stale()) return;
        handleMessage(topic, message);
      });
    }
  }

  function onVisibilityChange(): void {
    if (userClosed || !visibility) return;
    if (visibility.hidden) {
      paused = true;
      clearRetryTimer();
      closeSource();
      setStatus("closed");
    } else if (paused) {
      paused = false;
      attempts = 0;
      connect();
    }
  }

  visibility?.addEventListener("visibilitychange", onVisibilityChange);
  connect();

  return {
    close(): void {
      if (userClosed) return;
      userClosed = true;
      clearRetryTimer();
      closeSource();
      visibility?.removeEventListener("visibilitychange", onVisibilityChange);
      setStatus("closed");
    },
    getStatus: () => status,
  };
}
