import { execFile } from "node:child_process";

/**
 * OKR python 子进程层 — 与 profile-whoami.ts / leads-sync.ts 同口径：
 * - 默认 runner 一律 execFile('python3', [scriptPath, ...args])：数组参数、
 *   shell:false、硬超时、有界输出（8MB）；
 * - BUC cookie 只经 env SA_SESSION_COOKIE 注入子进程内存，绝不进 argv（ps 可见）、
 *   日志与错误信息；
 * - 子进程输出按「末行 JSON」宽容解析（前置进度 / 告警行不致命）。
 */

export interface PythonRunOptions {
  readonly scriptPath: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** 桥构建的完整子进程 env（含 SA_SESSION_COOKIE；绝不落日志）。 */
  readonly env: NodeJS.ProcessEnv;
}

export interface PythonRunResult {
  /** 进程退出码；被超时杀死 / 无法启动时为 null。 */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** spawn 级错误（如 python3 缺失 ENOENT）；正常退出为 null。 */
  readonly spawnError: string | null;
}

export type PythonRunner = (options: PythonRunOptions) => Promise<PythonRunResult>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 末行 JSON 宽容解析：从最后一行往前找第一条 { 开头的合法 JSON 对象。 */
export function parseLastJson(stdout: unknown): Record<string, unknown> | null {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 不是合法 JSON 行：继续向前找。
    }
  }
  return null;
}

/** 生产默认 runner：execFile python3 + env 注入 + 硬超时；失败折叠为诚实结果，绝不抛出。 */
export function createDefaultPythonRunner(): PythonRunner {
  return (options) =>
    new Promise<PythonRunResult>((resolve) => {
      execFile(
        "python3",
        [options.scriptPath, ...options.args],
        {
          env: options.env,
          timeout: options.timeoutMs,
          shell: false,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, timedOut: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), spawnError: null });
            return;
          }
          const record = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
          const timedOut = record.killed === true || record.signal === "SIGTERM";
          const exitCode = typeof record.code === "number" ? record.code : null;
          resolve({
            exitCode,
            timedOut,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            // spawn 级错误（ENOENT 等）才记 spawnError；普通非零退出只体现在 exitCode。
            // execFile 的错误信息只含命令与参数（不含 env）；仍由调用方过 redact 双保险。
            spawnError: timedOut || exitCode !== null ? null : String(record.code ?? error.message.split("\n")[0] ?? "runner_error"),
          });
        },
      );
    });
}
