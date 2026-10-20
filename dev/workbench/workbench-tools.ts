import { execFile } from "node:child_process";

import { checkRow, firstLineOf, type CheckRow } from "./workbench-types.ts";

/**
 * 命令行工具存在性检查：execFile("which", [tool])，数组参数、shell:false、
 * 每项独立超时；只探存在性（PATH 可见与否），不跑版本/登录态子命令
 * （那是 F4 体检面板 dev/health/health-cli.ts 的职责）。
 * 未安装是能力缺口（info + 修法），不是错误——不影响退出码。
 */

export interface CommandResult {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<CommandResult>;

export interface ToolSpec {
  readonly name: string;
  readonly fix: string;
}

const GROUP = "tools";
const WHICH = "which";

/** 顺序即展示顺序；口径对齐静态版 CLI_CHECKS 与 F4 health-cli 的 CLI 清单。 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "dws", fix: "随 Qoder 工具链安装（~/.qoder/bin 加入 PATH）；钉钉授权执行 dws auth login" },
  { name: "a1", fix: "随 Aone 工具链安装；内网登录态执行 a1 auth login（免令牌）" },
  { name: "ossutil", fix: "安装 ossutil 后执行 ossutil config 写 ~/.ossutilconfig（脚本不读 AK）" },
  { name: "qodercli", fix: "随 Qoder 应用安装/更新（~/.qoder/bin 下取版本号最新）" },
  { name: "aliyun", fix: "安装 aliyun CLI 后执行 aliyun configure（AK 与默认 region）" },
];

export const DEFAULT_TOOL_TIMEOUT_MS = 5_000;

/** 默认 runner：execFile + 数组参数 + shell:false + 硬超时，永不 reject。 */
export function createDefaultToolRunner(): CommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: options.timeoutMs, shell: false, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

export async function checkToolRow(spec: ToolSpec, run: CommandRunner, timeoutMs: number): Promise<CheckRow> {
  const result = await run(WHICH, [spec.name], { timeoutMs });
  if (result.code === 0) {
    return checkRow(GROUP, spec.name, "ok", "已安装（PATH 可见）");
  }
  if (result.code === "ENOENT") {
    return checkRow(GROUP, spec.name, "info", "无法探测（本机找不到 which 命令）");
  }
  if (result.code === null) {
    return checkRow(GROUP, spec.name, "warn", `探测超时（${Math.max(Math.round(timeoutMs / 1000), 1)}s）`);
  }
  return checkRow(GROUP, spec.name, "info", `未安装。修法：${spec.fix}`);
}

/** 全组并行探测；单行异常降级为该行 error，绝不拖垮整份报告。 */
export async function toolsRows(
  run: CommandRunner,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<readonly CheckRow[]> {
  return Promise.all(
    TOOL_SPECS.map(async (spec): Promise<CheckRow> => {
      try {
        return await checkToolRow(spec, run, timeoutMs);
      } catch (error) {
        return checkRow(GROUP, spec.name, "error", `探测异常：${firstLineOf(error)}`);
      }
    }),
  );
}
