import { buildReport, checkRow, firstLineOf, type CheckReport, type CheckRow, type CheckTool } from "./workbench-types.ts";
import { dependenciesRow, nodeVersionRow } from "./workbench-node.ts";
import { configRows } from "./workbench-config.ts";
import { envRows, type EnvView } from "./workbench-env.ts";
import { createDefaultToolRunner, toolsRows, type CommandRunner } from "./workbench-tools.ts";
import { createDefaultPortProbe, portsRows, type PortProbe } from "./workbench-ports.ts";
import { permissionsRow } from "./workbench-permissions.ts";
import { createNodeWorkbenchFs, type WorkbenchFs } from "./workbench-fs.ts";

/**
 * 检查汇总：六组（runtime / config / env / tools / ports / security）并行
 * 收集，单组异常降级为该组一行 error，绝不拖垮整份报告。
 * 全部依赖可注入，测试用合成 deps；CLI 入口用 createDefaultDeps。
 */

export interface WorkbenchDeps {
  readonly rootDir: string;
  readonly nodeVersion: string;
  readonly env: EnvView;
  readonly fs: WorkbenchFs;
  readonly run: CommandRunner;
  readonly probePort: PortProbe;
  readonly nowMs: number;
}

export function createDefaultDeps(
  rootDir: string,
  options: { readonly env?: EnvView; readonly nowMs?: number } = {},
): WorkbenchDeps {
  return {
    rootDir,
    nodeVersion: process.versions.node,
    env: options.env ?? process.env,
    fs: createNodeWorkbenchFs(),
    run: createDefaultToolRunner(),
    probePort: createDefaultPortProbe(),
    nowMs: options.nowMs ?? Date.now(),
  };
}

async function safeGroup(
  group: string,
  collect: () => Promise<readonly CheckRow[]>,
): Promise<readonly CheckRow[]> {
  try {
    return await collect();
  } catch (error) {
    return [checkRow(group, group, "error", `检查异常：${firstLineOf(error)}`)];
  }
}

export async function collectChecks(tool: CheckTool, deps: WorkbenchDeps): Promise<CheckReport> {
  const groups = await Promise.all([
    safeGroup("runtime", async () => [
      nodeVersionRow(deps.nodeVersion),
      await dependenciesRow(deps.rootDir, deps.fs),
    ]),
    safeGroup("config", async () => configRows(deps.rootDir, deps.fs)),
    safeGroup("env", async () => envRows(deps.env)),
    safeGroup("tools", async () => toolsRows(deps.run)),
    safeGroup("ports", async () => portsRows(deps.probePort)),
    safeGroup("security", async () => [await permissionsRow(deps.rootDir, deps.fs)]),
  ]);
  return buildReport(tool, groups.flat(), deps.nowMs);
}
