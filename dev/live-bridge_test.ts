import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUS_BUFFER_LIMIT,
  createBus,
  createProducers,
  handleEvents,
  LIVE_PING_MS,
  LIVE_ROUTES,
  LIVE_TOPICS,
  PRODUCER_SOURCES,
  type Bus,
  type BusEvent,
} from "./live-bridge.ts";

// ---------------------------------------------------------------------------
// 合成数据约定：payload 只用「合成」字样的固定值，绝不含真实客户数据；
// producers 测试一律落在临时目录（.local-cache 零接触）；不 spawn 任何子进程。
// SSE 请求用 new Request("http://127.0.0.1:8000/local/events") 构造（回环）。
// ---------------------------------------------------------------------------

const LOOPBACK_URL = "http://127.0.0.1:8000/local/events";

function eventsRequest(query = "", method = "GET"): Request {
  return new Request(query ? `${LOOPBACK_URL}?${query}` : LOOPBACK_URL, { method });
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  assert.equal(done, false, "SSE 流不应提前结束");
  return new TextDecoder().decode(value);
}

function frameData(frame: string): Record<string, unknown> {
  const match = /^data: (.*)$/m.exec(frame);
  assert.ok(match, `帧缺少 data 行：${JSON.stringify(frame)}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

async function withCacheDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "live-producers-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// bus：扇出 / 退订 / 环形缓冲 / since 重放 / 事件冻结
// ---------------------------------------------------------------------------

test("bus：emit 按 topic 扇出，事件对象与 payload 冻结", () => {
  const bus = createBus();
  const crm: BusEvent[] = [];
  const ops: BusEvent[] = [];
  bus.subscribe("snapshot:crm", (event) => crm.push(event));
  bus.subscribe("snapshot:ops", (event) => ops.push(event));

  const payload = { name: "crm", tag: "合成" };
  const emitted = bus.emit("snapshot:crm", payload);

  assert.equal(crm.length, 1);
  assert.equal(ops.length, 0, "不同 topic 不应收到");
  assert.equal(emitted.id, 1);
  assert.equal(emitted.topic, "snapshot:crm");
  assert.deepEqual(emitted.payload, payload);
  assert.ok(Object.isFrozen(emitted), "事件对象必须冻结");
  assert.ok(Object.isFrozen(emitted.payload), "payload 必须冻结");
  assert.equal(typeof emitted.at, "string");
});

test("bus：subscribe 返回 unsubscribe，退订后不再收到", () => {
  const bus = createBus();
  const seen: BusEvent[] = [];
  const unsubscribe = bus.subscribe("snapshot:inbox", (event) => seen.push(event));

  bus.emit("snapshot:inbox", { n: 1 });
  unsubscribe();
  unsubscribe(); // 幂等
  bus.emit("snapshot:inbox", { n: 2 });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.payload, { n: 1 });
  assert.equal(bus.subscriberCount(), 0);
});

test("bus：环形缓冲只保留最近 50 条，id 单调自增", () => {
  const bus = createBus();
  for (let index = 1; index <= BUS_BUFFER_LIMIT + 10; index += 1) {
    bus.emit("snapshot:crm", { n: index });
  }
  const buffer = bus.buffer();
  assert.equal(buffer.length, BUS_BUFFER_LIMIT);
  assert.equal(buffer[0]!.id, 11);
  assert.equal(buffer[buffer.length - 1]!.id, BUS_BUFFER_LIMIT + 10);
  assert.equal(bus.lastId(), BUS_BUFFER_LIMIT + 10);
});

test("bus：replay(since) 只返回 id 大于 since 的缓冲事件", () => {
  const bus = createBus();
  for (let index = 1; index <= 5; index += 1) bus.emit("snapshot:ops", { n: index });
  assert.deepEqual(bus.replay(3).map((event) => event.id), [4, 5]);
  assert.deepEqual(bus.replay(0).map((event) => event.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(bus.replay(99), []);
});

// ---------------------------------------------------------------------------
// SSE：首帧 hello / 头 / topics 过滤 / 非法 400 / 回环 403 / since 重放 /
//      注入调度器验证 25s ping / 断开清理
// ---------------------------------------------------------------------------

test("SSE：路由表常量与词汇表导出", () => {
  assert.deepEqual(LIVE_ROUTES, [{ method: "GET", path: "/local/events" }]);
  assert.deepEqual([...LIVE_TOPICS], [
    "snapshot:crm",
    "snapshot:ops",
    "snapshot:inbox",
    "snapshot:yunqi",
    "bus:hello",
  ]);
  assert.equal(LIVE_PING_MS, 25_000);
});

test("SSE：200 + event-stream 头 + 首帧 event: hello（默认订阅全部白名单）", async () => {
  const bus = createBus();
  const response = handleEvents(eventsRequest(), bus);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  const reader = response.body!.getReader();
  const hello = await readFrame(reader);
  assert.match(hello, /^event: hello\ndata: .*\n\n$/);
  const data = frameData(hello);
  assert.equal(data.ok, true);
  assert.deepEqual(data.topics, [...LIVE_TOPICS]);
  await reader.cancel();
});

test("SSE：?topics= 过滤，未订阅 topic 的事件不下发", async () => {
  const bus = createBus();
  const response = handleEvents(eventsRequest("topics=snapshot:crm"), bus);
  const reader = response.body!.getReader();
  const hello = await readFrame(reader);
  assert.deepEqual(frameData(hello).topics, ["snapshot:crm"]);

  bus.emit("snapshot:ops", { leaked: true });
  bus.emit("snapshot:crm", { n: 1 });
  const frame = await readFrame(reader);
  assert.match(frame, /event: snapshot:crm/);
  assert.deepEqual(frameData(frame), { n: 1 }, "data 行应为事件 payload 本体");
  assert.ok(!frame.includes("leaked"), "未订阅 topic 不得下发");
  await reader.cancel();
});

test("SSE：非法 topic / 空 topics / 非法 since → 400", async () => {
  const bus = createBus();
  for (const query of ["topics=snapshot:crm,bogus", "topics=", "topics=snapshot%3Acrm%20", "since=abc", "since=-1"]) {
    const response = handleEvents(eventsRequest(query), bus);
    assert.equal(response.status, 400, `query=${query} 应 400`);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
  }
  assert.equal(bus.subscriberCount(), 0, "400 拒绝不得残留订阅");
});

test("SSE：非回环 hostname → 403", async () => {
  const bus = createBus();
  for (const url of ["http://example.com/local/events", "http://192.168.1.10:8000/local/events"]) {
    const response = handleEvents(new Request(url), bus);
    assert.equal(response.status, 403, `${url} 应 403`);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "host_not_allowed");
  }
  // 回环变体均放行
  for (const url of ["http://127.0.0.1:8000/local/events", "http://localhost:8000/local/events", "http://[::1]:8000/local/events"]) {
    const response = handleEvents(new Request(url), bus);
    assert.equal(response.status, 200, `${url} 应 200`);
    await response.body!.cancel();
  }
});

test("SSE：非 GET → 405 + Allow", async () => {
  const response = handleEvents(eventsRequest("", "POST"), createBus());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("SSE：?since=<id> 重放缓冲中 id 之后的事件（按 topics 过滤）", async () => {
  const bus = createBus();
  bus.emit("snapshot:crm", { n: 1 });
  bus.emit("snapshot:ops", { n: 2 });
  bus.emit("snapshot:crm", { n: 3 });

  const response = handleEvents(eventsRequest("topics=snapshot:crm&since=1"), bus);
  const reader = response.body!.getReader();
  await readFrame(reader); // hello

  const first = await readFrame(reader);
  assert.match(first, /id: 3\n/);
  assert.match(first, /event: snapshot:crm/);
  assert.deepEqual(frameData(first), { n: 3 }, "data 行应为事件 payload 本体");

  // 重放完成后，新事件继续实时下发
  bus.emit("snapshot:crm", { n: 4 });
  const live = await readFrame(reader);
  assert.match(live, /id: 4\n/);
  await reader.cancel();
});

test("SSE：注入调度器验证 25s 触发一次 `: ping`，断开时清理定时器", async () => {
  const bus = createBus();
  const scheduled: Array<{ callback: () => void; intervalMs: number; cleared: boolean }> = [];
  const response = handleEvents(eventsRequest(), bus, {
    scheduler: (callback, intervalMs) => {
      const handle = { callback, intervalMs, cleared: false };
      scheduled.push(handle);
      return {
        clear: () => {
          handle.cleared = true;
        },
      };
    },
  });
  assert.equal(scheduled.length, 1, "应只调度一个心跳定时器");
  assert.equal(scheduled[0]!.intervalMs, LIVE_PING_MS);
  assert.equal(scheduled[0]!.intervalMs, 25_000);

  const reader = response.body!.getReader();
  await readFrame(reader); // hello
  scheduled[0]!.callback();
  assert.equal(await readFrame(reader), ": ping\n\n");
  assert.equal(scheduled[0]!.cleared, false);

  await reader.cancel();
  assert.equal(scheduled[0]!.cleared, true, "断开必须清理心跳定时器");
});

test("SSE：客户端断开（cancel）清理全部订阅", async () => {
  const bus = createBus();
  const response = handleEvents(eventsRequest("topics=snapshot:crm,snapshot:ops"), bus);
  const reader = response.body!.getReader();
  await readFrame(reader);
  assert.equal(bus.subscriberCount(), 2);

  await reader.cancel();
  assert.equal(bus.subscriberCount(), 0);

  // 断开后 emit 不应抛错
  bus.emit("snapshot:crm", { n: 1 });
});

// ---------------------------------------------------------------------------
// producers：mtime/size 变化 → emit；缺失静默；start/stop 幂等；无子进程
// ---------------------------------------------------------------------------

test("producers：词汇表覆盖四个快照源", () => {
  assert.deepEqual(
    PRODUCER_SOURCES.map((source) => source.topic),
    ["snapshot:crm", "snapshot:ops", "snapshot:inbox", "snapshot:yunqi"],
  );
  assert.deepEqual(
    PRODUCER_SOURCES.map((source) => source.relativePath),
    ["crm-snapshot.json", "ops-digest.json", "notifications/inbox.json", "yunqi-highlights.json"],
  );
});

test("producers：首轮建立基线不 emit；mtime 变化 emit 一次；缺失文件静默", async () => {
  await withCacheDir(async (dir) => {
    const bus = createBus();
    const received: BusEvent[] = [];
    for (const topic of ["snapshot:crm", "snapshot:ops", "snapshot:inbox", "snapshot:yunqi"]) {
      bus.subscribe(topic, (event) => received.push(event));
    }
    const crmPath = join(dir, "crm-snapshot.json");
    await writeFile(crmPath, '{"rows":["合成"]}');

    const producers = createProducers({ cacheDir: dir, bus, intervalMs: 60_000 });
    producers.start();
    await producers.poll(); // 基线
    assert.equal(received.length, 0, "首轮基线不应 emit");

    const future = new Date(Date.now() + 60_000);
    await utimes(crmPath, future, future);
    await producers.poll();
    assert.equal(received.length, 1);
    assert.equal(received[0]!.topic, "snapshot:crm");
    const info = await stat(crmPath);
    assert.deepEqual(received[0]!.payload, {
      name: "crm",
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    });

    // 无变化再轮询不重复 emit；其余三个文件缺失静默
    await producers.poll();
    assert.equal(received.length, 1);
    producers.stop();
  });
});

test("producers：start/stop 幂等；stop 后不再 emit", async () => {
  await withCacheDir(async (dir) => {
    const bus = createBus();
    const received: BusEvent[] = [];
    bus.subscribe("snapshot:ops", (event) => received.push(event));
    const opsPath = join(dir, "ops-digest.json");
    await writeFile(opsPath, '{"v":1}');

    const producers = createProducers({ cacheDir: dir, bus, intervalMs: 10 });
    producers.start();
    producers.start(); // 幂等：不得叠加定时器
    producers.stop();
    producers.stop(); // 幂等
    await producers.poll(); // 基线（手动 poll 仍可用作显式刷新）

    await writeFile(opsPath, '{"v":2,"more":"合成"}');
    await sleep(60);
    assert.equal(received.length, 0, "stop 后不应 emit");
  });
});

test("producers：运行中检测到变化自动 emit（定时器驱动，双 start 只 emit 一次）", async () => {
  await withCacheDir(async (dir) => {
    const bus = createBus();
    const received: BusEvent[] = [];
    bus.subscribe("snapshot:yunqi", (event) => received.push(event));
    const yunqiPath = join(dir, "yunqi-highlights.json");
    await writeFile(yunqiPath, '{"v":1}');

    const producers = createProducers({ cacheDir: dir, bus, intervalMs: 10 });
    await producers.poll(); // 显式建立基线：避免负载下首轮定时 tick 晚于写文件，把新内容当基线（曾致 flaky）
    producers.start();
    producers.start();
    await writeFile(yunqiPath, '{"v":2,"title":"合成议程"}');
    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) await sleep(20);
    await sleep(60); // 再放行几轮 tick，确认定时器未叠加导致重复 emit
    assert.equal(received.length, 1, "变化应恰好 emit 一次（定时器未叠加）");
    producers.stop();
  });
});
