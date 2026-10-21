/**
 * Browser client for 飞书台账 — GET /local/feishu 与 GET /local/feishu/refresh
 * 只读白名单投影。
 *
 * 口径（与 dev/feishu-bridge.ts 桥契约一一对应）：
 * - 白名单投影：坏行丢弃（缺 chatId/messageId/guid 或非对象）、未知枚举如实降级
 *   （mode/chatType → "group"、identity → "none"、tokenStatus → "missing"）、
 *   data.status 形态不符整包 invalid_response —— 绝不半真半假（沿 wechat-client 先例）；
 * - sectionErrors 只认字符串值：非字符串键整键丢弃，不猜桥侧意图；
 * - 错误分层：{error:{code,message}} → FeishuClientError(code, detail)，
 *   feishuErrorMessage 给可直接展示的中文诚实文案；
 * - GET 超时 20s（桥侧 lark-cli 聚合调用较慢，留足余量）。
 */

import { composeErrorMessage } from "./error-message.ts";

const FEISHU_GET_TIMEOUT_MS = 20_000;

export type FeishuClientErrorCode =
  | "unavailable"
  | "invalid_response"
  | "cli_missing"
  | "auth_required"
  | "feishu_cli_failed"
  | "method_not_allowed";

const KNOWN_CODES: ReadonlySet<string> = new Set<FeishuClientErrorCode>([
  "unavailable", "invalid_response", "cli_missing", "auth_required", "feishu_cli_failed", "method_not_allowed",
]);

export type FeishuLedgerStatus = "ok" | "auth_required" | "cli_missing";
export type FeishuChatMode = "group" | "topic" | "p2p";
export type FeishuChatType = "group" | "p2p";
export type FeishuIdentity = "user" | "bot" | "none";
export type FeishuTokenStatus = "valid" | "expired" | "missing";

const LEDGER_STATUSES: ReadonlySet<string> = new Set<FeishuLedgerStatus>(["ok", "auth_required", "cli_missing"]);
const CHAT_MODES: ReadonlySet<string> = new Set<FeishuChatMode>(["group", "topic", "p2p"]);
const CHAT_TYPES: ReadonlySet<string> = new Set<FeishuChatType>(["group", "p2p"]);
const IDENTITIES: ReadonlySet<string> = new Set<FeishuIdentity>(["user", "bot", "none"]);
const TOKEN_STATUSES: ReadonlySet<string> = new Set<FeishuTokenStatus>(["valid", "expired", "missing"]);

export class FeishuClientError extends Error {
  readonly code: FeishuClientErrorCode;
  readonly detail: string;

  constructor(code: FeishuClientErrorCode, detail = "") {
    super(code);
    this.name = "FeishuClientError";
    this.code = code;
    this.detail = detail;
  }
}

export interface FeishuCliView {
  readonly found: boolean;
  readonly path: string;
  readonly version: string;
}

export interface FeishuAuthView {
  readonly identity: FeishuIdentity;
  readonly userName: string;
  readonly tokenStatus: FeishuTokenStatus;
  readonly loginCommand: string;
  readonly note: string;
}

export interface FeishuSummaryView {
  readonly groups: number;
  readonly p2p: number;
  readonly external: number;
  readonly atMe: number;
  readonly tasksOpen: number;
  readonly tasksDueToday: number;
  readonly tasksOverdue: number;
}

export interface FeishuChatView {
  readonly chatId: string;
  readonly name: string;
  readonly mode: FeishuChatMode;
  readonly external: boolean;
  readonly status: string;
  readonly ownerIdMasked: string;
  readonly peerName: string;
}

export interface FeishuAtMeView {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatName: string;
  readonly chatType: FeishuChatType;
  readonly senderName: string;
  readonly senderIdMasked: string;
  readonly createdAt: string;
  readonly preview: string;
  readonly deleted: boolean;
}

export interface FeishuTaskView {
  readonly guid: string;
  readonly summary: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly overdue: boolean;
  readonly dueToday: boolean;
}

/** 分区级诚实错误：只认字符串值，缺键/非字符串一律不出现在投影里。 */
export interface FeishuSectionErrors {
  readonly chats?: string;
  readonly atMe?: string;
  readonly tasks?: string;
}

/** GET /local/feishu(+refresh) 台账只读视图：三种 status 都带完整外壳，坏形态整包拒绝。 */
export interface FeishuLedgerView {
  readonly status: FeishuLedgerStatus;
  readonly updatedAt: string;
  readonly cli: FeishuCliView;
  readonly auth: FeishuAuthView;
  readonly summary: FeishuSummaryView;
  readonly chats: readonly FeishuChatView[];
  readonly atMe: readonly FeishuAtMeView[];
  readonly tasks: readonly FeishuTaskView[];
  readonly sectionErrors: FeishuSectionErrors;
}

/* ---------------- 基础工具 ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function localUrl(path: string): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(path, origin);
}

async function getJson(path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(new Request(localUrl(path), {
      method: "GET",
      signal: AbortSignal.timeout(FEISHU_GET_TIMEOUT_MS),
    }));
  } catch {
    throw new FeishuClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) ? payload.error : undefined;
    if (isRecord(error) && typeof error.code === "string" && KNOWN_CODES.has(error.code)) {
      throw new FeishuClientError(error.code as FeishuClientErrorCode, asText(error.message));
    }
    throw new FeishuClientError("unavailable");
  }
  if (!isRecord(payload.data)) throw new FeishuClientError("invalid_response");
  return payload.data;
}

/* ---------------- 投影（白名单：坏行丢弃，坏形状整包拒绝） ---------------- */

