/**
 * 进程内事件总线（实时事件总线 T1）— donor: scripts/lib/live/bus.js（emit/subscribe/环形缓冲）。
 *
 * 职责：桥内单一 bus。producers（dev/live/producers.ts）经 emit() 写入，
 * GET /local/events 的 SSE 订阅者（dev/live/live-bridge.ts）经 subscribe() 扇出。
 * 语义：
 * - emit(topic, payload) → 冻结事件（自增 id + ISO at），扇出给该 topic 的监听者，
 *   并写入环形缓冲（默认最近 50 条）供 ?since=<id> 重放；
 * - subscribe(topic, listener) → 返回幂等 unsubscribe；
 * - 监听者抛错不影响其他监听者（逐个隔离），错误走 console.error 分层记录。
 * 红线：不可变（事件与 payload 深冻结）；无 IO、无子进程、无定时器。
 */

export interface BusEvent {
  readonly id: number;
  readonly topic: string;
  readonly at: string;
  readonly payload: unknown;
}

export interface Bus {
  emit(topic: string, payload?: unknown): BusEvent;
  subscribe(topic: string, listener: (event: BusEvent) => void): () => void;
  /** 缓冲中 id 大于 since 的事件（升序）；since 缺省返回整个缓冲。 */
  replay(since?: number): readonly BusEvent[];
  /** 环形缓冲只读快照（最近 bufferLimit 条）。 */
  buffer(): readonly BusEvent[];
  /** 当前监听者总数；传 topic 时只数该 topic（测试与 /health 观测用）。 */
  subscriberCount(topic?: string): number;
  /** 已铸出的最大事件 id；尚无事件时为 0。 */
  lastId(): number;
}

export const BUS_BUFFER_LIMIT = 50;

export interface BusOptions {
  readonly bufferLimit?: number;
  readonly now?: () => number;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Object.isFrozen(record)) {
    Object.freeze(record);
    for (const key of Object.keys(record)) deepFreeze(record[key]);
  }
  return value;
}

export function createBus(options: BusOptions = {}): Bus {
  const bufferLimit = options.bufferLimit ?? BUS_BUFFER_LIMIT;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
    throw new TypeError("bus: bufferLimit 必须为正整数");
  }

  let nextId = 1;
  let ring: readonly BusEvent[] = [];
  const listeners = new Map<string, ReadonlySet<(event: BusEvent) => void>>();

  function emit(topic: string, payload?: unknown): BusEvent {
    if (typeof topic !== "string" || !topic) {
      throw new TypeError("bus: topic 必须为非空字符串");
    }
    const event: BusEvent = Object.freeze({
      id: nextId,
      topic,
      at: new Date(now()).toISOString(),
      payload: deepFreeze(payload ?? null),
    });
    nextId += 1;
    ring = ring.length >= bufferLimit ? [...ring.slice(ring.length - bufferLimit + 1), event] : [...ring, event];
    for (const listener of listeners.get(topic) ?? []) {
      try {
        listener(event);
      } catch (error) {
        // 单个监听者失败不断流：SSE 端由 live-bridge 负责断连清理，这里只记录。
        console.error(JSON.stringify({ event: "bus_listener_failed", topic, message: error instanceof Error ? error.message : String(error) }));
      }
    }
    return event;
  }

  function subscribe(topic: string, listener: (event: BusEvent) => void): () => void {
    if (typeof topic !== "string" || !topic) {
      throw new TypeError("bus: topic 必须为非空字符串");
    }
    if (typeof listener !== "function") {
      throw new TypeError("bus: listener 必须为函数");
    }
    listeners.set(topic, new Set([...(listeners.get(topic) ?? []), listener]));
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = listeners.get(topic);
      if (!current) return;
      const next = new Set(current);
      next.delete(listener);
      if (next.size === 0) listeners.delete(topic);
      else listeners.set(topic, next);
    };
  }

  function replay(since?: number): readonly BusEvent[] {
    if (since === undefined) return ring;
    return ring.filter((event) => event.id > since);
  }

  function subscriberCount(topic?: string): number {
    if (topic !== undefined) return listeners.get(topic)?.size ?? 0;
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  }

  return {
    emit,
    subscribe,
    replay,
    buffer: () => ring,
    subscriberCount,
    lastId: () => nextId - 1,
  };
}
