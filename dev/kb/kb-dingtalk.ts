import type { KbAdapter, KbAdapterContext } from "./kb-adapter-shared.ts";
import { runCliJson } from "./kb-adapter-shared.ts";
import type {
  KbAdapterHit,
  KbDingtalkSource,
  KbSpace,
} from "./kb-types.ts";
import { trunc } from "./kb-util.ts";

/**
 * 钉钉知识库（dws wiki CLI 只读）。
 * Ported semantics from base/sa-workbench scripts/lib/kb/dingtalk.js:
 * 每个已配置空间与（可选）全企业搜索各自成一路排名，交给上层 RRF；单路失败不影响其余。
 * CLI 参数一律数组传给 execFile（不经 shell）、硬超时；JSON 前的告警行宽容解析。
 */

const CLI_TIMEOUT_MS = 25_000;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/;
const DWS_BIN = "dws";

export interface DingtalkAdapterOptions {
  readonly run?: KbAdapterContext["run"];
}

interface DingtalkNode {
  readonly nodeId?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly nodeType?: unknown;
  readonly extension?: unknown;
  readonly url?: unknown;
  readonly docUrl?: unknown;
}

/** dws 把成功负载包在 {data:{…}}；列表类命令也可能直接给顶层字段。 */
function dwsPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      return record.data as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

export function createDingtalkAdapter(options: DingtalkAdapterOptions = {}): KbAdapter {
  const run = options.run;
  if (!run) throw new Error("dingtalk 适配器需要注入 run");

  const call = (args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<unknown> =>
    runCliJson(run, DWS_BIN, [...args, "-f", "json"], timeoutMs, "未找到 DWS CLI");

  async function searchSpace(
    source: KbDingtalkSource,
    space: { id: string; name: string },
    query: string,
    k: number,
  ): Promise<KbAdapterHit[]> {
    const payload = dwsPayload(await call([
      "wiki", "+node-search", "--workspace", space.id, "--query", query, "--limit", String(Math.min(k, 30)),
    ]));
    const nodes = Array.isArray(payload.nodes) ? payload.nodes as DingtalkNode[] : [];
    return nodes
      .filter((node) => node.nodeType !== "folder")
      .slice(0, k)
      .map((node, index) => nodeToHit(source, node, space.name, index + 1,
        `${space.name}${node.extension ? ` · ${String(node.extension)}` : ""}`));
  }

  async function searchEnterprise(source: KbDingtalkSource, query: string, k: number): Promise<KbAdapterHit[]> {
    const payload = await call(["aisearch", "enterprise", "--queries", query, "--types", "document"]);
    const results = Array.isArray((payload as Record<string, unknown>).result)
      ? (payload as Record<string, unknown>).result as Record<string, unknown>[]
      : [];
    return results.slice(0, k).map((result, index) => {
      const meta = result.meta && typeof result.meta === "object" ? result.meta as Record<string, unknown> : {};
      const nodeId = typeof result.nodeId === "string" ? result.nodeId : typeof meta.nodeId === "string" ? meta.nodeId : "";
      return {
        sourceId: source.id,
        type: "dingtalk" as const,
        id: nodeId,
        key: `dt:${nodeId || String(result.url ?? "")}`,
        title: typeof result.title === "string" && result.title ? result.title : "未命名",
        space: "全企业",
        url: typeof result.url === "string" ? result.url : "",
        snippet: trunc(result.snippet ?? "", 240),
        rank: index + 1,
      };
    });
  }

  return {
    type: "dingtalk",
    label: "钉钉知识库",

    spaces: async (rawSource) => {
      const source = rawSource as KbDingtalkSource;
      return (source.spaces ?? []).map((space) => ({ id: space.id, name: space.name || space.id, leaf: false }));
    },

    /* 各空间与全企业搜索各自成一路排名，交给上层 RRF；单路失败不影响其余。 */
    search: async (rawSource, query, k) => {
      const source = rawSource as KbDingtalkSource;
      const jobs: Promise<KbAdapterHit[]>[] = (source.spaces ?? []).map((space) => searchSpace(source, space, query, k));
      if (source.enterprise) jobs.push(searchEnterprise(source, query, k));
      const settled = await Promise.allSettled(jobs);
      const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<KbAdapterHit[]> => entry.status === "fulfilled");
      if (!fulfilled.length && settled.length) {
        throw settled[0]!.status === "rejected" ? settled[0]!.reason : new Error("钉钉检索失败");
      }
      return fulfilled.flatMap((entry) => entry.value);
    },

    read: async (_rawSource, id) => {
      const nodeId = String(id ?? "");
      if (!NODE_ID_PATTERN.test(nodeId)) throw new Error("非法节点 ID");
      const payload = dwsPayload(await call(["doc", "read", "--node", nodeId], CLI_TIMEOUT_MS));
      const markdown = payload.markdown ?? (payload.data as Record<string, unknown> | undefined)?.markdown;
      if (markdown == null) throw new Error("非在线文字文档，请打开原文查看");
      return {
        title: "",
        format: "md",
        body: String(markdown).slice(0, 200 * 1024),
        url: typeof payload.docUrl === "string" ? payload.docUrl : "",
      };
    },
  };
}

function nodeToHit(
  source: KbDingtalkSource,
  node: DingtalkNode,
  spaceName: string,
  rank: number,
  snippet: string,
): KbAdapterHit {
  const nodeId = String(node.nodeId ?? "");
  return {
    sourceId: source.id,
    type: "dingtalk",
    id: nodeId,
    key: `dt:${nodeId}`,
    title: typeof node.name === "string" && node.name ? node.name : typeof node.title === "string" && node.title ? node.title : "未命名",
    space: spaceName,
    url: typeof node.url === "string" ? node.url : typeof node.docUrl === "string" ? node.docUrl : "",
    snippet,
    rank,
  };
}

export type { KbSpace };
