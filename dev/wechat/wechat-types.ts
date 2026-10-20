/**
 * Wechat bridge 类型与常量（微信办公台账：只读快照投影 + 本地绑定写）。
 * donor: base/sa-workbench data/wechat.json.example（快照形状）、tools/wxkey/build.js
 * （群/待办/@我/单聊口径）、scripts/lib/custorg.js（客户组织导入语义）——搬语义不搬代码。
 *
 * 红线：微信快照只读；消息正文只出 ≤24 字掩码；个人 wxid 不出桥（掩码指纹）；
 * bindings/custorg 是本地文件写（0600、原子、写前备份、单飞锁、append-only 审计）；
 * custorg 导入必须 dry→confirm 两步（confirm 严格 === token）；不触碰任何解密库/密钥。
 */

import type {
  WechatBindingEntry,
  WechatQrTreeView,
  WechatSnapshotView,
} from "../../src/lib/wechat-model.ts";

export type WechatErrorCode =
  | "wechat_invalid_request"
  | "binding_not_found"
  | "wechat_busy"
  | "confirm_mismatch"
  | "wechat_store_failed"
  | "wechat_unavailable"
  | "method_not_allowed";

export class WechatBridgeError extends Error {
  readonly code: WechatErrorCode;
  constructor(code: WechatErrorCode, message: string) {
    super(message);
    this.name = "WechatBridgeError";
    this.code = code;
  }
}

export const WECHAT_ROUTES = [
  { method: "GET", path: "/local/wechat", operation: "snapshot" },
  { method: "GET", path: "/local/wechat/bindings", operation: "bindings-list" },
  { method: "PUT", path: "/local/wechat/bindings", operation: "bindings-put" },
  { method: "DELETE", path: "/local/wechat/bindings", operation: "bindings-delete" },
  { method: "POST", path: "/local/wechat/custorg-import", operation: "custorg-import" },
  { method: "GET", path: "/local/wechat/custorg", operation: "custorg-list" },
  { method: "GET", path: "/local/wechat/tree", operation: "tree" },
] as const;
export type WechatRoute = (typeof WECHAT_ROUTES)[number];

/* ---------------- 掩码与校验上限 ---------------- */

/** 消息正文掩码预览上限（字）：桥与前端同一口径，绝不出全文。 */
export const WECHAT_MASK_PREVIEW_CHARS = 24;
/** 群 id 白名单形态：微信 chatroom id（数字/字母段 + @chatroom）。 */
export const WECHAT_GROUP_ID_PATTERN = /^[A-Za-z0-9_.\-]{1,64}@chatroom$/;
/** 客户键：非空、≤40 字（donor custorg LIMITS.customer 同口径）。 */
export const WECHAT_CUST_KEY_MAX = 40;
/** 每群最多绑定客户数（台账防膨胀）。 */
export const WECHAT_MAX_CUST_KEYS = 8;
/** 绑定备注上限（donor 页面 note 单行输入的量级）。 */
export const WECHAT_BIND_NOTE_MAX = 120;
/** custorg 导入文本上限：本地服务整机 body 上限 40KB，桥侧收敛到 32K 字符如实拒绝。 */
export const WECHAT_CUSTORG_MAX_TEXT = 32_000;
/** 请求体上限（与 dev/function-local-node.ts MAX_BODY_BYTES 对齐）。 */
export const WECHAT_MAX_BODY_BYTES = 40 * 1024;
/** custorg 台账上限（donor custorg DEF）。 */
export const WECHAT_CUSTORG_MAX_CUSTOMERS = 80;
export const WECHAT_CUSTORG_MAX_ROWS_PER_CUSTOMER = 60;
/** custorg 导入 token：sha256(规范化文本) 前 16 位十六进制。 */
export const WECHAT_TOKEN_PATTERN = /^[0-9a-f]{16}$/;

/* ---------------- bindings 台账 ---------------- */

export interface WechatAuditRow {
  readonly at: string;
  readonly op: "bind" | "unbind" | "custorg-import";
  readonly groupId: string;
  readonly custKeys: readonly string[];
  readonly note: string;
  readonly customers: number;
  readonly rows: number;
  readonly ok: boolean;
}

