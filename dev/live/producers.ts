/**
 * 快照文件生产者（实时事件总线 T3）：轮询 .local-cache 下四个快照文件的
 * mtimeMs/sizeBytes，变化时向 bus emit `snapshot:<name>` {name, mtimeMs, sizeBytes}。
 *
 * 诚实原则：文件缺失静默跳过（不发事件、不造数据）；首轮观察只建基线不 emit
 * （避免桥重启即广播陈旧快照——客户端 hello 后自会走 REST 拉取）。
 * 红线：只用 fs.stat 只读探测，绝不 spawn 子进程、绝不读写文件内容。
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { Bus } from "./bus.ts";

export interface ProducerSource {
  readonly name: string;
  readonly topic: string;
  readonly relativePath: string;
}

/** 四个快照源 → topic 词汇表（与 live-bridge LIVE_TOPICS 的 snapshot:* 对齐）。 */
export const PRODUCER_SOURCES: readonly ProducerSource[] = [
  { name: "crm", topic: "snapshot:crm", relativePath: "crm-snapshot.json" },
  { name: "ops", topic: "snapshot:ops", relativePath: "ops-digest.json" },
  { name: "inbox", topic: "snapshot:inbox", relativePath: "notifications/inbox.json" },
  { name: "yunqi", topic: "snapshot:yunqi", relativePath: "yunqi-highlights.json" },
] as const;

export const DEFAULT_PRODUCER_INTERVAL_MS = 5_000;

export interface FileObservation {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

export interface ProducersState {
  readonly running: boolean;
  readonly lastPollAt: string | null;
  readonly observations: Readonly<Record<string, FileObservation>>;
}

export interface Producers {
  /** 启动轮询；重复调用幂等（不叠加定时器）。 */
  start(): void;
  /** 停止轮询；重复调用幂等。停止后不再自动 emit。 */
  stop(): void;
  /** 显式轮询一次（测试与手动刷新用）；返回本次 emit 的事件数。 */
  poll(): Promise<number>;
  state(): ProducersState;
}

export interface ProducersOptions {
  readonly cacheDir: string;
  readonly bus: Bus;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

async function observe(path: string): Promise<FileObservation | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    return { mtimeMs: info.mtimeMs, sizeBytes: info.size };
  } catch {
    // 缺失 / 不可读：静默跳过（诚实——不发事件）。
    return undefined;
  }
}

export function createProducers(options: ProducersOptions): Producers {
  const { cacheDir, bus } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_PRODUCER_INTERVAL_MS;
  const now = options.now ?? Date.now;
  if (typeof cacheDir !== "string" || !cacheDir) {
    throw new TypeError("producers: cacheDir 必须为非空字符串");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new TypeError("producers: intervalMs 必须为正数");
  }

  let lastSeen: Readonly<Record<string, FileObservation>> = {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPollAt: string | null = null;
  let polling: Promise<number> | undefined;

  async function poll(): Promise<number> {
    let emitted = 0;
    let next: Record<string, FileObservation> = {};
    for (const source of PRODUCER_SOURCES) {
      const observation = await observe(join(cacheDir, source.relativePath));
      if (observation === undefined) continue; // 缺失：不记基线、不发事件
      next = { ...next, [source.name]: observation };
      const previous = lastSeen[source.name];
      if (previous === undefined) continue; // 首轮：只建基线
      if (previous.mtimeMs === observation.mtimeMs && previous.sizeBytes === observation.sizeBytes) continue;
      bus.emit(source.topic, {
        name: source.name,
        mtimeMs: observation.mtimeMs,
        sizeBytes: observation.sizeBytes,
      });
      emitted += 1;
    }
    lastSeen = next;
    lastPollAt = new Date(now()).toISOString();
    return emitted;
  }

  function start(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      // 单飞：上一轮未结束不叠加（fs.stat 很快，防御慢盘）。
      if (polling !== undefined) return;
      polling = poll()
        .catch((error) => {
          console.error(JSON.stringify({ event: "live_producers_poll_failed", message: error instanceof Error ? error.message : String(error) }));
          return 0;
        })
        .finally(() => {
          polling = undefined;
        });
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    start,
    stop,
    poll,
    state: () => ({ running: timer !== undefined, lastPollAt, observations: lastSeen }),
  };
}
