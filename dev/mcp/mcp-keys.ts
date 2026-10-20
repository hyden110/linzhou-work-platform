import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import {
  MCP_HASH_HINT_CHARS,
  MCP_KEY_PREFIX,
  MCP_KEY_PATTERN,
  MCP_SCOPES,
  type McpKeyCreateResult,
  type McpKeyView,
  type McpScope,
} from "./mcp-types.ts";

/**
 * MCP 服务 API key 库 — sak_ 多 key + scope + sha256。
 * donor: scripts/lib/mcpserver/keys.js + scripts/mcpkeys.js（搬语义不搬代码）。
 *
 * 红线：明文只在 add 应答里出现一次；落盘只存 sha256 哈希（keys.json 0600 原子写），
 * 出站视图只报前 8 位 hint。手工编辑/损坏容错：结构不对的记录丢弃，绝不因坏文件拒绝全部 key。
 */

/* dev/mcp/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_MCP_KEYS_FILE = joinPath(PROJECT_ROOT, ".local-cache", "mcp", "keys.json");

export interface McpKeyRecord {
  readonly id: number;
  readonly name: string;
  readonly hash: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly note: string;
}

export interface McpKeyStore {
  /** 新增 key：明文仅此一次返回；落盘只有 sha256。 */
  readonly add: (name: string, opts?: { scopes?: readonly McpScope[]; note?: string }) => Promise<McpKeyCreateResult>;
  /** 按 id 吊销（软删：revokedAt 落时间戳）；未找到/已吊销 → null。 */
  readonly revoke: (id: number) => Promise<McpKeyView | null>;
  /** 校验明文 key：sak_ 形态 + sha256 命中 + 未吊销；命中顺带落 lastUsedAt。 */
  readonly verify: (raw: string) => Promise<McpKeyRecord | null>;
  /** 掩码列表（含已吊销，最新 id 在后）。 */
  readonly list: () => Promise<readonly McpKeyView[]>;
  /** 全量记录（进程内用；绝不出站）。 */
  readonly records: () => Promise<readonly McpKeyRecord[]>;
  readonly state: () => Promise<{ total: number; active: number; revoked: number; file: string }>;
  readonly touch: (id: number) => Promise<void>;
}

