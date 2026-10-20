import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { MAAS_KEYWORDS } from "../src/lib/crm-model.ts";

/**
 * Local-only bridge for MaaS 候选初筛（D4）：
 * - candidates(): 读 .local-cache/crm-snapshot.json，用 crm-model 的 MAAS_KEYWORDS
 *   匹配项目名/客户名，产出 .local-cache/maas-candidates.json（0600）。候选只标
 *   「疑似」，不硬判；cate（混合云/公有云/国际）与 MaaS 维度无关，禁止参与。
 * - overrides(): 人工覆盖表。优先本机 .local-cache/maas-overrides.json（0600，
 *   真实数据允许），缺失/非法时回退 public/data/maas-overrides.json（保持 {}，
 *   绝不写入真实数据），再不行则空表。
 * - overridesState(): 同上，但带来源标记；本机文件存在却损坏时如实返回
 *   source:"corrupt"（不静默回落，避免下次保存把人工分类全清空）。
 * - setOverride(): 写本机覆盖表（0600 原子写）。status=unconfirmed 表示清除覆盖，
 *   回到关键词初筛口径。本机覆盖表损坏时拒写（overrides_corrupt），原字节不动。
 * 桥内所有写操作串成单队列（读-改-写不交错），失败只 reject 当次、不毒化队列。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const SNAPSHOT_PATH = join(CACHE_DIR, "crm-snapshot.json");
const CANDIDATES_PATH = join(CACHE_DIR, "maas-candidates.json");
const LOCAL_OVERRIDES_PATH = join(CACHE_DIR, "maas-overrides.json");
const PUBLIC_OVERRIDES_PATH = join(PROJECT_ROOT, "public", "data", "maas-overrides.json");

const MAX_CID_CHARS = 128;
const MAX_NAME_CHARS = 200;
const MAX_CANDIDATE_EVIDENCE = 12;

export interface MaasCandidateEvidence {
  readonly source: "customer" | "project";
  readonly name: string;
  readonly keywords: readonly string[];
}

export interface MaasCandidate {
  readonly cid: string;
  readonly customerName: string;
  /** 只标「疑似」：候选永远是建议分类 maas，最终判定以人工覆盖表为准。 */
  readonly suggestion: "maas";
  readonly evidence: readonly MaasCandidateEvidence[];
}

export interface MaasCandidatesFile {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly readOnly: true;
  /** 快照客户总数（覆盖率分母口径），含无 PPL 客户。 */
  readonly totalCustomers: number;
  readonly candidates: readonly MaasCandidate[];
}

export type MaasOverrideValue = "maas" | "non_maas";
/** 覆盖表只能存 maas/non_maas；unconfirmed 仅作为「清除覆盖」的写入语义。 */
export type MaasOverridesFile = Record<string, MaasOverrideValue>;
export type MaasOverrideStatus = MaasOverrideValue | "unconfirmed";

export type MaasOverrideWriteResult =
  | { readonly ok: true; readonly overrides: MaasOverridesFile }
  | { readonly ok: false; readonly error: "invalid_cid" | "invalid_status" | "overrides_corrupt" };

/** local=本机表；public=本机缺失回退静态表；empty=两者皆无；corrupt=本机存在但无法解析。 */
export type MaasOverridesSource = "local" | "public" | "empty" | "corrupt";

export interface MaasOverridesState {
  readonly overrides: MaasOverridesFile;
  readonly source: MaasOverridesSource;
}

export interface MaasBridgeOptions {
  readonly cacheDir?: string;
  readonly publicOverridesPath?: string;
  readonly now?: () => number;
  /** 候选产物写盘失败的记录钩子；缺省只打印错误码，结果照常返回。 */
  readonly onPersistError?: (error: unknown) => void;
}

