/**
 * Environment health bridge (F4) — public entry, mirroring kb-bridge.ts /
 * cases-bridge.ts: implementation lives in ./health/ and this file re-exports
 * the public surface so the router and tests can import from dev/health-bridge.ts.
 */
export { createHealthBridge, type HealthBridge, type HealthBridgeOptions } from "./health/health-bridge.ts";
export type { HealthBridgeRow, HealthCapRow, HealthCliRow, HealthSnapshot } from "./health/health-types.ts";
export { redact, redactNote } from "./health/health-redact.ts";
