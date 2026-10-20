import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ProfileBridgeError, type ProfileDoc, type ProfileLastCheck, type ProfilePrefs, type ProfilePublicView, type ProfileSessionRecord, type SessionSource } from "./profile-types.ts";

/**
 * 个人中心存储层 — semantics ported from base/sa-workbench scripts/lib/profile.js
 * （搬语义不搬代码）：
 * - ~/.sa-workbench/active.json                 当前账号 {empId, at}（activeGet/activeSet）；
 * - ~/.sa-workbench/users/<empId>/profile.json  {version,user,source,session,prefs}，文件 0600、目录 0700；
 * - 原子写：tmp + rename，任何失败不留半份文件；
 * - 损坏 JSON：读 / 写路径一律抛 profile_corrupt 拒绝，绝不静默覆盖；
 * - publicView() 是唯一出站视图：cookie 原值只给掩码（前 4 位…共 N 字符）。
 */

export const EMP_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DOMAIN_RE = /^[a-z0-9.-]+$/;
/** manual 粘贴 cookie 上限（本台口径 8192 字符，比 donor 16KB 更紧）。 */
export const MAX_SESSION_COOKIE = 8192;
/** 共享 BUC 会话生效域名后缀白名单（照 donor cookieDomains 默认值）。 */
export const DOMAIN_ALLOWLIST: readonly string[] = ["aliyun-inc.com", "alibaba-inc.com"];
export const SESSION_SOURCES: readonly string[] = ["manual", "chrome", "auto"];

const PREF_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PREF_KEYS = 50;
const MAX_PREF_STRING = 200;
const NAME_LIMIT = 64;

export function validEmp(id: unknown): boolean {
  return typeof id === "string" && EMP_RE.test(id);
}

/** donor mask() 语义：前 4 位 + 总长度，绝不回显原值。 */
export function maskCookie(value: string): string {
  const s = String(value ?? "");
  if (!s) return "";
  return `${s.slice(0, 4)}…共 ${s.length} 字符`;
}

/** donor parseCookieInput 语义的精简移植：「Cookie: a=b; c=d」/「a=b; c=d」/ DevTools JSON 数组 → 键值对。 */
export function parseCookiePairs(text: string): readonly (readonly [string, string])[] {
  const s = String(text ?? "").trim();
  if (!s) return [];
  let pairs: readonly (readonly [string, unknown])[] = [];
  if (s.startsWith("[") || s.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return [];
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.cookies)
        ? (parsed as Record<string, unknown>).cookies as unknown[]
        : [parsed];
    pairs = (arr as unknown[])
      .map((entry) => {
        const record = entry as Record<string, unknown> | null;
        return record && typeof record.name === "string" && record.value != null
          ? [record.name.trim(), String(record.value)] as const
          : null;
      })
      .filter((pair): pair is readonly [string, string] => pair !== null);
  } else {
    const flat = s.replace(/^cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "; ");
    pairs = flat.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const : null;
      })
      .filter((pair): pair is readonly [string, string] => pair !== null);
  }
  const seen = new Set<string>();
  const out: (readonly [string, string])[] = [];
  for (const [name, value] of pairs) {
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[;\r\n\0]/.test(value)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push([name, value]);
  }
  return out;
}

export function countCookiePairs(value: string): number {
  return parseCookiePairs(value).length;
}

export type DomainsResult =
  | { readonly ok: true; readonly domains: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 域名后缀白名单校验：每个域名必须等于或位于 aliyun-inc.com / alibaba-inc.com 之下。 */
export function normalizeDomains(input: unknown): DomainsResult {
  if (input === undefined || input === null) return { ok: true, domains: [...DOMAIN_ALLOWLIST] };
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: "domains 必须是非空数组（省略则使用白名单默认值）" };
  }
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") return { ok: false, reason: "domains 只接受字符串域名" };
    const domain = entry.trim().toLowerCase().replace(/^\.+/, "");
    if (!domain || domain.length > 120 || domain.includes("..") || !DOMAIN_RE.test(domain)) {
      return { ok: false, reason: `domains 含非法域名形态（只收 [a-z0-9.-]，≤120 字符）` };
    }
    const allowed = DOMAIN_ALLOWLIST.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
    if (!allowed) {
      return { ok: false, reason: `domains 不在白名单后缀内（${DOMAIN_ALLOWLIST.join(" / ")}）` };
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains.length > 0 ? { ok: true, domains } : { ok: false, reason: "domains 归一化后为空" };
}

