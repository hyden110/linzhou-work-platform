/**
 * Wechat snapshot（微信办公桥）— 快照只读 + 白名单投影 + 掩码。
 * donor: base/sa-workbench data/wechat.json.example（形状）、tools/wxkey/build.js
 * （群/待办/@我/单聊口径）、assets/pages/wechat.js D()（空模板按未生成处理）。
 *
 * 红线（搬语义不搬代码）：
 * - 本桥只读快照文件，绝不读微信消息表、绝不做任何解密、绝不接触密钥/解密库；
 * - 消息正文只出 ≤24 字掩码预览（maskPreview），完整正文绝不出桥；
 * - 个人 wxid 绝不出桥：单聊 id / 单聊 mention convId / 正文内 wxid 形态词一律
 *   打码为不可逆指纹（maskWxid）；群主、成员名单、群公告、解密目录全部丢弃；
 * - 群 chatroom id 是绑定台账的键，如实保留（它不是个人 wxid）；
 * - 快照缺失/空模板/坏 JSON → status:"missing" + 修复指引（donor「给修复指引
 *   而非空白」口径），绝不伪造数据。
 */

import { readFile } from "node:fs/promises";

import type {
  WechatCustomerStatus,
  WechatGroupView,
  WechatLabelView,
  WechatMentionView,
  WechatRecentAtView,
  WechatSingleView,
  WechatSnapshotView,
  WechatSourceView,
  WechatStatsView,
  WechatTodoView,
  WechatUrgency,
} from "../../src/lib/wechat-model.ts";
import { WECHAT_MASK_PREVIEW_CHARS, type WechatBindingEntry } from "./wechat-types.ts";

/** 快照缺失时的修复指引（照 donor emptyHtml「给步骤而非空白」，但本机绝不执行解密）。 */
export const WECHAT_MISSING_STEPS: readonly string[] = [
  "微信快照由静态台（base/sa-workbench）的本机常驻同步生成：data/wechat.json（0600、不入 git）。",
  "把该文件的绝对路径填入 .local-cache/agents.json 的 wechat.snapshotPath（参考 config/agents.json.example）。",
  "本桥只读快照做白名单投影：不读消息表、不做任何解密、不接触密钥。",
  "快照就绪后刷新本页即可看到群台账 / @我待办 / 单聊未回；缺失时只给指引，绝不伪造数据。",
];

