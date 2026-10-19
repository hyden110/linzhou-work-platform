import { createHash } from "node:crypto";

import type { KbAdapter, KbAdapterContext } from "./kb-adapter-shared.ts";
import { runCliJson } from "./kb-adapter-shared.ts";
import type {
  KbAdapterHit,
  KbBailianSource,
  KbDoc,
  KbSpace,
} from "./kb-types.ts";
import { trunc } from "./kb-util.ts";

/**
 * 百炼知识库（aliyun CLI retrieve 只读，最小移植）。
 * Ported semantics from base/sa-workbench scripts/lib/kb/bailian.js:
 * 召回切片只在检索时拿得到全文 → 内存缓存最近 500 条供 read 预览；过期如实报错。
 * 本机当前配置未启用百炼（无 workspaceId/indices），适配器保持禁用态即可。
 */

const CLI_TIMEOUT_MS = 25_000;
const ALIYUN_BIN = "aliyun";
const MAX_CACHED_CHUNKS = 500;
const MAX_BODY = 200 * 1024;

export interface BailianAdapterOptions {
  readonly run?: KbAdapterContext["run"];
}

interface BailianNode {
  readonly Text?: unknown;
  readonly Score?: unknown;
  readonly Metadata?: unknown;
}

/** 召回切片内存缓存：id → {title, body, hier}，容量 500，先进先出。 */
export function createChunkCache() {
  const chunks = new Map<string, { title: string; body: string; hier: string }>();
  return {
    remember(id: string, value: { title: string; body: string; hier: string }): void {
      if (chunks.has(id)) chunks.delete(id);
      chunks.set(id, value);
      while (chunks.size > MAX_CACHED_CHUNKS) {
        const oldest = chunks.keys().next().value;
        if (oldest === undefined) break;
        chunks.delete(oldest);
      }
    },
    get(id: string) {
      return chunks.get(String(id));
    },
  };
}

export function createBailianAdapter(options: BailianAdapterOptions = {}): KbAdapter {
  const run = options.run;
  if (!run) throw new Error("bailian 适配器需要注入 run");
  const chunks = createChunkCache();

  const call = async (cmd: string, args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const payload = await runCliJson(run, ALIYUN_BIN, ["bailian", cmd, ...args], timeoutMs, "未找到 aliyun CLI");
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const success = record.Success;
    const code = record.Code;
    if (success === false || (typeof code === "string" && code !== "Success" && !record.Data)) {
      throw new Error(typeof record.Message === "string" && record.Message ? record.Message : "aliyun 调用失败");
    }
    return record.Data && typeof record.Data === "object" && !Array.isArray(record.Data)
      ? record.Data as Record<string, unknown>
      : {};
  };

  const baseArgs = (source: KbBailianSource): string[] => [
    ...(source.profile ? ["--profile", source.profile] : []),
    ...(source.region ? ["--region", source.region] : []),
  ];

  return {
    type: "bailian",
    label: "百炼知识库",

    spaces: async (rawSource) => {
      const source = rawSource as KbBailianSource;
      const spaces: KbSpace[] = (source.indices ?? []).map((index) => ({ id: index.id, name: index.name || index.id, leaf: true }));
      return spaces;
    },

    search: async (rawSource, query, k) => {
      const source = rawSource as KbBailianSource;
      const jobs = (source.indices ?? []).map(async (index) => {
        const data = await call("retrieve", [
          "--workspace-id", source.workspaceId,
          "--index-id", index.id,
          "--query", query,
          "--dense-similarity-topk", String(Math.min(k * 2, 100)),
          ...baseArgs(source),
        ], CLI_TIMEOUT_MS);
        const nodes = Array.isArray(data.Nodes) ? data.Nodes as BailianNode[] : [];
        return nodes.slice(0, k).map((node, position): KbAdapterHit => {
          const text = String(node.Text ?? "");
          const metadata = node.Metadata && typeof node.Metadata === "object" ? node.Metadata as Record<string, unknown> : {};
          const id = `${index.id}:${createHash("sha1").update(text).digest("hex").slice(0, 16)}`;
          const title = typeof metadata.doc_name === "string" && metadata.doc_name
            ? metadata.doc_name
            : typeof metadata.title === "string" && metadata.title ? metadata.title : "切片";
          const hier = typeof metadata.hier_title === "string" ? metadata.hier_title : typeof metadata.title === "string" ? metadata.title : "";
          chunks.remember(id, { title, body: text, hier });
          return {
            sourceId: source.id,
            type: "bailian",
            id,
            key: `bl:${id}`,
            title,
            space: index.name,
            snippet: trunc(text, 240),
            score: typeof node.Score === "number" ? node.Score : undefined,
            rank: position + 1,
          };
        });
      });
      const settled = await Promise.allSettled(jobs);
      const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<KbAdapterHit[]> => entry.status === "fulfilled");
      if (!fulfilled.length && settled.length) {
        throw settled[0]!.status === "rejected" ? settled[0]!.reason : new Error("百炼检索失败");
      }
      return fulfilled.flatMap((entry) => entry.value);
    },

    read: async (_rawSource, id) => {
      const chunk = chunks.get(String(id));
      if (!chunk) throw new Error("切片已过期，请重新检索");
      const body = `${chunk.hier ? `${chunk.hier}\n\n` : ""}${chunk.body}`.slice(0, MAX_BODY);
      const doc: KbDoc = { title: chunk.title, format: "text", body, url: "" };
      return doc;
    },
  };
}
