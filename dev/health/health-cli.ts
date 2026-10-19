import { execFile } from "node:child_process";

import { redactNote } from "./health-redact.ts";
import type { HealthCliRow } from "./health-types.ts";

/**
 * Read-only CLI presence probes (F4), modeled on dev/cases/cases-cli.ts:
 * array args only (never a shell string), no stdin, bounded output, a hard
 * per-CLI timeout (≤15s). Every probe is a version-style subcommand with no
 * side effects; login state is only reported when a version-like read-only
 * command yields it, otherwise the row answers "unknown" honestly. dws runs
 * bare (array argv, never piped through a shell). Failing probes degrade
 * their own row only — the snapshot as a whole never goes down with them.
 */

export type HealthCommandResult = {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type HealthCommandRunner = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<HealthCommandResult>;

export interface CliSpec {
  /** 稳定行 key，前端按它映射中文标签。 */
  readonly key: string;
  /** 只读版本探测参数；绝不跑有副作用的命令。 */
  readonly versionArgs: readonly string[];
  readonly fix: string;
}

export const DEFAULT_CLI_TIMEOUT_MS = 10_000;
export const MAX_CLI_TIMEOUT_MS = 15_000;

/** 顺序即展示顺序：五个取数 CLI，语义对应静态版 CLI_CHECKS（只搬口径）。 */
export const CLI_SPECS: readonly CliSpec[] = [
  { key: "a1", versionArgs: ["--version"], fix: "随 Aone 工具链安装；内网登录态用 a1 auth login（免令牌）" },
  { key: "ossutil", versionArgs: ["version"], fix: "安装 ossutil 后执行 ossutil config 写 ~/.ossutilconfig（工作台脚本不读 AK 值）" },
  { key: "qodercli", versionArgs: ["--version"], fix: "随 Qoder 应用安装/更新（~/.qoder/bin 下取版本号最新）" },
  { key: "dws", versionArgs: ["--version"], fix: "检查 ~/.qoder/bin/dws 是否在 PATH；钉钉授权用 dws auth login" },
  { key: "aliyun", versionArgs: ["version"], fix: "安装 aliyun CLI 后执行 aliyun configure（AK 与默认 region）" },
];

/** Default runner: execFile with array args, no shell, hard timeout. */
export function createDefaultHealthRunner(): HealthCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: options.timeoutMs, shell: false, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
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

/** 从 --version 输出提取首个版本样式片段（1.2 / 1.2.3 / 1.2.3-beta.1）。 */
export function extractVersion(text: string): string {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-.][\w.-]+)?)/.exec(String(text ?? ""));
  const version = match?.[1] ?? "";
  return /^\d+\.\d+/.test(version) ? version.slice(0, 40) : "";
}

/** 单 CLI 只读探测：缺失→missing；超时/失败→error（note 已脱敏）；成功→ok 或 unknown。 */
export async function checkCli(
  spec: CliSpec,
  bin: string,
  run: HealthCommandRunner,
  timeoutMs: number,
): Promise<HealthCliRow> {
  const result = await run(bin, [...spec.versionArgs], { timeoutMs });
  if (result.code === "ENOENT") {
    return { name: spec.key, state: "missing", version: "", note: `未安装。修法：${spec.fix}` };
  }
  if (result.code === null) {
    return { name: spec.key, state: "error", version: "", note: `命令超时（${Math.max(Math.round(timeoutMs / 1000), 1)}s）或被终止` };
  }
  if (result.code !== 0) {
    const line = redactNote(result.stderr || result.stdout);
    return {
      name: spec.key,
      state: "error",
      version: "",
      note: line ? `${spec.key} ${spec.versionArgs.join(" ")} 失败：${line}` : `${spec.key} 退出码 ${result.code}`,
    };
  }
  const version = extractVersion(result.stdout) || extractVersion(result.stderr);
  return version
    ? { name: spec.key, state: "ok", version, note: "" }
    : { name: spec.key, state: "unknown", version: "", note: "已安装，但只读探测未取得版本号" };
}

/** 全组并行探测；单行异常降级为该行 error，绝不拖垮整体快照。 */
export async function collectCli(
  run: HealthCommandRunner,
  bins: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<readonly HealthCliRow[]> {
  const capped = Math.min(Math.max(timeoutMs, 1_000), MAX_CLI_TIMEOUT_MS);
  return Promise.all(
    CLI_SPECS.map(async (spec): Promise<HealthCliRow> => {
      try {
        return await checkCli(spec, bins[spec.key] ?? spec.key, run, capped);
      } catch (error) {
        return {
          name: spec.key,
          state: "error",
          version: "",
          note: redactNote(error instanceof Error ? error.message : error) || "探测异常",
        };
      }
    }),
  );
}
