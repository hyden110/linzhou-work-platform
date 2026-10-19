/**
 * Shared types for the published-cases ledger bridge (F3) — read-only.
 * Ported semantics from base/sa-workbench tools/fetch/cases_fetch.js +
 * assets/models/cases-model.js:
 * - 一个「案例单元」= 发布根下一个一级目录（collection）或整仓（site）；
 * - 只存元数据（名称/别名/客户别名/最近发布/入口 URL），绝不读 HTML 正文；
 * - 缺配置 / 坏配置 / CLI 失败都如实呈现，绝不造数据。
 */

export type CasesChannelId = "code" | "oss";

export type CasesChannelState = "ok" | "degraded" | "error" | "unconfigured";

export interface CasesChannelStatus {
  readonly state: CasesChannelState;
  readonly note: string;
  readonly count: number;
}

/** code.repos[] 条目（sanitize 后）；mode 缺省 site，与参考实现一致。 */
export interface CasesRepoSpec {
  readonly repo: string;
  readonly mode: "site" | "collection";
  readonly publishDir: string;
  readonly exclude: readonly string[];
}

export interface CasesOssSpec {
  readonly bucket: string;
  readonly publicBase: string;
  readonly exclude: readonly string[];
}

export interface CasesConfig {
  readonly repos: readonly CasesRepoSpec[];
  readonly codeExclude: readonly string[];
  readonly oss: CasesOssSpec | null;
  readonly aliases: Readonly<Record<string, string>>;
  readonly custAliases: Readonly<Record<string, string>>;
}

/** 单渠道产出的原始案例（未跨源合并）；url 已是 http(s)，否则为空串。 */
export interface RawCase {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly src: CasesChannelId;
  readonly pageCount: number;
}

export interface CasesChannelResult {
  readonly state: CasesChannelState;
  readonly note: string;
  readonly raws: readonly RawCase[];
}

/** 投影到浏览器的白名单字段；不携带仓库内部路径细节以外的内容。 */
export interface PublishedCase {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly cust: string;
  readonly updatedAt: string;
  readonly entryUrl: string;
  readonly srcs: readonly string[];
  readonly pageCount: number;
}

export interface CasesSnapshot {
  readonly configured: boolean;
  readonly cases: readonly PublishedCase[];
  readonly channels: Readonly<Record<CasesChannelId, CasesChannelStatus>>;
  readonly fetchedAt: string;
}
