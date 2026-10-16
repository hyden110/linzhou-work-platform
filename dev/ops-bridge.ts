import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import type { CommandRunner } from "./crm-bridge.ts";

/**
 * Local-only bridge for the ops digest (Qoder blog/changelog, QwenWork
 * announcements, 千仔 messages). The digest itself is produced by
 * sync/ops_digest.py; this bridge only reads it, drives refreshes, builds the
 * deterministic daily card and manages the wechat-link registry.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const OPS_DIGEST_PATH = join(CACHE_DIR, "ops-digest.json");
const OPS_WECHAT_PATH = join(CACHE_DIR, "ops-wechat-links.json");
const OPS_SCRIPT = join(PROJECT_ROOT, "sync", "ops_digest.py");

const OPS_REFRESH_TIMEOUT_MS = 5 * 60_000;
const OPS_MAX_DIGEST_ITEMS = 500;
const OPS_MAX_WECHAT_LINKS = 50;
const OPS_AI_TIMEOUT_MS = 20_000;
const OPS_AI_MAX_OUTPUT_CHARS = 300;
const OPS_WECHAT_FETCH_TIMEOUT_MS = 15_000;
const OPS_MAX_REDIRECT_HOPS = 5;
const OPS_FETCH_HOSTS = new Set([
  "qoder.com", "www.qoder.com", "qoder.com.cn", "www.qoder.com.cn",
  "help.aliyun.com", "qwenwork.cn", "www.qwenwork.cn",
]);
const OPS_SOURCE_TYPES = ["blog", "changelog", "announcement", "qianzai"] as const;
const OPS_GROUP_LABELS: Record<OpsSourceType, string> = {
  blog: "活动",
  changelog: "更新",
  announcement: "公告",
  qianzai: "千仔讯息",
};
const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

export type OpsSourceType = (typeof OPS_SOURCE_TYPES)[number];

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

export type RegisterWechatResult =
  | { readonly ok: true; readonly link: OpsWechatLink }
  | { readonly ok: false; readonly error: "invalid_url" };

export interface OpsBridge {
  readonly digest: () => Promise<OpsDigest | undefined>;
  readonly refreshStatus: () => OpsRefreshStatus;
  readonly startRefresh: () => OpsRefreshStatus;
  readonly card: () => Promise<OpsCard | undefined>;
  readonly wechatLinks: () => Promise<readonly OpsWechatLink[]>;
  readonly registerWechatLink: (url: string) => Promise<RegisterWechatResult>;
}

export interface OpsBridgeOptions {
  readonly cacheDir?: string;
  readonly run?: CommandRunner;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}

const defaultOpsRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, path);
}

function asSourceStatus(raw: unknown): OpsSourceStatus {
  const record = (raw ?? {}) as Partial<OpsSourceStatus>;
  const status = record.status;
  return {
    status: status === "ok" || status === "partial" || status === "error" || status === "auth_required" || status === "missing"
      ? status
      : "missing",
    error: typeof record.error === "string" ? record.error : null,
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : null,
    lastSuccessAt: typeof record.lastSuccessAt === "string" ? record.lastSuccessAt : null,
    count: typeof record.count === "number" ? record.count : 0,
    complete: record.complete === true,
    stale: record.stale === true,
  };
}

function asOpsItem(raw: unknown): OpsItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const sourceType = record.sourceType;
  if (typeof record.id !== "string" || typeof record.title !== "string") return undefined;
  if (sourceType !== "blog" && sourceType !== "changelog" && sourceType !== "announcement" && sourceType !== "qianzai") {
    return undefined;
  }
  return {
    id: record.id,
    sourceType,
    source: typeof record.source === "string" ? record.source : sourceType,
    title: record.title,
    url: typeof record.url === "string" ? record.url : null,
    publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : null,
    summary: typeof record.summary === "string" ? record.summary : null,
    kind: typeof record.kind === "string" ? record.kind : null,
  };
}

function projectDigest(raw: unknown): OpsDigest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  const sourcesRaw = record.sources && typeof record.sources === "object" && !Array.isArray(record.sources)
    ? record.sources as Record<string, unknown>
    : {};
  const sources = Object.fromEntries(
    OPS_SOURCE_TYPES.map((key) => [key, asSourceStatus(sourcesRaw[key])]),
  );
  const items = (Array.isArray(record.items) ? record.items : [])
    .map(asOpsItem)
    .filter((item): item is OpsItem => item !== undefined)
    .slice(0, OPS_MAX_DIGEST_ITEMS);
  return {
    schemaVersion: 1,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
    readOnly: record.readOnly === true,
    sources,
    items,
  };
}

/** Deterministic URL normalisation: scheme-less, host-lowercased, no trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Deterministic title normalisation for cross-source dedupe. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[，。！？：；“”‘’"'!?·—\s\-]+/g, "").trim();
}

function localDateKey(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function itemLocalDate(item: OpsItem): string | null {
  if (!item.publishedAt) return null;
  const date = new Date(item.publishedAt.includes("T") ? item.publishedAt : item.publishedAt.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return null;
  return localDateKey(date.getTime());
}

function templateOverview(
  counts: Record<OpsSourceType, number>,
  total: number,
  aiConfigured: boolean,
): OpsCard["overview"] {
  const text = total === 0
    ? "今日暂无新增运营讯息。"
    : `今日共 ${total} 条运营讯息：活动 ${counts.blog} · 更新 ${counts.changelog} · 公告 ${counts.announcement} · 千仔讯息 ${counts.qianzai}。`;
  const note = aiConfigured && total === 0
    ? "模板汇总（今日无新增，未调用 AI）"
    : "模板汇总（未接入 AI 摘要）";
  return { kind: "template", text, note };
}

function countsOfGroups(groups: readonly OpsCardGroup[]): Record<OpsSourceType, number> {
  return Object.fromEntries(
    OPS_SOURCE_TYPES.map((key) => [key, groups.find((group) => group.key === key)?.count ?? 0]),
  ) as Record<OpsSourceType, number>;
}

/** Shape guard for the overview artifact written at refresh time; GET only reads it. */
function asOverview(raw: unknown): OpsCard["overview"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if ((record.kind !== "ai" && record.kind !== "template")
    || typeof record.text !== "string" || typeof record.note !== "string") return undefined;
  return { kind: record.kind, text: record.text, note: record.note };
}

