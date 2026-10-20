import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveClient,
  LIVE_RETRY_BASE_MS,
  LIVE_RETRY_MAX_MS,
  type LiveClientEvent,
  type LiveStatus,
} from "./live-client.ts";

// ---------------------------------------------------------------------------
// live-client 单测：注入假 EventSource / 假定时器 / 假 visibility，
// 验证订阅、指数退避（1s 起、上限 30s）、since 续传、hidden 暂停恢复、close 终止。
// 合成数据：payload 只用「合成」固定值。
// ---------------------------------------------------------------------------

interface FakeMessage {
  data?: string;
  lastEventId?: string;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: FakeMessage) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeMessage) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...list, listener]);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(type: string, message: FakeMessage = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }
}

interface ScheduledTimer {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

function makeTimers(): {
  scheduled: ScheduledTimer[];
  setTimeoutImpl: (callback: () => void, ms: number) => ScheduledTimer;
  clearTimeoutImpl: (handle: unknown) => void;
} {
  const scheduled: ScheduledTimer[] = [];
  return {
    scheduled,
    setTimeoutImpl: (callback, ms) => {
      const handle = { callback, ms, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      (handle as ScheduledTimer).cancelled = true;
    },
  };
}

class FakeVisibility {
  hidden = false;
  private listeners: Array<() => void> = [];

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners = [...this.listeners, listener];
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners = this.listeners.filter((item) => item !== listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

interface Harness {
  statuses: LiveStatus[];
  events: LiveClientEvent[];
  timers: ReturnType<typeof makeTimers>;
  visibility: FakeVisibility;
  close: () => void;
}

function makeHarness(topics: readonly string[] = ["snapshot:crm"]): Harness {
  FakeEventSource.instances = [];
  const statuses: LiveStatus[] = [];
  const events: LiveClientEvent[] = [];
  const timers = makeTimers();
  const visibility = new FakeVisibility();
  const client = createLiveClient({
    topics,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    eventSourceFactory: (url) => new FakeEventSource(url),
    visibility,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  return { statuses, events, timers, visibility, close: () => client.close() };
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert.ok(source, "应已创建 EventSource");
  return source;
}

test("建连 URL 带 topics；open → status open；事件带 topic/id/data", () => {
  const harness = makeHarness(["snapshot:crm", "snapshot:ops"]);
  assert.equal(FakeEventSource.instances.length, 1);
  const source = lastSource();
  assert.equal(source.url, "/local/events?topics=snapshot%3Acrm%2Csnapshot%3Aops");

  source.dispatch("open");
  assert.deepEqual(harness.statuses, ["open"]);

  source.dispatch("snapshot:crm", { data: '{"name":"crm","tag":"合成"}', lastEventId: "7" });
  assert.deepEqual(harness.events, [
    { topic: "snapshot:crm", id: 7, data: { name: "crm", tag: "合成" } },
  ]);

  // hello 帧也转交 onEvent；data 非法 JSON 时按原样字符串下发（不吞、不造）
  source.dispatch("hello", { data: '{"ok":true}' });
  source.dispatch("snapshot:ops", { data: "not-json" });
  assert.equal(harness.events[1]!.topic, "hello");
  assert.deepEqual(harness.events[2]!, { topic: "snapshot:ops", id: null, data: "not-json" });
  harness.close();
});

test("topics 非法（空数组 / 空串）立即抛错，不建连", () => {
  assert.throws(() => makeHarness([]), /topics/);
  assert.throws(
    () => makeHarness(["snapshot:crm", ""]),
    /topics/,
  );
});

test("onerror → status reconnecting；指数退避 1s 起、翻倍、上限 30s", () => {
  const harness = makeHarness();
  assert.equal(LIVE_RETRY_BASE_MS, 1_000);
  assert.equal(LIVE_RETRY_MAX_MS, 30_000);

  const delays: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    lastSource().dispatch("error");
    const timer = harness.timers.scheduled[round]!;
    delays.push(timer.ms);
    timer.callback(); // 触发重连
  }
  assert.deepEqual(delays.slice(0, 4), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(delays[6], LIVE_RETRY_MAX_MS, "退避应封顶 30s");
  assert.deepEqual(harness.statuses.slice(0, 2), ["reconnecting", "reconnecting"]);

  // 重连成功后 open 将退避计数复位
  lastSource().dispatch("open");
  lastSource().dispatch("error");
  assert.equal(harness.timers.scheduled[7]!.ms, 1_000);
  harness.close();
});

test("断线重连 URL 携带 since=<lastEventId> 续传", () => {
  const harness = makeHarness();
  lastSource().dispatch("open");
  lastSource().dispatch("snapshot:crm", { data: '{"n":1}', lastEventId: "42" });
  lastSource().dispatch("error");
  harness.timers.scheduled[0]!.callback();
  assert.match(lastSource().url, /since=42/);
  harness.close();
});

test("document.hidden → 暂停断流（status closed）；恢复可见 → 立即重连", () => {
  const harness = makeHarness();
  const first = lastSource();
  first.dispatch("open");

  harness.visibility.setHidden(true);
  assert.equal(first.closed, true, "hidden 时应断开 SSE，避免占满浏览器连接");
  assert.equal(harness.statuses[harness.statuses.length - 1], "closed");

  harness.visibility.setHidden(false);
  assert.equal(FakeEventSource.instances.length, 2, "恢复可见应立即重连");
  lastSource().dispatch("open");
  assert.equal(harness.statuses[harness.statuses.length - 1], "open");
  harness.close();
});

test("close() 永久终止：清定时器、断流、error 不再重连", () => {
  const harness = makeHarness();
  const source = lastSource();
  source.dispatch("error"); // 已排定一次重连
  harness.close();
  assert.equal(source.closed, true);
  assert.equal(harness.timers.scheduled[0]!.cancelled, true);
  assert.equal(harness.statuses[harness.statuses.length - 1], "closed");

  const count = FakeEventSource.instances.length;
  harness.timers.scheduled[0]!.callback(); // 即便回调漏网也不得建连
  assert.equal(FakeEventSource.instances.length, count);
});
