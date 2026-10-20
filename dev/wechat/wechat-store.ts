/**
 * Wechat store（微信办公桥）— bindings / custorg 本地台账存取。
 * donor: scripts/bridge.js locked()（单飞）+ wechatQrWrite / custorg.save
 * （0600 原子写）语义 → V2 落 .local-cache/wechat/ 四件套：
 * - bindings.json     群↔客户人工绑定台账（本地文件写，不碰微信任何数据）；
 * - custorg.json      客户组织台账（按客户键合并，dry→confirm 后才写）；
 * - audit.jsonl       append-only 审计（一行一笔写尝试的结论，无消息正文）；
 * - backup/           每次覆盖写前的上一版备份（0600，可恢复）。
 * 闸门（沿 reply/notify 桥口径）：0600 文件 + 0700 目录、唯一 tmp + rename 原子写、
 * 写前备份、单飞锁（在飞即如实 wechat_busy 拒绝）、审计只增不改。
 */

import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import type { WechatBindingEntry } from "../../src/lib/wechat-model.ts";
import { WechatBridgeError } from "./wechat-types.ts";
import type { WechatAuditRow, WechatBindingsView, WechatCustorgCustomer, WechatCustorgRow } from "./wechat-types.ts";

/* dev/wechat/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_WECHAT_DIR = joinPath(PROJECT_ROOT, ".local-cache", "wechat");

const AUDIT_OPS: ReadonlySet<string> = new Set(["bind", "unbind", "custorg-import"]);
/** 审计尾读取上限（GET bindings 回显用，防响应膨胀）。 */
export const WECHAT_AUDIT_TAIL = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/** 台账行白名单投影：坏行返回 null（读路径双保险，坏行丢弃不猜）。 */
export function projectBindingEntry(raw: unknown): WechatBindingEntry | null {
  if (!isRecord(raw)) return null;
  const groupId = asText(raw.groupId).trim();
  if (!groupId) return null;
  if (!Array.isArray(raw.custKeys)) return null;
  const custKeys = raw.custKeys.filter((key): key is string => typeof key === "string").map((key) => key.trim()).filter(Boolean);
  return { groupId, custKeys, note: asText(raw.note), updatedAt: asText(raw.updatedAt) };
}

/** 审计行白名单投影：op 不在白名单 / 非对象一律 null。 */
export function projectAuditRow(raw: unknown): WechatAuditRow | null {
  if (!isRecord(raw)) return null;
  const op = asText(raw.op);
  if (!AUDIT_OPS.has(op)) return null;
  return {
    at: asText(raw.at),
    op: op as WechatAuditRow["op"],
    groupId: asText(raw.groupId),
    custKeys: Array.isArray(raw.custKeys) ? raw.custKeys.filter((k): k is string => typeof k === "string") : [],
    note: asText(raw.note),
    customers: asCount(raw.customers),
    rows: asCount(raw.rows),
    ok: raw.ok !== false,
  };
}

function projectCustorgRow(raw: unknown): WechatCustorgRow | null {
  if (!isRecord(raw)) return null;
  const row: WechatCustorgRow = {
    dept: asText(raw.dept),
    name: asText(raw.name),
    title: asText(raw.title),
    contact: asText(raw.contact),
  };
  return row.dept || row.name || row.title ? row : null;
}

function projectCustorgCustomers(raw: unknown): Record<string, WechatCustorgCustomer> {
  if (!isRecord(raw)) return {};
  const out: Record<string, WechatCustorgCustomer> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !Array.isArray(value.items)) continue;
    const items = value.items
      .map(projectCustorgRow)
      .filter((row): row is WechatCustorgRow => row !== null);
    out[key] = { name: asText(value.name), items };
  }
  return out;
}

