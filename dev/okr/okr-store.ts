import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sanitizeEditsFile } from "./okr-edits.ts";
import { OkrBridgeError, type OkrAuditLine, type OkrDiffItem, type OkrEditsFile } from "./okr-types.ts";

/**
 * OKR 本机缓存层（.local-cache/okr/）：
 * - okr.json          CRD 快照（fetch_okr.py 原子写；桥只读）
 * - edits.json        sync-dry 暂存的待同步编辑
 * - edits.confirm.json sync-confirm 勾选项（成功后清理，失败保留供排查）
 * - last-dry.json     最近一次 dry-run 的逐项差异（confirm 的冲突预检依据）
 * - audit.jsonl       确认写入审计，每行 {at,keys,acceptConflicts,exitCode}
 * 红线：损坏 JSON 一律抛 okr_corrupt 拒读，绝不静默覆盖；写盘全部 tmp+rename 原子。
 */

export interface OkrStore {
  readonly dir: string;
  readonly snapshotPath: string;
  readonly editsPath: string;
  readonly confirmPath: string;
  readonly lastDryPath: string;
  readonly auditPath: string;
  readonly readSnapshot: () => Promise<Record<string, unknown> | null>;
  readonly readEdits: () => Promise<OkrEditsFile>;
  readonly writeEdits: (file: OkrEditsFile) => Promise<void>;
  readonly writeConfirmEdits: (file: OkrEditsFile) => Promise<void>;
  readonly removeConfirmEdits: () => Promise<void>;
  readonly readLastDry: () => Promise<readonly OkrDiffItem[] | null>;
  readonly writeLastDry: (items: readonly OkrDiffItem[]) => Promise<void>;
  readonly appendAudit: (line: OkrAuditLine) => Promise<void>;
}

const EMPTY_EDITS: OkrEditsFile = { exportedAt: "", baseSnapshotAt: "", edits: [] };

/** tmp + rename 原子写（与 profile-store 同口径；快照缓存无凭据，0644 即可）。 */
async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(text, "utf-8");
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function readJsonOrNull(file: string, corruptLabel: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OkrBridgeError("okr_unavailable", `${corruptLabel}读取失败（${(error as NodeJS.ErrnoException).code ?? "IO 错误"}）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OkrBridgeError("okr_corrupt", `本机缓存文件损坏（${corruptLabel}）：拒绝读写，请人工检查后修复或删除 .local-cache/okr 下对应文件`);
  }
}

function sanitizeDryItems(raw: unknown): readonly OkrDiffItem[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).items)) return null;
  const items = (raw as Record<string, unknown>).items as unknown[];
  return items.filter((item): item is OkrDiffItem => Boolean(item) && typeof item === "object");
}

export function createOkrStore(dir: string): OkrStore {
  const snapshotPath = join(dir, "okr.json");
  const editsPath = join(dir, "edits.json");
  const confirmPath = join(dir, "edits.confirm.json");
  const lastDryPath = join(dir, "last-dry.json");
  const auditPath = join(dir, "audit.jsonl");

  async function readSnapshot(): Promise<Record<string, unknown> | null> {
    const parsed = await readJsonOrNull(snapshotPath, "OKR 快照 okr.json ");
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OkrBridgeError("okr_corrupt", "OKR 快照 okr.json 形态不可识别：请重新刷新快照");
    }
    return parsed as Record<string, unknown>;
  }

  async function readEditsFile(file: string): Promise<OkrEditsFile> {
    const parsed = await readJsonOrNull(file, "OKR 编辑暂存 edits.json ");
    if (parsed === null) return EMPTY_EDITS;
    const sanitized = sanitizeEditsFile(parsed);
    if (!sanitized) {
      throw new OkrBridgeError("okr_corrupt", "OKR 编辑暂存 edits.json 形态不可识别：请重新执行预检");
    }
    return sanitized;
  }

  async function writeEditsFile(file: string, payload: OkrEditsFile): Promise<void> {
    await atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async function removeConfirmEdits(): Promise<void> {
    try {
      await unlink(confirmPath);
    } catch {
      // 已不存在：幂等成功。
    }
  }

  async function readLastDry(): Promise<readonly OkrDiffItem[] | null> {
    const parsed = await readJsonOrNull(lastDryPath, "OKR 预检结果 last-dry.json ");
    if (parsed === null) return null;
    return sanitizeDryItems(parsed);
  }

  async function writeLastDry(items: readonly OkrDiffItem[]): Promise<void> {
    await atomicWrite(lastDryPath, `${JSON.stringify({ items }, null, 2)}\n`);
  }

  async function appendAudit(line: OkrAuditLine): Promise<void> {
    await mkdir(dir, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify(line)}\n`, "utf-8");
  }

  return {
    dir,
    snapshotPath,
    editsPath,
    confirmPath,
    lastDryPath,
    auditPath,
    readSnapshot,
    readEdits: () => readEditsFile(editsPath),
    writeEdits: (file) => writeEditsFile(editsPath, file),
    writeConfirmEdits: (file) => writeEditsFile(confirmPath, file),
    removeConfirmEdits,
    readLastDry,
    writeLastDry,
    appendAudit,
  };
}
