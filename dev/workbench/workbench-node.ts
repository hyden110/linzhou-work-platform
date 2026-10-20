import { join } from "node:path";

import { checkRow, type CheckRow } from "./workbench-types.ts";
import { createNodeWorkbenchFs, type WorkbenchFs } from "./workbench-fs.ts";

/**
 * Runtime checks. Node 口径与 scripts/check-node.mjs 及 package.json engines
 * (>=22.12.0 <23) 一致：只接受 22.x 且 minor ≥ 12。check-node.mjs 在模块顶层
 * 直接执行（导入即抛错），因此这里按同一口径复刻判定，而不是 import 它。
 * 依赖检查通过注入的 WorkbenchFs 完成，测试用内存假 fs 覆盖各分支。
 */

export const NODE_MAJOR = 22;
export const NODE_MIN_MINOR = 12;

export function isSupportedNode(version: string): boolean {
  const [major, minor] = String(version ?? "").replace(/^v/, "").split(".").map(Number);
  return major === NODE_MAJOR && Number.isFinite(minor) && minor >= NODE_MIN_MINOR;
}

export function nodeVersionRow(version: string): CheckRow {
  return isSupportedNode(version)
    ? checkRow("runtime", "node", "ok", `Node ${version}（要求 ${NODE_MAJOR}.${NODE_MIN_MINOR}+ 且 <${NODE_MAJOR + 1}）`)
    : checkRow(
        "runtime",
        "node",
        "error",
        `Node ${version} 不受支持：需要 ${NODE_MAJOR}.${NODE_MIN_MINOR}+ 且 <${NODE_MAJOR + 1}。`
          + `修法：本终端切到 Node ${NODE_MAJOR}（如 nvm use ${NODE_MAJOR}）后重试`,
      );
}

function dependencyNames(manifest: unknown): readonly string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const record = manifest as Record<string, unknown>;
  const names = (value: unknown): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  return [...names(record.dependencies), ...names(record.devDependencies)];
}

async function missingPackages(rootDir: string, names: readonly string[], fs: WorkbenchFs): Promise<readonly string[]> {
  const checks = await Promise.all(
    names.map(async (name) => ((await fs.exists(join(rootDir, "node_modules", name, "package.json"))) ? "" : name)),
  );
  return checks.filter((name) => name.length > 0);
}

/** 依赖就绪：node_modules 存在且 package.json 声明的每个包都有自己的 package.json。 */
export async function dependenciesRow(
  rootDir: string,
  fs: WorkbenchFs = createNodeWorkbenchFs(),
): Promise<CheckRow> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(join(rootDir, "package.json")));
  } catch {
    return checkRow("runtime", "dependencies", "error", "package.json 缺失或无法解析");
  }
  const names = dependencyNames(manifest);
  if (!(await fs.exists(join(rootDir, "node_modules")))) {
    return checkRow("runtime", "dependencies", "error", `node_modules 缺失（声明 ${names.length} 个包）。修法：npm ci`);
  }
  const missing = await missingPackages(rootDir, names, fs);
  if (missing.length > 0) {
    const shown = missing.slice(0, 6).join("、") + (missing.length > 6 ? ` 等 ${missing.length} 个` : "");
    return checkRow("runtime", "dependencies", "error", `缺少依赖：${shown}。修法：npm ci`);
  }
  return checkRow("runtime", "dependencies", "ok", `已安装 ${names.length}/${names.length} 个声明依赖`);
}
