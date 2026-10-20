/**
 * Environment health bridge (F4) — public entry, mirroring kb-bridge.ts /
 * cases-bridge.ts: implementation lives in ./health/ and this file re-exports
 * the public surface so the router and tests can import from dev/health-bridge.ts.
 *
 * 接线提示（local-router.ts 禁改，由交付负责人挂接）：GET /local/health 的既有
 * 显式接线保持不动；新增两条 POST 路由用子路由模式挂载——
 *   const routed = await healthBridge.handle(request); if (routed) return routed;
 * 路由表常量：HEALTH_ROUTES（POST /local/health/check、POST /local/health/renew）。
 */
export { createHealthBridge, type HealthBridge, type HealthBridgeOptions } from "./health/health-bridge.ts";
export { HEALTH_ROUTES, HealthBridgeError } from "./health/health-types.ts";
export type {
  HealthBridgeRow,
  HealthCapRow,
  HealthCheckSnapshot,
  HealthCliRow,
  HealthErrorCode,
  HealthGroupName,
  HealthGroupCheckedAt,
  HealthRenewResult,
  HealthRenewRow,
  HealthRenewState,
  HealthSnapshot,
} from "./health/health-types.ts";
export { redact, redactNote } from "./health/health-redact.ts";
