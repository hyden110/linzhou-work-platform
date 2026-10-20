/**
 * Datasource bridge contracts — 数据源管理总表本地桥的错误码、路由表与视图契约。
 *
 * 路由表说明：dev/local-router.ts 属禁改文件，本桥自带 handle(request) 子路由并导出
 * DATASOURCE_ROUTES 常量供接线——集成方只需在 local-router 里
 * `const routed = await datasourceBridge.handle(request); if (routed) return routed;`
 * 即可挂载全部两条路由（405/错误映射都在子路由内闭环）。
 *
 * 错误分层：失败响应为 {ok:false, error:{code, message}}；code 为下方稳定错误码，
 * message 为可直接展示的中文文案（不含绝对路径、不含凭据，敌意输出先过 redactNote）。
 */

import type {
  Capability,
  Channel,
  ChannelId,
  DataSource,
  EnvSection,
  HealthGroup,
} from "../../src/lib/datasource-model.ts";

/** 稳定错误码：路由按 code 映射 400/405/409/502。 */
export type DataSourceErrorCode =
  | "datasource_invalid_request"
  | "datasource_busy"
  | "datasource_refresh_failed"
  | "datasource_unavailable"
  | "method_not_allowed";

export class DataSourceBridgeError extends Error {
  readonly code: DataSourceErrorCode;

  constructor(code: DataSourceErrorCode, message: string) {
    super(message);
    this.name = "DataSourceBridgeError";
    this.code = code;
  }
}

export const DATASOURCE_ROUTES = [
  { method: "GET", path: "/local/datasources", operation: "registry" },
  { method: "POST", path: "/local/datasources/refresh", operation: "refresh" },
] as const;

/* ---------- 每源状态（从既有桥产物派生，缺失即 missing 诚实标注） ---------- */

export type DataSourceState = "ok" | "stale" | "error" | "missing" | "static" | "unknown";

export interface DataSourceStatus {
  readonly state: DataSourceState;
  /** 判定通道说明（相对路径/产物名，绝无绝对路径、绝无凭据值）。 */
  readonly evidence: string;
  readonly fetchedAt: string | null;
}

export interface DataSourceView extends DataSource {
  readonly status: DataSourceStatus;
}

export interface RefreshGroupView {
  readonly id: string;
  readonly d: string;
  /** v2 是否接了刷新通道（cust/ops/ppl/leads/dingtalk）。 */
  readonly supported: boolean;
  /** unsupported 时的诚实原因；supported 时为 null。 */
  readonly reason: string | null;
  readonly sourceCount: number;
}

export interface DataSourceRegistryView {
  readonly version: string;
  readonly generatedAt: string;
  readonly channels: readonly Channel[];
  readonly groups: readonly RefreshGroupView[];
  readonly caps: readonly Capability[];
  readonly envSections: readonly EnvSection[];
  readonly healthGroups: readonly HealthGroup[];
  readonly sources: readonly DataSourceView[];
}

/* ---------- 组刷新 ---------- */

export type SourceRefreshState = "started" | "ok" | "failed" | "skipped";

export interface SourceRefreshResult {
  readonly sys: string;
  readonly state: SourceRefreshState;
  readonly detail: string;
}

export interface DataSourceRefreshView {
  readonly group: string;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly startedAt: string;
  readonly results: readonly SourceRefreshResult[];
}

/** 既有桥刷新函数的最小注入面（默认接真实桥实例）。 */
export interface RefreshStatusLike {
  readonly state: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly error?: string | null;
}

export interface DataSourceRefreshDeps {
  readonly crmStatus: () => RefreshStatusLike;
  readonly crmStart: () => RefreshStatusLike;
  readonly opsStatus: () => RefreshStatusLike;
  readonly opsStart: () => RefreshStatusLike;
  readonly pplStatus: () => RefreshStatusLike;
  readonly pplStart: () => RefreshStatusLike;
  readonly leadsRefresh: () => Promise<{ readonly summary: { readonly total: number; readonly open?: number; readonly radarAt?: string; readonly fetchedAt?: string } }>;
  readonly dingtalkStartSummary: () => Promise<{ readonly ok: boolean; readonly error?: string; readonly status: unknown; readonly reused: boolean }>;
}

/** 状态派生的只读产物探针（全部可注入；默认接真实桥的只读投影）。 */
export interface DataSourceProbes {
  readonly crmSnapshot: () => Promise<unknown | undefined>;
  readonly opsDigest: () => Promise<unknown | undefined>;
  readonly pplInspection: () => Promise<unknown | undefined>;
  readonly leadsSnapshot: () => Promise<unknown | undefined>;
  readonly kbSources: () => Promise<readonly unknown[]>;
  readonly dingtalkWrites: () => Promise<readonly unknown[]>;
  readonly healthSnapshot: () => Promise<unknown | undefined>;
  readonly ontologyGraph: () => Promise<unknown | undefined>;
}

export interface DataSourceBridgeOptions {
  readonly now?: () => number;
  readonly probes?: DataSourceProbes;
  readonly refreshDeps?: DataSourceRefreshDeps;
}

export interface DataSourceBridge {
  readonly registry: () => Promise<DataSourceRegistryView>;
  readonly refresh: (body: unknown) => Promise<DataSourceRefreshView>;
  readonly handle: (request: Request) => Promise<Response | undefined>;
}

export type { Channel, ChannelId, DataSource };
