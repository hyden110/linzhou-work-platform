import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import {
  normalizeNotifyIncoming,
  NOTIFY_INBOX_LIMIT,
  NOTIFY_STATE_LIMIT,
  projectNotifyItem,
} from "./notify-model.ts";
import {
  NotifyBridgeError,
  type NotifyItem,
  type NotifyItemsView,
  type NotifyReadResult,
  type NotifyStateView,
} from "./notify-types.ts";

/**
 * Notify bridge (F6) — 消息中心。Semantics ported from base/sa-workbench
 * scripts/lib/notify/index.js（搬语义不搬代码）：
 * - 收件箱 .local-cache/notifications/inbox.json 由本桥唯一写入；0600 原子写
 *   （唯一 tmp + rename）、cap 200（超出丢最旧）、按 id 指纹去重（重复不落盘）。
 * - P0 生产者只有 enqueueTest（POST /local/notify/test）：内容明确「测试」且不含
 *   真实数据；钉钉/aitable 页外分发（chat +dm / record create）绝不做，
 *   真实事件源待后续批次接入（代码与文案均如实说明）。
 * - markRead 只动 read 位（ids / all / read:false 还原）；坏输入 notify_invalid_request。
 * - 不做 SSE、不做轮询：端上打开面板时拉取 + 显式刷新。
 */

/* dev/notify/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_NOTIFY_INBOX_PATH = joinPath(PROJECT_ROOT, ".local-cache", "notifications", "inbox.json");

export interface NotifyBridgeOptions {
  readonly inboxPath?: string;
  readonly now?: () => number;
}

export interface NotifyIngestResult {
  readonly id: string;
  readonly added: boolean;
}

export interface NotifyBridge {
  readonly state: () => Promise<NotifyStateView>;
  readonly items: () => Promise<NotifyItemsView>;
  readonly markRead: (input: {
    readonly ids?: unknown;
    readonly all?: unknown;
    readonly read?: unknown;
  }) => Promise<NotifyReadResult>;
  readonly enqueueTest: () => Promise<NotifyIngestResult>;
  /** 结构化入队（收件箱唯一写入口）：测试与后续批次生产者复用；坏数据拒绝。 */
  readonly ingest?: (raw: unknown) => Promise<NotifyIngestResult>;
}

interface InboxFile {
  readonly savedAt: string;
  readonly items: NotifyItem[];
}

const emptyInbox = (): InboxFile => ({ savedAt: "", items: [] });

export function createNotifyBridge(options: NotifyBridgeOptions = {}): NotifyBridge {
  const inboxPath = options.inboxPath ?? DEFAULT_NOTIFY_INBOX_PATH;
  const now = options.now ?? Date.now;
  /** enqueueTest 的唯一 id 序号（同毫秒连发也不冲突）。 */
  let testSeq = 0;

  /** 读收件箱：缺失 / 坏 JSON → 如实空箱（桥是唯一写者，读回再投影双保险）。 */
  async function loadInbox(): Promise<InboxFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(inboxPath, "utf-8"));
    } catch {
      return emptyInbox();
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyInbox();
    const source = raw as Record<string, unknown>;
    const rows = Array.isArray(source.items) ? source.items : [];
    return {
      savedAt: typeof source.savedAt === "string" ? source.savedAt : "",
      items: rows
        .map((row) => projectNotifyItem(row))
        .filter((item): item is NotifyItem => item !== null),
    };
  }

  /** 0600 原子写：目录 0700 → 唯一 tmp(0600) → rename；失败清理 tmp（无残留）。 */
  async function saveInbox(items: NotifyItem[]): Promise<void> {
    const payload = JSON.stringify({ savedAt: new Date(now()).toISOString(), items }, null, 2);
    await mkdir(dirname(inboxPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${inboxPath}.${process.pid}.${now()}.tmp`;
    try {
      await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, inboxPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  /** 唯一写入口：normalize → 去重 → cap 200 → 落盘；重复不写文件（字节不变）。 */
  async function ingest(raw: unknown): Promise<NotifyIngestResult> {
    const item = normalizeNotifyIncoming(raw, now());
    if (!item) {
      throw new NotifyBridgeError("notify_invalid_request", "消息不合法：需要合法 id（字母数字与 : _ - .）与非空标题。");
    }
    const inbox = await loadInbox();
    if (inbox.items.some((entry) => entry.id === item.id)) {
      return { id: item.id, added: false };
    }
    const next = [item, ...inbox.items].slice(0, NOTIFY_INBOX_LIMIT);
    await saveInbox(next);
    return { id: item.id, added: true };
  }

  const unreadOf = (items: readonly NotifyItem[]): number =>
    items.filter((item) => !item.read).length;

  async function state(): Promise<NotifyStateView> {
    const inbox = await loadInbox();
    return {
      savedAt: inbox.savedAt,
      unread: unreadOf(inbox.items),
      total: inbox.items.length,
      items: inbox.items.slice(0, NOTIFY_STATE_LIMIT),
    };
  }

  async function items(): Promise<NotifyItemsView> {
    const inbox = await loadInbox();
    return {
      savedAt: inbox.savedAt,
      unread: unreadOf(inbox.items),
      total: inbox.items.length,
      items: inbox.items,
    };
  }

  async function markRead(input: {
    readonly ids?: unknown;
    readonly all?: unknown;
    readonly read?: unknown;
  }): Promise<NotifyReadResult> {
    const markAsRead = input.read !== false;
    if (input.ids !== undefined && !Array.isArray(input.ids)) {
      throw new NotifyBridgeError("notify_invalid_request", "ids 必须是字符串数组。");
    }
    const idList = Array.isArray(input.ids) ? input.ids.map((entry) => String(entry)).slice(0, 200) : [];
    if (input.all !== true && idList.length === 0) {
      throw new NotifyBridgeError("notify_invalid_request", "需要 ids（≤200 个）或 all:true 之一。");
    }
    const inbox = await loadInbox();
    const idSet = new Set(idList);
    let marked = 0;
    const next = inbox.items.map((item) => {
      const hit = input.all === true || idSet.has(item.id);
      if (!hit || item.read === markAsRead) return item;
      marked += 1;
      return markAsRead
        ? { ...item, read: true, readAt: new Date(now()).toISOString() }
        : { ...item, read: false, readAt: "" };
    });
    if (marked > 0) await saveInbox(next);
    return { marked, unread: unreadOf(next) };
  }

  /**
   * P0 唯一生产者：显式「测试」消息——title/summary 前缀「测试」、source「测试」、
   * 无链接、不含真实客户数据；真实事件源（钉钉/aitable）待后续批次接入。
   */
  async function enqueueTest(): Promise<NotifyIngestResult> {
    testSeq += 1;
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    return ingest({
      id: `test-${stamp}-${testSeq}`,
      kind: "test",
      title: `测试消息（合成，第 ${testSeq} 条）`,
      summary: `测试消息 ${testSeq}：用于验证消息中心链路；真实事件源（钉钉 / aitable）待后续批次接入。`,
      source: "测试",
      link: "",
    });
  }

  return { state, items, markRead, enqueueTest, ingest };
}
