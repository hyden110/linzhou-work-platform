import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

import { REPLY_MAX_TEXT_CHARS, type ReplyCommandRunner } from "./reply-types.ts";

/**
 * Reply engine (F9) — 本机 AI 引擎通道（建议生成专用）。
 * donor: scripts/lib/ai.js runQodercli + scripts/lib/reply/suggest.js（搬语义不搬代码）。
 *
 * 红线：
 * - localOnly：只探测本机 qoder/qodercli bin，缺失如实 engine_missing，绝不回落云端 API；
 * - prompt（含消息原文与客户画像）一律经 stdin 传子进程，不进 argv——argv 对同机 ps 可见；
 * - execFile 数组参数、shell:false、硬超时、有界输出；stdin EPIPE 属正常（CLI 不读时）。
 */

/** headless 单轮参数（照 donor ai.js runQodercli：禁会话持久化、空 MCP、禁全部工具）。 */
export const REPLY_ENGINE_ARGS = [
  "--no-session-persistence",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--strict-mcp-config",
  "--setting-sources",
  "user",
  "--tools",
  "",
  "-p",
] as const;

/** 引擎输出里的语气白名单（donor suggest.js TONES）。 */
export const REPLY_TONES = ["正式", "平实", "简短"] as const;

/** 引擎子进程输出上限（8MB，沿 donor ai.js maxBuffer）。 */
const ENGINE_MAX_BUFFER = 8 * 1024 * 1024;

/** 客户画像白名单字段（crm 快照 customers 行的只读投影，进 prompt 的仅这些）。 */
export interface CrmProfileLine {
  readonly cid: string;
  readonly name: string;
  readonly industry: string;
  readonly area: string;
  readonly level: string;
}

/**
 * 本机引擎定位：env 覆盖（SA_REPLY_ENGINE_BIN / QODER_CLI_BIN）→ ~/.qoder/bin/{qodercli,qoder}
 * → /usr/local/bin、/opt/homebrew/bin 同名。全部要过 existsSync（env 指向不存在的文件同样算缺失，
 * 诚实 engine_missing 而不是 spawn 时才炸）。找不到返回 ""。
 */
export function resolveEngineBin(
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): string {
  const home = String(env.HOME ?? "");
  const candidates = [
    String(env.SA_REPLY_ENGINE_BIN ?? "").trim(),
    String(env.QODER_CLI_BIN ?? "").trim(),
    home ? `${home}/.qoder/bin/qodercli` : "",
    home ? `${home}/.qoder/bin/qoder` : "",
    "/usr/local/bin/qodercli",
    "/usr/local/bin/qoder",
    "/opt/homebrew/bin/qodercli",
    "/opt/homebrew/bin/qoder",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

/** 默认 runner：execFile 数组 argv、shell:false、硬超时、8MB 有界输出；stdin 可选写入。 */
export function createDefaultEngineRunner(): ReplyCommandRunner {
  return (file, args, options) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        [...args],
        { cwd: tmpdir(), timeout: options.timeoutMs, shell: false, maxBuffer: ENGINE_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
            resolve({
              code: error.killed ? null : code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              killed: error.killed === true,
            });
            return;
          }
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
      if (options.stdin !== undefined) {
        /* prompt 只经 stdin 进子进程；CLI 若不读 stdin 会 EPIPE，属正常，不能掀翻 promise。 */
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.stdin);
      }
    });
}

function profileSection(profile: CrmProfileLine | null): string {
  if (!profile) return "（无客户画像：CRM 快照缺失或未命中该客户，按消息原文谨慎拟稿，不编造客户事实）";
  return [
    `- 名称：${profile.name}`,
    `- CID：${profile.cid}`,
    profile.industry ? `- 行业：${profile.industry}` : "",
    profile.area ? `- 区域：${profile.area}` : "",
    profile.level ? `- 客户层级：${profile.level}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 建议生成 prompt（纯函数）：客户画像（白名单字段，可能为 null）+ 消息原文（标题/摘要/时间）
 * + 输出契约（只输出一个 JSON 对象 {needReply,text,tone,reason}，text ≤600 字、无 markdown）。
 */
export function buildSuggestPrompt(input: {
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly profile: CrmProfileLine | null;
}): string {
  const lines = [
    "你是企业客户服务的回复助理。请根据下面的客户画像与消息原文，拟一条可直接发送的中文回复。",
    "",
    "【客户画像（本机 CRM 快照，只读）】",
    profileSection(input.profile),
    "",
    "【消息原文】",
    `标题：${input.title}`,
  ];
  if (input.createdAt) lines.push(`时间：${input.createdAt}`);
  lines.push(
    `正文：${input.summary || "（无摘要）"}`,
    "",
    "【输出要求】",
    "只输出一个 JSON 对象，不要 markdown 代码块、不要任何多余文本，形如：",
    '{"needReply": true, "text": "回复正文", "tone": "正式|平实|简短", "reason": "一句话说明为什么这样回"}',
    `text 为纯文本、不超过 ${REPLY_MAX_TEXT_CHARS} 字、不带称呼与 markdown 前缀；reason 不超过 160 字。`,
    "若判断这条消息无需回复（寒暄/通知类），needReply 置 false 且 text 置空字符串。",
    "不得编造客户画像与消息原文之外的事实。",
  );
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** crm 快照客户画像匹配（纯函数只读）：客户名（清洗后 ≥2 字）出现在标题或摘要里才算命中。 */
export function matchCustomerProfile(
  snapshot: unknown,
  item: { readonly title: string; readonly summary: string },
): CrmProfileLine | null {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.customers)) return null;
  const haystack = `${asText(item.title)} ${asText(item.summary)}`;
  for (const row of snapshot.customers) {
    if (!isRecord(row)) continue;
    const name = asText(row.name).replace(/[\u0000-\u001f\u007f「」]/g, "").trim().slice(0, 80);
    if (name.length < 2 || !haystack.includes(name)) continue;
    return {
      cid: asText(row.cid),
      name,
      industry: asText(row.industry),
      area: asText(row.area),
      level: asText(row.level),
    };
  }
  return null;
}

/** 引擎输出宽容解 JSON：取首个 { 到最后一个 }（CLI 常带告警行）；解不出返回 null。 */
export function parseEngineJson(stdout: string): Record<string, unknown> | null {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 结论整形（donor shapeResult 口径）：needReply/text/tone/reason 白名单 + 截断 + 去 markdown 前缀。 */
export function shapeSuggestion(
  raw: Record<string, unknown>,
  ms: number,
  engine: string,
): {
  readonly needReply: boolean;
  readonly text: string;
  readonly tone: string;
  readonly reason: string;
  readonly ms: number;
  readonly engine: string;
} {
  const wantReply = raw.needReply !== false && raw.needReply !== "false";
  /* 模型偶尔把 markdown 前缀塞进来：提示词已禁，这里再兜一层，保证复制即可发。 */
  const text = asText(raw.text).trim().replace(/^[#>*\-\s]+/, "").slice(0, REPLY_MAX_TEXT_CHARS);
  const tone = asText(raw.tone);
  return {
    needReply: wantReply && text.length > 0,
    text: wantReply ? text : "",
    tone: (REPLY_TONES as readonly string[]).includes(tone) ? tone : "",
    reason: asText(raw.reason).slice(0, 160),
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
    engine: engine || "qodercli",
  };
}
