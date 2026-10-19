import type { KbAdapter, KbAdapterContext } from "./kb-adapter-shared.ts";
import type {
  KbAdapterHit,
  KbAliyundocSource,
  KbDoc,
  KbSpace,
} from "./kb-types.ts";
import { trunc } from "./kb-util.ts";

/**
 * 阿里云官方文档（help.aliyun.com 的 llms.txt 体系）——零凭据只读源。
 * Ported semantics from base/sa-workbench scripts/lib/kb/aliyundoc.js:
 * 官方两级索引（根索引列产品 → 产品索引列文档条目，`- [标题](.md地址): 摘要`）
 * → 按需取 .md 正文。安全口径：只走 allowlist 主机、手动跟随重定向并逐跳校验；
 * 索引解析结果带 TTL 缓存，取新失败时回落上次结果（last-good），离线抖动不阻断检索。
 */

const SITES = {
  cn: { base: "https://help.aliyun.com", host: "help.aliyun.com", langs: ["zh", "en"] },
  intl: { base: "https://www.alibabacloud.com/help", host: "www.alibabacloud.com", langs: ["zh", "en", "ja", "id", "tc", "pt-br"] },
} as const;

const HOSTS: readonly string[] = Object.values(SITES).map((site) => site.host);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BODY = 200 * 1024;
const MAX_LIST = 300;
/* 一次检索最多新拉 6 个产品索引（约 4MB）；已缓存的产品全量参与，不受此限 */
const COLD_PER_SEARCH = 6;
const MAX_PRODUCTS = 40;
const CODE_PATTERN = /^[A-Za-z0-9._/-]{1,160}$/;
const DOT_PATTERN = /(^|\/)\.\.?(\/|$)/;
const ENTRY_PATTERN = /^- \[([^\]]{1,300})\]\((https:\/\/[^)\s]{1,900})\)(?::\s*(.*))?$/;
const LANG_FALLBACK = "zh";

export interface AliyundocIndexEntry {
  readonly title: string;
  readonly url: string;
  readonly desc: string;
  readonly sec: string;
}

interface CacheEntry<T> {
  readonly at: number;
  readonly data: T;
}

export interface AliyundocOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function normalizeAliyundocSource(source: unknown): { site: "cn" | "intl"; lang: string; products: { id: string; name: string }[] } {
  const raw = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const site = raw.site === "intl" || raw.site === "cn" ? raw.site : "cn";
  const langs = SITES[site].langs;
  const lang = typeof raw.lang === "string" && (langs as readonly string[]).includes(raw.lang) ? raw.lang : langs[0] ?? LANG_FALLBACK;
  const seen = new Set<string>();
  const products: { id: string; name: string }[] = [];
  for (const item of Array.isArray(raw.products) ? raw.products : []) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || !CODE_PATTERN.test(id) || DOT_PATTERN.test(id) || id.includes("//") || seen.has(id) || products.length >= MAX_PRODUCTS) continue;
    seen.add(id);
    products.push({ id, name: trunc(record.name ?? id, 60) });
  }
  return { site, lang, products };
}

/** URL 构造与解析都会规范化掉 `..`，故先按原始串拒绝，再校验主机与后缀。 */
export function allowedUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.includes("..")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !HOSTS.includes(parsed.hostname) || parsed.search || parsed.hash) return null;
  return DOT_PATTERN.test(parsed.pathname) ? null : parsed;
}

/** 只接受 allowlist 主机上的 .md 绝对地址：read() 的 id 来自前端，必须先过这道校验。 */
export function mdUrlOf(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !/\.md$/.test(value)) return "";
  const parsed = allowedUrl(value);
  return parsed ? parsed.href : "";
}

export function aliyundocIndexUrl(site: string, lang: string, code?: string): string {
  const resolved = site === "intl" ? SITES.intl : SITES.cn;
  const resolvedLang = (resolved.langs as readonly string[]).includes(lang) ? lang : resolved.langs[0] ?? LANG_FALLBACK;
  const suffix = code ? `/${String(code).replace(/^\/+|\/+$/g, "")}` : "";
  return `${resolved.base}/${resolvedLang}${suffix}/llms.txt`;
}

/** 从产品级 llms.txt 地址反推产品 code（根索引 → 产品索引的寻址键）。 */
export function productCodeOf(url: unknown, site: string, lang: string): string {
  const resolved = site === "intl" ? SITES.intl : SITES.cn;
  const resolvedLang = (resolved.langs as readonly string[]).includes(lang) ? lang : resolved.langs[0] ?? LANG_FALLBACK;
  const prefix = `${resolved.base}/${resolvedLang}/`;
  const suffix = "/llms.txt";
  const value = String(url ?? "");
  if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length <= prefix.length + suffix.length) return "";
  const code = value.slice(prefix.length, -suffix.length);
  return CODE_PATTERN.test(code) && !DOT_PATTERN.test(code) ? code : "";
}