function asCli(value: unknown): FeishuCliView {
  const record = isRecord(value) ? value : {};
  return { found: record.found === true, path: asText(record.path), version: asText(record.version) };
}

function asAuth(value: unknown): FeishuAuthView {
  const record = isRecord(value) ? value : {};
  const identity = asText(record.identity);
  const tokenStatus = asText(record.tokenStatus);
  return {
    identity: IDENTITIES.has(identity) ? (identity as FeishuIdentity) : "none",
    userName: asText(record.userName),
    tokenStatus: TOKEN_STATUSES.has(tokenStatus) ? (tokenStatus as FeishuTokenStatus) : "missing",
    loginCommand: asText(record.loginCommand),
    note: asText(record.note),
  };
}

function asSummary(value: unknown): FeishuSummaryView {
  const record = isRecord(value) ? value : {};
  return {
    groups: asNumber(record.groups),
    p2p: asNumber(record.p2p),
    external: asNumber(record.external),
    atMe: asNumber(record.atMe),
    tasksOpen: asNumber(record.tasksOpen),
    tasksDueToday: asNumber(record.tasksDueToday),
    tasksOverdue: asNumber(record.tasksOverdue),
  };
}

function asChat(value: unknown): FeishuChatView | null {
  if (!isRecord(value) || !asText(value.chatId)) return null;
  const mode = asText(value.mode);
  return {
    chatId: asText(value.chatId),
    name: asText(value.name),
    mode: CHAT_MODES.has(mode) ? (mode as FeishuChatMode) : "group",
    external: value.external === true,
    status: asText(value.status),
    ownerIdMasked: asText(value.ownerIdMasked),
    peerName: asText(value.peerName),
  };
}

function asAtMe(value: unknown): FeishuAtMeView | null {
  if (!isRecord(value) || !asText(value.messageId)) return null;
  const chatType = asText(value.chatType);
  return {
    messageId: asText(value.messageId),
    chatId: asText(value.chatId),
    chatName: asText(value.chatName),
    chatType: CHAT_TYPES.has(chatType) ? (chatType as FeishuChatType) : "group",
    senderName: asText(value.senderName),
    senderIdMasked: asText(value.senderIdMasked),
    createdAt: asText(value.createdAt),
    preview: asText(value.preview),
    deleted: value.deleted === true,
  };
}

function asTask(value: unknown): FeishuTaskView | null {
  if (!isRecord(value) || !asText(value.guid)) return null;
  return {
    guid: asText(value.guid),
    summary: asText(value.summary),
    dueAt: asText(value.dueAt),
    createdAt: asText(value.createdAt),
    overdue: value.overdue === true,
    dueToday: value.dueToday === true,
  };
}

function asSectionErrors(value: unknown): FeishuSectionErrors {
  const record = isRecord(value) ? value : {};
  const out: { chats?: string; atMe?: string; tasks?: string } = {};
  if (typeof record.chats === "string") out.chats = record.chats;
  if (typeof record.atMe === "string") out.atMe = record.atMe;
  if (typeof record.tasks === "string") out.tasks = record.tasks;
  return out;
}

function asLedger(data: Record<string, unknown>): FeishuLedgerView {
  const status = asText(data.status);
  if (!LEDGER_STATUSES.has(status)) throw new FeishuClientError("invalid_response");
  return {
    status: status as FeishuLedgerStatus,
    updatedAt: asText(data.updatedAt),
    cli: asCli(data.cli),
    auth: asAuth(data.auth),
    summary: asSummary(data.summary),
    chats: (Array.isArray(data.chats) ? data.chats : [])
      .map(asChat)
      .filter((row): row is FeishuChatView => row !== null),
    atMe: (Array.isArray(data.atMe) ? data.atMe : [])
      .map(asAtMe)
      .filter((row): row is FeishuAtMeView => row !== null),
    tasks: (Array.isArray(data.tasks) ? data.tasks : [])
      .map(asTask)
      .filter((row): row is FeishuTaskView => row !== null),
    sectionErrors: asSectionErrors(data.sectionErrors),
  };
}

/* ---------------- 请求 ---------------- */

/** GET /local/feishu —— 台账只读白名单投影（缓存快照口径由桥侧决定）。 */
export async function fetchFeishuLedger(fetchImpl: typeof fetch = fetch): Promise<FeishuLedgerView> {
  return asLedger(await getJson("/local/feishu", fetchImpl));
}

/** GET /local/feishu/refresh —— 强制桥侧重新聚合 lark-cli 后返回同形状数据。 */
export async function fetchFeishuLedgerRefresh(fetchImpl: typeof fetch = fetch): Promise<FeishuLedgerView> {
  return asLedger(await getJson("/local/feishu/refresh", fetchImpl));
}

/** 错误码 → 可直接展示的中文诚实文案（缺失/未授权态都不粉饰）。 */
export function feishuErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    unavailable: "本地桥未启动或网络失败：请确认已在本机运行飞书台账桥后重试。",
    invalid_response: "本机服务返回了无法识别的飞书台账数据。",
    cli_missing: "未找到 lark-cli：按 FEISHU_CLI_PATH → ~/.qoderwork/bin/lark-cli → ~/.qwenworkcn/bin/lark-cli → PATH 顺序发现，请确认已安装后重试。",
    auth_required: "飞书 user 身份未授权或已过期：请在终端完成登录后刷新。",
    feishu_cli_failed: "本机 lark-cli 调用失败：请稍后重试或查看桥侧日志定位原因。",
    method_not_allowed: "请求方式不被本机服务接受。",
  };
  const code = error instanceof FeishuClientError ? error.code : "unavailable";
  const base = messages[code] ?? messages.unavailable;
  return composeErrorMessage(base, error instanceof FeishuClientError ? error.detail : "");
}
