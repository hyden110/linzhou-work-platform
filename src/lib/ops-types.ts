/** Ops digest contracts mirrored from dev/ops-bridge.ts (the browser never imports dev code). */

export type OpsSourceType = "blog" | "changelog" | "announcement" | "qianzai";

export interface OpsSourceStatus {
  readonly status: "ok" | "partial" | "error" | "auth_required" | "missing";
  readonly error: string | null;
  readonly fetchedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly count: number;
  readonly complete: boolean;
  readonly stale: boolean;
}

export interface OpsItem {
  readonly id: string;
  readonly sourceType: OpsSourceType;
  readonly source: string;
  readonly title: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly summary: string | null;
  readonly kind: string | null;
}

export interface OpsDigest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly readOnly: boolean;
  readonly sources: Record<string, OpsSourceStatus>;
  readonly items: readonly OpsItem[];
}

export interface OpsRefreshStatus {
  readonly state: "idle" | "running" | "succeeded" | "failed";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface OpsCardEntry {
  readonly title: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly source: string;
  readonly sourceType: OpsSourceType;
  readonly kind: string | null;
  readonly summary: string | null;
}

export interface OpsCardGroup {
  readonly key: OpsSourceType;
  readonly label: string;
  readonly count: number;
  readonly items: readonly OpsCardEntry[];
}

export interface OpsCard {
  readonly date: string;
  readonly generatedAt: string;
  readonly total: number;
  readonly dedupedFrom: number;
  readonly overview: { readonly kind: "ai" | "template"; readonly text: string; readonly note: string };
  readonly groups: readonly OpsCardGroup[];
}

export interface OpsWechatLink {
  readonly id: string;
  readonly url: string;
  readonly registeredAt: string;
  readonly status: "registered" | "fetched" | "fetch_failed";
  readonly note: string;
  readonly title: string | null;
}