export interface WechatStore {
  /** 绑定台账（坏文件如实空表，绝不静默重建真相）。 */
  readonly loadBindings: () => Promise<WechatBindingsView>;
  /** upsert 一条人工绑定（单飞 + 备份 + 0600 原子写 + 审计）。 */
  readonly putBinding: (entry: { groupId: string; custKeys: readonly string[]; note: string }) => Promise<WechatBindingsView>;
  /** 解绑（不存在如实 binding_not_found；同闸门）。 */
  readonly deleteBinding: (groupId: string) => Promise<WechatBindingsView>;
  /** custorg 台账读回（缺失/损坏如实空）。 */
  readonly loadCustorg: () => Promise<{ updatedAt: string; customers: Record<string, WechatCustorgCustomer> }>;
  /** 按客户键合并写入（出现的整体替换、未出现的保留；同闸门 + 审计）。 */
  readonly saveCustorgMerge: (
    parsed: Readonly<Record<string, WechatCustorgCustomer>>,
    meta: { customers: number; rows: number },
  ) => Promise<{ updatedAt: string; totalCustomers: number; totalRows: number }>;
  /** 审计尾 limit 行（最新在前）；坏行跳过，绝不因一行坏丢整账。 */
  readonly readAuditTail: (limit: number) => Promise<readonly WechatAuditRow[]>;
}

export interface WechatStoreOptions {
  readonly now?: () => number;
}