const CUSTOMER_STATUSES: ReadonlySet<string> = new Set<WechatCustomerStatus>(["confirmed", "matched", "pending"]);
const URGENCIES: ReadonlySet<string> = new Set<WechatUrgency>(["high", "mid", "low", "overdue"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const asCount = (value: unknown): number => Math.max(0, Math.trunc(asNumber(value)));

/** 正文内 wxid 形态词（wxid_xxx）整体打码——掩码预览也不得夹带个人 id。 */
const WXID_IN_TEXT = /wxid_[A-Za-z0-9_-]+/g;

/**
 * 消息正文掩码预览：wxid 形态词打码 → 折空白 → 截 24 字加省略号。
 * 非字符串如实转字符串（数字保形），null/undefined → 空串。
 */
export function maskPreview(text: unknown, max: number = WECHAT_MASK_PREVIEW_CHARS): string {
  const flat = String(text ?? "")
    .replace(WXID_IN_TEXT, "wxid_***")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** fnv-1a 32 位（短指纹足够区分本地台账行，非加密用途、不可逆推原 id）。 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/** 个人 wxid → 不可逆掩码指纹（wxid…ab12cd）；空/非字符串如实空。 */
export function maskWxid(id: unknown): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return "";
  const prefix = raw.startsWith("wxid") ? "wxid" : raw.slice(0, 2);
  return `${prefix}…${fingerprint(raw)}`;
}

/** 缺失态视图：四种原因各有诚实文案 + 统一修复指引（绝不空白、绝不伪造）。 */
export function missingWechatSnapshotView(
  reason: "no-path" | "no-file" | "malformed" | "template",
  note: string,
): WechatSnapshotView {
  const base: Record<typeof reason, string> = {
    "no-path":
      "未配置微信办公快照路径（wechat.snapshotPath）：请把静态台本机常驻同步生成的 data/wechat.json 绝对路径填入 .local-cache/agents.json（参考 config/agents.json.example）。",
    "no-file":
      "快照文件尚未生成：实时群台账 / @我待办由静态台本机常驻同步维护，本台仅只读展示；确认 wechat.snapshotPath 指向的文件已生成后刷新。",
    malformed:
      "快照文件不是合法 JSON：等待静态台常驻同步重建后刷新（本桥只读，不修复、不伪造）。",
    template:
      "快照还是空模板（无 updatedAt / groups 未生成）：按「未生成」处理，等静态台完成一次重建后刷新。",
  };
  const missingNote = note ? `${base[reason]}（${note}）` : base[reason];
  return { status: "missing", missingNote, steps: WECHAT_MISSING_STEPS };
}

/** 读快照文本：缺失/不可读如实 null（调用方给 missing 指引，不抛给用户）。 */
export async function readSnapshotText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function projectStats(raw: unknown, custBound: number): WechatStatsView {
  const record = isRecord(raw) ? raw : {};
  return {
    groups: asCount(record.groups),
    groupsActive7: asCount(record.groupsActive7),
    groupsActive30: asCount(record.groupsActive30),
    groupsMine7: asCount(record.groupsMine7),
    custBound,
    atMeAll: asCount(record.atMeAll),
    atMe30: asCount(record.atMe30),
    todos: asCount(record.todos),
    todosHigh: asCount(record.todosHigh),
    unread: asCount(record.unread),
    singleUnreplied: asCount(record.singleUnreplied),
    messages: asCount(record.messages),
  };
}

function projectCounts(raw: unknown, keys: readonly string[]): Record<string, number> {
  const record = isRecord(raw) ? raw : {};
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = asCount(record[key]);
  return out;
}

function projectCustKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((key): key is string => typeof key === "string" && key.trim() !== "").map((key) => key.trim());
}

function projectRecentAt(raw: unknown): WechatRecentAtView | null {
  if (!isRecord(raw)) return null;
  return { t: asNumber(raw.t), name: asText(raw.name), textMasked: maskPreview(raw.text) };
}

function projectGroup(raw: unknown, binding: WechatBindingEntry | undefined): WechatGroupView | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id);
  if (!id) return null; // 缺群 id 的行无法作为台账键：丢弃不猜
  const custKeys = binding ? [...binding.custKeys] : projectCustKeys(raw.custKeys);
  const statusRaw = asText(raw.customerStatus);
  const customerStatus: WechatCustomerStatus = binding
    ? binding.custKeys.length > 0
      ? "confirmed"
      : "pending" // 空绑定 = 清除人工绑定：如实待确认（自动推断等快照重建回落）
    : CUSTOMER_STATUSES.has(statusRaw)
      ? (statusRaw as WechatCustomerStatus)
      : "pending";
  const atMe = isRecord(raw.atMe) ? raw.atMe : {};
  return {
    id,
    name: asText(raw.name) || id,
    memberCount: asCount(raw.memberCount),
    muted: raw.muted === true,
    unread: asCount(raw.unread),
    lastMsgAt: asNumber(raw.lastMsgAt),
    lastSummaryMasked: maskPreview(raw.lastSummary),
    custKeys,
    customerStatus,
    bindNote: binding ? binding.note : asText(raw.bindNote),
    msg: projectCounts(raw.msg, ["d7", "d30", "dWin", "all"]) as WechatGroupView["msg"],
    senders: projectCounts(raw.senders, ["d7", "d30", "all"]) as WechatGroupView["senders"],
    mine: projectCounts(raw.mine, ["d7", "d30", "all", "lastAt"]) as WechatGroupView["mine"],
    atMe: {
      all: asCount(atMe.all),
      lastAt: asNumber(atMe.lastAt),
      daysSince: typeof atMe.daysSince === "number" && Number.isFinite(atMe.daysSince) ? atMe.daysSince : null,
      unreplied: atMe.unreplied === true,
    },
    recentAtMe: (Array.isArray(raw.recentAtMe) ? raw.recentAtMe : [])
      .map(projectRecentAt)
      .filter((row): row is WechatRecentAtView => row !== null)
      .slice(0, 20),
  };
}