/* 中文查询常不带空格：空格词权重高，CJK 二元组权重低；只中二元组时要求 ≥2 个才算命中，压噪声 */
export function tokenizeQuery(query: string): { words: string[]; grams: string[] } {
  const text = String(query ?? "").toLowerCase();
  const words = Array.from(new Set(
    text.split(/[\s,，。、;；:：!！?？()（）[\]【】"'`|/\\]+/).filter((item) => item && item.length <= 40),
  )).slice(0, 8);
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
  const grams: string[] = [];
  for (let index = 0; index + 2 <= cjk.length && grams.length < 24; index += 1) grams.push(cjk.slice(index, index + 2));
  return { words, grams: Array.from(new Set(grams)) };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0 && count < 3) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function scoreTextAgainst(title: string, desc: string, tokens: { words: string[]; grams: string[] }, wTitle: number, wDesc: number): number {
  const t = String(title ?? "").toLowerCase();
  const d = String(desc ?? "").toLowerCase();
  let score = 0;
  let wordHit = 0;
  let gramHit = 0;
  for (const word of tokens.words) {
    const inTitle = t.includes(word);
    const inDesc = d.includes(word);
    if (!inTitle && !inDesc) continue;
    wordHit += 1;
    score += (inTitle ? wTitle : 0) + (inDesc ? wDesc : 0) + occurrences(d, word);
  }
  for (const gram of tokens.grams) {
    const inTitle = t.includes(gram);
    const inDesc = d.includes(gram);
    if (!inTitle && !inDesc) continue;
    gramHit += 1;
    score += (inTitle ? wTitle : 0) * 0.15 + (inDesc ? wDesc : 0) * 0.15;
  }
  return wordHit || gramHit >= 2 ? score : 0;
}

/** 索引行格式：`- [标题](URL): 摘要`，`## 小节` 作为分组；根索引与产品索引同构。 */
export function parseLlmsIndex(text: string): AliyundocIndexEntry[] {
  const entries: AliyundocIndexEntry[] = [];
  let section = "";
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      section = trunc(line.slice(3), 80);
      continue;
    }
    const match = ENTRY_PATTERN.exec(line);
    if (!match) continue;
    entries.push({ title: trunc(match[1], 200), url: match[2]!, desc: trunc(match[3] ?? "", 400), sec: section });
  }
  return entries;
}

