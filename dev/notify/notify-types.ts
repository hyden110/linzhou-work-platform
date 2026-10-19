/**
 * Contracts for the notify bridge (F6) — 消息中心（inbox 聚合 + 铃铛数据面）。
 * Semantics ported from base/sa-workbench scripts/lib/notify/index.js（搬语义不搬代码，
 * KINDS/KIND_T 以 index.js 为准：含 reply「待回复」）。
 *
 * F6-P0 边界：
 * - 本机收件箱 .local-cache/notifications/inbox.json 由本桥唯一写入；0600 原子写
 *   （唯一 tmp + rename）、cap 200（超出丢最旧）、按 id 指纹去重。
 * - P0 生产者只有 POST /local/notify/test（内容明确「测试」且不含真实数据）；
 *   钉钉/aitable 页外分发（chat +dm / record create）是静态库行为，本批绝不做；
 *   真实事件源待后续批次接入（代码与文案均如实说明）。
 * - 不做 SSE、不做轮询：端上打开面板时拉取 + 显式刷新。
 */

export const NOTIFY_KINDS = ["dingtalk", "lead", "cust", "reminder", "reply", "test"] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** 中文标签（照 index.js KIND_T：notify.js 里少 reply，以 index.js 为准）。 */
export const NOTIFY_KIND_LABELS: Readonly<Record<NotifyKind, string>> = {
  dingtalk: "钉钉",
  lead: "线索",
  cust: "客户",
  reminder: "提醒",
  reply: "待回复",
  test: "测试",
};

/** 稳定错误码载体：路由按 code 映射 400/502。 */
export type NotifyErrorCode = "notify_invalid_request" | "notify_unavailable";

export class NotifyBridgeError extends Error {
  readonly code: NotifyErrorCode;

  constructor(code: NotifyErrorCode, message: string) {
    super(message);
    this.name = "NotifyBridgeError";
    this.code = code;
  }
}

/** 收件箱条目（白名单字段，与任务口径一一对应）。 */
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

/** GET /local/notify/state 的 data：items 最近 50 + unread 数 + total。 */
export interface NotifyStateView {
  readonly savedAt: string;
  readonly unread: number;
  readonly total: number;
  readonly items: readonly NotifyItem[];
}

/** GET /local/notify/items 的 data：全量（≤200），供端上筛选。 */
export interface NotifyItemsView {
  readonly savedAt: string;
  readonly unread: number;
  readonly total: number;
  readonly items: readonly NotifyItem[];
}

/** POST /local/notify/read 的 data。 */
export interface NotifyReadResult {
  readonly marked: number;
  readonly unread: number;
}
