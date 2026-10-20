/**
 * Guides bridge — public entry, mirroring report-bridge.ts / datasource-bridge.ts:
 * implementation lives in ./guides/ and this file re-exports the public surface
 * so the router and tests can import from dev/guides-bridge.ts.
 *
 * 接线提示（local-router.ts 禁改，由交付负责人挂接）：
 *   import { createGuidesBridge } from "./guides-bridge.ts";
 *   const guidesBridge = dependencies.guidesBridge ?? createGuidesBridge({...});
 *   const routed = await guidesBridge.handle(request); if (routed) return routed;
 * 路由表常量：GUIDES_ROUTES（GET /local/guides、POST /local/guide/check、POST /local/guide/act）。
 */
export { createGuidesBridge } from "./guides/guides-bridge.ts";
export {
  GUIDES_ROUTES,
  GuidesBridgeError,
} from "./guides/guides-types.ts";
export type {
  CapsView,
  GuideActResult,
  GuideCheckResult,
  GuideCommandRunner,
  GuideDefsView,
  GuideVerifyResult,
  GuidesBridge,
  GuidesBridgeOptions,
  GuidesErrorCode,
  ProvisionResult,
} from "./guides/guides-types.ts";
