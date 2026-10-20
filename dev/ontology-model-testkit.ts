/**
 * ontology-model_test 的共享测试基件（testkit）。
 *
 * 只承载测试侧常量与类型转发，绝不含实现逻辑：
 * - BASIS_SEED_COUNT_EXPECTED：donor assets/models/ontology-schema.js 种子规模
 *   （constraints 6 条、basis 4 种），用于锁定共享注册表没有被悄悄裁剪。
 * - 其余符号从 src/lib/ontology-types.ts 原样转发，测试文件只依赖本 testkit，
 *   便于以后统一替换测试入口。
 */

export const BASIS_SEED_COUNT_EXPECTED = { constraints: 6, basis: 4 } as const;

export { ONTOLOGY_ACTIONS } from "../src/lib/ontology-types.ts";
export type {
  AuditLine,
  EffectiveGraph,
  GraphNode,
  OntologyEdits,
} from "../src/lib/ontology-types.ts";
