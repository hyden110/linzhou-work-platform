import { execFile } from "node:child_process";

import { ReportBridgeError } from "./report-types.ts";

/**
 * dws / SSH contract for the report bridge (F6) — ported from base/sa-workbench
 * scripts/lib/report/index.js runCmd/dwsRunOf/rateRetry/sshRun（搬语义不搬代码）。
 * 只读红线：仅 4 条 dws 只读命令 + 1 条 SSH automation detail；数组 argv、无本地
 * shell、显式超时、有界输出；dws 自管钉钉凭据，本模块不读也不落任何 Cookie/Token。
 * 注意：automations 的远端命令串只在「远端 shell」里展开（ssh 单 argv 传入），
 * 本地进程是 execFile("ssh", [...])——bin/wakerId/trigger 均先过静态版同款正则。
 */

export const RECORD_QUERY_TIMEOUT_MS = 60_000;
export const OUTBOX_LIST_TIMEOUT_MS = 30_000;
export const DRIVE_LIST_TIMEOUT_MS = 60_000;
export const DOC_READ_TIMEOUT_MS = 60_000;
export const AUTOMATIONS_SSH_TIMEOUT_MS = 90_000;

/** dws 限流自愈重试的间隔（照静态版 1.5s；测试可注入 0）。 */
export const RATE_RETRY_SLEEP_MS = 1_500;
/** 照静态版 RATE_RE：CLI 侧呈现为 business error: success=false / RATE_LIMIT 等。 */
export const RATE_LIMIT_PATTERN = /business error: success=false|RATE_LIMIT|限流|过于频繁|too frequent/i;

export type ReportCommandResult = {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
};

export interface ReportCommandOptions {
  readonly timeoutMs: number;
}

export type ReportCommandRunner = (
  file: string,
  args: readonly string[],
  options: ReportCommandOptions,
) => Promise<ReportCommandResult>;