export interface WechatBindingsView {
  readonly updatedAt: string;
  readonly entries: readonly WechatBindingEntry[];
  readonly total: number;
  readonly auditTail: readonly WechatAuditRow[];
}

/* ---------------- custorg 导入（dry→confirm） ---------------- */

export interface WechatCustorgRow {
  readonly dept: string;
  readonly name: string;
  readonly title: string;
  readonly contact: string;
}

export interface WechatCustorgCustomer {
  readonly name: string;
  readonly items: readonly WechatCustorgRow[];
}

export interface WechatCustorgParseOk {
  readonly ok: true;
  readonly customers: Readonly<Record<string, WechatCustorgCustomer>>;
  readonly customerCount: number;
  readonly rowCount: number;
}

export interface WechatCustorgParseFail {
  readonly ok: false;
  readonly note: string;
}

export type WechatCustorgParseResult = WechatCustorgParseOk | WechatCustorgParseFail;

export interface WechatCustorgDiffEntry {
  readonly key: string;
  readonly incomingRows: number;
  readonly existingRows: number;
}

export interface WechatCustorgImportDry {
  readonly phase: "dry";
  readonly token: string;
  readonly customerCount: number;
  readonly rowCount: number;
  readonly willImport: readonly WechatCustorgDiffEntry[];
  readonly willOverwrite: readonly WechatCustorgDiffEntry[];
  readonly note: string;
}

export interface WechatCustorgImportConfirmed {
  readonly phase: "confirmed";
  readonly token: string;
  readonly customerCount: number;
  readonly rowCount: number;
  readonly totalCustomers: number;
  readonly totalRows: number;
  readonly updatedAt: string;
}

export type WechatCustorgImportResult = WechatCustorgImportDry | WechatCustorgImportConfirmed;

/* ---------------- custorg 台账读回（GET /local/wechat/custorg） ---------------- */

/** 台账里一个客户：key 为客户键（与绑定 custKeys 同口径），rows 为联系人明细。 */
export interface WechatCustorgLedgerEntry {
  readonly key: string;
  readonly name: string;
  readonly rows: readonly WechatCustorgRow[];
  readonly rowCount: number;
}

/** custorg 台账只读视图：空台账如实空数组（绝不编造样例数据）。 */
export interface WechatCustorgLedgerView {
  readonly updatedAt: string;
  readonly customers: readonly WechatCustorgLedgerEntry[];
  readonly totalCustomers: number;
  readonly totalRows: number;
}

/* ---------------- 桥公开面 ---------------- */

export interface WechatBridge {
  /** GET /local/wechat：快照白名单投影（缺失 → status:"missing" + 修复指引）。 */
  readonly snapshot: () => Promise<WechatSnapshotView>;
  /** GET /local/wechat/bindings：群↔客户绑定台账。 */
  readonly bindings: () => Promise<WechatBindingsView>;
  /** PUT /local/wechat/bindings：本地台账写（原子 0600 + 备份 + 单飞 + 审计）。 */
  readonly putBinding: (body: unknown) => Promise<WechatBindingsView>;
  /** DELETE /local/wechat/bindings：解绑（同上闸门）。 */
  readonly deleteBinding: (body: unknown) => Promise<WechatBindingsView>;
  /** POST /local/wechat/custorg-import：dry→confirm 两步导入。 */
  readonly custorgImport: (body: unknown) => Promise<WechatCustorgImportResult>;
  /** GET /local/wechat/custorg：本地客户组织台账只读回显（导入不是只写）。 */
  readonly custorg: () => Promise<WechatCustorgLedgerView>;
  /** GET /local/wechat/tree：qr-tree 分组只读。 */
  readonly tree: () => Promise<WechatQrTreeView>;
  /** 子路由闭环：非本桥路径返回 undefined，交回主路由。 */
  readonly handle: (request: Request) => Promise<Response | undefined>;
}

export type { WechatBindingEntry, WechatQrTreeView, WechatSnapshotView };
