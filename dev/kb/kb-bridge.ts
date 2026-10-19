import { join as joinPath, resolve as resolvePath } from "node:path";

import { createDefaultKbRunner, type KbAdapter, type KbAdapterContext, type KbCommandRunner } from "./kb-adapter-shared.ts";
import { createAliyundocAdapter } from "./kb-aliyundoc.ts";
import { createBailianAdapter } from "./kb-bailian.ts";
import { loadKbConfig } from "./kb-config.ts";
import { createDingtalkAdapter } from "./kb-dingtalk.ts";
import { createObsidianAdapter } from "./kb-obsidian.ts";
import { createKbSummarizer } from "./kb-summary.ts";
import { KbBridgeError } from "./kb-types.ts";
import type {
  KbAdapterHit,
  KbConfig,
  KbDoc,
  KbHit,
  KbSearchOutcome,
  KbSource,
  KbSourceType,
  KbSourceStatus,
  KbSourceView,
  KbSpace,
  KbSummaryHit,
  KbSummaryResult,
} from "./kb-types.ts";
import { snippetOf, terms, trunc } from "./kb-util.ts";

/**
 * 统一知识检索桥（F2）：多源扇出 + RRF 融合 + 摘要。
 * Ported semantics from base/sa-workbench scripts/lib/kb/index.js:
 * - 各源分数口径不可比，按名次融合：score = Σ weight / (60 + rank)；同一 key（同一文档）跨路命中累加；
 * - 单源超时（默认 25s）只影响该源状态，不拖垮其余源；
 * - 只读：不写回任何知识库；对外投影为白名单字段，绝对路径不出桥。
 */

export const RRF_K = 60;

/* kb-bridge.ts 位于 dev/kb/，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_KB_CONFIG_PATH = joinPath(PROJECT_ROOT, ".local-cache", "kb.json");

const SEARCH_TIMEOUT_MS = 25_000;
const ENRICH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 180_000;
const MAX_FUSED_HITS = 40;
const DEFAULT_SEARCH_K = 10;
const MAX_SUMMARY_QUERY_CHARS = 200;

export interface KbBridgeOptions {
  readonly configPath?: string;
  readonly searchTimeoutMs?: number;
  readonly enrichTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly summaryTimeoutMs?: number;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly run?: KbCommandRunner;
  /** Test seam: replace built-in adapters (fake adapters never touch CLI/network). */
  readonly adapters?: Partial<Record<KbSourceType, KbAdapter>>;
}

export interface KbBridge {
  readonly config: () => Promise<KbConfig>;
  readonly sources: () => Promise<readonly KbSourceView[]>;
  readonly search: (query: string, only?: readonly string[], k?: number) => Promise<KbSearchOutcome>;
  readonly read: (sourceId: string, id: string) => Promise<KbDoc>;
  readonly summary: (query: string, hits: readonly unknown[]) => Promise<KbSummaryResult>;
}

