import { collectChecks, createDefaultDeps, type WorkbenchDeps } from "./workbench-checks.ts";
import { exitCodeOf, type CheckTool } from "./workbench-types.ts";
import { renderToolOutput } from "./workbench-format.ts";

/**
 * CLI 组装层（scripts/workbench-init.mjs / workbench-doctor.mjs 的全部逻辑）：
 * 收集检查 → 渲染表格 → 返回退出码（error>0 → 1）。
 * init 与 doctor 跑同一套只读检查；init 只是多一段「下一步」引导，
 * 两者的差异只在 tool 标识与输出尾部，二者都不写任何文件。
 */

export interface CliOptions {
  readonly rootDir: string;
  readonly deps?: WorkbenchDeps;
  readonly log?: (line: string) => void;
}

export async function runWorkbenchCli(tool: CheckTool, options: CliOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const deps = options.deps ?? createDefaultDeps(options.rootDir);
    const report = await collectChecks(tool, deps);
    log(renderToolOutput(report));
    return exitCodeOf(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${tool} 失败：${message.split("\n")[0] ?? ""}`);
    return 1;
  }
}
