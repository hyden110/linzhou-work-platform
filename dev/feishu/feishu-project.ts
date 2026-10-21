/**
 * Feishu 投影层（飞书办公台账桥）— CLI JSON → 白名单视图（唯一出口）。
 *
 * 口径（与 src/lib/feishu-client.ts 前端投影一致）：
 * - 坏行丢弃：缺 chat_id / message_id / guid、非对象行、completed 混入的待办；
 * - 未知枚举如实降级：mode/chatType → "group"（前端同语义，不猜不造）；
 * - 隐私红线：open_id/owner_id/p2p_target_id 一律掩码指纹（姓名保留）；
 *   消息正文只出 ≤60 字预览（text 取 text、post 取标题或首段、媒体给占位符）；
 * - dueToday/overdue 以本机时区当天 [00:00,24:00) 判定；无截止两者皆 false；
 * - 时间归一：秒/毫秒 epoch 数字（串）与 ISO 串统一转 ISO；不可解析如实空串。
 */

import {
  FEISHU_MASK_PREFIX_CHARS,
  FEISHU_MASK_TAIL_CHARS,
  FEISHU_PREVIEW_CHARS,
  type FeishuAtMeView,
  type FeishuChatMode,
  type FeishuChatType,
  type FeishuChatView,
  type FeishuSummaryView,
  type FeishuTaskView,
} from "./feishu-types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/* ---------------- id 掩码 ---------------- */

/** fnv-1a 32 位短指纹（区分本地行足够，非加密、不可逆推原 id；沿 wechat 先例）。 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, FEISHU_MASK_TAIL_CHARS);
}

/**
 * 飞书 id → 掩码指纹：长 id 前 2 位 + … + 末 6 位（如 ou…abcd12）；
 * ≤8 位短 id 末 6 位会裸露大半原文，改用指纹；空/非字符串如实空串。
 */
export function maskFeishuId(id: unknown): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return "";
  const prefix = raw.slice(0, FEISHU_MASK_PREFIX_CHARS);
  const tail = raw.length > FEISHU_MASK_PREFIX_CHARS + FEISHU_MASK_TAIL_CHARS
    ? raw.slice(-FEISHU_MASK_TAIL_CHARS)
    : fingerprint(raw);
  return `${prefix}…${tail}`;
}

/* ---------------- 时间归一 ---------------- */

/**
 * epoch 秒/毫秒（数字或纯数字串）与 ISO 串 → epoch 毫秒；不可解析如实 NaN。
 * 阈值：≥1e12 视作毫秒，≥1e9 视作秒（2001 年后的秒级时间戳都在此区间）。
 */
export function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : value >= 1e9 ? value * 1000 : Number.NaN;
  }
  const text = asText(value);
  if (!text) return Number.NaN;
  if (/^\d+$/.test(text)) return toEpochMs(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toIso(value: unknown): string {
  const ms = toEpochMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** 本机时区当天边界 [start, end)（end = 次日 00:00，跨 DST 也按本地日历日）。 */
export function dayBounds(nowMs: number): { readonly start: number; readonly end: number } {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

/* ---------------- 消息预览 ---------------- */

const PREVIEW_PLACEHOLDERS: Readonly<Record<string, string>> = {
  image: "[图片]",
  file: "[文件]",
  audio: "[语音]",
  video: "[视频]",
  media: "[视频]",
  interactive: "[卡片]",
  sticker: "[表情]",
};

/** 折空白 + trim + 截断：>max 时截 max 字并追加单个省略号（全文绝不出桥）。 */
export function truncatePreview(text: unknown, max: number = FEISHU_PREVIEW_CHARS): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** content 可能是 JSON 编码串也可能是对象：解析失败时按裸文本如实处理。 */
function contentOf(content: unknown): Record<string, unknown> | string {
  if (isRecord(content)) return content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

/** post（富文本）：标题优先；无标题取首段 text/a 元素拼接；全无 → 占位不猜。 */
function postPreview(content: Record<string, unknown>): string {
  const title = asText(content.title);
  if (title) return title;
  const paragraphs = Array.isArray(content.content) ? content.content : [];
  const first = Array.isArray(paragraphs[0]) ? paragraphs[0] : [];
  const text = first
    .filter(isRecord)
    .map((element) => asText(element.text))
    .join("")
    .trim();
  return text || "[富文本]";
}

/** msg_type + content → ≤60 字预览：text 取正文、post 取标题/首段、媒体给占位、未知给 [消息]。 */
export function extractPreview(msgType: unknown, content: unknown): string {
  const type = asText(msgType).toLowerCase();
  if (PREVIEW_PLACEHOLDERS[type]) return PREVIEW_PLACEHOLDERS[type];
  const parsed = contentOf(content);
  if (type === "text") {
    const text = typeof parsed === "string" ? parsed : asText(parsed.text);
    return truncatePreview(text);
  }
  if (type === "post") {
    return truncatePreview(typeof parsed === "string" ? parsed : postPreview(parsed));
  }
  return "[消息]";
}

/* ---------------- 行提取（容忍 _notice 等未知键与常见包装层） ---------------- */

const ROW_KEYS: readonly string[] = ["items", "list", "chats", "messages", "tasks", "data", "result", "records"];

/** 从 CLI payload 提取行数组：顶层数组 / items|data.items 等常见包装，深度 ≤3，找不到如实空。 */
export function extractFeishuRows(payload: unknown, depth = 0): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload) || depth >= 3) return [];
  for (const key of ROW_KEYS) {
    if (payload[key] !== undefined) {
      const rows = extractFeishuRows(payload[key], depth + 1);
      if (rows.length > 0) return rows;
    }
  }
  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.some(isRecord)) return value.filter(isRecord);
  }
  return [];
}