function projectTodo(raw: unknown): WechatTodoView | null {
  if (!isRecord(raw)) return null;
  const groupId = asText(raw.groupId);
  const urgency = asText(raw.urgency);
  if (!groupId || !URGENCIES.has(urgency)) return null;
  return {
    groupId,
    groupName: asText(raw.groupName) || groupId,
    custKeys: projectCustKeys(raw.custKeys),
    urgency: urgency as WechatUrgency,
    daysSince: asCount(raw.daysSince),
    at: asNumber(raw.at),
    fromName: asText(raw.fromName),
    textMasked: maskPreview(raw.text),
  };
}

function projectMention(raw: unknown): WechatMentionView | null {
  if (!isRecord(raw)) return null;
  const kind = asText(raw.kind);
  if (kind !== "at" && kind !== "single") return null;
  const group = raw.group === true;
  const convId = asText(raw.convId);
  return {
    kind,
    t: asNumber(raw.t),
    // 单聊会话 id 就是对方 wxid：打码；群 chatroom id 是台账键，保留。
    convId: group ? convId : maskWxid(convId),
    convName: asText(raw.convName) || (group ? convId : maskWxid(convId)),
    group,
    custKeys: projectCustKeys(raw.custKeys),
    fromName: asText(raw.fromName),
    textMasked: maskPreview(raw.text),
    unread: raw.unread === true,
  };
}

function projectSingle(raw: unknown): WechatSingleView | null {
  if (!isRecord(raw)) return null;
  const idMasked = maskWxid(raw.id);
  if (!idMasked) return null;
  return {
    idMasked,
    name: asText(raw.name) || idMasked,
    muted: raw.muted === true,
    msg: projectCounts(raw.msg, ["d7", "d30", "all"]) as WechatSingleView["msg"],
    lastMsgAt: asNumber(raw.lastMsgAt),
    unread: asCount(raw.unread),
    lastSummaryMasked: maskPreview(raw.lastSummary),
    unreplied: raw.unreplied === true,
  };
}

function projectLabel(raw: unknown): WechatLabelView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
  return { id: raw.id, name: raw.name };
}

/**
 * 快照 → 白名单投影（唯一出口）：
 * - 只保留统计/台账所需字段；群主、成员名单、群公告、解密目录、个人 wxid 全部丢弃或打码；
 * - bindings 台账（人工绑定）覆盖快照 custKeys/customerStatus/bindNote，custBound 重算；
 * - 空模板（无 updatedAt / groups 非数组）按 donor D() 口径 → missing 指引。
 */
export function projectWechatSnapshot(raw: unknown, bindings: readonly WechatBindingEntry[]): WechatSnapshotView {
  if (!isRecord(raw)) return missingWechatSnapshotView("template", "");
  const updatedAt = asText(raw.updatedAt);
  if (!updatedAt || !Array.isArray(raw.groups)) return missingWechatSnapshotView("template", "");

  const bindingMap = new Map(bindings.map((entry) => [entry.groupId, entry]));
  const groups = raw.groups
    .map((row) => projectGroup(row, isRecord(row) ? bindingMap.get(asText(row.id)) : undefined))
    .filter((row): row is WechatGroupView => row !== null);
  const todos = (Array.isArray(raw.todos) ? raw.todos : [])
    .map(projectTodo)
    .filter((row): row is WechatTodoView => row !== null);
  const mentions = (Array.isArray(raw.mentions) ? raw.mentions : [])
    .map(projectMention)
    .filter((row): row is WechatMentionView => row !== null);
  const singles = (Array.isArray(raw.singles) ? raw.singles : [])
    .map(projectSingle)
    .filter((row): row is WechatSingleView => row !== null);
  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .map(projectLabel)
    .filter((row): row is WechatLabelView => row !== null);

  const me = isRecord(raw.me) ? raw.me : {};
  const source = isRecord(raw.source) ? raw.source : {};
  const custBound = groups.filter((group) => group.custKeys.length > 0).length;
  return {
    status: "ok",
    version: asCount(raw.version),
    updatedAt,
    meName: asText(me.name).slice(0, 64), // me.wxid 绝不出桥
    source: projectCounts(source, ["dbs", "tables", "messages", "groups", "singles", "window"]) as WechatSourceView,
    stats: projectStats(raw.stats, custBound),
    groups,
    todos,
    mentions,
    singles,
    labels,
  };
}
