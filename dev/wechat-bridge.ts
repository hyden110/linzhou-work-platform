/**
 * Wechat bridge（微信办公台账）— public entry，照 reply-bridge.ts / worklog-bridge.ts 先例：
 * 实现在 ./wechat/，本文件 re-export 公开面，路由与测试统一从 dev/wechat-bridge.ts 导入。
 */
export { createWechatBridge, type WechatBridgeOptions } from "./wechat/wechat-bridge.ts";
export {
  WechatBridgeError,
  WECHAT_BIND_NOTE_MAX,
  WECHAT_CUSTORG_MAX_TEXT,
  WECHAT_GROUP_ID_PATTERN,
  WECHAT_MASK_PREVIEW_CHARS,
  WECHAT_MAX_CUST_KEYS,
  WECHAT_ROUTES,
  WECHAT_TOKEN_PATTERN,
} from "./wechat/wechat-types.ts";
export type {
  WechatAuditRow,
  WechatBindingsView,
  WechatBridge,
  WechatCustorgImportResult,
  WechatErrorCode,
  WechatRoute,
} from "./wechat/wechat-types.ts";
export { createWechatStore, DEFAULT_WECHAT_DIR, type WechatStore } from "./wechat/wechat-store.ts";
export { maskPreview, maskWxid, WECHAT_MISSING_STEPS } from "./wechat/wechat-snapshot.ts";
export { custorgToken, parseCustorgImport } from "./wechat/wechat-custorg.ts";
