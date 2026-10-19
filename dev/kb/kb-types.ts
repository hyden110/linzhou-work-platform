/**
 * Shared types for the unified knowledge retrieval bridge (F2).
 * Ported semantics from base/sa-workbench scripts/lib/kb/*.js — read-only:
 * no adapter ever writes back to a knowledge source, and no customer data
 * ever leaves this machine (summary payloads carry title/path/snippet only).
 */

export type KbSourceType = "obsidian" | "dingtalk" | "bailian" | "aliyundoc";

export interface KbSpaceRef {
  readonly id: string;
  readonly name: string;
}

export interface KbIndexRef {
  readonly id: string;
  readonly name: string;
}

interface KbSourceBase {
  readonly id: string;
  readonly type: KbSourceType;
  readonly name: string;
  readonly enabled: boolean;
  readonly weight?: number;
}

export interface KbObsidianSource extends KbSourceBase {
  readonly type: "obsidian";
  readonly vault: string;
  readonly dirs: readonly string[];
}

export interface KbDingtalkSource extends KbSourceBase {
  readonly type: "dingtalk";
  readonly spaces: readonly KbSpaceRef[];
  readonly enterprise: boolean;
}

export interface KbBailianSource extends KbSourceBase {
  readonly type: "bailian";
  readonly profile: string;
  readonly region: string;
  readonly workspaceId: string;
  readonly indices: readonly KbIndexRef[];
}

export interface KbAliyundocSource extends KbSourceBase {
  readonly type: "aliyundoc";
  readonly site: "cn" | "intl";
  readonly lang: string;
  readonly products: readonly KbIndexRef[];
}

export type KbSource = KbObsidianSource | KbDingtalkSource | KbBailianSource | KbAliyundocSource;

export interface KbSummaryConfig {
  readonly model: string;
  readonly topN: number;
}

export interface KbConfig {
  readonly sources: readonly KbSource[];
  readonly summary: KbSummaryConfig;
}

export interface KbSpace {
  readonly id: string;
  readonly name: string;
  readonly leaf: boolean;
  readonly count?: number;
}

/** One adapter hit before fusion. `key` dedupes the same document across sources. */
export interface KbAdapterHit {
  readonly sourceId: string;
  readonly type: KbSourceType;
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly space: string;
  readonly path?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly score?: number;
  readonly rank?: number;
}

export interface KbDoc {
  readonly title: string;
  readonly format: "md" | "text";
  readonly body: string;
  readonly url: string;
}

/** Uniform public shape projected at the bridge boundary; never carries absolute paths. */
export interface KbHit {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly type: KbSourceType;
  readonly id: string;
  readonly title: string;
  readonly space: string;
  readonly path: string;
  readonly url: string;
  readonly snippet: string;
  readonly rank: number;
  readonly score: number;
}

export interface KbSourceStatus {
  readonly sourceId: string;
  readonly name: string;
  readonly type: KbSourceType;
  readonly ok: boolean;
  readonly n: number;
  readonly ms: number;
  readonly note?: string;
}

export interface KbSearchOutcome {
  readonly q: string;
  readonly hits: readonly KbHit[];
  readonly status: readonly KbSourceStatus[];
}

export interface KbSourceView {
  readonly id: string;
  readonly type: KbSourceType;
  readonly name: string;
  readonly label: string;
  readonly ok: boolean;
  readonly spaces: readonly KbSpace[];
  readonly note?: string;
}

/** Summary request input after client-side whitelisting — title/path/snippet only, no customer fields. */
export interface KbSummaryHit {
  readonly sourceId: string;
  readonly id: string;
  readonly title: string;
  readonly space: string;
  readonly source: string;
  readonly snippet: string;
}

export interface KbSummaryResult {
  readonly answer: string;
  readonly ms: number | null;
  readonly degraded: false;
}

/** Typed failure so routes can map to safe HTTP codes without leaking internals. */
export class KbBridgeError extends Error {
  readonly code: "source_not_found" | "kb_read_failed" | "kb_summary_failed" | "invalid_source";

  constructor(code: KbBridgeError["code"], message?: string) {
    super(message ?? code);
    this.name = "KbBridgeError";
    this.code = code;
  }
}