function buildTodayGroups(digest: OpsDigest, nowMs: number): { groups: OpsCardGroup[]; total: number; dedupedFrom: number } {
  const today = localDateKey(nowMs);
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const byGroup = new Map<OpsSourceType, OpsCardEntry[]>(OPS_SOURCE_TYPES.map((key) => [key, []]));
  const counts: Record<OpsSourceType, number> = { blog: 0, changelog: 0, announcement: 0, qianzai: 0 };
  let dedupedFrom = 0;
  for (const item of digest.items) {
    if (itemLocalDate(item) !== today) continue;
    dedupedFrom += 1;
    const urlKey = item.url ? `u:${normalizeUrl(item.url)}` : null;
    const titleKey = `t:${normalizeTitle(item.title)}`;
    if ((urlKey && seenUrls.has(urlKey)) || seenTitles.has(titleKey)) continue;
    if (urlKey) seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    counts[item.sourceType] += 1;
    byGroup.get(item.sourceType)?.push({
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      source: item.source,
      sourceType: item.sourceType,
      kind: item.kind,
      summary: item.summary,
    });
  }
  const groups = OPS_SOURCE_TYPES.map((key) => {
    const items = byGroup.get(key) ?? [];
    return { key, label: OPS_GROUP_LABELS[key], count: items.length, items };
  });
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return { groups, total, dedupedFrom };
}

