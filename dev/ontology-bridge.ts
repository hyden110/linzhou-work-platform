/**
 * Ontology bridge (F8) — public entry, mirroring report-bridge.ts / notify-bridge.ts:
 * implementation lives in ./ontology/ and this file re-exports the public surface
 * so the router wiring and tests can import from dev/ontology-bridge.ts.
 *
 * 接线提示（local-router.ts 属禁改文件，由交付负责人挂接）：
 *   import { createOntologyBridge } from "./ontology-bridge.ts";
 *   const ontologyBridge = dependencies.ontologyBridge ?? createOntologyBridge();
 *   // 在三条 /local/ontology* 路由处（或统一前置）：
 *   const routed = await ontologyBridge.handle(request);
 *   if (routed) return routed;
 * 路由表见 ONTOLOGY_ROUTES（GET /local/ontology、GET /local/ontology/graph、
 * POST /local/ontology/action）。
 */
export {
  createOntologyBridge,
} from "./ontology/ontology-bridge.ts";
export {
  createOntologyStore,
  DEFAULT_ONTOLOGY_DIR,
  type OntologyStore,
  type OntologyStoreDeps,
} from "./ontology/ontology-store.ts";
export {
  ONTOLOGY_AUDIT_TAIL,
  ONTOLOGY_ROUTES,
  OntologyBridgeError,
  type OntologyActionResponse,
  type OntologyBridge,
  type OntologyBridgeOptions,
  type OntologyErrorCode,
  type OntologyGraphResponse,
  type OntologyRoute,
  type OntologyStateView,
} from "./ontology/ontology-types.ts";