export function createWechatStore(dir: string, options: WechatStoreOptions = {}): WechatStore {
  const now = options.now ?? Date.now;
  const bindingsPath = joinPath(dir, "bindings.json");
  const custorgPath = joinPath(dir, "custorg.json");
  const auditPath = joinPath(dir, "audit.jsonl");
  const backupDir = joinPath(dir, "backup");
  let backupSeq = 0;

  const iso = (): string => new Date(now()).toISOString();

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
  }

  /** 0600 原子写：唯一 tmp + rename；失败清理 tmp 并如实 wechat_store_failed（不泄露路径）。 */
  async function writeAtomic(path: string, payload: string): Promise<void> {
    try {
      await ensureDir();
      const tmpPath = `${path}.${process.pid}.${now()}.${backupSeq += 1}.tmp`;
      try {
        await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
        await rename(tmpPath, path);
        await chmod(path, 0o600).catch(() => {});
      } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
      }
    } catch {
      throw new WechatBridgeError("wechat_store_failed", "本地台账写入失败（0600 原子写/备份任一环节）：本次未生效，请检查磁盘与目录权限后重试。");
    }
  }

  /** 写前备份：目标文件存在才备；备份失败不阻塞主写？——不，备份失败即整笔失败（可恢复优先）。 */
  async function backupFile(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return; // 首次写入无旧版可备：如实跳过
    }
    const name = `${path.split("/").pop() ?? "file"}.${now()}.${backupSeq += 1}.bak.json`;
    await mkdir(backupDir, { recursive: true, mode: 0o700 }).catch(() => {});
    await writeAtomic(joinPath(backupDir, name), raw);
  }

  async function readJsonLenient(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch {
      return null;
    }
  }

  /* 单飞锁（donor locked() 口径）：在飞时第二笔如实 busy 拒绝，不排队不静默。 */
  let inflight: Promise<unknown> | null = null;
  async function withLock<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (inflight) {
      throw new WechatBridgeError("wechat_busy", `台账写入进行中（${label} 单飞锁）：请等待上一笔完成后重试，本次未写入。`);
    }
    const task = run().finally(() => { inflight = null; });
    inflight = task;
    return task;
  }

  async function readEntries(): Promise<WechatBindingEntry[]> {
    const doc = await readJsonLenient(bindingsPath);
    const rows = isRecord(doc) && Array.isArray(doc.entries) ? doc.entries : [];
    return rows.map(projectBindingEntry).filter((row): row is WechatBindingEntry => row !== null);
  }

  async function bindingsViewOf(entries: readonly WechatBindingEntry[], updatedAt: string): Promise<WechatBindingsView> {
    return { updatedAt, entries, total: entries.length, auditTail: await readAuditTail(WECHAT_AUDIT_TAIL) };
  }

  async function appendAudit(row: Omit<WechatAuditRow, "at">): Promise<void> {
    try {
      await ensureDir();
      await appendFile(auditPath, `${JSON.stringify({ at: iso(), ...row })}\n`, { encoding: "utf-8", mode: 0o600 });
      await chmod(auditPath, 0o600).catch(() => {});
    } catch {
      // 审计是旁路：写失败不吞主结果，但如实留痕（stdout 结构化日志）。
      console.error(JSON.stringify({ event: "wechat_audit_write_failed", op: row.op, groupId: row.groupId }));
    }
  }

  async function writeBindings(entries: readonly WechatBindingEntry[], op: "bind" | "unbind", changed: { groupId: string; custKeys: readonly string[]; note: string }): Promise<WechatBindingsView> {
    const updatedAt = iso();
    await backupFile(bindingsPath);
    await writeAtomic(bindingsPath, JSON.stringify({ version: 1, updatedAt, entries }, null, 2));
    await appendAudit({ op, groupId: changed.groupId, custKeys: changed.custKeys, note: changed.note, customers: changed.custKeys.length, rows: 0, ok: true });
    return bindingsViewOf(entries, updatedAt);
  }

  async function loadBindings(): Promise<WechatBindingsView> {
    const doc = await readJsonLenient(bindingsPath);
    const updatedAt = isRecord(doc) ? asText(doc.updatedAt) : "";
    return bindingsViewOf(await readEntries(), updatedAt);
  }

  async function putBinding(entry: { groupId: string; custKeys: readonly string[]; note: string }): Promise<WechatBindingsView> {
    return withLock("bindings", async () => {
      const current = await readEntries();
      const kept = current.filter((row) => row.groupId !== entry.groupId);
      const next: WechatBindingEntry = {
        groupId: entry.groupId,
        custKeys: [...entry.custKeys],
        note: entry.note,
        updatedAt: iso(),
      };
      return writeBindings([...kept, next], "bind", { groupId: next.groupId, custKeys: next.custKeys, note: next.note });
    });
  }

  async function deleteBinding(groupId: string): Promise<WechatBindingsView> {
    return withLock("bindings", async () => {
      const current = await readEntries();
      if (!current.some((row) => row.groupId === groupId)) {
        throw new WechatBridgeError("binding_not_found", "该群不在本地绑定台账中：无需解绑或已解除（可先 GET /local/wechat/bindings 核对）。");
      }
      const next = current.filter((row) => row.groupId !== groupId);
      return writeBindings(next, "unbind", { groupId, custKeys: [], note: "" });
    });
  }

  async function loadCustorg(): Promise<{ updatedAt: string; customers: Record<string, WechatCustorgCustomer> }> {
    const doc = await readJsonLenient(custorgPath);
    return {
      updatedAt: isRecord(doc) ? asText(doc.updatedAt) : "",
      customers: projectCustorgCustomers(isRecord(doc) ? doc.customers : null),
    };
  }

  async function saveCustorgMerge(
    parsed: Readonly<Record<string, WechatCustorgCustomer>>,
    meta: { customers: number; rows: number },
  ): Promise<{ updatedAt: string; totalCustomers: number; totalRows: number }> {
    return withLock("custorg", async () => {
      const current = await loadCustorg();
      /* donor 合并语义：本次出现的客户整体替换，未出现的保留（增量导入不误伤已有台账）。 */
      const customers: Record<string, WechatCustorgCustomer> = { ...current.customers, ...parsed };
      const updatedAt = iso();
      await backupFile(custorgPath);
      await writeAtomic(custorgPath, JSON.stringify({ version: 1, updatedAt, customers }, null, 1));
      const totalCustomers = Object.keys(customers).length;
      const totalRows = Object.values(customers).reduce((sum, customer) => sum + customer.items.length, 0);
      await appendAudit({ op: "custorg-import", groupId: "", custKeys: Object.keys(parsed), note: "", customers: meta.customers, rows: meta.rows, ok: true });
      return { updatedAt, totalCustomers, totalRows };
    });
  }

  async function readAuditTail(limit: number): Promise<readonly WechatAuditRow[]> {
    let raw: string;
    try {
      raw = await readFile(auditPath, "utf-8");
    } catch {
      return [];
    }
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return projectAuditRow(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is WechatAuditRow => row !== null);
    return rows.slice(Math.max(0, rows.length - limit)).reverse();
  }

  return { loadBindings, putBinding, deleteBinding, loadCustorg, saveCustorgMerge, readAuditTail };
}
