/**
 * Datasource bridge — public entry, mirroring report-bridge.ts / health-bridge.ts:
 * implementation lives in ./datasource/ and this file re-exports the public
 * surface so the router and tests can import from dev/datasource-bridge.ts.
 *
 * 接线提示（local-router.ts 禁改，由交付负责人挂接）：
 *   import { createDataSourceBridge } from "./datasource-bridge.ts";
 *   const datasourceBridge = dependencies.datasourceBridge ?? createDataSourceBridge({...});
 *   const routed = await datasourceBridge.handle(request); if (routed) return routed;
 * 路由表常量：DATASOURCE_ROUTES（GET /local/datasources、POST /local/datasources/refresh）。
 */
export { createDataSourceBridge } from "./datasource/datasource-bridge.ts";
export {
  DATASOURCE_ROUTES,
  DataSourceBridgeError,
} from "./datasource/datasource-types.ts";
export type {
  DataSourceBridge,
  DataSourceBridgeOptions,
  DataSourceErrorCode,
  DataSourceProbes,
  DataSourceRefreshDeps,
  DataSourceRefreshView,
  DataSourceRegistryView,
  DataSourceState,
  DataSourceStatus,
  DataSourceView,
  RefreshGroupView,
  SourceRefreshResult,
} from "./datasource/datasource-types.ts";