async function aiOverview(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
  apiKey: string,
  groups: readonly OpsCardGroup[],
): Promise<OpsCard["overview"] | undefined> {
  const titles = groups
    .flatMap((group) => group.items.map((item) => `[${group.label}] ${item.title}`))
    .slice(0, 30);
  if (titles.length === 0) return undefined;
  const model = env.OPS_AI_MODEL ?? "qwen-flash";
  try {
    const response = await fetchImpl(DASHSCOPE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是运营推广助手。用一句话概括今天的运营讯息要点，只输出这一句话，不超过 80 字，不要编造列表之外的内容。" },
          { role: "user", content: titles.join("\n") },
        ],
        temperature: 0.3,
        max_tokens: 160,
      }),
      signal: AbortSignal.timeout(OPS_AI_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json().catch(() => undefined);
    const choices = (payload as { choices?: unknown[] } | undefined)?.choices;
    const first = choices?.[0] as { message?: { content?: unknown } } | undefined;
    const content = typeof first?.message?.content === "string" ? first.message.content.trim() : "";
    if (!content) return undefined;
    return { kind: "ai", text: content.slice(0, OPS_AI_MAX_OUTPUT_CHARS), note: `AI 摘要（${model} 生成，仅供速览）` };
  } catch {
    return undefined;
  }
}

function asWechatLink(raw: unknown): OpsWechatLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.url !== "string" || typeof record.registeredAt !== "string") return undefined;
  const status = record.status;
  if (status !== "registered" && status !== "fetched" && status !== "fetch_failed") return undefined;
  return {
    id: record.id,
    url: record.url,
    registeredAt: record.registeredAt,
    status,
    note: typeof record.note === "string" ? record.note : "",
    title: typeof record.title === "string" ? record.title : null,
  };
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a whitelisted link with redirects handled manually: every Location hop
 * is re-validated against OPS_FETCH_HOSTS before it is followed (cap 5 hops).
 * A hop to a foreign host fails honestly instead of silently following.
 */
async function fetchWhitelistedLink(
  fetchImpl: typeof fetch,
  startUrl: string,
  base: OpsWechatLink,
): Promise<OpsWechatLink> {
  let current = startUrl;
  for (let hop = 0; hop <= OPS_MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(OPS_WECHAT_FETCH_TIMEOUT_MS) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return { ...base, status: "fetch_failed", note: `重定向缺少目标地址（HTTP ${response.status}）`, title: null };
      }
      let target: URL;
      try {
        target = new URL(location, current);
      } catch {
        return { ...base, status: "fetch_failed", note: "重定向目标地址无效，已停止抓取", title: null };
      }
      const targetHost = hostOf(target.toString());
      if (!targetHost || !OPS_FETCH_HOSTS.has(targetHost)) {
        return { ...base, status: "fetch_failed", note: `重定向到非白名单域名 ${targetHost ?? "无效地址"}，已拒绝抓取`, title: null };
      }
      if (hop === OPS_MAX_REDIRECT_HOPS) {
        return { ...base, status: "fetch_failed", note: `重定向超过 ${OPS_MAX_REDIRECT_HOPS} 跳上限，已停止抓取`, title: null };
      }
      current = target.toString();
      continue;
    }
    const body = response.ok ? await response.text().catch(() => "") : "";
    const title = /<title>([^<]{1,200})<\/title>/.exec(body)?.[1]?.trim() ?? null;
    return {
      ...base,
      status: response.ok ? "fetched" : "fetch_failed",
      note: response.ok ? "已尝试抓取（白名单域名，重定向逐跳复验）" : `抓取失败（HTTP ${response.status}）`,
      title,
    };
  }
  return { ...base, status: "fetch_failed", note: `重定向超过 ${OPS_MAX_REDIRECT_HOPS} 跳上限，已停止抓取`, title: null };
}