export type RrfHit = KbAdapterHit & { readonly srcScore: number; readonly score: number };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`超时（${Math.max(Math.round(ms / 1000), 1)}s）· ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 各源分数口径不可比，按名次融合：score = Σ weight / (60 + rank)。
 * 同一 key（同一文档）跨路命中累加，snippet 取首个非空。
 */
export function rrfFuse(
  lists: readonly { readonly sourceId: string; readonly hits: readonly KbAdapterHit[] }[],
  weights: Readonly<Record<string, number>>,
): RrfHit[] {
  const byKey = new Map<string, RrfHit>();
  for (const { sourceId, hits } of lists) {
    const weight = weights[sourceId] ?? 1;
    for (const candidate of hits) {
      const contribution = weight / (RRF_K + (candidate.rank ?? 1));
      const existing = byKey.get(candidate.key);
      if (existing) {
        existing.score += contribution;
        if (!existing.snippet && candidate.snippet) existing.snippet = candidate.snippet;
        continue;
      }
      byKey.set(candidate.key, { ...candidate, srcScore: candidate.score ?? 0, score: contribution });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

/** Adapter hits → public whitelist shape. Anything not listed here cannot reach the browser. */
function projectHit(fused: RrfHit, sourceName: string, position: number): KbHit {
  return {
    sourceId: String(fused.sourceId ?? "").slice(0, 40),
    sourceName: sourceName.slice(0, 60),
    type: fused.type,
    id: String(fused.id ?? "").slice(0, 1024),
    title: trunc(fused.title, 200),
    space: trunc(fused.space ?? "", 80),
    path: trunc(fused.path ?? "", 200),
    url: typeof fused.url === "string" && /^https?:\/\//.test(fused.url) ? fused.url : "",
    snippet: trunc(fused.snippet ?? "", 300),
    rank: position + 1,
    score: Number.isFinite(fused.score) ? fused.score : 0,
  };
}

/** 摘要输入白名单：只保留 标题/路径/摘要片段 等展示字段，客户数据在此物理不可达。 */
function sanitizeSummaryHit(raw: unknown): KbSummaryHit | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const title = String(record.title ?? "").slice(0, 200);
  const snippet = String(record.snippet ?? "").slice(0, 1000);
  if (!title && !snippet) return null;
  return {
    sourceId: String(record.sourceId ?? "").slice(0, 40),
    id: String(record.id ?? "").slice(0, 1024),
    title,
    space: String(record.space ?? "").slice(0, 120),
    source: String(record.source ?? record.sourceName ?? "").slice(0, 60),
    snippet,
  };
}

export function createKbBridge(options: KbBridgeOptions = {}): KbBridge {
  const configPath = options.configPath ?? DEFAULT_KB_CONFIG_PATH;
  const now = options.now ?? Date.now;
  const run = options.run ?? createDefaultKbRunner();
  const context: KbAdapterContext = { run, fetchImpl: options.fetchImpl ?? fetch, now };
  const adapters: Record<KbSourceType, KbAdapter> = {
    obsidian: createObsidianAdapter({ now }),
    dingtalk: createDingtalkAdapter({ run }),
    bailian: createBailianAdapter({ run }),
    aliyundoc: createAliyundocAdapter({ fetchImpl: context.fetchImpl, now }),
    ...options.adapters,
  };
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const enrichTimeoutMs = options.enrichTimeoutMs ?? ENRICH_TIMEOUT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const summaryTimeoutMs = options.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS;

  const summarizeWith = (model: string) => createKbSummarizer({ run, model, timeoutMs: summaryTimeoutMs });

  const loadSources = async (): Promise<KbSource[]> => {
    const config = await loadKbConfig(configPath);
    return config.sources.filter((source) => source.enabled && Boolean(adapters[source.type]));
  };

  /** Reference semantics: a non-empty `only` (even fully-invalid) restricts the fan-out. */
  const pickForSearch = async (only?: readonly string[]): Promise<KbSource[]> => {
    const enabled = await loadSources();
    if (!only) return enabled;
    return enabled.filter((source) => only.includes(source.id));
  };

  return {
    config: () => loadKbConfig(configPath),

    sources: async () => {
      const config = await loadKbConfig(configPath);
      const enabled = config.sources.filter((source) => Boolean(adapters[source.type]));
      return Promise.all(enabled.map(async (source): Promise<KbSourceView> => {
        const adapter = adapters[source.type];
        const base = { id: source.id, type: source.type, name: source.name, label: adapter.label };
        try {
          const spaces: KbSpace[] = [...await withTimeout(adapter.spaces(source), searchTimeoutMs, source.name)];
          return { ...base, ok: true, spaces };
        } catch (error) {
          return {
            ...base,
            ok: false,
            spaces: [],
            note: trunc(error instanceof Error ? error.message : String(error), 200),
          };
        }
      }));
    },

    search: async (rawQuery, only, k = DEFAULT_SEARCH_K) => {
      const query = String(rawQuery ?? "").trim();
      if (!query) return { q: query, hits: [], status: [] };
      const selected = await pickForSearch(only?.filter((id) => id).slice(0, 10));
      const statuses: KbSourceStatus[] = [];
      const lists: { sourceId: string; hits: KbAdapterHit[] }[] = [];
      const weights: Record<string, number> = {};
      await Promise.all(selected.map(async (source) => {
        const startedAt = now();
        weights[source.id] = source.weight ?? 1;
        try {
          const hits = await withTimeout(
            Promise.resolve(adapters[source.type].search(source, query, k)),
            searchTimeoutMs,
            source.name,
          );
          lists.push({ sourceId: source.id, hits: hits.map((hit) => ({ ...hit, sourceId: source.id })) });
          statuses.push({ sourceId: source.id, name: source.name, type: source.type, ok: true, n: hits.length, ms: now() - startedAt });
        } catch (error) {
          statuses.push({
            sourceId: source.id,
            name: source.name,
            type: source.type,
            ok: false,
            n: 0,
            ms: now() - startedAt,
            note: trunc(error instanceof Error ? error.message : String(error), 200),
          });
        }
      }));
      const order = new Map(selected.map((source, index) => [source.id, index]));
      statuses.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));
      const nameById = new Map(selected.map((source) => [source.id, source.name]));
      const hits = rrfFuse(lists, weights)
        .slice(0, MAX_FUSED_HITS)
        .map((fused, position) => projectHit(fused, nameById.get(fused.sourceId) ?? "", position));
      return { q: query, hits, status: statuses };
    },

    read: async (sourceId, id) => {
      const config = await loadKbConfig(configPath);
      const source = config.sources.find((candidate) => candidate.id === sourceId && Boolean(adapters[candidate.type]));
      if (!source) throw new KbBridgeError("source_not_found");
      try {
        return await withTimeout(Promise.resolve(adapters[source.type].read(source, String(id ?? "").slice(0, 1024))), readTimeoutMs, source.name);
      } catch (error) {
        if (error instanceof KbBridgeError) throw error;
        throw new KbBridgeError("kb_read_failed", trunc(error instanceof Error ? error.message : String(error), 300));
      }
    },

    summary: async (rawQuery, rawHits) => {
      const query = String(rawQuery ?? "").trim().slice(0, MAX_SUMMARY_QUERY_CHARS);
      const config = await loadKbConfig(configPath);
      const hits = (Array.isArray(rawHits) ? rawHits : [])
        .slice(0, config.summary.topN)
        .map(sanitizeSummaryHit)
        .filter((hit): hit is KbSummaryHit => hit !== null);
      if (!query || !hits.length) throw new KbBridgeError("kb_summary_failed", "缺少问题或检索片段");

      /* 总结前补全文：命中片段常很短，读正文后取命中词附近 800 字；失败沿用原片段。 */
      const enabled = await loadSources();
      const enriched = await Promise.all(hits.map(async (hit): Promise<KbSummaryHit> => {
        const source = enabled.find((candidate) => candidate.id === hit.sourceId);
        if (!source || !hit.id) return hit;
        try {
          const doc = await withTimeout(Promise.resolve(adapters[source.type].read(source, hit.id)), enrichTimeoutMs, source.name);
          if (!doc?.body) return hit;
          return { ...hit, snippet: snippetOf(doc.body.replace(/^---[\s\S]*?\n---/, ""), terms(query), 800) };
        } catch {
          return hit; /* 保留原片段 */
        }
      }));

      try {
        return await summarizeWith(config.summary.model).summarize(query, enriched);
      } catch (error) {
        throw new KbBridgeError("kb_summary_failed", trunc(error instanceof Error ? error.message : String(error), 300));
      }
    },
  };
}