/* ---------------- 三个 section 的白名单投影 ---------------- */

const CHAT_MODES: ReadonlySet<string> = new Set<FeishuChatMode>(["group", "topic", "p2p"]);
const CHAT_TYPES: ReadonlySet<string> = new Set<FeishuChatType>(["group", "p2p"]);

/** chat 行：chat_id 必备（台账键）；未知 mode 降级 group（前端同口径）；描述/成员等一概不出桥。 */
function projectChatRow(raw: Record<string, unknown>): FeishuChatView | null {
  const chatId = asText(raw.chat_id);
  if (!chatId) return null;
  const rawMode = asText(raw.chat_mode);
  const mode: FeishuChatMode = CHAT_MODES.has(rawMode) ? (rawMode as FeishuChatMode) : "group";
  const name = asText(raw.name);
  const peerRaw = asText(raw.peer_name) || asText(raw.p2p_target_name);
  return {
    chatId,
    name,
    mode,
    external: raw.external === true,
    status: asText(raw.chat_status),
    ownerIdMasked: maskFeishuId(raw.owner_id), // owner open_id 绝不出原文
    peerName: mode === "p2p" ? peerRaw || name : "", // p2p_target_id 绝不出桥（连掩码位都不占）
  };
}

export function projectChatRows(payload: unknown): readonly FeishuChatView[] {
  return extractFeishuRows(payload)
    .map((row) => projectChatRow(row))
    .filter((row): row is FeishuChatView => row !== null);
}

/** @我行：message_id 必备；sender 只出姓名 + 掩码 id；正文只出 ≤60 字预览。 */
function projectAtMeRow(raw: Record<string, unknown>): FeishuAtMeView | null {
  const messageId = asText(raw.message_id);
  if (!messageId) return null;
  const sender = isRecord(raw.sender) ? raw.sender : {};
  const senderId = sender.id ?? sender.open_id ?? sender.sender_id ?? sender.union_id;
  const rawChatType = asText(raw.chat_type);
  return {
    messageId,
    chatId: asText(raw.chat_id),
    chatName: asText(raw.chat_name),
    chatType: CHAT_TYPES.has(rawChatType) ? (rawChatType as FeishuChatType) : "group",
    senderName: asText(sender.name),
    senderIdMasked: maskFeishuId(senderId),
    createdAt: toIso(raw.create_time),
    preview: extractPreview(raw.msg_type, raw.content),
    deleted: raw.deleted === true,
  };
}

export function projectAtMeRows(payload: unknown): readonly FeishuAtMeView[] {
  return extractFeishuRows(payload)
    .map((row) => projectAtMeRow(row))
    .filter((row): row is FeishuAtMeView => row !== null);
}

function dueOf(raw: Record<string, unknown>): unknown {
  if (isRecord(raw.due) && raw.due.timestamp !== undefined) return raw.due.timestamp;
  return raw.due_time ?? raw.dueTime ?? raw.due;
}

function completedOf(raw: Record<string, unknown>): boolean {
  if (raw.completed === true) return true;
  // 完成时刻可解析才算完成（""/0/缺失 → NaN → 未完成）
  return Number.isFinite(toEpochMs(raw.completed_at ?? raw.completedAt));
}

/** 待办行：guid 必备；completed 混入如实丢弃（查询已带 --complete=false，双保险）。 */
function projectTaskRow(raw: Record<string, unknown>, bounds: { start: number; end: number }): FeishuTaskView | null {
  const guid = asText(raw.guid);
  if (!guid || completedOf(raw)) return null;
  const dueMs = toEpochMs(dueOf(raw));
  return {
    guid,
    summary: asText(raw.summary),
    dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : "",
    createdAt: toIso(raw.created_at ?? raw.createdAt),
    overdue: Number.isFinite(dueMs) && dueMs < bounds.start,
    dueToday: Number.isFinite(dueMs) && dueMs >= bounds.start && dueMs < bounds.end,
  };
}

export function projectTaskRows(payload: unknown, nowMs: number): readonly FeishuTaskView[] {
  const bounds = dayBounds(nowMs);
  return extractFeishuRows(payload)
    .map((row) => projectTaskRow(row, bounds))
    .filter((row): row is FeishuTaskView => row !== null);
}

/* ---------------- summary ---------------- */

/** 计数一律从投影后的行重算（不信 CLI 自带计数）：groups=非 p2p、atMe 含 deleted 行。 */
export function buildFeishuSummary(
  chats: readonly FeishuChatView[],
  atMe: readonly FeishuAtMeView[],
  tasks: readonly FeishuTaskView[],
): FeishuSummaryView {
  const p2p = chats.filter((chat) => chat.mode === "p2p").length;
  return {
    groups: chats.length - p2p,
    p2p,
    external: chats.filter((chat) => chat.external).length,
    atMe: atMe.length,
    tasksOpen: tasks.length,
    tasksDueToday: tasks.filter((task) => task.dueToday).length,
    tasksOverdue: tasks.filter((task) => task.overdue).length,
  };
}
