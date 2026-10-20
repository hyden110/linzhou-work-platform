/**
 * MCP bridge — public entry, mirroring reply-bridge.ts / agentloop-bridge.ts:
 * implementation lives in ./mcp/ and this file re-exports the public surface
 * so the router and tests can import from dev/mcp-bridge.ts.
 */
export { createMcpBridge, type McpBridgeOptions } from "./mcp/mcp-bridge.ts";
export {
  McpBridgeError,
  MCP_AUDIT_TAIL,
  MCP_CHECK_BUDGET_MS,
  MCP_CHECK_CONCURRENCY,
  MCP_CONNECTOR_NAME_MAX,
  MCP_DRY_TOKEN_CAP,
  MCP_DRY_TOKEN_TTL_MS,
  MCP_HANDSHAKE_TIMEOUT_MS,
  MCP_HASH_HINT_CHARS,
  MCP_KEY_PATTERN,
  MCP_KEY_PREFIX,
  MCP_MAX_TEXT,
  MCP_ROUTES,
  MCP_SCOPES,
} from "./mcp/mcp-types.ts";
export type {
  McpAuditRow,
  McpBridge,
  McpCheckStatus,
  McpCheckView,
  McpChildHandle,
  McpConnectorCheckResult,
  McpConnectorOp,
  McpConnectorSourceView,
  McpConnectorSummary,
  McpConnectorTransport,
  McpConnectorView,
  McpConnectorsView,
  McpConfirmResult,
  McpDryResult,
  McpErrorCode,
  McpKeyCreateResult,
  McpKeyView,
  McpKeysView,
  McpRoute,
  McpScope,
  McpServiceState,
  McpSpawnFn,
  McpToggleResult,
} from "./mcp/mcp-types.ts";
export {
  createKeyStore,
  isValidScopes,
  keyViewOf,
  normalizeKeyDoc,
  sha256Hex,
  type McpKeyRecord,
  type McpKeyStore,
  type McpKeyStoreOptions,
} from "./mcp/mcp-keys.ts";
export { createAuditLog, projectAuditRow, type McpAuditInput, type McpAuditLog, type McpAuditLogOptions } from "./mcp/mcp-audit.ts";
export {
  CANONICAL_PROTOCOL_VERSION,
  createSessionStore,
  dispatch,
  errNote,
  parseMessage,
  pickMsg,
  rpcError,
  rpcResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  type DispatchContext,
  type DispatchTool,
  type DispatchToolDescriptor,
  type RpcFrame,
  type RpcMessage,
  type SessionRecord,
  type SessionStore,
} from "./mcp/mcp-protocol.ts";
export { buildMcpTools, mcpTextResult, scopesOf, type McpTool, type McpToolDeps } from "./mcp/mcp-tools.ts";
export {
  cleanDef,
  createConnectorRegistry,
  createNodeSpawn,
  defaultConnectorSources,
  type ConnectorRegistry,
  type ConnectorRegistryOptions,
  type ConnectorSourceSpec,
  type WritePlan,
} from "./mcp/mcp-connector.ts";
export { createRpcEndpoint, type RpcEndpoint, type RpcEndpointOptions } from "./mcp/mcp-rpc.ts";
export {
  maskArg,
  maskDef,
  maskKV,
  maskUrl,
  MCP_CONNECTOR_NAME_RE,
  redactTail,
  secretNames,
  tildePath,
  transportOf,
} from "./mcp/mcp-mask.ts";
