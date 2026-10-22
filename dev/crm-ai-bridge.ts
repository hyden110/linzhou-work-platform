import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { CID_PATTERN } from "./crm-bridge.ts";
import { resolveDwsBin } from "./report/report-dws.ts";
import { buildGaapAttribution } from "../src/lib/gaap-attribution.ts";
import { formatThresholdAmount } from "../src/lib/gaap-thresholds.ts";
import type { AttributionRecord } from "./crm-attribution-bridge.ts";

/**
 * Local-only bridge for 「CRM AI 助理」explanations (工单 #10074 R2.3).
 *
 * 安全边界（需求 R2.3 / R3）：
 * - 仅允许 1:1 单聊发送给「CRM AI 助理」（dws chat message send --open-dingtalk-id），
 *   禁止群发、禁止发给其他会话；openDingTalkId 只从环境变量读取，不硬编码在代码里。
 * - 提问由系统模板生成（客户名与 CID、鲲鹏异动卡口径、FBI 产品变化摘要），不携带任何凭据；
 *   问题文本绝不来自浏览器。
 * - 只读回复（dws chat +chat-messages 时间窗拉取），失败/超时如实降级，不伪造解释。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const ATTRIBUTION_DIR = join(CACHE_DIR, "crm-attribution");
const SNAPSHOT_PATH = join(CACHE_DIR, "crm-snapshot.json");

const DWS_SEND_TIMEOUT_MS = 60_000;
const DWS_READ_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 20_000;
const REPLY_WAIT_TIMEOUT_MS = 5 * 60_000;
const MAX_CONSECUTIVE_READ_ERRORS = 3;
const MAX_ANSWER_CHARS = 4_000;
const MAX_QUESTION_CHARS = 1_200;
const OPEN_DINGTALK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export interface CrmAiExplainRecord {
  readonly schemaVersion: 1;
  readonly cid: string;
  readonly state: "running" | "done" | "failed";
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** 模板生成的问题（本地缓存展示与复用比对，非用户输入）。 */
  readonly question: string | null;
  readonly askedAt: string | null;
  readonly answer: string | null;
  readonly answerAt: string | null;
  readonly error: string | null;
}

export type CrmAiExplainStartResult =
  | { readonly ok: true; readonly record: CrmAiExplainRecord; readonly reused: boolean }
  | {
    readonly ok: false;
    readonly error: "invalid_cid" | "customer_not_found" | "attribution_missing" | "unconfigured" | "busy";
  };

export interface CrmAiBridge {
  readonly explain: (cid: string) => Promise<CrmAiExplainRecord | undefined>;
  readonly startExplain: (cid: string, force?: boolean) => Promise<CrmAiExplainStartResult>;
}

export interface CrmAiBridgeOptions {
  readonly cacheDir?: string;
  readonly run?: CrmAiRunner;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
}

export interface CrmAiCommandResult {
  readonly code: number | "ENOENT" | null;
  readonly stdout: string;
}

export type CrmAiRunner = (file: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<CrmAiCommandResult>;

const defaultRunner: CrmAiRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: PROJECT_ROOT, env: process.env, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout) => {
        const code = error
          ? error.code === "ENOENT" ? "ENOENT" : (typeof error.code === "number" ? error.code : null)
          : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });

export interface CrmAiQuestionInput {
  readonly name: string;
  readonly cid: string;
  /** 鲲鹏异动卡（主关联人归属口径）：环比（百分点）与涨跌额（元）；缺失时如实注明。 */
  readonly rate: number | null;
  readonly diff: number | null;
  /** FBI 报表数据日与前一日。 */
  readonly currentDate: string | null;
  readonly previousDate: string | null;
  /** FBI 产品变化摘要（如「模型服务 +35 万、计算 +20 万」）；无行时 null。 */
  readonly productSummary: string | null;
}