/* 官方 md 夹带检索锚点（整行 <meta og:title>、标题尾随空锚点）与整行注释，预览前剥掉 */
export function cleanAliyundocMarkdown(text: string): string {
  return String(text ?? "")
    .replace(/^\s*<meta\b[^>\n]*>\s*$/gim, "")
    .replace(/^\s*<!--[^\n]*?-->\s*$/gm, "")
    .replace(/<span id="[^"]*"\s*\/>/g, "")
    .replace(/<a id="[^"]*"\s*>\s*<\/a>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function createAliyundocAdapter(options: AliyundocOptions = {}): KbAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  /* key → { fresh 缓存, lastGood 上次成功 }；离线/文档站抖动时回落 last-good */
  const freshCache = new Map<string, CacheEntry<unknown>>();
  const lastGoodCache = new Map<string, unknown>();

  async function getText(url: string, timeoutMs: number): Promise<string> {
    let current = url;
    for (let hop = 0; hop < 5; hop += 1) {
      if (!allowedUrl(current)) throw new Error(`非白名单地址：${trunc(current, 120)}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(current, { redirect: "manual", signal: controller.signal, headers: { accept: "text/plain,*/*" } });
      } catch (error) {
        const name = error && typeof error === "object" ? String((error as { name?: unknown }).name ?? "") : "";
        throw new Error(name === "AbortError" ? "取数超时" : `网络错误：${trunc(error instanceof Error ? error.message : String(error), 120)}`);
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("重定向缺少 location");
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) throw new Error(`响应超过 ${Math.round(MAX_BYTES / 1048576)}MB`);
      return new TextDecoder("utf-8").decode(buffer);
    }
    throw new Error("重定向次数过多");
  }

  async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const hit = freshCache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.data as T;
    try {
      const data = await fetcher();
      freshCache.set(key, { at: now(), data });
      lastGoodCache.set(key, data);
      return data;
    } catch (error) {
      if (lastGoodCache.has(key)) return lastGoodCache.get(key) as T;
      throw error;
    }
  }

  async function rootIndex(source: { site: "cn" | "intl"; lang: string }): Promise<(AliyundocIndexEntry & { code: string })[]> {
    return cached(`root:${source.site}:${source.lang}`, async () =>
      parseLlmsIndex(await getText(aliyundocIndexUrl(source.site, source.lang), 30_000))
        .map((entry) => ({ ...entry, code: productCodeOf(entry.url, source.site, source.lang) })));
  }

  function productIndex(site: "cn" | "intl", lang: string, code: string): Promise<AliyundocIndexEntry[]> {
    return cached(`prod:${site}:${lang}:${code}`, () => getText(aliyundocIndexUrl(site, lang, code), 30_000).then(parseLlmsIndex));
  }

  function isCachedProduct(site: string, lang: string, code: string): boolean {
    return freshCache.has(`prod:${site}:${lang}:${code}`);
  }

  function itemOf(source: KbAliyundocSource, productName: string, entry: AliyundocIndexEntry): KbAdapterHit | null {
    const url = mdUrlOf(entry.url);
    if (!url) return null;
    return {
      sourceId: source.id,
      type: "aliyundoc",
      id: url,
      key: url,
      title: entry.title,
      space: productName,
      path: entry.sec,
      url: url.replace(/\.md$/, ""),
    };
  }

  return {
    type: "aliyundoc",
    label: "阿里云官方文档",

    spaces: async (rawSource) => {
      const source = normalizeAliyundocSource(rawSource);
      const spaces: KbSpace[] = source.products.map((product) => ({ id: product.id, name: product.name, leaf: true }));
      return spaces;
    },

    search: async (rawSource, query, k) => {
      const source = normalizeAliyundocSource(rawSource);
      if (!source.products.length) throw new Error("未选择产品");
      const tokens = tokenizeQuery(query);
      if (!tokens.words.length && !tokens.grams.length) return [];
      const roots = await rootIndex(source);
      const byCode = new Map(roots.filter((root) => root.code).map((root) => [root.code, root]));
      const productScore = new Map<string, number>();
      for (const product of source.products) {
        const root = byCode.get(product.id);
        productScore.set(product.id, scoreTextAgainst(root ? root.title : product.name, root ? root.desc : "", tokens, 4, 1));
      }
      /* 已缓存的产品索引零成本全查；未缓存的按产品分取前 N，把冷启开销压在 6 次请求内 */
      const warm: string[] = [];
      const cold: string[] = [];
      for (const product of source.products) (isCachedProduct(source.site, source.lang, product.id) ? warm : cold).push(product.id);
      cold.sort((a, b) => (productScore.get(b) ?? 0) - (productScore.get(a) ?? 0));
      const picked = [...warm, ...cold.slice(0, COLD_PER_SEARCH)];

      const hits: KbAdapterHit[] = [];
      const errors: string[] = [];
      await Promise.all(picked.map(async (code) => {
        const product = source.products.find((item) => item.id === code);
        try {
          const index = await productIndex(source.site, source.lang, code);
          const bonus = Math.min(productScore.get(code) ?? 0, 8) * 0.3;
          for (const entry of index) {
            const score = scoreTextAgainst(entry.title, entry.desc, tokens, 6, 2);
            if (score <= 0) continue;
            const item = itemOf(rawSource as KbAliyundocSource, product ? product.name : code, entry);
            if (item) hits.push({ ...item, score: score + bonus, snippet: trunc(entry.desc, 240) });
          }
        } catch (error) {
          errors.push(trunc(error instanceof Error ? error.message : String(error), 160));
        }
      }));
      if (!hits.length && errors.length === picked.length && errors.length) throw new Error(errors[0]!);
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.title.localeCompare(b.title));
      return hits.slice(0, k).map((entry, index) => ({ ...entry, rank: index + 1 }));
    },

    read: async (rawSource, id) => {
      void rawSource;
      const url = mdUrlOf(id);
      if (!url) throw new Error("非法文档地址");
      const text = await getText(url, 30_000);
      /* 个别 .md 地址服务端回 200 的 HTML 壳而非 Markdown：不假装是正文，交给「打开原文」 */
      const head = text.slice(0, 200).toLowerCase();
      if (head.includes("<!doctype html") || /<html[\s>]/.test(head)) {
        throw new Error("该文档暂无 Markdown 源，请打开原文查看");
      }
      const body = cleanAliyundocMarkdown(text).slice(0, MAX_BODY);
      const h1 = /^#\s+(.+)$/m.exec(body);
      const title = h1 ? trunc(h1[1], 200) : trunc(url.split("/").pop()?.replace(/\.md$/, "") ?? "", 200);
      return { title, format: "md", body, url: url.replace(/\.md$/, "") };
    },
  };
}

/** 供 bridge 复用的列表上限（根索引产品数、列表截断等），保持与参考实现一致的口径。 */
export const ALIYUNDOC_MAX_LIST = MAX_LIST;
