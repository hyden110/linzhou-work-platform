import { join } from "node:path";

import { checkRow, firstLineOf, type CheckRow } from "./workbench-types.ts";
import type { WorkbenchFs } from "./workbench-fs.ts";

/**
 * .local-cache 权限巡检：文件应为 0600、目录应为 0700，偏离 → warn。
 * 只走访元数据（相对路径 + 权限位），绝不读内容；说明里只出现相对路径与
 * 权限位数字（如 0644）。符号链接不适用该口径（跳过）；走访有条目上限，
 * 防止意外巨型目录拖垮体检。
 */

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

const GROUP = "security";
const ROW_NAME = ".local-cache 权限";
const MAX_ENTRIES = 1_000;
const MAX_SHOWN = 6;
const CACHE_DIR = ".local-cache";

interface Deviation {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly mode: number;
}

interface WalkResult {
  readonly deviations: readonly Deviation[];
  readonly visited: number;
  readonly truncated: boolean;
}

async function walkDir(fs: WorkbenchFs, dir: string, prefix: string, budget: number): Promise<WalkResult> {
  const entries = await fs.list(dir);
  const deviations: Deviation[] = [];
  let visited = 0;
  let truncated = false;
  for (const entry of entries) {
    if (visited >= budget) {
      truncated = true;
      break;
    }
    visited += 1;
    if (entry.kind === "other") continue;
    const mode = entry.mode & 0o777;
    const expected = entry.kind === "dir" ? DIR_MODE : FILE_MODE;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (mode !== expected) deviations.push({ path, kind: entry.kind, mode });
    if (entry.kind === "dir") {
      const child = await walkDir(fs, join(dir, entry.name), path, budget - visited);
      visited += child.visited;
      truncated = truncated || child.truncated;
      deviations.push(...child.deviations);
    }
  }
  return { deviations, visited, truncated };
}

function octalOf(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function formatDeviation(deviation: Deviation): string {
  const kind = deviation.kind === "dir" ? "目录" : "文件";
  const suffix = deviation.kind === "dir" ? "/" : "";
  return `${deviation.path}${suffix}（${kind}）${octalOf(deviation.mode)}`;
}

function renderRow(result: WalkResult): CheckRow {
  const total = result.deviations.length;
  if (total === 0) {
    return checkRow(GROUP, ROW_NAME, "ok", `全部 ${result.visited} 个条目合规（文件 0600 / 目录 0700；内容不读取）`);
  }
  const shown = result.deviations.slice(0, MAX_SHOWN).map(formatDeviation);
  const rest = total > MAX_SHOWN ? ` 等 ${total} 个` : "";
  const truncated = result.truncated ? `；条目超过 ${MAX_ENTRIES}，走访已截断` : "";
  return checkRow(
    GROUP,
    ROW_NAME,
    "warn",
    `${total} 个条目偏离（文件应为 0600、目录应为 0700）：${shown.join("、")}${rest}${truncated}`,
  );
}

export async function permissionsRow(rootDir: string, fs: WorkbenchFs): Promise<CheckRow> {
  const cacheDir = join(rootDir, CACHE_DIR);
  if (!(await fs.exists(cacheDir))) {
    return checkRow(GROUP, ROW_NAME, "info", "目录不存在，暂无本地缓存文件可检查");
  }
  try {
    return renderRow(await walkDir(fs, cacheDir, "", MAX_ENTRIES));
  } catch (error) {
    return checkRow(GROUP, ROW_NAME, "error", `读取失败：${firstLineOf(error)}`);
  }
}
