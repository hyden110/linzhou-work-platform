/**
 * AgentLoop bridge — public entry, mirroring reply-bridge.ts / report-bridge.ts:
 * implementation lives in ./agentloop/ and this file re-exports the public surface
 * so the router and tests can import from dev/agentloop-bridge.ts.
 */
export { createAgentloopBridge, type AgentloopBridgeOptions } from "./agentloop/agentloop-bridge.ts";
export {
  AgentloopBridgeError,
  AGENTLOOP_API_VERSION,
  AGENTLOOP_CONSOLE,
  AGENTLOOP_CONSOLE_BASE,
  AGENTLOOP_DRY_TOKEN_TTL_MS,
  AGENTLOOP_MAX_UPSTREAM_BYTES,
  AGENTLOOP_PROBE_TIMEOUT_MS,
  AGENTLOOP_ROUTES,
  AGENTLOOP_SIGNATURE_METHOD,
  AGENTLOOP_TICKETS_TAIL,
  AGENTLOOP_TICKET_HOST,
  AGENTLOOP_TICKET_REGION,
  AGENTLOOP_TICKET_TIMEOUT_MS,
  AGENTLOOP_TICKET_TTL_SEC,
} from "./agentloop/agentloop-types.ts";
export type {
  AgentloopBridge,
  AgentloopCreds,
  AgentloopCredsView,
  AgentloopErrorCode,
  AgentloopProbeTarget,
  AgentloopRoute,
  AgentloopTestState,
  AgentloopTestView,
  AgentloopTicketAudit,
  AgentloopTicketConfirmView,
  AgentloopTicketDryView,
  AgentloopTicketRequestSummary,
  AgentloopTicketsView,
  SlsFetch,
  SlsFetchInit,
  SlsFetchResponse,
} from "./agentloop/agentloop-types.ts";
export {
  createAgentloopStore,
  DEFAULT_AGENTLOOP_DIR,
  projectTicketAudit,
  type AgentloopStore,
} from "./agentloop/agentloop-store.ts";
export {
  buildResource,
  buildStringToSign,
  maskAccessKey,
  maskTicket,
  sanitizeUpstreamDetail,
  signHmacSha1,
  validateCredentials,
} from "./agentloop/agentloop-model.ts";
export { createSlsClient, defaultSlsFetch, SlsRequestError, type SlsClient } from "./agentloop/agentloop-sls.ts";