export function createOpsBridge(options: OpsBridgeOptions = {}): OpsBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const digestPath = join(cacheDir, "ops-digest.json");
  const wechatPath = join(cacheDir, "ops-wechat-links.json");
  const overviewPath = join(cacheDir, "ops-card-overview.json");
  const run = options.run ?? defaultOpsRunner;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const iso = () => new Date(now()).toISOString();
  let refresh: OpsRefreshStatus = { state: "idle", startedAt: null, finishedAt: null, error: null };

  const readWechat = async () => {
    const raw = await readJson(wechatPath);
    const list = Array.isArray(raw) ? raw : [];
    return list.map(asWechatLink).filter((link): link is OpsWechatLink => link !== undefined);
  };
  const saveWechat = async (links: readonly OpsWechatLink[]) => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(wechatPath, links.slice(-OPS_MAX_WECHAT_LINKS));
  };

  /**
   * The AI overview is computed exactly once per refresh and cached next to the
   * digest (0600). GET /local/ops/card must stay side-effect free, so it only
   * reads this artifact and falls back to the deterministic template.
   */
  const computeOverview = async (): Promise<void> => {
    try {
      const digest = await projectDigest(await readJson(digestPath));
      if (!digest) return;
      const nowMs = now();
      const { groups, total } = buildTodayGroups(digest, nowMs);
      const apiKey = env.DASHSCOPE_API_KEY;
      const template = templateOverview(countsOfGroups(groups), total, Boolean(apiKey));
      let overview = template;
      if (apiKey && total > 0) {
        const ai = await aiOverview(fetchImpl, env, apiKey, groups);
        overview = ai ?? { kind: "template", text: template.text, note: "AI 摘要失败，已回退模板汇总" };
      }
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(overviewPath, {
        date: localDateKey(nowMs),
        digestGeneratedAt: digest.generatedAt,
        total,
        overview,
      });
    } catch {
      // Missing artifact simply means GET falls back to the template overview.
    }
  };

  return {
    digest: async () => projectDigest(await readJson(digestPath)),

    refreshStatus: () => refresh,

    startRefresh: () => {
      if (refresh.state === "running") return refresh;
      refresh = { state: "running", startedAt: iso(), finishedAt: null, error: null };
      run("python3", [OPS_SCRIPT], {
        cwd: PROJECT_ROOT,
        env: process.env,
        timeoutMs: OPS_REFRESH_TIMEOUT_MS,
      })
        .then(async (result) => {
          if (result.code === 0) {
            // Compute before flipping to "succeeded": once the UI sees the
            // refresh finish, the overview artifact is already on disk.
            await computeOverview();
            refresh = { ...refresh, state: "succeeded", finishedAt: iso() };
          } else {
            refresh = { ...refresh, state: "failed", finishedAt: iso(), error: result.code === null ? "digest_timeout" : "digest_failed" };
          }
        })
        .catch(() => {
          refresh = { ...refresh, state: "failed", finishedAt: iso(), error: "digest_failed" };
        });
      return refresh;
    },

    card: async () => {
      const digest = await projectDigest(await readJson(digestPath));
      if (!digest) return undefined;
      const nowMs = now();
      const { groups, total, dedupedFrom } = buildTodayGroups(digest, nowMs);
      const apiKey = env.DASHSCOPE_API_KEY;
      const template = templateOverview(countsOfGroups(groups), total, Boolean(apiKey));
      let overview = template;
      const cachedRaw = await readJson(overviewPath);
      if (cachedRaw && typeof cachedRaw === "object" && !Array.isArray(cachedRaw)) {
        const cached = cachedRaw as Record<string, unknown>;
        const cachedOverview = asOverview(cached.overview);
        if (cachedOverview
          && cached.date === localDateKey(nowMs)
          && cached.digestGeneratedAt === digest.generatedAt
          && cached.total === total) {
          overview = cachedOverview;
        }
      }
      return {
        date: localDateKey(nowMs),
        generatedAt: digest.generatedAt,
        total,
        dedupedFrom,
        overview,
        groups,
      };
    },

    wechatLinks: () => readWechat(),

    registerWechatLink: async (url) => {
      const trimmed = typeof url === "string" ? url.trim() : "";
      if (trimmed.length < 12 || trimmed.length > 500 || /\s/.test(trimmed)) return { ok: false, error: "invalid_url" };
      const host = hostOf(trimmed);
      if (!host) return { ok: false, error: "invalid_url" };
      const links = await readWechat();
      const id = `${now()}-${links.length + 1}`;
      let entry: OpsWechatLink = {
        id,
        url: trimmed,
        registeredAt: iso(),
        status: "registered",
        note: `域名 ${host} 不在自动抓取白名单，仅登记（公众号无公开 API，v1 只做登记入口）`,
        title: null,
      };
      if (OPS_FETCH_HOSTS.has(host)) {
        try {
          entry = await fetchWhitelistedLink(fetchImpl, trimmed, entry);
        } catch {
          entry = { ...entry, status: "fetch_failed", note: "抓取请求失败（网络或超时）" };
        }
      }
      await saveWechat([...links, entry]);
      return { ok: true, link: entry };
    },
  };
}
