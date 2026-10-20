import type { McpConnectorTransport } from "./mcp-types.ts";

/**
 * MCP 掩码工具（纯函数）— url query / env / headers / 长 token arg 一律掩码后才出站。
 * donor: scripts/lib/mcp.js 掩码段（搬语义不搬代码）。
 * 红线：任何出站视图（发现清单 / dry diff / 体检原因）都必须先过这里的掩码。
 */

/** 连接器名白名单：1–80 字符，禁引号与控制符（donor NAME_RE 同口径）。 */
export const MCP_CONNECTOR_NAME_RE = /^[\w@./\u4e00-\u9fa5 -]{1,80}$/;

/** query 里这些键的值恒抹掉（MCP 网关常把 key 挂在 query 上）。 */
const SECRET_QS = /^(key|token|secret|sig|signature|auth|apikey|api_key|access_token|password)$/i;
/** env / headers 里这些名字的值恒抹掉。 */
const SECRET_KEY = /(key|token|secret|password|credential|authorization|cookie)/i;
/** 路径段/参数里的长 ID、令牌（本身就是凭据的一部分）只留 ***。 */
const TOKEN_SEG = /^[A-Za-z0-9_-]{20,}$/;
const TOKEN_ARG = /^[A-Za-z0-9+/_=-]{24,}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 绝对路径 → ~ 展示形态（只重写精确 home 前缀；出站绝不带绝对路径）。 */
export function tildePath(p: string, home: string): string {
  const s = String(p ?? "");
  return home && s.startsWith(home) ? `~${s.slice(home.length)}` : s;
}

/** url 掩码：token 路径段 ***、敏感 query 值 ***、超长值 ***；非法 URL 截断兜底。 */
export function maskUrl(raw: string): string {
  const s = String(raw ?? "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s.slice(0, 120);
  }
  u.pathname = u.pathname.split("/").map((seg) => (TOKEN_SEG.test(seg) ? "***" : seg)).join("/");
  for (const k of Array.from(u.searchParams.keys())) {
    const v = u.searchParams.get(k) ?? "";
    u.searchParams.set(k, SECRET_QS.test(k) || v.length >= 24 ? "***" : v);
  }
  return u.toString();
}

/** arg 掩码：凭据形态（≥24 位 base64/hex 样）恒 ***；路径 tilde 化。 */
export function maskArg(a: unknown, home: string): string {
  const s = String(a ?? "");
  if (TOKEN_ARG.test(s)) return "***";
  return tildePath(s, home);
}

/** env/headers 掩码：敏感名值恒 ***，其余 tilde + 截断 200。 */
export function maskKV(obj: unknown, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(obj)) return out;
  for (const k of Object.keys(obj).slice(0, 40)) {
    out[k] = SECRET_KEY.test(k) ? "***" : tildePath(String(obj[k] ?? ""), home).slice(0, 200);
  }
  return out;
}

/** env/headers 只出站键名 + secret 标记（值永不离开本机进程）。 */
export function secretNames(obj: unknown): readonly { name: string; secret: boolean }[] {
  if (!isRecord(obj)) return [];
  return Object.keys(obj)
    .filter((k) => typeof k === "string")
    .slice(0, 40)
    .map((k) => ({ name: k, secret: SECRET_KEY.test(k) }));
}

/** 错误输出尾行脱敏：k=v 凭据形态抹成 k=***，只留最后一行 ≤160 字。 */
export function redactTail(text: string): string {
  const last = String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  return last.replace(/\b([A-Za-z0-9_-]{2,64})=([A-Za-z0-9%+/_.:-]{16,})/g, "$1=***").slice(0, 160);
}

/** 传输方式推断：url → http/sse；command → stdio；其余按 type 提示，判不出 unknown。 */
export function transportOf(def: unknown): McpConnectorTransport {
  const d = isRecord(def) ? def : {};
  const t = String(d.type ?? d.transport ?? "").toLowerCase();
  if (typeof d.url === "string" && d.url) return t.includes("sse") ? "sse" : "http";
  if (typeof d.command === "string" && d.command) return "stdio";
  if (t.includes("sse")) return "sse";
  if (t.includes("http")) return "http";
  if (t.includes("stdio")) return "stdio";
  return "unknown";
}

/**
 * 定义的可分享投影（dry diff 摘要 / snippet 用）：白名单字段 + 全量掩码。
 * 凭据真值绝不进投影——那才是「只落宿主配置文件」的语义。
 */
export function maskDef(def: unknown, home: string): Record<string, unknown> {
  const d = isRecord(def) ? def : {};
  const out: Record<string, unknown> = {};
  if (typeof d.command === "string" && d.command) out.command = tildePath(d.command, home);
  if (Array.isArray(d.args)) out.args = d.args.slice(0, 20).map((a) => maskArg(a, home));
  if (typeof d.url === "string" && d.url) out.url = maskUrl(d.url);
  if (typeof d.type === "string" && d.type) out.type = d.type;
  if (isRecord(d.env)) out.env = maskKV(d.env, home);
  if (isRecord(d.headers)) out.headers = maskKV(d.headers, home);
  if (typeof d.disabled === "boolean") out.disabled = d.disabled;
  return out;
}
