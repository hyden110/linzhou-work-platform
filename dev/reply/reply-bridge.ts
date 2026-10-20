import { existsSync as defaultExistsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { createNotifyBridge, type NotifyBridge } from "../notify-bridge.ts";
import { redactNotify } from "../notify/notify-model.ts";
import { resolveDwsBin } from "../report/report-dws.ts";
import {
  deriveReplyCandidates,
  extractDingtalkGroup,
  replyChannelOf,
} from "../../src/lib/reply-model.ts";
import {
  buildSuggestPrompt,
  createDefaultEngineRunner,
  matchCustomerProfile,
  parseEngineJson,
  REPLY_ENGINE_ARGS,
  resolveEngineBin,
  shapeSuggestion,
} from "./reply-engine.ts";
import {
  beijingDayKey,
  createReplyStore,
  DEFAULT_REPLY_DIR,
  type ReplyStore,
} from "./reply-store.ts";
import {
  ReplyBridgeError,
  REPLY_ENGINE_TIMEOUT_MS,
  REPLY_MAX_TEXT_CHARS,
  REPLY_PREVIEW_CHARS,
  REPLY_QUOTA_PER_CONV_DAY,
  REPLY_QUOTA_PER_DAY,
  REPLY_ROUTES,
  REPLY_SENDS_TAIL,
  REPLY_SEND_TIMEOUT_MS,
  type ReplyBridge,
  type ReplyCandidatesView,
  type ReplyCommandRunner,
  type ReplyErrorCode,
  type ReplyHistoryView,
  type ReplyQuota,
  type ReplyQuotaView,
  type ReplySendAudit,
  type ReplySendResult,
  type ReplySendsView,
  type ReplySuggestResult,
} from "./reply-types.ts";

/**
 * Reply bridge (F9) — 待回复候选 / AI 建议生成 / 钉钉人工确认发送 / 草稿历史 / 发送审计。
 * donor: scripts/lib/reply/{index,suggest,context,enrich,send,store}.js + bridge.js /reply/*。
 *
 * 数据面：
 * - 候选从 notify 收件箱纯派生（src/lib/reply-model.ts，桥与前端同一口径），
 *   replied 位来自发送审计（exitCode 0）；
 * - 建议上下文只有两样：crm 快照客户画像（只读白名单字段）+ 消息原文（title/summary），
 *   每次现取不落盘；prompt 经 stdin 进本机引擎（qoder/qodercli），缺失 engine_missing 绝不回落云端；
 * - 额度 quota.json：每会话日 ≤6、全局日 ≤60，超限 quota_exceeded；只有生成成功才记账；
 * - 发送仅钉钉 dws chat message send --group <cid>，body.confirm 必须严格 === id 才执行；
 *   每次真实子进程尝试都落 sends.jsonl 审计 {at,id,group,exitCode,maskedPreview}；
 * - 草稿历史 store.json 只存结论（建议文本/语气/理由），不存消息原文上下文。
 */

/* dev/reply/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
const DEFAULT_CRM_SNAPSHOT_PATH = joinPath(PROJECT_ROOT, ".local-cache", "crm-snapshot.json");

/** 请求体体积上限：正文 ≤600 字 + id/confirm，16KB 足够；超限如实拒绝。 */
const MAX_BODY_BYTES = 16 * 1024;
/** 额度账本 conv 键上限（照 donor：超 200 裁掉最早的，防账本无限膨胀）。 */
const QUOTA_CONV_LIMIT = 200;

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface ReplyBridgeOptions {
  /** 收件箱数据面（缺省真 notify 桥；测试注入临时收件箱）。 */
  readonly notifyBridge?: NotifyBridge;
  /** reply 存储目录（缺省 .local-cache/reply；测试注入临时目录）。 */
  readonly dir?: string;
  /** crm 快照路径（只读；缺省 .local-cache/crm-snapshot.json）。 */
  readonly crmSnapshotPath?: string;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
  /** 本机引擎 runner 注入点（测试用 stub；缺省 execFile 真 runner）。 */
  readonly engineRunner?: ReplyCommandRunner;
  /** dws runner 注入点（测试用 stub 绝不真发；缺省 execFile 真 runner）。 */
  readonly dwsRunner?: ReplyCommandRunner;
  /** 显式 bin 覆盖（缺省按定位链探测）。 */
  readonly engineBin?: string;
  readonly dwsBin?: string;
  readonly store?: ReplyStore;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: ReplyErrorCode): number {
  if (code === "reply_not_found") return 404;
  if (code === "no_channel" || code === "no_group") return 409;
  if (code === "quota_exceeded") return 429;
  if (code === "method_not_allowed") return 405;
  if (code === "engine_missing" || code === "dws_missing") return 503;
  if (code === "engine_error" || code === "send_failed" || code === "reply_unavailable") return 502;
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lastLine(text: string): string {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

/** 错误消息一律先脱敏再截断（凭据形态文本不出桥）。 */
function safeDetail(text: string, max = 200): string {
  return redactNotify(text).slice(0, max);
}

/** 审计掩码预览：先脱敏、折空白、截 24 字（长文加省略号）——审计不落全文。 */
export function maskSendPreview(text: string): string {
  const flat = redactNotify(text).replace(/\s+/g, " ").trim();
  return flat.length > REPLY_PREVIEW_CHARS ? `${flat.slice(0, REPLY_PREVIEW_CHARS)}…` : flat;
}

function bodyOf(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) {
    throw new ReplyBridgeError("reply_invalid_request", "请求体必须是 JSON 对象：{id}。");
  }
  return request;
}

function idOf(body: Record<string, unknown>): string {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id || id.length > 120) {
    throw new ReplyBridgeError("reply_invalid_request", "缺少候选 id：body.id 必须为非空字符串（≤120 位）。");
  }
  return id;
}

export function createReplyBridge(options: ReplyBridgeOptions = {}): ReplyBridge {
  const notifyBridge = options.notifyBridge ?? createNotifyBridge();
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const store = options.store ?? createReplyStore(options.dir ?? DEFAULT_REPLY_DIR, { now });
  const crmSnapshotPath = options.crmSnapshotPath ?? DEFAULT_CRM_SNAPSHOT_PATH;
  const engineRunner = options.engineRunner ?? createDefaultEngineRunner();
  const dwsRunner = options.dwsRunner ?? createDefaultEngineRunner();
  const engineBin = () => options.engineBin ?? resolveEngineBin(env, existsSync);
  const dwsBin = () => options.dwsBin ?? resolveDwsBin(env, existsSync);

  const iso = (): string => new Date(now()).toISOString();

  function quotaViewOf(quota: ReplyQuota): ReplyQuotaView {
    return { day: quota.day, used: quota.total, limit: REPLY_QUOTA_PER_DAY, perConvLimit: REPLY_QUOTA_PER_CONV_DAY };
  }

  async function readCrmSnapshot(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(crmSnapshotPath, "utf-8"));
    } catch {
      return null; // 快照缺失/损坏：画像是旁路，不挡生成（contextProfile 如实 false）
    }
  }

  async function candidates(): Promise<ReplyCandidatesView> {
    const inbox = await notifyBridge.items();
    const repliedIds = await store.loadSentIds();
    const quota = await store.loadQuota(beijingDayKey(now()));
    return {
      savedAt: inbox.savedAt,
      items: deriveReplyCandidates(inbox.items, repliedIds),
      quota: quotaViewOf(quota),
      engine: { available: engineBin() !== "", localOnly: true },
    };
  }

  async function history(): Promise<ReplyHistoryView> {
    return { rows: await store.loadHistory() };
  }

  async function suggest(body: unknown): Promise<ReplySuggestResult> {
    const id = idOf(bodyOf(body));
    const inbox = await notifyBridge.items();
    const item = inbox.items.find((entry) => entry.id === id);
    if (!item) {
      throw new ReplyBridgeError("reply_not_found", "候选不存在或已过期：请刷新收件箱后重试。");
    }

    /* 额度闸门先于引擎（超限一次子进程都不起）；会话键 = openConversationId，无 cid 回落候选 id。 */
    const day = beijingDayKey(now());
    const quota = await store.loadQuota(day);
    const convKey = extractDingtalkGroup(item) || item.id;
    if (quota.total >= REPLY_QUOTA_PER_DAY) {
      throw new ReplyBridgeError(
        "quota_exceeded",
        `今日建议生成已达全局上限 ${REPLY_QUOTA_PER_DAY} 条，明日自动恢复。`,
      );
    }
    const convUsed = quota.conv[convKey]?.count ?? 0;
    if (convUsed >= REPLY_QUOTA_PER_CONV_DAY) {
      throw new ReplyBridgeError(
        "quota_exceeded",
        `该会话今日已生成 ${REPLY_QUOTA_PER_CONV_DAY} 次建议，请直接手动回复或明日再试。`,
      );
    }

    /* 本机引擎缺失即硬失败——绝不回落云端 API（红线）。 */
    const bin = engineBin();
    if (!bin) {
      throw new ReplyBridgeError(
        "engine_missing",
        "未检测到本机 AI 引擎（qoder/qodercli）：回复建议只走本机引擎，绝不回落云端 API。请安装后重试。",
      );
    }

    const profile = matchCustomerProfile(await readCrmSnapshot(), item);
    const prompt = buildSuggestPrompt({
      title: item.title,
      summary: item.summary,
      createdAt: item.createdAt,
      profile,
    });
    const startedAt = now();
    const result = await engineRunner(bin, REPLY_ENGINE_ARGS, {
      timeoutMs: REPLY_ENGINE_TIMEOUT_MS,
      stdin: prompt, // 消息原文只经 stdin，不进 argv（argv 对同机 ps 可见）
    });
    const ms = Math.max(0, now() - startedAt);

    if (result.code === "ENOENT") {
      throw new ReplyBridgeError(
        "engine_missing",
        "本机 AI 引擎二进制无法执行（ENOENT）：只走本机引擎，绝不回落云端 API。请检查安装后重试。",
      );
    }
    if (result.killed === true) {
      throw new ReplyBridgeError("engine_error", `本机引擎超时（${Math.round(REPLY_ENGINE_TIMEOUT_MS / 1000)}s），未生成建议。`);
    }
    if (result.code !== 0) {
      const detail = safeDetail(lastLine(result.stderr || result.stdout));
      throw new ReplyBridgeError("engine_error", `本机引擎失败（退出码 ${String(result.code)}）：${detail || "无错误输出"}`);
    }
    const parsed = parseEngineJson(result.stdout);
    if (!parsed) {
      throw new ReplyBridgeError("engine_error", "本机引擎输出中解析不出 JSON 结论，未生成建议（不猜不造）。");
    }
    const shaped = shapeSuggestion(parsed, ms, "qodercli");

    /* 草稿入库（只存结论不存消息原文）；存储是旁路，失败不吞本次结果但要留痕。 */
    const draft = {
      sid: `${id}-${now()}`,
      id,
      convKey,
      convTitle: item.title,
      needReply: shaped.needReply,
      text: shaped.text,
      tone: shaped.tone,
      reason: shaped.reason,
      ms: shaped.ms,
      engine: shaped.engine,
      at: iso(),
    };
    await store.recordDraft(draft).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "reply_draft_store_failed", id, reason: String((error as Error)?.message ?? error).slice(0, 120) }));
    });

    /* 记账：只有生成成功才扣额度；重读账本再写（跨请求并发下尽量少扣错）。 */
    const next: ReplyQuota = { ...await store.loadQuota(day), day };
    const nextConv = { ...next.conv, [convKey]: { count: (next.conv[convKey]?.count ?? 0) + 1 } };
    const keys = Object.keys(nextConv);
    const trimmed: Record<string, { count: number }> = {};
    for (const key of keys.slice(Math.max(0, keys.length - QUOTA_CONV_LIMIT))) trimmed[key] = nextConv[key];
    const nextQuota: ReplyQuota = { day, total: next.total + 1, conv: trimmed };
    await store.saveQuota(nextQuota).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "reply_quota_write_failed", reason: String((error as Error)?.message ?? error).slice(0, 120) }));
    });

    return {
      id,
      needReply: shaped.needReply,
      text: shaped.text,
      tone: shaped.tone,
      reason: shaped.reason,
      ms: shaped.ms,
      engine: shaped.engine,
      localOnly: true,
      contextProfile: profile !== null,
      quota: quotaViewOf(nextQuota),
    };
  }

  async function send(body: unknown): Promise<ReplySendResult> {
    const record = bodyOf(body);
    const id = idOf(record);

    /* 人工确认闸门先于一切（donor 页面逐条确认的服务端等价物）：
     * confirm 必须严格 === 候选 id，否则一次 dws 都不会被调、也不留审计。 */
    if (typeof record.confirm !== "string" || record.confirm !== id) {
      throw new ReplyBridgeError(
        "confirm_mismatch",
        "人工确认未完成：confirm 必须严格等于候选 id（页面弹窗逐条确认后才发送）。本次未执行任何发送。",
      );
    }

    const inbox = await notifyBridge.items();
    const item = inbox.items.find((entry) => entry.id === id);
    if (!item) {
      throw new ReplyBridgeError("reply_not_found", "候选不存在或已过期：请刷新收件箱后重试。");
    }

    const channel = replyChannelOf(item);
    if (channel === "wechat") {
      throw new ReplyBridgeError(
        "no_channel",
        "微信源没有自动发送通道：只允许一键复制，请在微信客户端里粘贴后由人发送。",
      );
    }
    if (channel !== "dingtalk") {
      throw new ReplyBridgeError("no_channel", "该消息来源没有可用发送通道（当前仅支持钉钉）：只允许复制。");
    }
    const group = extractDingtalkGroup(item);
    if (!group) {
      throw new ReplyBridgeError(
        "no_group",
        "未能从消息中解析 openConversationId（cid…）：本次不发送，只允许复制（钉钉会话 id 待事件源批次接入）。",
      );
    }

    /* 正文规整：统一换行、去首尾空白；超限不截断直接拒（截半句发出去比不发更糟，donor 口径）。 */
    const text = String(record.text ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) {
      throw new ReplyBridgeError("no_text", "没有可发送的正文：请先生成建议或在草稿编辑框粘贴内容。");
    }
    if (text.length > REPLY_MAX_TEXT_CHARS) {
      throw new ReplyBridgeError(
        "too_long",
        `正文 ${text.length} 字，超过上限 ${REPLY_MAX_TEXT_CHARS} 字：不截断发送，请删减后再发。`,
      );
    }

    const bin = dwsBin();
    const args = ["chat", "message", "send", "--group", group, "--text", text, "-y", "--format", "json"];
    const result = await dwsRunner(bin, args, { timeoutMs: REPLY_SEND_TIMEOUT_MS });

    /* 真实子进程尝试必留审计（成败都记）；审计是旁路，写失败如实回 audited:false。 */
    const at = iso();
    const audit: ReplySendAudit = { at, id, group, exitCode: result.code, maskedPreview: maskSendPreview(text) };
    const audited = await store.appendSend(audit).then(() => true).catch(() => false);

    if (result.code === "ENOENT") {
      throw new ReplyBridgeError(
        "dws_missing",
        "未找到 dws CLI：本次未发送。请安装 dws 并在终端完成 dws auth login 后重试。",
      );
    }
    if (result.killed === true) {
      throw new ReplyBridgeError(
        "send_failed",
        `dws 发送超时（${Math.round(REPLY_SEND_TIMEOUT_MS / 1000)}s）：结果不确定，请到钉钉核对该消息是否已发出。`,
      );
    }
    if (result.code !== 0) {
      const detail = safeDetail(lastLine(result.stderr || result.stdout));
      throw new ReplyBridgeError("send_failed", `dws 发送失败（退出码 ${String(result.code)}）：${detail || "无错误输出"}`);
    }
    /* 退出码 0 也可能业务失败（{success:false,...}）：如实报错，不假装发出去了。 */
    const payload = parseEngineJson(result.stdout);
    if (payload && (payload.success === false || isNonEmptyError(payload.error))) {
      const detail = safeDetail(errorMessageOf(payload), 300);
      throw new ReplyBridgeError("send_failed", `dws 业务失败：${detail}`);
    }
    return { id, group, exitCode: 0, audited, at };
  }

  async function sends(): Promise<ReplySendsView> {
    const all = await store.readSends(Number.MAX_SAFE_INTEGER);
    return { sends: all.slice(0, REPLY_SENDS_TAIL), total: all.length };
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new ReplyBridgeError("reply_invalid_request", "请求体过大：回复正文上限 600 字，远不需要这么多内容。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new ReplyBridgeError("reply_invalid_request", "请求体过大：回复正文上限 600 字，远不需要这么多内容。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ReplyBridgeError("reply_invalid_request", "请求体不是合法 JSON。");
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const route = REPLY_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非 reply 路径：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      if (route.operation === "candidates") return jsonResponse({ ok: true, data: await candidates() });
      if (route.operation === "history") return jsonResponse({ ok: true, data: await history() });
      if (route.operation === "sends") return jsonResponse({ ok: true, data: await sends() });
      if (route.operation === "suggest") return jsonResponse({ ok: true, data: await suggest(await readBody(request)) });
      return jsonResponse({ ok: true, data: await send(await readBody(request)) });
    } catch (error) {
      if (error instanceof ReplyBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "reply_unavailable", message: "回复服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { candidates, history, suggest, send, sends, handle };
}

/** dws 成功响应可能带 error:{} 空对象——仅非空 error 才算失败（照 report-dws classifyDwsFailure 口径）。 */
function isNonEmptyError(error: unknown): boolean {
  return Boolean(error) && (typeof error !== "object" || Array.isArray(error) || Object.keys(error).length > 0);
}

function errorMessageOf(payload: Record<string, unknown>): string {
  const error = payload.error;
  const message = isRecord(error)
    ? error.message ?? error.reason
    : typeof error === "string"
      ? error
      : payload.message ?? payload.reason;
  return String(message ?? "dws 未说明原因");
}