/** 提问模板：只含业务数据与口径标注，绝不携带凭据；由桥在本机组装，浏览器只传 cid。 */
export function crmAiQuestion(input: CrmAiQuestionInput): string {
  const kunpeng = input.rate !== null
    ? `鲲鹏异动卡（主关联人归属口径）：昨日环比 ${input.rate > 0 ? "+" : ""}${input.rate}%`
      + (input.diff !== null ? `，涨跌额 ${input.diff > 0 ? "+" : ""}${formatThresholdAmount(input.diff)}` : "")
    : "鲲鹏异动卡（主关联人归属口径）：昨日环比缺失";
  const fbi = input.currentDate !== null
    ? `FBI 报表（业绩分成口径，${input.currentDate}${input.previousDate ? ` vs ${input.previousDate}` : " vs 前一日"}）：`
      + (input.productSummary ?? "未返回该客户的产品拆分")
    : "FBI 报表（业绩分成口径）：未返回该客户的产品拆分";
  return [
    `请解读客户「${input.name}」（CID ${input.cid}）的 GAAP 异动。`,
    `${kunpeng}。${fbi}。`,
    "两套数据口径不同（业绩分成 vs 主关联人归属），请分别解读，不要强行对齐数字。",
    "请说明：1）主要变化来自哪些产品；2）可能的原因；3）建议的跟进动作。回复控制在 300 字以内。",
  ].join("").slice(0, MAX_QUESTION_CHARS);
}

/** 由 FBI 一级产品拆分生成提问用的产品变化摘要（top3 按 |变化额|）。 */
export function fbiProductSummary(
  level1Rows: readonly { level1: string; diff: number }[],
): string | null {
  if (level1Rows.length === 0) return null;
  return level1Rows
    .slice(0, 3)
    .map((row) => `${row.level1} ${row.diff > 0 ? "+" : ""}${formatThresholdAmount(row.diff)}`)
    .join("、");
}

interface ConversationMessage {
  readonly messageId: string;
  readonly text: string;
  readonly createTime: string | null;
}

/**
 * 从 +chat-messages 时间窗（起点=发送时刻，仅含本人与助理的单聊）里提取助理回复：
 * 本人消息按「文本 === 所发问题」识别；窗口内其余消息即助理回复，取首条。
 */
export function extractAssistantReply(payload: unknown, question: string): ConversationMessage | undefined {
  const record = payload as { messages?: unknown } | null | undefined;
  const raw = Array.isArray(record?.messages) ? record.messages : [];
  const messages: ConversationMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const messageId = typeof message.messageId === "string" && MESSAGE_ID_PATTERN.test(message.messageId)
      ? message.messageId
      : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!messageId || !text) continue;
    const createTime = typeof message.createTime === "string" ? message.createTime : null;
    messages.push({ messageId, text, createTime });
  }
  let mineIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.text === question) {
      mineIndex = index;
      break;
    }
  }
  const candidates = (mineIndex >= 0 ? messages.slice(mineIndex + 1) : messages)
    .filter((message) => message.text !== question);
  return candidates[0];
}

/** dws 发送成功的回执里提取 openTaskId（仅用于发送状态确认，不外发）。 */
export function parseOpenTaskId(stdout: string): string | undefined {
  return /"openTaskId"\s*:\s*"([A-Za-z0-9_-]{4,128})"/.exec(stdout)?.[1];
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, path);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f「」]/g, "").trim().slice(0, max);
  return cleaned || null;
}

/** 从本地快照取客户行（提问模板需要的名字与异动字段；缺字段如实置 null）。 */
function snapshotCustomer(
  raw: unknown,
  cid: string,
): { name: string; rate: number | null; diff: number | null } | undefined {
  const customers = (raw as { customers?: unknown[] } | undefined)?.customers ?? [];
  const match = customers.find((item) => (item as { cid?: unknown })?.cid === cid) as Record<string, unknown> | undefined;
  if (!match) return undefined;
  const name = cleanText(match.name, 80);
  if (!name) return undefined;
  const rate = typeof match.yesterdayGaapRate === "number" && Number.isFinite(match.yesterdayGaapRate)
    ? match.yesterdayGaapRate
    : null;
  const diff = typeof match.yesterdayGaapDiff === "number" && Number.isFinite(match.yesterdayGaapDiff)
    ? match.yesterdayGaapDiff
    : null;
  return { name, rate, diff };
}

