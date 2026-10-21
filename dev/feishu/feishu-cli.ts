/**
 * Feishu CLI 探测层（飞书办公台账桥）— 发现 / 版本 / 授权探针 / 只读命令闸门。
 *
 * 红线：execFile 数组 argv、shell:false、硬超时 25s、maxBuffer 4MB；只读命令
 * 白名单精确匹配（auth login / 任何发信写命令根本进不了 runner）；section 级
 * 隔离——单命令失败只产出该区 note，绝不拖垮整体；错误文案先脱敏（服务器绝对
 * 路径 / lark token / JWT / open_id 形态词一律打码）再截断，中文诚实。
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  FEISHU_AUTH_ARGS,
  FEISHU_CLI_MAX_BUFFER,
  FEISHU_CLI_TIMEOUT_CODE,
  FEISHU_CLI_TIMEOUT_MS,
  FEISHU_READONLY_COMMANDS,
  FEISHU_SECTION_NOTE_DETAIL_CHARS,
  FEISHU_VERSION_ARGS,
  type FeishuIdentity,
  type FeishuRunner,
  type FeishuTokenStatus,
} from "./feishu-types.ts";

/** auth status 探针结论（只留视图需要的字段，payload 其余立即丢弃）。 */
export interface FeishuAuthProbe {
  readonly userAvailable: boolean;
  readonly identity: FeishuIdentity;
  readonly userName: string;
  readonly tokenStatus: FeishuTokenStatus;
  readonly note: string;
  readonly probeFailed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/* ---------------- 发现 ---------------- */

/** 发现顺序：FEISHU_CLI_PATH → ~/.qoderwork → ~/.qwenworkcn → PATH（拼出逐个可 fs 检查的候选）。 */
export function defaultFeishuCandidates(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): readonly string[] {
  const candidates: string[] = [];
  const fromEnv = (env.FEISHU_CLI_PATH ?? "").trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(join(home, ".qoderwork", "bin", "lark-cli"));
  candidates.push(join(home, ".qwenworkcn", "bin", "lark-cli"));
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.trim()) candidates.push(join(dir, "lark-cli"));
  }
  return candidates;
}

/** 第一个存在的常规文件胜出；全不存在如实空串（cli_missing 诚实态的输入）。 */
export function discoverFeishuCli(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // 不可 stat（权限等）按不存在处理，继续下一候选
    }
  }
  return "";
}

/** 默认 runner：execFile 跑发现到的二进制（数组 argv、无 shell、硬超时、限缓冲）。 */
export function createExecFileRunner(path: string): FeishuRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        path,
        [...args],
        { timeout: FEISHU_CLI_TIMEOUT_MS, shell: false, maxBuffer: FEISHU_CLI_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            return;
          }
          const withCode = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const code = withCode.killed || withCode.signal
            ? FEISHU_CLI_TIMEOUT_CODE // 超时被杀：GNU timeout 同款约定码
            : typeof withCode.code === "number"
              ? withCode.code
              : -1; // ENOENT 等字符串错误码：如实 -1（发现后消失的竞态）
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

/* ---------------- 脱敏 ---------------- */

