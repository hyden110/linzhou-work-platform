import { execFile } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";

import { redactNote } from "../health/health-redact.ts";

/**
 * BUC 判活子进程层 — 语义照 base/sa-workbench tools/fetch/whoami.py（已移植到
 * tools/profile/whoami.py）：
 * - 默认 runner 一律 execFile('python3', [whoamiPath])，数组参数、shell:false、硬超时 20s；
 * - cookie 只经 env SA_SESSION_COOKIE 注入子进程内存，绝不进 argv（ps 可见）、日志与错误信息；
 * - 子进程输出按「末行 JSON」宽容解析（前置告警行不致命）；
 * - 任何回传 note 先过 health-redact 的 redactNote，敌意输出里的 cookie 形态内容也被抹除。
 */

export const WHOAMI_TIMEOUT_MS = 20_000;

export interface WhoamiRunOptions {
  readonly whoamiPath: string;
  readonly timeoutMs: number;
  /** 桥构建的完整子进程 env（含 SA_SESSION_COOKIE；绝不落日志）。 */
  readonly env: NodeJS.ProcessEnv;
}

export interface WhoamiOutcome {
  readonly ok: boolean;
  readonly empId: string | null;
  readonly name: string | null;
  readonly code: string | null;
  readonly note: string;
}

export type WhoamiRunner = (options: WhoamiRunOptions) => Promise<WhoamiOutcome>;

const NOTE_LIMIT = 200;

export function defaultWhoamiPath(): string {
  return join(resolvePath(import.meta.dirname, "..", ".."), "tools", "profile", "whoami.py");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asOptionalText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : null;

function firstLine(text: unknown): string {
  return String(text ?? "").split("\n")[0] ?? "";
}

/** 末行 JSON 宽容解析：从最后一行往前找第一条 { 开头且含 boolean ok 的合法 JSON。 */
export function parseWhoamiStdout(stdout: string): WhoamiOutcome | null {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") continue;
    return {
      ok: parsed.ok,
      empId: parsed.ok ? asOptionalText(parsed.empId) : null,
      name: parsed.ok ? asOptionalText(parsed.name) : null,
      code: typeof parsed.code === "string" && parsed.code ? parsed.code.slice(0, 40) : null,
      note: redactNote(parsed.note).slice(0, NOTE_LIMIT),
    };
  }
  return null;
}

/** 生产默认 runner：execFile python3 + env 注入 + 硬超时；失败折叠为诚实 outcome，绝不抛出原值。 */
export function createDefaultWhoamiRunner(): WhoamiRunner {
  return (options) =>
    new Promise<WhoamiOutcome>((resolve) => {
      execFile(
        "python3",
        [options.whoamiPath],
        {
          env: options.env,
          timeout: options.timeoutMs,
          shell: false,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const outcome = parseWhoamiStdout(String(stdout ?? ""));
          if (outcome) {
            resolve(outcome);
            return;
          }
          if (error) {
            const record = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            const timedOut = record.killed === true || record.signal === "SIGTERM";
            resolve({
              ok: false,
              empId: null,
              name: null,
              code: timedOut ? "timeout" : record.code === "ENOENT" ? "python_missing" : "runner_error",
              // execFile 的错误信息只含命令与参数（不含 env），仍统一过 redact 双保险。
              note: timedOut
                ? `判活子进程超时（>${Math.round(options.timeoutMs / 1000)}s）`
                : redactNote(firstLine(error.message)).slice(0, NOTE_LIMIT),
            });
            return;
          }
          resolve({
            ok: false,
            empId: null,
            name: null,
            code: "bad_output",
            note: redactNote(`whoami 输出无法解析：${firstLine(stderr) || "无 JSON 行"}`).slice(0, NOTE_LIMIT),
          });
        },
      );
    });
}
