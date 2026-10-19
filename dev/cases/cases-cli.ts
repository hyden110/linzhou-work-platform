import { execFile } from "node:child_process";

import { parseJsonPayload } from "../kb/kb-util.ts";

/**
 * CLI plumbing for the cases bridge (a1 / ossutil), modeled after
 * dev/kb/kb-adapter-shared.ts with one upgrade the reference needs: stderr is
 * captured too, so a failing channel can present an honest last-error.
 * Safety rules kept from the kb bridge: array args only (never a shell
 * string), hard timeout, no stdin, bounded output buffer.
 */

export type CasesCommandResult = {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export interface CasesCommandOptions {
  readonly timeoutMs: number;
}

export type CasesCommandRunner = (
  file: string,
  args: readonly string[],
  options: CasesCommandOptions,
) => Promise<CasesCommandResult>;

/** Default runner: execFile with array args, no shell, hard timeout. */
export function createDefaultCasesRunner(): CasesCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: options.timeoutMs, shell: false, maxBuffer: 64 * 1024 * 1024 },
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

/** First line of stderr (or a bare exit-code note), bounded like the reference `note`. */
export function cliErrorNote(result: CasesCommandResult): string {
  const line = result.stderr.trim().split("\n")[0]?.trim() ?? "";
  if (line) return line.slice(0, 200);
  if (result.code === null) return "执行失败";
  return `退出码 ${result.code}`;
}

/** 二进制缺失（ENOENT）→ notFoundMessage；非零退出 → 首行 stderr；JSON 解析失败 → 如实报错。 */
export async function runCliJson(
  run: CasesCommandRunner,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  notFoundMessage: string,
): Promise<unknown> {
  const result = await run(file, [...args, "-f", "json"], { timeoutMs });
  if (result.code === "ENOENT") throw new Error(notFoundMessage);
  if (result.code !== 0 && result.code !== null) throw new Error(cliErrorNote(result));
  const payload = parseJsonPayload(result.stdout);
  if (payload === undefined) throw new Error(`${file} 输出非 JSON`);
  return payload;
}
