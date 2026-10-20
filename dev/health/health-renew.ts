/**
 * 登录态续期检测（renew）：对五个取数 CLI 重跑「登录态子命令」，
 * 口径移植自 base/sa-workbench assets/models/datasource-model.js CLI_CHECKS
 * （a1 auth whoami / aliyun sts GetCallerIdentity / ossutil ls /
 *   dws auth status / qodercli --version）。
 *
 * 红线：只跑只读子命令（execFile 数组参数、无 shell、硬超时）；
 * 身份值（account/Arn/corp_name/user_name）绝不回显，只报状态与到期时间；
 * 一切子进程输出先过 redactNote 才可能进 note；结果不落盘（快照文件与 renew 无关）。
 */

import { CLI_SPECS, type HealthCommandRunner } from "./health-cli.ts";
import { redactNote } from "./health-redact.ts";
import type { HealthRenewRow, HealthRenewState } from "./health-types.ts";

type RenewKind = "json-field" | "dws-session" | "oss-buckets" | "version";

interface RenewSpec {
  readonly key: string;
  readonly args: readonly string[];
  readonly kind: RenewKind;
  /** json-field：判定登录态有效的存在性字段（值本身绝不回显）。 */
  readonly field?: string;
  readonly okNote: string;
}

export const RENEW_SPECS: readonly RenewSpec[] = [
  { key: "a1", args: ["auth", "whoami", "-f", "json"], kind: "json-field", field: "account", okNote: "Aone 登录态有效（身份值不回显）" },
  { key: "aliyun", args: ["sts", "GetCallerIdentity"], kind: "json-field", field: "Arn", okNote: "阿里云 STS 身份有效（Arn 不回显）" },
  { key: "ossutil", args: ["ls"], kind: "oss-buckets", okNote: "OSS 可访问" },
  { key: "dws", args: ["auth", "status"], kind: "dws-session", okNote: "钉钉授权有效（到期时间见 expiresAt）" },
  { key: "qodercli", args: ["--version"], kind: "version", okNote: "qodercli 在位" },
];

export const RENEW_KEYS: readonly string[] = RENEW_SPECS.map((s) => s.key);

function fixFor(key: string): string {
  return CLI_SPECS.find((spec) => spec.key === key)?.fix ?? "";
}

/** ISO 字符串或 epoch 秒/毫秒 → ISO；无法判定返回空串（绝不猜）。 */
export function parseExpiry(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return "";
}

function parseJsonObject(stdout: string, stderr: string): Record<string, unknown> | undefined {
  for (const text of [stdout, stderr]) {
    const s = String(text ?? "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const parsed: unknown = JSON.parse(s.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* 尝试下一段输出 */
    }
  }
  return undefined;
}

function unwrap(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
}

const VERSION_RE = /(\d+\.\d+\.\d+)/;
const BUCKET_RE = /Bucket Number is:\s*(\d+)/;

function row(key: string, state: HealthRenewState, note: string, expiresAt = ""): HealthRenewRow {
  return { key, state, expiresAt, note };
}

function evaluate(spec: RenewSpec, code: number | string | null, stdout: string, stderr: string, nowMs: number): HealthRenewRow {
  if (code === "ENOENT") return row(spec.key, "missing", `未安装。修法：${fixFor(spec.key)}`);
  if (code === null) return row(spec.key, "error", "登录态子命令超时或被终止");
  if (code !== 0) {
    const line = redactNote(stderr || stdout);
    return row(spec.key, "error", line ? `检测失败：${line}` : `退出码 ${String(code)}。修法：${fixFor(spec.key)}`);
  }

  if (spec.kind === "version") {
    const version = VERSION_RE.exec(`${stdout}\n${stderr}`)?.[1] ?? "";
    return version ? row(spec.key, "ok", `版本 ${version}`) : row(spec.key, "error", "已安装，但只读探测未取得版本号");
  }
  if (spec.kind === "oss-buckets") {
    const hit = BUCKET_RE.exec(stdout);
    return hit
      ? row(spec.key, "ok", `${spec.okNote} · 可见桶 ${hit[1]} 个`)
      : row(spec.key, "error", `输出未见桶计数。修法：${fixFor(spec.key)}`);
  }

  const payload = parseJsonObject(stdout, stderr);
  if (!payload) {
    const line = redactNote(stderr || stdout);
    return row(spec.key, "error", line ? `输出无法解析：${line}` : "输出无法解析为 JSON");
  }
  const data = unwrap(payload);

  if (spec.kind === "dws-session") {
    const authenticated = data.authenticated === true || data.authenticated === "true";
    const expiresAt = parseExpiry(data.refresh_expires_at ?? data.expires_at);
    if (!authenticated) {
      return row(spec.key, "expired", "授权未完成或已过期：终端执行 dws auth login", expiresAt);
    }
    if (expiresAt && Date.parse(expiresAt) < nowMs) {
      return row(spec.key, "expired", "refresh token 已过期：终端执行 dws auth login", expiresAt);
    }
    return row(spec.key, "ok", spec.okNote, expiresAt);
  }

  /* json-field：字段存在即登录态有效；值绝不进 note。 */
  const present = typeof data[spec.field ?? ""] === "string" && String(data[spec.field ?? ""]).length > 0;
  return present
    ? row(spec.key, "ok", spec.okNote)
    : row(spec.key, "expired", `登录态无效（未见 ${spec.field} 字段）。修法：${fixFor(spec.key)}`);
}

export interface RenewDeps {
  readonly run: HealthCommandRunner;
  readonly bins: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly now: () => number;
}

/** 按 spec 顺序重跑所选键的登录态子命令；单键异常降级为该键 error 行。 */
export async function renewCli(keys: readonly string[], deps: RenewDeps): Promise<readonly HealthRenewRow[]> {
  const wanted = new Set(keys);
  const specs = RENEW_SPECS.filter((spec) => wanted.has(spec.key));
  return Promise.all(
    specs.map(async (spec): Promise<HealthRenewRow> => {
      try {
        const result = await deps.run(deps.bins[spec.key] ?? spec.key, [...spec.args], { timeoutMs: deps.timeoutMs });
        return evaluate(spec, result.code, result.stdout, result.stderr, deps.now());
      } catch (error) {
        return row(spec.key, "error", redactNote(error instanceof Error ? error.message : error) || "检测异常");
      }
    }),
  );
}