/** 默认 runner：execFile 数组参数、无 shell、硬超时、有界输出（与 leads/cases 桥同口径）。 */
export function createDefaultReportRunner(): ReportCommandRunner {
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

/** dws 定位：QODERWAKE_DWS_CLI_PATH → DWS_BIN → ~ 展望路径 → PATH 裸命令（与 leads-sync 同口径）。 */
export function resolveDwsBin(env: NodeJS.ProcessEnv, existsSync: (path: string) => boolean): string {
  const fromEnv = String(env.QODERWAKE_DWS_CLI_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  const binEnv = String(env.DWS_BIN ?? "").trim();
  if (binEnv) return binEnv;
  const home = String(env.HOME ?? "");
  const candidates = home
    ? [`${home}/.qoderwork/bin/dws`, `${home}/.qoder/bin/dws`, "/usr/local/bin/dws"]
    : ["/usr/local/bin/dws"];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? "dws";
}

/** CLI 输出常在 JSON 前后带告警行：取首个 { 到最后一个 } 宽容解析（照静态版 jsonOf）。 */
export function parseDwsJson(rawText: string): unknown {
  const s = String(rawText ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new ReportBridgeError("report_unavailable", "dws 无 JSON 输出");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReportBridgeError("report_unavailable", `dws JSON 解析失败：${reason}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * dws v1.0.52.x 成功响应带 error:{} 空对象——仅非空 error / success:false 才算失败
 * （照静态版 dwsFail）；need_auth / no_enterprise / dws-error 三分类照抄。
 */
export function classifyDwsFailure(
  payload: Record<string, unknown>,
): { kind: "need_auth" | "no_enterprise" | "dws-error"; message: string } | null {
  const error = payload.error;
  const hasError = Boolean(error) && (typeof error !== "object" || Array.isArray(error) || Object.keys(error).length > 0);
  const failed = payload.success === false;
  if (!hasError && !failed) return null;
  const errorRecord = asRecord(error);
  const message = String(
    (typeof error === "string" ? error : (errorRecord.message ?? errorRecord.reason)) ?? payload.message ?? payload.reason ?? "dws 调用失败",
  );
  const kind = /not_authenticated|未登录|auth login/i.test(message)
    ? "need_auth"
    : /ENTERPRISE_NOT_AUTHORIZED/.test(message)
      ? "no_enterprise"
      : "dws-error";
  return { kind, message };
}

function lastLine(text: string): string {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

/**
 * 跑一条 dws 只读命令并解 JSON：dws 缺失（ENOENT / 定位不到）→ report_unavailable；
 * 无 JSON / 解析失败 → report_unavailable；dws 报失败 → report_upstream（分类进 detail）。
 * 限流形态错误隔 sleepMs 重试一次（照静态版 rateRetry）；sleepImpl 可注入（测试免真实等待）。
 */
export async function runDws(
  run: ReportCommandRunner,
  dwsBin: string,
  args: readonly string[],
  timeoutMs: number,
  retrySleepMs: number = RATE_RETRY_SLEEP_MS,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
): Promise<Record<string, unknown>> {
  const attempt = async (): Promise<Record<string, unknown>> => {
    const result = await run(dwsBin, [...args, "--format", "json"], { timeoutMs });
    if (result.code === "ENOENT") {
      throw new ReportBridgeError("report_unavailable", "未找到 dws CLI；修法：安装 dws 后 dws auth login 完成钉钉授权");
    }
    let payload: Record<string, unknown> | null = null;
    let reason = "";
    for (const stream of [result.stdout, result.stderr]) {
      try {
        payload = asRecord(parseDwsJson(stream));
        break;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (!payload) {
      throw new ReportBridgeError(
        "report_unavailable",
        `dws 无 JSON 输出：${redactText(lastLine(result.stderr || result.stdout)).slice(0, 200) || reason}`,
      );
    }
    const failure = classifyDwsFailure(payload);
    if (failure) {
      const redactedMessage = redactText(failure.message);
      const classified = new ReportBridgeError("report_upstream", redactedMessage.slice(0, 300));
      (classified as { detail?: string }).detail = failure.kind;
      // 限流判定用截断前的完整消息（评审 P3-2：标记落在 300 字截断之外时不能漏重试）。
      (classified as { rateLimited?: boolean }).rateLimited = RATE_LIMIT_PATTERN.test(redactedMessage);
      throw classified;
    }
    return payload;
  };
  try {
    return await attempt();
  } catch (error) {
    const retryable = error instanceof ReportBridgeError
      && (error as { detail?: string }).detail === "dws-error"
      && (error as { rateLimited?: boolean }).rateLimited === true;
    if (!retryable) throw error;
    await sleepImpl(retrySleepMs);
    return attempt();
  }
}

/** SSH 只读探测：BatchMode + ConnectTimeout + 私钥 + host + 固定模板远端命令（单 argv，无本地 shell）。 */
export async function runSsh(
  run: ReportCommandRunner,
  options: {
    readonly host: string;
    readonly keyPath: string;
    readonly remoteCommand: string;
    readonly timeoutMs: number;
  },
): Promise<ReportCommandResult> {
  const result = await run("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-i", options.keyPath,
    options.host,
    options.remoteCommand,
  ], { timeoutMs: options.timeoutMs });
  return result;
}

/** 凭据形态脱敏（sk- 16 位裸密钥 / LTAI 8 位 AccessKey / token= 等键值形态），错误消息与任何
 * 透出文本先过这里。词边界 + 长度下限为本批加严口径（较 leads/health 更严）：
 * task-list / risk-control / sklearn / flask-app 等正常词不得命中（评审 P2-1）。 */
export function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[已脱敏]")
    .replace(/\bLTAI[A-Za-z0-9]{8,}/g, "[已脱敏]")
    .replace(/\b(?:api[_-]?key|token|password|cookie|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "[已脱敏]");
}
