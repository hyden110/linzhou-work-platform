/**
 * SSE 事件流端点（实时事件总线 T2）— donor: scripts/bridge.js GET /events +
 * scripts/lib/live/bus.js sse()。GET /local/events → text/event-stream。
 *
 * 协议：
 * - 首帧 `event: hello`（data: {ok, at, topics}）；
 * - 事件帧 `id: <busId>\nevent: <topic>\ndata: <payload json>\n\n`（id 供 EventSource 续传）；
 * - 空闲心跳每 25s 一行 `: ping` 注释帧防代理断流（调度器可注入以便测试）；
 * - `?topics=a,b` 白名单校验（LIVE_TOPICS），非法 400；缺省订阅全部白名单；
 * - `?since=<id>` 重放环形缓冲中 id 之后的事件（按 topics 过滤）；
 * - 客户端断开（stream cancel）清理订阅与心跳定时器。
 * 安全：仅回环 hostname（127.0.0.1 / localhost / [::1] / ::1），否则 403；
 * EventSource 带不了自定义头，回环校验就是本端点的门禁（与 donor 一致）。
 */

import type { Bus, BusEvent } from "./bus.ts";

export const LIVE_TOPICS = [
  "snapshot:crm",
  "snapshot:ops",
  "snapshot:inbox",
  "snapshot:yunqi",
  "bus:hello",
] as const;

export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** 路由表常量：负责人在 dev/local-router.ts 接线时引用（本模块不改 router）。 */
export const LIVE_EVENTS_PATH = "/local/events";
export const LIVE_ROUTES = [{ method: "GET", path: LIVE_EVENTS_PATH }] as const;

export const LIVE_PING_MS = 25_000;
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const LIVE_TOPIC_SET: ReadonlySet<string> = new Set(LIVE_TOPICS);
const ERROR_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export interface LiveSchedulerHandle {
  clear(): void;
  unref?(): void;
}

/** 心跳调度器注入点：默认 setInterval；测试注入假调度器验证 25s 与清理。 */
export type LiveScheduler = (callback: () => void, intervalMs: number) => LiveSchedulerHandle;

export interface HandleEventsOptions {
  readonly pingMs?: number;
  readonly scheduler?: LiveScheduler;
  readonly now?: () => number;
}

function jsonResponse(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...ERROR_HEADERS, ...headers } });
}

function defaultScheduler(callback: () => void, intervalMs: number): LiveSchedulerHandle {
  const timer = setInterval(callback, intervalMs);
  return {
    clear: () => clearInterval(timer),
    unref: () => timer.unref?.(),
  };
}

function parseTopics(raw: string | null): readonly string[] | undefined {
  if (raw === null) return [...LIVE_TOPICS];
  const topics = raw.split(",");
  if (topics.length === 0 || topics.some((topic) => !LIVE_TOPIC_SET.has(topic))) return undefined;
  return [...new Set(topics)];
}

function parseSince(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function formatEvent(event: BusEvent): string {
  return `id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload ?? null)}\n\n`;
}

export function handleEvents(request: Request, bus: Bus, options: HandleEventsOptions = {}): Response {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET" });
  }
  const url = new URL(request.url);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return jsonResponse({ ok: false, error: "host_not_allowed" }, 403);
  }
  const topics = parseTopics(url.searchParams.get("topics"));
  if (topics === undefined) {
    return jsonResponse({ ok: false, error: "invalid_topic" }, 400);
  }
  const sinceRaw = url.searchParams.get("since");
  const since = parseSince(sinceRaw);
  if (sinceRaw !== null && since === undefined) {
    return jsonResponse({ ok: false, error: "invalid_since" }, 400);
  }

  const now = options.now ?? Date.now;
  const pingMs = options.pingMs ?? LIVE_PING_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const encoder = new TextEncoder();
  // start() 在 ReadableStream 构造时同步执行，detach 必须先声明再建流。
  let detach: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 流已被消费端关闭：标记后统一走 cleanup，绝不向已关闭流写入。
          closed = true;
          cleanup();
        }
      };
      const unsubscribes: Array<() => void> = [];
      let pingHandle: LiveSchedulerHandle | undefined;
      let cleaned = false;
      function cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        pingHandle?.clear();
        for (const unsubscribe of unsubscribes) unsubscribe();
        unsubscribes.length = 0;
      }

      write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date(now()).toISOString(), topics })}\n\n`);
      if (since !== undefined) {
        const wanted: ReadonlySet<string> = new Set(topics);
        for (const event of bus.replay(since)) {
          if (wanted.has(event.topic)) write(formatEvent(event));
        }
      }
      for (const topic of topics) {
        unsubscribes.push(bus.subscribe(topic, (event) => write(formatEvent(event))));
      }
      pingHandle = scheduler(() => write(": ping\n\n"), pingMs);
      pingHandle.unref?.();
      detach = cleanup;
    },
    cancel() {
      detach?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
