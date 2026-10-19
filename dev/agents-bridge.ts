/**
 * Agents bridge (F7) — public entry, mirroring report-bridge.ts / health-bridge.ts:
 * implementation lives in ./agents/ and this file re-exports the public surface
 * so the router and tests can import from dev/agents-bridge.ts.
 */
export {
  AGENTLOOP_CONSOLE,
  AGENTLOOP_WRITES_NOTE,
  createAgentsBridge,
  findSourceField,
  maskAk,
  parsePortFile,
  scanPilotViews,
  WAKE_ENTRY_PATHS,
  WAKE_PROBE_TIMEOUT_MS,
  type AgentsBridge,
  type AgentsBridgeOptions,
} from "./agents/agents-bridge.ts";
export { AgentsBridgeError } from "./agents/agents-types.ts";
export type {
  AgentLoopStatusView,
  AgentLoopViewRow,
  AgentsErrorCode,
  AgentsWakeState,
  WakeDaemonStatus,
  WakeDaemonView,
  WakeEndpointLink,
  WakeEntryLink,
  WechatSnapshotSource,
  WechatSnapshotStats,
  WechatSnapshotView,
} from "./agents/agents-types.ts";
