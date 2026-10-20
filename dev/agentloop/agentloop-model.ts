/**
 * AgentLoop model — 纯函数（掩码 / 校验 / SLS 经典签名串装配 / 脱敏截断）。
 * donor: scripts/lib/agentloop.js maskAk+validate、scripts/lib/sls.js slsFetch 签名口径。
 * 本文件零 IO、零网络、零凭据落盘；sk 仅在 signHmacSha1 入参瞬时存在。
 */

import { createHash, createHmac } from "node:crypto";

import { AGENTLOOP_API_VERSION, AGENTLOOP_SIGNATURE_METHOD } from "./agentloop-types.ts";

export const AK_PATTERN = /^[A-Za-z0-9]{10,64}$/;
export const SK_PATTERN = /^[A-Za-z0-9]{24,64}$/;

/** AK 掩码（donor maskAk 同口径：≤8 位只留前 2，其余前 4 + **** + 后 4）。 */
export function maskAccessKey(ak: string): string {
  const text = String(ak ?? "");
  if (!text) return "****";
  if (text.length <= 8) return `${text.slice(0, 2)}****`;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

/** 票据掩码：前 4 + **** + 后 4（短票只留前 2 + ****，绝不整票透出）。 */
export function maskTicket(ticket: string): string {
  return maskAccessKey(ticket);
}

/** 凭据形态校验：合法返回 ""，否则返回中文原因（原因里绝不带输入值）。 */
export function validateCredentials(accessKeyId: unknown, accessKeySecret: unknown): string {
  if (typeof accessKeyId !== "string" || !AK_PATTERN.test(accessKeyId)) {
    return "AccessKey ID 不合法（10–64 位字母数字，LTAI 开头）";
  }
  if (typeof accessKeySecret !== "string" || !SK_PATTERN.test(accessKeySecret)) {
    return "AccessKey Secret 不合法（24–64 位字母数字）";
  }
  return "";
}

/** 规范化查询串（键排序 + encodeURIComponent，donor slsFetch qs 口径）。 */
export function buildResource(path: string, query: Readonly<Record<string, string | number>> = {}): string {
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return path;
  const qs = keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`).join("&");
  return `${path}?${qs}`;
}

export const AGENTLOOP_CANON_HEADERS =
  `x-log-apiversion:${AGENTLOOP_API_VERSION}\nx-log-signaturemethod:${AGENTLOOP_SIGNATURE_METHOD}\n`;

/** 待签串装配（donor：method\n md5\n contentType\n date\n canonHeaders\n resource）。 */
export function buildStringToSign(input: {
  readonly method: string;
  readonly date: string;
  readonly resource: string;
  readonly body?: string;
  readonly contentType?: string;
}): string {
  const md5 = input.body ? createHash("md5").update(input.body).digest("hex") : "";
  const contentType = input.contentType ?? "";
  return `${input.method}\n${md5}\n${contentType}\n${input.date}\n${AGENTLOOP_CANON_HEADERS}${input.resource}`;
}

/** HMAC-SHA1 base64 签名（donor：Authorization = "SLS " + ak + ":" + sig）。 */
export function signHmacSha1(stringToSign: string, sk: string): string {
  return createHmac("sha1", sk).update(stringToSign).digest("base64");
}

/** 凭据形态串脱敏：LTAI 开头的 AK、≥24 位连续字母数字的 SK 形态一律打码。 */
const CREDENTIAL_SHAPED = /\b(?:LTAI[A-Za-z0-9]{6,60}|[A-Za-z0-9]{24,64})\b/g;

/** 上游错误详情脱敏截断：折空白、去凭据形态串、截 max 字。 */
export function sanitizeUpstreamDetail(text: string, max = 200): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(CREDENTIAL_SHAPED, (match) => (match.startsWith("LTAI") ? "LT****" : `${match.slice(0, 2)}****`));
  return flat.length > max ? flat.slice(0, max) : flat;
}