export interface MaasBridge {
  /** 快照缺失/非法 → undefined（路由层 404）。每次生成都重算并覆盖产物。 */
  readonly candidates: () => Promise<MaasCandidatesFile | undefined>;
  readonly overrides: () => Promise<MaasOverridesFile>;
  /** 只读：带来源标记的覆盖表（体检/前端用于识别损坏状态），绝不写盘。 */
  readonly overridesState: () => Promise<MaasOverridesState>;
  readonly setOverride: (cid: string, status: MaasOverrideStatus) => Promise<MaasOverrideWriteResult>;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** 唯一 tmp 名（pid + UUID，独占创建）+ 0600 + rename；失败清理 tmp 后如实抛出。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 单写队列：任务按调用顺序串行执行；某任务失败只 reject 自己，队列继续。 */
function createWriteQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

type LocalOverridesRead =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly overrides: MaasOverridesFile }
  | { readonly kind: "corrupt" };

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

/** 区分「本机文件不存在」与「存在但无法读取/解析/非对象」——后者绝不静默回落。 */
async function readLocalOverrides(path: string): Promise<LocalOverridesRead> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "corrupt" };
  }
  try {
    const overrides = sanitizeOverrides(JSON.parse(text));
    return overrides ? { kind: "ok", overrides } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

/** 只认 maas/non_maas；其余值（含 unconfirmed、非法类型）一律丢弃。 */
function sanitizeOverrides(raw: unknown): MaasOverridesFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const overrides: MaasOverridesFile = {};
  for (const [cid, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = cleanText(cid, MAX_CID_CHARS);
    if (!key || (value !== "maas" && value !== "non_maas")) continue;
    overrides[key] = value;
  }
  return overrides;
}

function keywordHits(text: string): string[] {
  const haystack = text.toLowerCase();
  return MAAS_KEYWORDS.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

interface SnapshotCustomer {
  readonly cid: string;
  readonly name: string;
}

interface SnapshotProject {
  readonly name: string;
  readonly cid: string | null;
  readonly customerName: string | null;
}

function projectSnapshotSections(raw: unknown): { customers: SnapshotCustomer[]; projects: SnapshotProject[] } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  const customers = (Array.isArray(record.customers) ? record.customers : [])
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const cid = cleanText(entry.cid, MAX_CID_CHARS);
      const name = cleanText(entry.name, MAX_NAME_CHARS);
      return cid && name ? { cid, name } : undefined;
    })
    .filter((item): item is SnapshotCustomer => item !== undefined);
  if (customers.length === 0) return undefined;
  const projects = (Array.isArray(record.projects) ? record.projects : [])
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const cid = cleanText(entry.cid, MAX_CID_CHARS);
      const customerName = cleanText(entry.customerName, MAX_NAME_CHARS);
      const name = cleanText(entry.name, MAX_NAME_CHARS);
      return { name, cid: cid || null, customerName: customerName || null };
    })
    .filter((project) => project.name.length > 0);
  return { customers, projects };
}

