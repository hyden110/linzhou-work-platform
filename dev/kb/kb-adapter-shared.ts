import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

import { parseJsonPayload } from "./kb-util.ts";

/**
 * Adapter contract ported from base/sa-workbench scripts/lib/kb/*.js.
 * Read-only surface only (spaces/search/read): the F2 endpoints expose no
 * config writes, so discover/test/list from the reference are intentionally
 * not ported.
 *
 * Safety rules every adapter must keep:
 * - external CLI calls go through the injected runner with ARRAY args only
 *   (never a shell string) and a hard timeout;
 * - long payloads (summary prompts) travel via stdin, not argv;
 * - remote reads only hit an allowlist of https hosts;
 * - ids coming from the browser are re-validated before any read.
 */

export type KbCommandResult = { readonly code: number | string | null; readonly stdout: string };

export interface KbCommandOptions {
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type KbCommandRunner = (
  file: string,
  args: readonly string[],
  options: KbCommandOptions,
) => Promise<KbCommandResult>;

/** Default runner: execFile with array args, no shell, hard timeout. */
export function createDefaultKbRunner(): KbCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        [...args],
        {
          timeout: options.timeoutMs,
          shell: false,
          maxBuffer: 16 * 1024 * 1024,
          cwd: options.cwd,
          env: options.env,
        },
        (error, stdout) => {
          if (error) {
            const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
            resolve({ code, stdout: String(stdout ?? "") });
            return;
          }
          resolve({ code: 0, stdout: String(stdout ?? "") });
        },
      );
      // 长文本（摘要提示词等）经 stdin 传入：argv 对同机任意进程的 ps 可见。
      if (options.stdin != null) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(String(options.stdin));
      }
    });
}

export interface KbAdapterContext {
  readonly run: KbCommandRunner;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}

/** CLI JSON call: array args only, bounded timeout, tolerant JSON extraction. */
export async function runCliJson(
  run: KbCommandRunner,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  notFoundMessage: string,
  extra: { readonly stdin?: string; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const result = await run(file, args, { timeoutMs, stdin: extra.stdin, cwd: extra.cwd, env: extra.env });
  if (result.code === "ENOENT" || (result.code === null && !result.stdout)) {
    throw new Error(notFoundMessage);
  }
  if (result.code !== 0 && result.code !== null) {
    throw new Error(cliErrorNote(result.stdout) ?? "执行失败");
  }
  const payload = parseJsonPayload(result.stdout);
  if (payload === undefined) throw new Error("JSON 解析失败");
  return payload;
}

function cliErrorNote(stdout: string): string | null {
  const payload = parseJsonPayload(stdout);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim().split("\n")[0]!.slice(0, 300);
    }
  }
  return null;
}

/** qodercli summary runs from a neutral cwd with SDK-entry env vars stripped. */
export function summaryRunnerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(QODER|QODERCN|QODERCLI|QW_QODER|__QODER)/.test(key) || key === "__CFBundleIdentifier") continue;
    env[key] = value;
  }
  return env;
}

export function summaryWorkingDir(): string {
  return tmpdir();
}
