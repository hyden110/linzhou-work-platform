/**
 * Feishu bridge 类型与常量（飞书办公台账：只读本机 lark-cli 聚合投影）。
 *
 * 红线：本桥只读——绝不构造/执行任何写、发信、登录类命令（auth login、
 * messages-send 等一律进不了命令闸门）；登录由用户自己在终端完成，桥只给
 * loginCommand 指引。auth 过期/缺失是一等公民诚实态（status:"auth_required"），
 * CLI 找不到 → status:"cli_missing"，绝不伪造数据。个人 open_id/owner_id/
 * p2p_target_id 一律掩码指纹不出桥（姓名保留）；消息正文只出 ≤60 字预览；
 * 错误消息中文、不含服务器绝对路径、不含 token/凭据。
 *
 * data 形状与 src/lib/feishu-client.ts（前端白名单投影）共用契约，字段名一致。
 */

export type FeishuErrorCode = "method_not_allowed" | "feishu_unavailable";

export class FeishuBridgeError extends Error {
  readonly code: FeishuErrorCode;
  constructor(code: FeishuErrorCode, message: string) {
    super(message);
    this.name = "FeishuBridgeError";
    this.code = code;
  }
}

export const FEISHU_ROUTES = [
  { method: "GET", path: "/local/feishu", operation: "aggregate" },
  { method: "GET", path: "/local/feishu/refresh", operation: "refresh" },
] as const;
export type FeishuRoute = (typeof FEISHU_ROUTES)[number];

/* ---------------- CLI 契约（离线核对过 --help：v1.0.45.1） ---------------- */

/** lark-cli 子进程硬超时（毫秒）。 */
export const FEISHU_CLI_TIMEOUT_MS = 25_000;
/** stdout/stderr 缓冲上限（4MB）。 */
export const FEISHU_CLI_MAX_BUFFER = 4 * 1024 * 1024;
/** 默认 runner 的超时约定退出码（GNU timeout 同款语义）。 */
export const FEISHU_CLI_TIMEOUT_CODE = 124;
/** 聚合视图缓存 TTL（毫秒）：GET /local/feishu 复用，refresh 破缓存。 */
export const FEISHU_CACHE_TTL_MS = 300_000;

export const FEISHU_VERSION_ARGS = ["--version"] as const;
export const FEISHU_AUTH_ARGS = ["auth", "status"] as const;
export const FEISHU_CHATS_ARGS = [
  "im", "+chat-list", "--as", "user",
  "--types", "p2p,group", "--sort-type", "ByActiveTimeDesc",
  "--page-size", "50", "--format", "json",
] as const;
export const FEISHU_ATME_ARGS = [
  "im", "+messages-search", "--as", "user", "--is-at-me",
  "--query", "", "--page-size", "20", "--format", "json",
] as const;
export const FEISHU_TASKS_ARGS = [
  "task", "+get-my-tasks", "--complete=false", "--page-limit", "2", "--format", "json",
] as const;

/**
 * 只读命令闸门白名单：runSection 只放行下列 argv（join 后精确匹配），
 * 任何写/发信/登录命令（auth login、+send 等）在构造层就不可能存在。
 */
export const FEISHU_READONLY_COMMANDS: readonly string[] = [
  [...FEISHU_VERSION_ARGS].join(" "),
  [...FEISHU_AUTH_ARGS].join(" "),
  [...FEISHU_CHATS_ARGS].join(" "),
  [...FEISHU_ATME_ARGS].join(" "),
  [...FEISHU_TASKS_ARGS].join(" "),
];

/** auth_required 时给用户的可复制登录命令（桥绝不代跑；--no-wait/--scope 已核对 --help）。 */
export const FEISHU_LOGIN_COMMAND =
  'lark-cli auth login --scope "im:chat:read im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user task:task:read contact:user.base:readonly offline_access" --no-wait';

/* ---------------- 投影上限 ---------------- */

/** 消息预览截断上限（字符）：超出加 …，全文绝不出桥。 */
export const FEISHU_PREVIEW_CHARS = 60;
/** id 掩码保留的前缀字符数（如 "ou"）。 */
export const FEISHU_MASK_PREFIX_CHARS = 2;
/** id 掩码保留的末尾字符数（如 "abcd12"）。 */
export const FEISHU_MASK_TAIL_CHARS = 6;
/** section 错误里允许的脱敏细节长度上限。 */
export const FEISHU_SECTION_NOTE_DETAIL_CHARS = 160;

/* ---------------- 视图契约（与 src/lib/feishu-client.ts 同形状） ---------------- */

export type FeishuLedgerStatus = "ok" | "auth_required" | "cli_missing";
export type FeishuChatMode = "group" | "topic" | "p2p";
export type FeishuChatType = "group" | "p2p";
export type FeishuIdentity = "user" | "bot" | "none";
export type FeishuTokenStatus = "valid" | "expired" | "missing";

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

/** 分区级诚实错误：仅失败区出现在键上（成功区不占键）。 */
export interface FeishuSectionErrors {
  readonly chats?: string;
  readonly atMe?: string;
  readonly tasks?: string;
}

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

/* ---------------- 桥公开面 ---------------- */

/** 注入式命令 runner：只收 argv（二进制路径由桥发现后绑定），测试全合成。 */
export type FeishuRunner = (
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface FeishuBridgeOptions {
  /** 注入 runner（缺省 execFile 跑发现到的 lark-cli；测试注入全合成结果）。 */
  readonly runner?: FeishuRunner;
  /** CLI 发现候选（缺省 FEISHU_CLI_PATH → ~/.qoderwork → ~/.qwenworkcn → PATH）。 */
  readonly candidates?: readonly string[];
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

export interface FeishuBridge {
  /** GET /local/feishu：聚合视图（TTL 缓存 + 单飞）。 */
  readonly aggregate: () => Promise<FeishuLedgerView>;
  /** GET /local/feishu/refresh：清缓存重跑，返回同形状。 */
  readonly refresh: () => Promise<FeishuLedgerView>;
  /** 子路由闭环：非本桥路径返回 undefined，交回主路由。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}
