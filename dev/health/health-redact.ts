/**
 * Redaction for anything a child process printed before it may enter a health
 * row, ported from base/sa-workbench scripts/lib/health.js `redact` with a
 * stricter second stage: lines carrying credential-shaped keys are dropped
 * entirely, so neither values nor key names (token=/password=/cookie=) can
 * survive into the snapshot. The sentinel test in dev/health-bridge_test.ts
 * feeds a hostile fixture through this and asserts on the serialized snapshot.
 */

/** 疑似凭据键（词级，不区分大小写）：命中行整行抹除，键名也不保留。 */
const CRED_KEY_LINE =
  /^[^\n]*\b(?:token|secret|password|passwd|cookie|credential|apikey|api[-_]?key|access[-_]?key|authorization)\b[^\n]*$/gim;

/** 参考口径：长 token 型 k=v（值 ≥16 位连续 token 字符）抹值；键名疑似凭据则整对抹除。 */
const TOKEN_KV = /\b([A-Za-z0-9_-]{2,64})=([A-Za-z0-9%+/_.:-]{16,})/g;

/** 裸密钥前缀（sk-/LTAI 开头的 AccessKey 形态）。 */
const BARE_KEY = /\b(?:sk|LTAI)[-]?[A-Za-z0-9]{4,}/g;

const CRED_KEY_WORD = /token|secret|password|passwd|cookie|credential|apikey|api[-_]?key|access[-_]?key|authorization/i;

/** 单行替换上限，与既有 bridge note 的 200 字符口径一致。 */
const NOTE_LIMIT = 200;

function replaceTokenKv(_whole: string, key: string, _value: string): string {
  return CRED_KEY_WORD.test(key) ? "[已脱敏]" : `${key}=***`;
}

/** 子进程输出回传前脱敏；多行输入保留行结构以便错误首行提示可读。 */
export function redact(text: unknown): string {
  return String(text ?? "")
    .replace(CRED_KEY_LINE, "[已脱敏]")
    .replace(TOKEN_KV, replaceTokenKv)
    .replace(BARE_KEY, "[已脱敏]");
}

/** 脱敏 + 压缩空白 + 截断，得到可进快照 note 的一行话。 */
export function redactNote(text: unknown): string {
  return redact(text).replace(/\s+/g, " ").trim().slice(0, NOTE_LIMIT);
}