/** manual cookie 值校验：返回 null=合法，否则返回不含原值的拒绝原因。 */
export function sessionValueProblem(value: unknown): string | null {
  if (typeof value !== "string") return "value 必须是字符串（粘贴的 Cookie 头）";
  const trimmed = value.trim();
  if (!trimmed) return "Cookie 不能为空";
  if (trimmed.length > MAX_SESSION_COOKIE) return `Cookie 超长（上限 ${MAX_SESSION_COOKIE} 字符）`;
  return null;
}

/** prefs 白名单：扁平键值（布尔/字符串/数字/null），越界返回 null（= 拒绝）。 */
export function sanitizePrefs(input: unknown): ProfilePrefs | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_PREF_KEYS) return null;
  const prefs: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    if (!PREF_KEY_RE.test(key)) return null;
    const kind = typeof value;
    if (value === null || kind === "boolean") prefs[key] = value as boolean | null;
    else if (kind === "number" && Number.isFinite(value)) prefs[key] = value as number;
    else if (kind === "string" && (value as string).length <= MAX_PREF_STRING) prefs[key] = value as string;
    else return null;
  }
  return prefs;
}

export function blankProfile(empId: string, mode: SessionSource = "manual"): ProfileDoc {
  return { version: 1, user: { empId, name: "" }, source: { mode }, session: null, prefs: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function sanitizeLastCheck(value: unknown): ProfileLastCheck | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  return {
    ok: value.ok,
    at: asText(value.at),
    self: typeof value.self === "boolean" ? value.self : null,
    code: typeof value.code === "string" && value.code ? value.code : null,
    note: typeof value.note === "string" && value.note ? value.note.slice(0, 200) : null,
    empId: typeof value.empId === "string" && value.empId ? value.empId.slice(0, 32) : null,
  };
}

function sanitizeSession(value: unknown): ProfileSessionRecord | null {
  if (!isRecord(value) || typeof value.value !== "string" || !value.value) return null;
  const domains = Array.isArray(value.domains)
    ? value.domains.filter((domain): domain is string => typeof domain === "string" && DOMAIN_RE.test(domain)).slice(0, 20)
    : [...DOMAIN_ALLOWLIST];
  return {
    value: value.value,
    domains,
    updatedAt: asText(value.updatedAt) || null,
    lastCheck: sanitizeLastCheck(value.lastCheck),
    verifiedAt: asText(value.verifiedAt) || null,
  };
}

/** 磁盘 JSON → ProfileDoc 的白名单投影；形态不可救药时返回 null（调用方按 corrupt 处理）。 */
export function sanitizeProfileDoc(raw: unknown, empId: string): ProfileDoc | null {
  if (!isRecord(raw)) return null;
  const user = isRecord(raw.user) ? raw.user : {};
  const source = isRecord(raw.source) ? raw.source : {};
  const mode: SessionSource = SESSION_SOURCES.includes(asText(source.mode)) ? source.mode as SessionSource : "manual";
  return {
    version: 1,
    user: {
      empId: validEmp(user.empId) ? asText(user.empId) : empId,
      name: asText(user.name).slice(0, NAME_LIMIT),
    },
    source: { mode },
    session: sanitizeSession(raw.session),
    prefs: sanitizePrefs(raw.prefs) ?? {},
  };
}

function sessionState(session: ProfileSessionRecord | null): "unset" | "set" | "ok" | "bad" {
  if (!session || !session.value) return "unset";
  if (session.lastCheck && session.lastCheck.ok === false) return "bad";
  if (session.lastCheck && session.lastCheck.ok === true) return "ok";
  return "set";
}

/** 唯一出站视图（照 donor publicView 语义）：绝无 session 原值，只暴露白名单元数据。 */
export function publicView(doc: ProfileDoc | null): ProfilePublicView {
  if (!doc) {
    return {
      configured: false,
      user: { empId: "", name: "" },
      source: { mode: "manual" },
      session: {
        set: false, masked: "", count: 0, domains: [...DOMAIN_ALLOWLIST],
        updatedAt: null, lastCheck: null, verifiedAt: null, state: "unset",
      },
      prefs: {},
    };
  }
  const session = doc.session;
  return {
    configured: true,
    user: { empId: doc.user.empId, name: doc.user.name },
    source: { mode: doc.source.mode },
    session: {
      set: Boolean(session && session.value),
      masked: session && session.value ? maskCookie(session.value) : "",
      count: session && session.value ? countCookiePairs(session.value) : 0,
      domains: session ? [...session.domains] : [...DOMAIN_ALLOWLIST],
      updatedAt: session ? session.updatedAt : null,
      lastCheck: session ? session.lastCheck : null,
      verifiedAt: session ? session.verifiedAt : null,
      state: sessionState(session),
    },
    prefs: { ...doc.prefs },
  };
}

export interface ActiveRecord {
  readonly empId: string;
  readonly at: string;
}

export interface ProfileStoreOptions {
  readonly home?: string;
  readonly now?: () => number;
}

export interface ProfileStore {
  readonly root: string;
  readonly activePath: string;
  readonly profilePath: (empId: string) => string;
  readonly readActive: () => Promise<ActiveRecord | null>;
  readonly setActive: (empId: string) => Promise<void>;
  readonly clearActive: () => Promise<void>;
  readonly readProfile: (empId: string) => Promise<ProfileDoc | null>;
  readonly writeProfile: (empId: string, doc: ProfileDoc) => Promise<void>;
}

/** tmp + rename 原子写；文件 0600，父目录递归创建（用户目录另行 0700）。 */
async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text, "utf-8");
  } finally {
    await handle.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export function createProfileStore(options: ProfileStoreOptions = {}): ProfileStore {
  const home = String(options.home ?? process.env.HOME ?? homedir()).replace(/\/$/, "");
  const now = options.now ?? Date.now;
  const root = join(home, ".sa-workbench");
  const activePath = join(root, "active.json");
  const usersRoot = join(root, "users");

  function profilePath(empId: string): string {
    if (!validEmp(empId)) throw new ProfileBridgeError("profile_invalid_request", "工号不合法（1-32 位字母 / 数字 / _ / -）");
    return join(usersRoot, empId, "profile.json");
  }

  /** 缺失 → null；损坏 JSON / 非对象 → profile_corrupt（绝不静默当空处理再覆盖）。 */
  async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ProfileBridgeError("profile_unavailable", `本机存储读取失败（${(error as NodeJS.ErrnoException).code ?? "IO 错误"}）`);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new ProfileBridgeError("profile_corrupt", `本机存储文件损坏（${file.replace(home, "~")}）：拒绝读写，请人工检查后修复或删除该文件`);
    }
  }

  async function readActive(): Promise<ActiveRecord | null> {
    const parsed = await readJsonFile(activePath);
    if (!parsed) return null;
    // 合法 JSON 但形态不对（如 empId 非法）＝没有活动账号，如实按未配置处理。
    return validEmp(parsed.empId) ? { empId: parsed.empId as string, at: asText(parsed.at) } : null;
  }

  async function setActive(empId: string): Promise<void> {
    if (!validEmp(empId)) throw new ProfileBridgeError("profile_invalid_request", "工号不合法（1-32 位字母 / 数字 / _ / -）");
    await atomicWrite(activePath, `${JSON.stringify({ empId, at: new Date(now()).toISOString() }, null, 2)}\n`);
  }

  async function clearActive(): Promise<void> {
    try {
      await unlink(activePath);
    } catch {
      // 已无 active.json：幂等成功。
    }
  }

  async function readProfile(empId: string): Promise<ProfileDoc | null> {
    const file = profilePath(empId);
    const parsed = await readJsonFile(file);
    if (!parsed) return null;
    const doc = sanitizeProfileDoc(parsed, empId);
    if (!doc) {
      throw new ProfileBridgeError("profile_corrupt", `profile.json 形态不可识别（${file.replace(home, "~")}）：拒绝覆盖，请人工检查`);
    }
    return doc;
  }

  async function writeProfile(empId: string, doc: ProfileDoc): Promise<void> {
    const file = profilePath(empId);
    const userDir = dirname(file);
    await mkdir(userDir, { recursive: true, mode: 0o700 });
    await chmod(userDir, 0o700);
    await atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  return { root, activePath, profilePath, readActive, setActive, clearActive, readProfile, writeProfile };
}