export function createMaasBridge(options: MaasBridgeOptions = {}): MaasBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const snapshotPath = join(cacheDir, "crm-snapshot.json");
  const candidatesPath = join(cacheDir, "maas-candidates.json");
  const localOverridesPath = join(cacheDir, "maas-overrides.json");
  const publicOverridesPath = options.publicOverridesPath ?? PUBLIC_OVERRIDES_PATH;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const enqueueWrite = createWriteQueue();
  const onPersistError = options.onPersistError ?? ((error: unknown) => {
    console.warn(`[maas-bridge] candidates artifact not persisted (${errorCode(error) || "unknown"})`);
  });

  /** 本机覆盖优先；缺失/非法回退 public 静态表；仍无效则空表。永不写 public。 */
  const readOverrides = async (): Promise<MaasOverridesFile> => {
    const local = sanitizeOverrides(await readJson(localOverridesPath));
    if (local) return local;
    const fallback = sanitizeOverrides(await readJson(publicOverridesPath));
    return fallback ?? {};
  };

  const readOverridesState = async (): Promise<MaasOverridesState> => {
    const local = await readLocalOverrides(localOverridesPath);
    if (local.kind === "ok") return { overrides: local.overrides, source: "local" };
    if (local.kind === "corrupt") return { overrides: {}, source: "corrupt" };
    const fallback = sanitizeOverrides(await readJson(publicOverridesPath));
    return fallback ? { overrides: fallback, source: "public" } : { overrides: {}, source: "empty" };
  };

  return {
    candidates: async () => {
      const sections = projectSnapshotSections(await readJson(snapshotPath));
      if (!sections) return undefined;
      const byCid = new Map(sections.customers.map((customer) => [customer.cid, customer]));
      const byName = new Map(sections.customers.map((customer) => [customer.name, customer]));
      const evidenceByCid = new Map<string, MaasCandidateEvidence[]>();
      const collect = (cid: string, evidence: MaasCandidateEvidence) => {
        const list = evidenceByCid.get(cid) ?? [];
        if (list.length < MAX_CANDIDATE_EVIDENCE) list.push(evidence);
        evidenceByCid.set(cid, list);
      };
      for (const customer of sections.customers) {
        const hits = keywordHits(customer.name);
        if (hits.length > 0) collect(customer.cid, { source: "customer", name: customer.name, keywords: hits });
      }
      for (const project of sections.projects) {
        const cid = project.cid && byCid.has(project.cid)
          ? project.cid
          : project.customerName ? byName.get(project.customerName)?.cid : undefined;
        if (!cid) continue;
        const hits = keywordHits(project.name);
        if (hits.length > 0) collect(cid, { source: "project", name: project.name, keywords: hits });
      }
      const candidates: MaasCandidate[] = sections.customers
        .filter((customer) => (evidenceByCid.get(customer.cid)?.length ?? 0) > 0)
        .map((customer) => ({
          cid: customer.cid,
          customerName: customer.name,
          suggestion: "maas" as const,
          evidence: evidenceByCid.get(customer.cid) ?? [],
        }));
      const file: MaasCandidatesFile = {
        schemaVersion: 1,
        generatedAt: iso(),
        readOnly: true,
        totalCustomers: sections.customers.length,
        candidates,
      };
      // 候选是纯派生数据：落盘失败只记录，不让已算出的结果变 500。
      try {
        await enqueueWrite(async () => {
          await mkdir(cacheDir, { recursive: true, mode: 0o700 });
          await writeJsonAtomic(candidatesPath, file);
        });
      } catch (error) {
        onPersistError(error);
      }
      return file;
    },

    overrides: readOverrides,

    overridesState: readOverridesState,

    setOverride: async (cid, status) => {
      if (status !== "maas" && status !== "non_maas" && status !== "unconfirmed") {
        return { ok: false, error: "invalid_status" as const };
      }
      // 控制字符直接拒绝（不清洗后放行），避免落盘 key 与请求 cid 不一致。
      const key = typeof cid === "string" && !CONTROL_CHARS.test(cid) ? cid.trim() : "";
      if (!key || key.length > MAX_CID_CHARS || /\s/.test(key)) {
        return { ok: false, error: "invalid_cid" as const };
      }
      return enqueueWrite(async (): Promise<MaasOverrideWriteResult> => {
        const local = await readLocalOverrides(localOverridesPath);
        if (local.kind === "corrupt") return { ok: false, error: "overrides_corrupt" as const };
        const base = local.kind === "ok" ? local.overrides : await readOverrides();
        // 未分类 = 清除覆盖，回到关键词初筛口径。
        const next: MaasOverridesFile = status === "unconfirmed"
          ? Object.fromEntries(Object.entries(base).filter(([existing]) => existing !== key))
          : { ...base, [key]: status };
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(localOverridesPath, next);
        return { ok: true, overrides: next };
      });
    },
  };
}