const ABS_PATH_RE = /(?:\/(?:Users|home|Volumes|private|var|opt|usr)\/|\/tmp\/|[A-Za-z]:\\)\S+/g;
const LARK_TOKEN_RE = /\b[tu]-[A-Za-z0-9._-]{6,}\b/g;
const APP_ID_RE = /\bcli_[A-Za-z0-9]{6,}\b/g;
const OPEN_ID_RE = /\b(?:ou|on|om)_[A-Za-z0-9]{6,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g;

/** 错误细节脱敏：路径/token/appid/open_id/JWT 打码 → 取首行 → 截断。绝不原样透出 stderr。 */
export function redactText(text: unknown, max: number = FEISHU_SECTION_NOTE_DETAIL_CHARS): string {
  const firstLine = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const redacted = firstLine
    .replace(JWT_RE, "<token>")
    .replace(LARK_TOKEN_RE, "<token>")
    .replace(APP_ID_RE, "<appid>")
    .replace(OPEN_ID_RE, "<id>")
    .replace(ABS_PATH_RE, "<路径>");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/* ---------------- 只读命令闸门 + JSON 运行 ---------------- */

export type FeishuRunOk = { readonly ok: true; readonly payload: unknown };
export type FeishuRunFail = { readonly ok: false; readonly note: string };

function parseCliJson(stdout: string): unknown | undefined {
  const text = String(stdout ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // 容错：个别环境会在 JSON 前打一行提示——从首个 {/[ 起再试一次（仍失败如实 undefined）
    const start = text.search(/[[{]/);
    if (start <= 0) return undefined;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return undefined;
    }
  }
}

/**
 * 只读命令唯一入口：argv 精确匹配白名单才执行（写/发信/登录命令在构造层就不存在，
 * 这里再挡一道——纵深防御）。失败 kinds 全部产出中文 note（已脱敏），绝不抛给用户堆栈。
 */
export async function runReadonlyJson(
  runner: FeishuRunner,
  args: readonly string[],
): Promise<FeishuRunOk | FeishuRunFail> {
  const key = [...args].join(" ");
  if (!FEISHU_READONLY_COMMANDS.includes(key)) {
    return { ok: false, note: "命令不在只读白名单内：已拒绝执行（本桥只读，绝不跑写/发信/登录命令）。" };
  }
  try {
    const result = await runner([...args]);
    if (result.code === FEISHU_CLI_TIMEOUT_CODE) {
      return { ok: false, note: `命令超时（${Math.round(FEISHU_CLI_TIMEOUT_MS / 1000)} 秒）已终止，本区未取到数据。` };
    }
    if (result.code !== 0) {
      const detail = redactText(result.stderr || result.stdout);
      return { ok: false, note: detail ? `lark-cli 失败（退出码 ${result.code}）：${detail}` : `lark-cli 失败（退出码 ${result.code}）。` };
    }
    const payload = parseCliJson(result.stdout);
    if (payload === undefined) {
      return { ok: false, note: "lark-cli 输出不是合法 JSON：本区未取到数据（桥只读，不猜内容）。" };
    }
    return { ok: true, payload };
  } catch (error) {
    const detail = redactText(error instanceof Error ? error.message : String(error));
    return { ok: false, note: detail ? `lark-cli 调用异常：${detail}` : "lark-cli 调用异常：原因不可读。" };
  }
}

/* ---------------- 版本与授权探针 ---------------- */

/** 从 --version 输出提取版本样式片段（保留 CLI 打印的 v 前缀，如 v1.0.45.1）。 */
export function extractVersion(text: unknown): string {
  const match = /(v?\d+(?:\.\d+)+(?:[-.\w]+)?)/.exec(String(text ?? ""));
  return match ? match[1].slice(0, 40) : "";
}

/** 版本探针：--version 输出非 JSON，直接取原文提版本号；失败如实空串（不冒充版本）。 */
export async function probeFeishuVersion(runner: FeishuRunner): Promise<string> {
  const key = [...FEISHU_VERSION_ARGS].join(" ");
  if (!FEISHU_READONLY_COMMANDS.includes(key)) return ""; // 纵深防御：白名单外一律不跑
  try {
    const raw = await runner([...FEISHU_VERSION_ARGS]);
    if (raw.code !== 0) return "";
    return extractVersion(raw.stdout) || extractVersion(raw.stderr);
  } catch {
    return "";
  }
}

function tokenStatusOf(user: Record<string, unknown>, userAvailable: boolean): FeishuTokenStatus {
  if (userAvailable) return "valid";
  return asText(user.tokenStatus).toLowerCase() === "expired" ? "expired" : "missing";
}

/**
 * 授权探针：user 可用 = identities.user.status==="ready"，或 available===true 且
 * tokenStatus 不在 {expired, missing}（契约口径）。探针失败 → probeFailed，
 * 按「不可确认 user 可用」处理（auth_required 诚实态），绝不假装已授权。
 */
export async function probeFeishuAuth(runner: FeishuRunner): Promise<FeishuAuthProbe> {
  const result = await runReadonlyJson(runner, FEISHU_AUTH_ARGS);
  if (!result.ok || !isRecord(result.payload)) {
    return {
      userAvailable: false,
      identity: "none",
      userName: "",
      tokenStatus: "missing",
      note: result.ok ? "授权探针输出形状不可识别：无法确认 user 身份可用。" : result.note,
      probeFailed: true,
    };
  }
  const payload = result.payload;
  const identities = isRecord(payload.identities) ? payload.identities : {};
  const user = isRecord(identities.user) ? identities.user : {};
  const bot = isRecord(identities.bot) ? identities.bot : {};
  const rawTokenStatus = asText(user.tokenStatus).toLowerCase();
  const userAvailable = user.status === "ready"
    || (user.available === true && rawTokenStatus !== "expired" && rawTokenStatus !== "missing");
  const identity: FeishuIdentity = payload.identity === "user" || payload.identity === "bot"
    ? payload.identity
    : userAvailable
      ? "user"
      : bot.status === "ready"
        ? "bot"
        : "none";
  return {
    userAvailable,
    identity,
    userName: asText(user.userName).slice(0, 64),
    tokenStatus: tokenStatusOf(user, userAvailable),
    note: redactText(payload.note, 200),
    probeFailed: false,
  };
}
