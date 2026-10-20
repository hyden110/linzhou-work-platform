/**
 * Ontology store (F8) — .local-cache/ontology/ 三文件存取（唯一写者：本体桥）。
 *
 * 存储契约（任务口径）：
 * - edits.json：策展层真身 {v,uids,ops}；缺失 = 空策展层；**损坏 = 拒绝启动写路径并
 *   抛 ontology_edits_corrupt（绝不静默清空）**；
 * - audit.jsonl：每执行一动作追加一行 {at,by:'workbench',key,action,ok}（append-only）；
 * - graph.json：派生图缓存，每次成功动作后重建；读侧损坏/过期可诚实重建（真身是日志）。
 *
 * 写盘红线：原子写（唯一 tmp + rename）、0600 文件 / 0700 目录、失败清理 tmp；
 * 与 notify/leads 桥同口径（屋内无共享 secureWrite 工具，就近实现）。
 */

import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath, join as joinPath } from "node:path";

import { emptyEdits, parseEditsDoc } from "../../src/lib/ontology-model.ts";
import type { AuditLine, OntologyEdits, OntologyGraphView } from "../../src/lib/ontology-types.ts";
import { OntologyBridgeError } from "./ontology-types.ts";

/* dev/ontology/ 位于 dev/ 下，上跳两级才是项目根（与 notify 桥同口径）。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_ONTOLOGY_DIR = joinPath(PROJECT_ROOT, ".local-cache", "ontology");

const CORRUPT_MESSAGE = "本体策展层文件（edits.json）已损坏：为免覆盖策展真身，读写两侧均已停用；请人工检查该文件后再试。";

export interface OntologyStoreDeps {
  readonly now?: () => number;
}

export interface OntologyStore {
  /** 读 edits.json：缺失 → 空策展层；损坏（坏 JSON / 形态不符）→ ontology_edits_corrupt。 */
  readonly loadEdits: () => Promise<OntologyEdits>;
  /** 原子写 edits.json（tmp+rename，0600）。 */
  readonly saveEdits: (edits: OntologyEdits) => Promise<void>;
  /** 审计追加一行（append-only，0600）。 */
  readonly appendAudit: (line: AuditLine) => Promise<void>;
  /** 审计尾 limit 行（缺失 → []；坏行跳过——读侧宽容，写侧 append-only 保证形状）。 */
  readonly readAuditTail: (limit: number) => Promise<AuditLine[]>;
  /** 读 graph.json：缺失/损坏 → null（调用方内存重建；派生物不报错）。 */
  readonly loadGraph: () => Promise<OntologyGraphView | null>;
  /** 原子写 graph.json。 */
  readonly saveGraph: (view: OntologyGraphView) => Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function unavailable(error: unknown, what: string): OntologyBridgeError {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  return new OntologyBridgeError(
    "ontology_unavailable",
    `本体存储（${what}）暂时不可用（${typeof code === "string" && code ? code : "I/O 错误"}），请稍后重试。`,
  );
}

function parseAuditLine(raw: string): AuditLine | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    if (typeof value.at !== "string" || typeof value.action !== "string" || typeof value.ok !== "boolean") return null;
    if (typeof value.by !== "string") return null;
    if (value.key !== null && typeof value.key !== "string") return null;
    return { at: value.at, by: value.by, key: value.key, action: value.action, ok: value.ok };
  } catch {
    return null;
  }
}

function parseGraphDoc(raw: string): OntologyGraphView | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.generatedAt !== "string") return null;
    if (typeof value.opsCount !== "number" || typeof value.lastOpAt !== "string") return null;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.links)) return null;
    if (!value.stats || typeof value.stats !== "object") return null;
    return value as unknown as OntologyGraphView;
  } catch {
    return null;
  }
}

export function createOntologyStore(dir: string, deps: OntologyStoreDeps = {}): OntologyStore {
  const now = deps.now ?? (() => Date.now());
  const editsPath = joinPath(dir, "edits.json");
  const auditPath = joinPath(dir, "audit.jsonl");
  const graphPath = joinPath(dir, "graph.json");

  async function ensureDir(): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw unavailable(error, "目录");
    }
  }

  /** 原子写：唯一 tmp（pid+时间戳）→ 0600 → rename；失败清理 tmp。 */
  async function atomicWrite(path: string, payload: string): Promise<void> {
    await ensureDir();
    const tmpPath = `${path}.${process.pid}.${now()}.tmp`;
    try {
      await writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
      await chmod(tmpPath, 0o600).catch(() => {});
      await rename(tmpPath, path);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw unavailable(error, path === editsPath ? "edits.json" : "graph.json");
    }
  }

  async function loadEdits(): Promise<OntologyEdits> {
    let raw: string;
    try {
      raw = await readFile(editsPath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) return emptyEdits();
      throw unavailable(error, "edits.json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OntologyBridgeError("ontology_edits_corrupt", CORRUPT_MESSAGE);
    }
    const doc = parseEditsDoc(parsed);
    if (!doc) throw new OntologyBridgeError("ontology_edits_corrupt", CORRUPT_MESSAGE);
    return doc;
  }

  async function appendAudit(line: AuditLine): Promise<void> {
    await ensureDir();
    try {
      await appendFile(auditPath, `${JSON.stringify(line)}\n`, { encoding: "utf-8", mode: 0o600 });
      await chmod(auditPath, 0o600).catch(() => {});
    } catch (error) {
      throw unavailable(error, "audit.jsonl");
    }
  }

  async function readAuditTail(limit: number): Promise<AuditLine[]> {
    if (limit <= 0) return [];
    let raw: string;
    try {
      raw = await readFile(auditPath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw unavailable(error, "audit.jsonl");
    }
    const lines: AuditLine[] = [];
    for (const entry of raw.split("\n")) {
      if (entry.trim() === "") continue;
      const line = parseAuditLine(entry);
      if (line) lines.push(line);
    }
    return lines.slice(Math.max(0, lines.length - limit));
  }

  async function loadGraph(): Promise<OntologyGraphView | null> {
    let raw: string;
    try {
      raw = await readFile(graphPath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw unavailable(error, "graph.json");
    }
    return parseGraphDoc(raw);
  }

  return {
    loadEdits,
    saveEdits: (edits) => atomicWrite(editsPath, `${JSON.stringify(edits, null, 2)}\n`),
    appendAudit,
    readAuditTail,
    loadGraph,
    saveGraph: (view) => atomicWrite(graphPath, `${JSON.stringify(view, null, 2)}\n`),
  };
}
