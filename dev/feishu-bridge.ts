/**
 * Feishu bridge（飞书办公台账）— public entry，照 wechat-bridge.ts / mcp-bridge.ts 先例：
 * 实现在 ./feishu/，本文件 re-export 公开面，路由与测试统一从 dev/feishu-bridge.ts 导入。
 */
export { createFeishuBridge } from "./feishu/feishu-bridge.ts";
export {
  createExecFileRunner,
  defaultFeishuCandidates,
  discoverFeishuCli,
  probeFeishuAuth,
  probeFeishuVersion,
  redactText,
  runReadonlyJson,
  type FeishuAuthProbe,
} from "./feishu/feishu-cli.ts";
export {
  buildFeishuSummary,
  extractFeishuRows,
  extractPreview,
  maskFeishuId,
  projectAtMeRows,
  projectChatRows,
  projectTaskRows,
  toEpochMs,
  truncatePreview,
} from "./feishu/feishu-project.ts";
export {
  FeishuBridgeError,
  FEISHU_ATME_ARGS,
  FEISHU_AUTH_ARGS,
  FEISHU_CACHE_TTL_MS,
  FEISHU_CHATS_ARGS,
  FEISHU_CLI_MAX_BUFFER,
  FEISHU_CLI_TIMEOUT_CODE,
  FEISHU_CLI_TIMEOUT_MS,
  FEISHU_LOGIN_COMMAND,
  FEISHU_MASK_PREFIX_CHARS,
  FEISHU_MASK_TAIL_CHARS,
  FEISHU_PREVIEW_CHARS,
  FEISHU_READONLY_COMMANDS,
  FEISHU_ROUTES,
  FEISHU_TASKS_ARGS,
  FEISHU_VERSION_ARGS,
} from "./feishu/feishu-types.ts";
export type {
  FeishuAtMeView,
  FeishuAuthView,
  FeishuBridge,
  FeishuBridgeOptions,
  FeishuChatMode,
  FeishuChatType,
  FeishuChatView,
  FeishuCliView,
  FeishuErrorCode,
  FeishuIdentity,
  FeishuLedgerStatus,
  FeishuLedgerView,
  FeishuRoute,
  FeishuRunner,
  FeishuSectionErrors,
  FeishuSummaryView,
  FeishuTaskView,
  FeishuTokenStatus,
} from "./feishu/feishu-types.ts";
