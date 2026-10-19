import {
  NOTIFY_KINDS,
  type NotifyItem,
  type NotifyKind,
} from "./notify-types.ts";

/**
 * Pure model for the notify bridge (F6) — ported from base/sa-workbench
 * scripts/lib/notify/index.js（搬语义不搬代码）：
 * - clean 口径照抄 index.js：控制字符清洗 → 空白折叠 → 截断；
 * - id 形态照抄 ID_RE；kind 白名单外一律落 test（照抄）；
 * - link 白名单偏离静态版：静态只放行站内 *.html（React 工作台没有 .html 页），
 *   本批只放行 http(s) URL，端上渲染时仅对 http(s) 出 <a>，其余一律空串。
 * - 入库加一道 SECRET_RE 脱敏（leads/health 同口径）：凭据形态文本不得写入收件箱。
 * 全部纯函数：无 I/O、无时钟（nowMs 由调用方注入）。
 */

export const NOTIFY_INBOX_LIMIT = 200;
export const NOTIFY_STATE_LIMIT = 50;

/** id 形态：照静态版 ID_RE（字母数字与 : _ - . ，1–120 位）。 */
export const NOTIFY_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,120}$/;

/** 凭据形态文本（sk- 16 位裸密钥 / LTAI 8 位 AccessKey + token= 等键值形态）：入库前整段抹除。
 * 词边界 + 长度下限为本批加严口径（较 leads/health 更严）——task-list / risk-control /
 * sklearn / flask-app 等正常词不得被误吞（评审 P2-1）。 */
export const NOTIFY_SECRET_PATTERN =
  /\bsk-[A-Za-z0-9_-]{16,}|\bLTAI[A-Za-z0-9]{8,}|\b(?:api[_-]?key|token|password|cookie|secret|authorization)\s*[:=]\s*[^\s,;]+/gi;

export function redactNotify(value: unknown): string {
  return String(value ?? "").replace(NOTIFY_SECRET_PATTERN, "[已脱敏]");
}

/** clean 口径照抄 index.js（前置一道凭据脱敏）：控制字符 → 空白折叠 → 截断。 */
export function cleanNotifyText(value: unknown, max: number): string {
  return redactNotify(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface NotifyIncoming {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly source?: unknown;
  readonly link?: unknown;
  readonly at?: unknown;
}

/** 消息规范化：白名单字段 + 长度截断；不合法返回 null（调用方拒绝入队）。 */
export function normalizeNotifyIncoming(raw: unknown, nowMs: number): NotifyItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : "";
  if (!NOTIFY_ID_PATTERN.test(id)) return null;
  const title = cleanNotifyText(source.title, 120);
  if (!title) return null;
  const kind: NotifyKind = (NOTIFY_KINDS as readonly string[]).includes(String(source.kind))
    ? (source.kind as NotifyKind)
    : "test";
  const link = typeof source.link === "string" && /^https?:\/\//i.test(source.link) ? source.link : "";
  const parsedAt = source.at == null ? Number.NaN : Date.parse(String(source.at));
  const createdAt = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date(nowMs).toISOString();
  return {
    id,
    kind,
    title,
    summary: cleanNotifyText(source.summary, 300),
    source: cleanNotifyText(source.source, 40),
    link,
    createdAt,
    readAt: "",
    read: false,
  };
}

/** 收件箱文件读回时的白名单投影：坏行丢弃（桥是唯一写者，此为读路径双保险）。 */
export function projectNotifyItem(raw: unknown): NotifyItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" && NOTIFY_ID_PATTERN.test(source.id) ? source.id : "";
  if (!id) return null;
  const kind: NotifyKind = (NOTIFY_KINDS as readonly string[]).includes(String(source.kind))
    ? (source.kind as NotifyKind)
    : "test";
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    id,
    kind,
    title: text(source.title),
    summary: text(source.summary),
    source: text(source.source),
    link: typeof source.link === "string" && /^https?:\/\//i.test(source.link) ? source.link : "",
    createdAt: text(source.createdAt),
    readAt: text(source.readAt),
    read: source.read === true,
  };
}