export interface McpKeyStoreOptions {
  readonly file?: string;
  readonly now?: () => number;
  readonly randomBytes?: (n: number) => Uint8Array;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** scope 白名单校验：非空数组且逐项在 MCP_SCOPES 内（拆分/缺省语义归桥层）。 */
export function isValidScopes(list: unknown): list is readonly McpScope[] {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every((s) => typeof s === "string" && (MCP_SCOPES as readonly string[]).includes(s));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (v: unknown): string => (typeof v === "string" ? v : "");
const asNullableText = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function cleanScopesOf(raw: unknown): readonly McpScope[] {
  if (!Array.isArray(raw)) return [...MCP_SCOPES];
  return MCP_SCOPES.filter((s) => raw.includes(s));
}

/** 损坏容错投影：坏 id / 坏 hash / 非对象记录一律丢弃；nextId 从存活记录重算。 */
export function normalizeKeyDoc(raw: unknown): { version: number; nextId: number; keys: McpKeyRecord[] } {
  const list = isRecord(raw) && Array.isArray(raw.keys) ? raw.keys : [];
  const keys: McpKeyRecord[] = list
    .filter((k): k is Record<string, unknown> => isRecord(k))
    .filter((k) => typeof k.id === "number" && Number.isInteger(k.id) && k.id >= 1)
    .filter((k) => /^[0-9a-f]{64}$/.test(asText(k.hash)))
    .map((k) => ({
      id: k.id as number,
      name: asText(k.name).trim() ? asText(k.name).trim().slice(0, 60) : `key-${String(k.id)}`,
      hash: asText(k.hash),
      scopes: cleanScopesOf(k.scopes),
      createdAt: asText(k.createdAt),
      lastUsedAt: asNullableText(k.lastUsedAt),
      revokedAt: asNullableText(k.revokedAt),
      note: asText(k.note).slice(0, 200),
    }))
    .sort((a, b) => a.id - b.id);
  return { version: 1, nextId: keys.length ? keys[keys.length - 1].id + 1 : 1, keys };
}

/** 出站视图：只有 sha256 前 8 位 hint + scope + 时间（绝无明文/全 hash）。 */
export function keyViewOf(rec: McpKeyRecord): McpKeyView {
  return {
    id: rec.id,
    name: rec.name,
    hashPrefix: rec.hash.slice(0, MCP_HASH_HINT_CHARS),
    scopes: [...rec.scopes],
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    revokedAt: rec.revokedAt,
    note: rec.note,
  };
}

export function createKeyStore(options: McpKeyStoreOptions = {}): McpKeyStore {
  const file = options.file ?? DEFAULT_MCP_KEYS_FILE;
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)));

  const iso = (): string => new Date(now()).toISOString();

  function generateKey(): string {
    return MCP_KEY_PREFIX + Array.from(randomBytes(16)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function ensureParent(): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dirname(file), 0o700).catch(() => {});
  }

  /** 0600 原子写：唯一 tmp + rename；失败清理 tmp（沿 reply/notify 桥口径）。 */
  async function writeAtomic(payload: string): Promise<void> {
    await ensureParent();
    const tmpPath = `${file}.${process.pid}.${now()}.tmp`;
    try {
      await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      await rename(tmpPath, file);
      await chmod(file, 0o600).catch(() => {});
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  async function loadDoc(): Promise<{ version: number; nextId: number; keys: McpKeyRecord[] }> {
    try {
      return normalizeKeyDoc(JSON.parse(await readFile(file, "utf-8")));
    } catch {
      return { version: 1, nextId: 1, keys: [] }; // 缺失/损坏 → 如实空表（不猜不造）
    }
  }

  async function persist(next: { version: number; nextId: number; keys: readonly McpKeyRecord[] }): Promise<void> {
    await writeAtomic(JSON.stringify({ version: 1, nextId: next.nextId, keys: next.keys }, null, 2));
  }

  async function add(name: string, opts: { scopes?: readonly McpScope[]; note?: string } = {}): Promise<McpKeyCreateResult> {
    const trimmed = String(name ?? "").trim();
    if (!trimmed || trimmed.length > 60) {
      throw new Error("key 名称必须为 1–60 位非空字符串（便于审计追溯）。");
    }
    const doc = await loadDoc();
    const key = generateKey();
    const rec: McpKeyRecord = {
      id: doc.nextId,
      name: trimmed,
      hash: sha256Hex(key),
      scopes: isValidScopes(opts.scopes) ? MCP_SCOPES.filter((s) => (opts.scopes as readonly string[]).includes(s)) : [...MCP_SCOPES],
      createdAt: iso(),
      lastUsedAt: null,
      revokedAt: null,
      note: String(opts.note ?? "").slice(0, 200),
    };
    await persist({ version: 1, nextId: rec.id + 1, keys: [...doc.keys, rec] });
    return {
      key, // 明文仅此一次：之后任何应答/日志/审计只出现 hashPrefix
      record: keyViewOf(rec),
      note: "明文 key 只显示这一次：请立即复制保存；遗失只能吊销重发。",
    };
  }

  async function revoke(id: number): Promise<McpKeyView | null> {
    const doc = await loadDoc();
    const idx = doc.keys.findIndex((k) => k.id === id && !k.revokedAt);
    if (idx < 0) return null;
    const revoked: McpKeyRecord = { ...doc.keys[idx], revokedAt: iso() };
    const keys = doc.keys.map((k, i) => (i === idx ? revoked : k));
    await persist({ ...doc, keys });
    return keyViewOf(revoked);
  }

  async function touch(id: number): Promise<void> {
    const doc = await loadDoc();
    const at = iso();
    let changed = false;
    const keys = doc.keys.map((k) => {
      if (k.id !== id || k.revokedAt) return k;
      changed = true;
      return { ...k, lastUsedAt: at };
    });
    if (changed) await persist({ ...doc, keys });
  }

  async function verify(raw: string): Promise<McpKeyRecord | null> {
    const s = String(raw ?? "").trim();
    if (!MCP_KEY_PATTERN.test(s)) return null;
    const hash = sha256Hex(s);
    const doc = await loadDoc();
    const rec = doc.keys.find((k) => k.hash === hash);
    if (!rec || rec.revokedAt) return null;
    await touch(rec.id).catch(() => {}); // lastUsedAt 是旁路：写失败不影响鉴权结论
    const at = iso();
    return { ...rec, lastUsedAt: at };
  }

  async function list(): Promise<readonly McpKeyView[]> {
    return (await loadDoc()).keys.map(keyViewOf);
  }

  async function records(): Promise<readonly McpKeyRecord[]> {
    return (await loadDoc()).keys;
  }

  async function state(): Promise<{ total: number; active: number; revoked: number; file: string }> {
    const doc = await loadDoc();
    return {
      total: doc.keys.length,
      active: doc.keys.filter((k) => !k.revokedAt).length,
      revoked: doc.keys.filter((k) => Boolean(k.revokedAt)).length,
      file,
    };
  }

  return { add, revoke, verify, list, records, state, touch };
}