function asExplainRecord(raw: unknown, cid: string): CrmAiExplainRecord | undefined {
  const record = raw as Partial<CrmAiExplainRecord> | undefined;
  if (!record || record.cid !== cid || record.schemaVersion !== 1 || typeof record.createdAt !== "string") {
    return undefined;
  }
  if (record.state !== "running" && record.state !== "done" && record.state !== "failed") return undefined;
  return record as CrmAiExplainRecord;
}

/** 上海时间的 "YYYY-MM-DD HH:mm:ss"（dws 时间窗参数口径）。 */
function shanghaiClock(moment: number): string {
  return new Date(moment).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
}

export function createCrmAiBridge(options: CrmAiBridgeOptions = {}): CrmAiBridge {
  const attributionDir = options.cacheDir ? join(options.cacheDir, "crm-attribution") : ATTRIBUTION_DIR;
  const snapshotPath = options.cacheDir ? join(options.cacheDir, "crm-snapshot.json") : SNAPSHOT_PATH;
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const env = options.env ?? process.env;
  const exists = options.existsSync ?? existsSync;
  const iso = () => new Date(now()).toISOString();
  const polling = new Map<string, Promise<void>>();

  const explainPath = (cid: string) => join(attributionDir, `${cid}.explain.json`);
  const readExplain = async (cid: string) => asExplainRecord(await readJson(explainPath(cid)), cid);
  const readAttribution = async (cid: string) =>
    (await readJson(join(attributionDir, `${cid}.json`))) as AttributionRecord | undefined;
  const saveExplain = async (record: CrmAiExplainRecord) => {
    await mkdir(attributionDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(explainPath(record.cid), record);
    return record;
  };

  const assistantId = (): string | null => {
    const value = String(env.CRM_AI_OPEN_DINGTALK_ID ?? "").trim();
    return OPEN_DINGTALK_ID_PATTERN.test(value) ? value : null;
  };

  const readReply = async (openId: string, askedAt: number, question: string) => {
    const result = await run(resolveDwsBin(env, exists), [
      "chat", "+chat-messages",
      "--open-dingtalk-id", openId,
      "--start", shanghaiClock(askedAt - 60_000),
      "--end", shanghaiClock(now()),
      "--order", "asc", "--format", "json",
    ], { timeoutMs: DWS_READ_TIMEOUT_MS });
    if (result.code === "ENOENT") return { kind: "missing" as const };
    if (result.code !== 0) return { kind: "read_failed" as const };
    try {
      const payload: unknown = JSON.parse(result.stdout);
      const reply = extractAssistantReply(payload, question);
      return reply ? { kind: "reply" as const, reply } : { kind: "pending" as const };
    } catch {
      return { kind: "read_failed" as const };
    }
  };

  const waitForReply = (record: CrmAiExplainRecord, openId: string, askedAt: number): Promise<void> => {
    const question = record.question ?? "";
    const deadline = askedAt + REPLY_WAIT_TIMEOUT_MS;
    const attempt = async (): Promise<void> => {
      let readErrors = 0;
      while (now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const outcome = await readReply(openId, askedAt, question);
        if (outcome.kind === "reply") {
          await saveExplain({
            ...record,
            state: "done",
            finishedAt: iso(),
            answer: outcome.reply.text.slice(0, MAX_ANSWER_CHARS),
            answerAt: outcome.reply.createTime,
            error: null,
          });
          return;
        }
        if (outcome.kind === "missing") {
          await saveExplain({ ...record, state: "failed", finishedAt: iso(), error: "dws_missing" });
          return;
        }
        readErrors = outcome.kind === "read_failed" ? readErrors + 1 : 0;
        if (readErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
          await saveExplain({ ...record, state: "failed", finishedAt: iso(), error: "dws_read_failed" });
          return;
        }
      }
      await saveExplain({ ...record, state: "failed", finishedAt: iso(), error: "crm_ai_timeout" });
    };
    const task = attempt().catch(async () => {
      await saveExplain({ ...record, state: "failed", finishedAt: iso(), error: "crm_ai_timeout" }).catch(() => undefined);
    }).finally(() => polling.delete(record.cid));
    polling.set(record.cid, task);
    return task;
  };

  const startExplain = async (cid: string, force = false): Promise<CrmAiExplainStartResult> => {
    if (!CID_PATTERN.test(cid)) return { ok: false, error: "invalid_cid" };
    if (polling.has(cid)) return { ok: false, error: "busy" };
    const openId = assistantId();
    if (!openId) return { ok: false, error: "unconfigured" };
    const customer = snapshotCustomer(await readJson(snapshotPath), cid);
    if (!customer) return { ok: false, error: "customer_not_found" };
    const attribution = await readAttribution(cid);
    if (!attribution || attribution.state !== "done" || typeof attribution.createdAt !== "string") {
      return { ok: false, error: "attribution_missing" };
    }
    const built = buildGaapAttribution(attribution.rows ?? []);
    const question = crmAiQuestion({
      name: customer.name,
      cid,
      rate: customer.rate,
      diff: customer.diff,
      currentDate: attribution.currentDate ?? null,
      previousDate: attribution.previousDate ?? null,
      productSummary: fbiProductSummary(built.level1Rows),
    });
    const existing = await readExplain(cid);
    if (!force && existing?.state === "done" && existing.question === question) {
      return { ok: true, record: existing, reused: true };
    }

    const askedAt = now();
    const pending: CrmAiExplainRecord = {
      schemaVersion: 1,
      cid,
      state: "running",
      createdAt: iso(),
      finishedAt: null,
      question,
      askedAt: iso(),
      answer: null,
      answerAt: null,
      error: null,
    };
    // 仅 1:1 发送给「CRM AI 助理」：单次点击最多一次发送，不重试轰炸。
    const sent = await run(resolveDwsBin(env, exists), [
      "chat", "message", "send",
      "--open-dingtalk-id", openId,
      "--content", question,
      "-y", "--format", "json",
    ], { timeoutMs: DWS_SEND_TIMEOUT_MS });
    if (sent.code === "ENOENT") {
      return { ok: true, record: await saveExplain({ ...pending, state: "failed", finishedAt: iso(), error: "dws_missing" }), reused: false };
    }
    if (sent.code !== 0 || !parseOpenTaskId(sent.stdout)) {
      return { ok: true, record: await saveExplain({ ...pending, state: "failed", finishedAt: iso(), error: "dws_send_failed" }), reused: false };
    }
    const record = await saveExplain(pending);
    void waitForReply(record, openId, askedAt);
    return { ok: true, record, reused: false };
  };

  return {
    explain: async (cid) => {
      if (!CID_PATTERN.test(cid)) return undefined;
      const record = await readExplain(cid);
      if (record?.state === "running" && !polling.has(cid)) {
        const openId = assistantId();
        const askedAt = record.askedAt !== null ? Date.parse(record.askedAt) : Number.NaN;
        if (openId && record.question !== null && Number.isFinite(askedAt)) {
          // 服务重启后按已持久化的 question/askedAt 续跑等待循环（超时由循环自身落终态）。
          void waitForReply(record, openId, askedAt);
        } else {
          // 无法恢复轮询（缺配置或时间戳损坏）：如实落终态，不让前端永远轮询 running。
          return saveExplain({ ...record, state: "failed", finishedAt: iso(), error: "crm_ai_timeout" });
        }
      }
      return record;
    },
    startExplain,
  };
}
