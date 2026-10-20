import { randomUUID } from "node:crypto";
import { existsSync as defaultExistsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { beijingDate, parseAutomationDetail } from "./report-bridge.ts";
import {
  DAILY_CONFIG_NOTE,
  DEFAULT_REPORT_CONFIG_PATH,
  loadReportConfig,
  remoteConfigNote,
  TRIGGER_PATTERN,
  type ReportDailyConfig,
  type ReportRemoteConfig,
  type ReportRemoteJob,
} from "./report-config.ts";
import {
  createDefaultReportRunner,
  OUTBOX_LIST_TIMEOUT_MS,
  RATE_RETRY_SLEEP_MS,
  RECORD_QUERY_TIMEOUT_MS,
  redactText,
  resolveDwsBin,
  runDws,
  runSsh,
  type ReportCommandRunner,
} from "./report-dws.ts";
import {
  createReportWriteStore,
  DEFAULT_REPORT_WRITE_DIR,
  maskWritePreview,
  type ReportWriteStore,
} from "./report-write-store.ts";
import {
  DRY_TOKEN_TTL_MS,
  MAX_WRITE_BODY_BYTES,
  PENDING_TOKEN_LIMIT,
  RECORD_ID_PATTERN,
  RECORD_UPDATE_TIMEOUT_MS,
  REPORT_MAX_TEXT,
  REPORT_WRITE_ROUTES,
  REPORT_WRITABLE_FIELDS,
  ReportWriteBridgeError,
  SUBMIT_COOLDOWN_MS,
  SUBMIT_PROBE_TIMEOUT_MS,
  WRITES_TAIL,
  type ReportSaveConfirmResult,
  type ReportSaveDiffItem,
  type ReportSaveDryResult,
  type ReportSubmitChannel,
  type ReportSubmitConfirmResult,
  type ReportSubmitDryResult,
  type ReportSubmittedInfo,
  type ReportWritableField,
  type ReportWriteAudit,
  type ReportWriteBridge,
  type ReportWritesView,
} from "./report-write-types.ts";

/**
 * Report write bridge (F6-P1) — 日报回写（草稿保存 / 提交）写能力。
 * donor: scripts/lib/report/index.js actSave / act('send') / runNow / outboxToday /
 * cooldownLeft + bridge.js POST /report/{save,send}（搬语义不搬代码）。
 *
 * 两步协议（服务端闸门，先于任何外部调用）：
 * - save-dry：白名单 sanitize → 读当日记录 → 逐字段 diff + 一次性 token（10min、单次消费）；
 * - save-confirm：confirm 严格 === token → 执行前重读记录做 recordId 冲突检查（冲突 409
 *   带清单、绝不覆盖）→ dws aitable record update（records-file 0600 落 tmp 即删）→
 *   回读校验 verified 如实返回 → 审计 append-only；
 * - submit-dry：冷却剩余（审计派生）+ outbox 今日去重 + SSH automation detail 只读探测通道；
 * - submit-confirm：confirm 闸门 → 冷却 429（诚实拒绝不重发）→ outbox 复查 409 →
 *   SSH automation run-now（复用远端完整提交链路）→ 成功与否都回读 outbox 校验 → 审计 run+verify 两行。
 * dws 缺失 → dws_missing 503 诚实失败；错误消息先 redactText 脱敏再截断。
 */

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface ReportWriteBridgeOptions {
  /** 日周报配置路径（缺省 .local-cache/report.json，与只读桥同一份）。 */
  readonly configPath?: string;
  /** 写审计目录（缺省 .local-cache/report；测试注入临时目录）。 */
  readonly dir?: string;
  /** dws / ssh runner 注入点（测试用 stub 绝不真发；缺省 execFile 真 runner）。 */
  readonly run?: ReportCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly existsSync?: (path: string) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomToken?: () => string;
  readonly store?: ReportWriteStore;
}

/** dry 铸造的一次性待确认票据（confirm 只认 token，载荷绝不从 confirm 请求体取）。 */
type PendingEntry =
  | { readonly kind: "save"; readonly createdAt: number; readonly recordId: string; readonly cells: Readonly<Record<string, string>> }
  | { readonly kind: "submit"; readonly createdAt: number; readonly trigger: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: string): number {
  if (code === "confirm_stale" || code === "no_record" || code === "record_conflict" || code === "already_submitted") return 409;
  if (code === "cooldown") return 429;
  if (code === "method_not_allowed") return 405;
  if (code === "dws_missing" || code === "ssh_unavailable") return 503;
  if (code === "dws_failed" || code === "submit_failed" || code === "write_unavailable") return 502;
  return 400; // report_invalid_request / report_unconfigured / confirm_mismatch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lastLine(text: string): string {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

/** 错误消息一律先脱敏再截断（凭据形态文本不出桥）。 */
function safeDetail(text: string, max = 200): string {
  return redactText(text).slice(0, max);
}

/** 照静态版 jsonOf：CLI 输出常在 JSON 前后带告警行，取首个 { 到最后一个 } 宽容解析。 */
function parseJsonLoose(text: string): Record<string, unknown> | null {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(s.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** dws 成功响应可能带 error:{} 空对象——仅非空 error / success:false 才算失败（donor dwsFail 口径）。 */
function isNonEmptyError(error: unknown): boolean {
  return Boolean(error) && (typeof error !== "object" || Array.isArray(error) || Object.keys(error).length > 0);
}

function remoteErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  const message = isRecord(error)
    ? error.message ?? error.reason
    : typeof error === "string"
      ? error
      : payload.message ?? payload.reason;
  return String(message ?? "远端未说明原因");
}

/** 照静态版 cellText：多态单元格归一为纯文本。 */
function cellTextOf(cell: unknown): string {
  if (cell == null) return "";
  if (Array.isArray(cell)) return cell.map((entry) => cellTextOf(entry)).filter(Boolean).join("；");
  if (typeof cell === "object") {
    const record = cell as Record<string, unknown>;
    return cellTextOf(record.text ?? record.value ?? "");
  }
  return String(cell).trim();
}

export function createReportWriteBridge(options: ReportWriteBridgeOptions = {}): ReportWriteBridge {
  const configPath = options.configPath ?? DEFAULT_REPORT_CONFIG_PATH;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const randomToken = options.randomToken ?? randomUUID;
  const run: ReportCommandRunner = options.run ?? createDefaultReportRunner();
  const store = options.store ?? createReportWriteStore(options.dir ?? DEFAULT_REPORT_WRITE_DIR);
  const dwsBin = resolveDwsBin(env, existsSync);

  const iso = (): string => new Date(now()).toISOString();

  /* ---------------- dws / ssh 调用（ENOENT 追踪 → dws_missing / ssh 分类） ---------------- */

  let sawEnoent = false;
  const trackingRun: ReportCommandRunner = async (file, args, callOptions) => {
    const result = await run(file, args, callOptions);
    if (result.code === "ENOENT") sawEnoent = true;
    return result;
  };

  async function dwsCall(args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
    sawEnoent = false;
    try {
      return await runDws(trackingRun, dwsBin, args, timeoutMs, RATE_RETRY_SLEEP_MS, sleep);
    } catch (error) {
      if (sawEnoent) {
        throw new ReportWriteBridgeError(
          "dws_missing",
          "未找到 dws CLI：本次没有写入任何内容。请安装 dws 并在终端完成 dws auth login 后重试。",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ReportWriteBridgeError("dws_failed", safeDetail(message, 300));
    }
  }

  /* ---------------- 配置段 ---------------- */

  async function dailyConfig(): Promise<ReportDailyConfig> {
    const loaded = await loadReportConfig(configPath);
    if (!loaded?.daily) {
      throw new ReportWriteBridgeError("report_unconfigured", loaded?.dailyNote || DAILY_CONFIG_NOTE);
    }
    return loaded.daily;
  }

  async function submitChannelConfig(): Promise<{ remote: ReportRemoteConfig; job: ReportRemoteJob }> {
    const loaded = await loadReportConfig(configPath);
    const remote = loaded?.remote ?? null;
    if (!remote) {
      throw new ReportWriteBridgeError("report_unconfigured", loaded?.remoteNote || remoteConfigNote());
    }
    const job = remote.jobs.find((entry) => entry.key === "submit");
    if (!job || !TRIGGER_PATTERN.test(job.trigger)) {
      throw new ReportWriteBridgeError(
        "report_unconfigured",
        "未配置 submit 触发器（remote.jobs.submit.trigger 需形如 tr_xxxxxx）：本台无法代提交日报。",
      );
    }
    return { remote, job };
  }

  /** 配置里的 ~/.ssh/... 按注入 HOME 展开（与只读桥 expandKeyPath 同口径）。 */
  function expandKeyPath(key: string): string {
    const home = String(env.HOME ?? "").replace(/\/$/, "");
    return key.startsWith("~/") && home ? `${home}${key.slice(1)}` : key;
  }

  /* ---------------- 当日记录 / outbox（donor queryToday / outboxToday 同口径） ---------------- */

  async function queryToday(daily: ReportDailyConfig): Promise<ReportTodayView | null> {
    const today = beijingDate(now());
    const filter = { operator: "and", operands: [{ operator: "date_eq", operands: [daily.fields.date, today] }] };
    const payload = await dwsCall([
      "aitable", "record", "query",
      "--base-id", daily.baseId,
      "--table-id", daily.tableId,
      "--filters", JSON.stringify(filter),
      "--field-ids", Object.values(daily.fields).join(","),
    ], RECORD_QUERY_TIMEOUT_MS);
    const data = isRecord(payload.data) ? payload.data : {};
    const rows = Array.isArray(data.records) ? data.records.filter(isRecord) : [];
    const mapped = rows
      .map((row) => ({
        recordId: String(row.recordId ?? row.id ?? ""),
        cells: isRecord(row.cells) ? row.cells : {},
        modifiedMs: Date.parse(String(row.lastModifiedTime ?? row.modifiedAt ?? "")) || 0,
        modifiedAt: String(row.lastModifiedTime ?? row.modifiedAt ?? ""),
      }))
      .filter((row) => row.recordId !== "")
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
    const hit = mapped[0];
    if (!hit) return null;
    const text = (key: keyof ReportDailyConfig["fields"]): string => cellTextOf(hit.cells[daily.fields[key]]);
    return {
      recordId: hit.recordId,
      modifiedAt: hit.modifiedAt,
      topic: text("topic"),
      dept: text("dept"),
      workStatus: text("workStatus"),
      followup: text("followup"),
      opportunity: text("opportunity"),
      risk: text("risk"),
      other: text("other"),
    };
  }

  async function outboxToday(daily: ReportDailyConfig): Promise<ReportSubmittedInfo> {
    const today = beijingDate(now());
    const args = [
      "report", "outbox", "list",
      "--cursor", "0", "--size", "20",
      "--start", `${today}T00:00:00+08:00`,
      "--end", `${today}T23:59:59+08:00`,
    ];
    if (daily.templateName) args.push("--template-name", daily.templateName);
    const payload = await dwsCall(args, OUTBOX_LIST_TIMEOUT_MS);
    const data = isRecord(payload.data) ? payload.data : {};
    const rows = (Array.isArray(payload.result) ? payload.result : Array.isArray(data.result) ? data.result : [])
      .filter(isRecord);
    const items = rows
      .map((row) => ({
        title: String(row["标题"] ?? row.title ?? row.subject ?? "").slice(0, 120),
        ms: Date.parse(String(row["日期"] ?? row.date ?? row.createTime ?? row.time ?? "")),
      }))
      .filter((row) => Number.isFinite(row.ms) && beijingDate(row.ms) === today)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((row) => ({ title: row.title, time: new Date(row.ms).toISOString() }));
    const total = rows
      .map((row) => Date.parse(String(row["日期"] ?? row.date ?? row.createTime ?? row.time ?? "")))
      .filter((ms) => Number.isFinite(ms) && beijingDate(ms) === today).length;
    return { n: total, items };
  }

  /* ---------------- dry token（一次性、10min TTL、类型绑定） ---------------- */

  const pending = new Map<string, PendingEntry>();

  function prunePending(): void {
    const cutoff = now() - DRY_TOKEN_TTL_MS;
    for (const [token, entry] of pending) {
      if (entry.createdAt <= cutoff) pending.delete(token);
    }
    while (pending.size > PENDING_TOKEN_LIMIT) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  }

  function mintToken(entry: Omit<PendingEntry, "createdAt">): string {
    prunePending();
    const token = randomToken();
    pending.set(token, { ...entry, createdAt: now() } as PendingEntry);
    return token;
  }

  /** confirm 闸门：严格 === dry token，先于任何外部调用；票据单次消费（防重放）。 */
  function consumePending(body: Record<string, unknown>, kind: "save" | "submit"): PendingEntry {
    const confirm = body.confirm;
    if (typeof confirm !== "string" || confirm.trim() === "") {
      throw new ReportWriteBridgeError(
        "confirm_mismatch",
        "人工确认未完成：body.confirm 必须严格等于 dry 返回的 token。本次未执行任何写入或触发。",
      );
    }
    prunePending();
    const entry = pending.get(confirm);
    if (!entry || entry.kind !== kind) {
      throw new ReportWriteBridgeError(
        "confirm_stale",
        "预检票据不存在、已过期（10 分钟）或类型不符：请重新预检后再确认。本次未执行任何写入或触发。",
      );
    }
    pending.delete(confirm);
    return entry;
  }

  /* ---------------- 白名单 sanitize（比 donor 更严：越界即整体拒绝，不静默丢弃） ---------------- */

  function sanitizeWritableCells(raw: unknown): Record<ReportWritableField, string> {
    if (!isRecord(raw)) {
      throw new ReportWriteBridgeError("report_invalid_request", "body.cells 必须是 JSON 对象（白名单字段 → 文本）。");
    }
    const outside = Object.keys(raw).filter((key) => !(REPORT_WRITABLE_FIELDS as readonly string[]).includes(key));
    if (outside.length > 0) {
      throw new ReportWriteBridgeError(
        "report_invalid_request",
        `白名单外字段一律拒绝：${outside.join(" / ")}（可写白名单：${REPORT_WRITABLE_FIELDS.join(" / ")}；`
        + `dept / workStatus / date 只读，绝不入写面）。`,
      );
    }
    const cells = {} as Record<ReportWritableField, string>;
    let count = 0;
    for (const key of REPORT_WRITABLE_FIELDS) {
      if (!(key in raw)) continue;
      const value = raw[key];
      if (typeof value !== "string") {
        throw new ReportWriteBridgeError("report_invalid_request", `${key} 必须是字符串（空串 = 清空该字段）。`);
      }
      if (value.includes("\0")) {
        throw new ReportWriteBridgeError("report_invalid_request", `${key} 含 NUL 控制符，已整体拒绝。`);
      }
      const normalized = value.replace(/\r\n?/g, "\n");
      if (normalized.length > REPORT_MAX_TEXT) {
        throw new ReportWriteBridgeError(
          "report_invalid_request",
          `${key} 长度 ${normalized.length} 超过上限 ${REPORT_MAX_TEXT} 字：不截断保存，请删减后重试。`,
        );
      }
      cells[key] = normalized;
      count += 1;
    }
    if (count === 0) {
      throw new ReportWriteBridgeError("report_invalid_request", "没有可保存的内容：cells 至少包含一个白名单字段。");
    }
    return cells;
  }

  function validRecordId(raw: unknown): string {
    const recordId = typeof raw === "string" ? raw.trim() : "";
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new ReportWriteBridgeError(
        "report_invalid_request",
        `recordId 不合法：需为 1–64 位字母数字下划线中划线（收到「${safeDetail(recordId, 16)}」）。`,
      );
    }
    return recordId;
  }

  /** recordId 冲突 → 409 带冲突清单（期望 id / 当前 id / 最新内容），绝不覆盖。 */
  function conflictError(expectedRecordId: string, fresh: ReportTodayView): ReportWriteBridgeError {
    return new ReportWriteBridgeError(
      "record_conflict",
      "记录已被外部更新（可能初稿任务刚跑完）：本次未覆盖任何内容，已为你带出最新记录，请刷新后重新编辑。",
      {
        expectedRecordId,
        currentRecordId: fresh.recordId,
        current: {
          topic: fresh.topic,
          dept: fresh.dept,
          workStatus: fresh.workStatus,
          followup: fresh.followup,
          opportunity: fresh.opportunity,
          risk: fresh.risk,
          other: fresh.other,
          modifiedAt: fresh.modifiedAt,
        },
      },
    );
  }

  /* ---------------- 审计（append-only；写失败如实 audited:false，不吞结果） ---------------- */

  async function appendAudit(row: ReportWriteAudit): Promise<boolean> {
    try {
      await store.appendWrite(row);
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        event: "report_write_audit_failed",
        op: row.op,
        reason: safeDetail(String((error as Error)?.message ?? error), 120),
      }));
      return false;
    }
  }

  /* ---------------- save ---------------- */

  async function saveDry(body: unknown): Promise<ReportSaveDryResult> {
    if (!isRecord(body)) {
      throw new ReportWriteBridgeError("report_invalid_request", "请求体必须是 JSON 对象：{recordId, cells}。");
    }
    const cells = sanitizeWritableCells(body.cells);
    const recordId = validRecordId(body.recordId);
    const daily = await dailyConfig();
    const fresh = await queryToday(daily);
    if (!fresh) {
      throw new ReportWriteBridgeError(
        "no_record",
        "今日记录不存在（初稿由 QoderWake 每日 19:00 生成）：先等初稿或直接在 AI 表格编辑，本次未写入。",
      );
    }
    if (fresh.recordId !== recordId) throw conflictError(recordId, fresh);
    const diff: ReportSaveDiffItem[] = REPORT_WRITABLE_FIELDS
      .filter((key) => key in cells)
      .map((key) => ({
        key,
        fieldId: daily.fields[key],
        before: fresh[key],
        after: cells[key],
        changed: fresh[key].trim() !== cells[key].trim(),
      }));
    const token = mintToken({ kind: "save", recordId, cells });
    return { token, recordId, at: iso(), today: beijingDate(now()), diff };
  }

  async function saveConfirm(body: unknown): Promise<ReportSaveConfirmResult> {
    if (!isRecord(body)) {
      throw new ReportWriteBridgeError("report_invalid_request", "请求体必须是 JSON 对象：{confirm}。");
    }
    /* confirm 闸门先于任何外部调用；载荷用 dry 票据里的快照，绝不从本请求体取。 */
    const entry = consumePending(body, "save");
    if (entry.kind !== "save") throw new ReportWriteBridgeError("write_unavailable", "unreachable");
    const daily = await dailyConfig();
    const fresh = await queryToday(daily);
    if (!fresh) {
      throw new ReportWriteBridgeError("no_record", "今日记录不存在：本次未写入任何内容。");
    }
    if (fresh.recordId !== entry.recordId) throw conflictError(entry.recordId, fresh);

    const cellsById: Record<string, string> = {};
    for (const key of REPORT_WRITABLE_FIELDS) {
      if (key in entry.cells) cellsById[daily.fields[key]] = entry.cells[key];
    }
    const previewSource = REPORT_WRITABLE_FIELDS
      .filter((key) => key in entry.cells)
      .map((key) => entry.cells[key])
      .find((text) => text.trim() !== "") ?? "";
    const maskedPreview = maskWritePreview(previewSource);

    /* records 文件 0600 落 tmp 即删（donor actSave 同款；数组 argv，无 shell 拼接）。 */
    const tmpPath = joinPath(tmpdir(), `sa-report-write-${process.pid}-${now()}-${randomUUID().slice(0, 8)}.json`);
    try {
      await writeFile(tmpPath, JSON.stringify([{ recordId: entry.recordId, cells: cellsById }]), {
        encoding: "utf-8",
        mode: 0o600,
      });
      sawEnoent = false;
      try {
        await runDws(trackingRun, dwsBin, [
          "aitable", "record", "update",
          "--base-id", daily.baseId,
          "--table-id", daily.tableId,
          "--records-file", tmpPath,
        ], RECORD_UPDATE_TIMEOUT_MS, RATE_RETRY_SLEEP_MS, sleep);
      } catch (error) {
        const missing = sawEnoent;
        await appendAudit({
          at: iso(), op: "save", phase: "update", target: entry.recordId,
          exitCode: missing ? "ENOENT" : "dws-error",
          executed: !missing, ok: false, verified: false, maskedPreview,
        });
        if (missing) {
          throw new ReportWriteBridgeError(
            "dws_missing",
            "未找到 dws CLI：本次没有保存成功，草稿仍在页面里。请安装 dws 并 dws auth login 后重试。",
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ReportWriteBridgeError("dws_failed", safeDetail(message, 300));
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }

    /* 回读校验：逐字段 trim 比对（donor actSave verified 口径）；回读失败如实 verified:false。 */
    let after: ReportTodayView | null = null;
    try {
      after = await queryToday(daily);
    } catch {
      after = null;
    }
    const sentKeys = REPORT_WRITABLE_FIELDS.filter((key) => key in entry.cells);
    const verified = after !== null
      && after.recordId === entry.recordId
      && sentKeys.every((key) => after !== null && after[key].trim() === entry.cells[key].trim());
    const audited = await appendAudit({
      at: iso(), op: "save", phase: "update", target: entry.recordId,
      exitCode: 0, executed: true, ok: true, verified, maskedPreview,
    });
    return {
      recordId: entry.recordId,
      verified,
      at: iso(),
      updated: sentKeys,
      audited,
      note: verified
        ? "已写回 AI 表格并通过回读校验。"
        : "已写回，但回读内容与提交不一致（或回读失败）：请到 AI 表格人工确认，勿盲目重复保存。",
    };
  }

  /* ---------------- submit ---------------- */

  function cooldownLeft(lastRunMs: number): number {
    if (lastRunMs <= 0) return 0;
    const left = lastRunMs + SUBMIT_COOLDOWN_MS - now();
    return left > 0 ? left : 0;
  }

  async function probeChannel(remote: ReportRemoteConfig, job: ReportRemoteJob): Promise<ReportSubmitChannel> {
    const keyPath = expandKeyPath(remote.key);
    if (!existsSync(keyPath)) {
      return { available: false, enabled: false, lastStatus: "", nextAt: "", note: "SSH 私钥不存在（remote.key）：发送通道不可用。" };
    }
    sawEnoent = false;
    const detailCommand = `${remote.bin} automation detail --waker-id ${remote.wakerId} --automation-id ${job.trigger} --runs-limit 1`;
    const result = await runSsh(trackingRun, {
      host: remote.host,
      keyPath,
      remoteCommand: detailCommand,
      timeoutMs: SUBMIT_PROBE_TIMEOUT_MS,
    });
    if (sawEnoent) {
      return { available: false, enabled: false, lastStatus: "", nextAt: "", note: "本机 ssh 命令缺失：发送通道不可用。" };
    }
    if (result.code !== 0) {
      return {
        available: false, enabled: false, lastStatus: "", nextAt: "",
        note: `SSH 探测失败（退出 ${String(result.code)}）：${safeDetail(lastLine(result.stderr || result.stdout)) || "无错误输出"}`,
      };
    }
    const parsed = parseAutomationDetail(String(result.stdout ?? ""));
    return {
      available: true,
      enabled: parsed.ENABLED === "true",
      lastStatus: parsed.LAST_RUN_STATUS ?? "",
      nextAt: parsed.NEXT_RUN_AT ?? "",
      note: `SSH 发送通道可用（远端任务 ${parsed.NAME ?? job.name}；TASK_DESCRIPTION 不透出）。`,
    };
  }

  async function submitDry(): Promise<ReportSubmitDryResult> {
    const daily = await dailyConfig();
    const { remote, job } = await submitChannelConfig();
    const cooldownRemainMs = cooldownLeft(await store.lastSubmitRunMs());
    const submitted = await outboxToday(daily);
    const channel = await probeChannel(remote, job);
    const alreadySubmitted = submitted.n > 0 ? submitted : null;
    const blocked = cooldownRemainMs > 0 || alreadySubmitted !== null || !channel.available;
    const reasons: string[] = [];
    if (cooldownRemainMs > 0) reasons.push(`上次触发仍在 5 分钟冷却内（剩 ${Math.ceil(cooldownRemainMs / 1000)} 秒）`);
    if (alreadySubmitted) reasons.push(`今日已提交过日报（${alreadySubmitted.n} 次）`);
    if (!channel.available) reasons.push(channel.note);
    return {
      token: mintToken({ kind: "submit", trigger: job.trigger }),
      at: iso(),
      today: beijingDate(now()),
      blocked,
      cooldownRemainMs,
      alreadySubmitted,
      channel,
      note: blocked ? `暂不建议提交：${reasons.join("；")}。` : "预检通过：确认后将 run-now 触发远端提交任务（远端自带工作日判定与去重护栏）。",
    };
  }

  async function submitConfirm(body: unknown): Promise<ReportSubmitConfirmResult> {
    if (!isRecord(body)) {
      throw new ReportWriteBridgeError("report_invalid_request", "请求体必须是 JSON 对象：{confirm}。");
    }
    /* confirm 闸门先于任何外部调用。 */
    const entry = consumePending(body, "submit");
    if (entry.kind !== "submit") throw new ReportWriteBridgeError("write_unavailable", "unreachable");
    const daily = await dailyConfig();
    const { remote, job } = await submitChannelConfig();

    /* 冷却闸门（本地审计派生，先于外部调用）：诚实 429，绝不重发。 */
    const remain = cooldownLeft(await store.lastSubmitRunMs());
    if (remain > 0) {
      throw new ReportWriteBridgeError(
        "cooldown",
        `刚触发过提交，${Math.ceil(remain / 1000)} 秒后可再试（5 分钟冷却内诚实拒绝，不重发）。`,
      );
    }
    /* outbox 双保险去重（donor act('send') 口径；远端定时任务另有同口径护栏）。 */
    const before = await outboxToday(daily);
    if (before.n > 0) {
      throw new ReportWriteBridgeError(
        "already_submitted",
        `今日已提交过日报（${before.items[0]?.title || before.n + " 次"}），不重复发送。`,
        { submitted: before },
      );
    }

    const keyPath = expandKeyPath(remote.key);
    if (!existsSync(keyPath)) {
      await appendAudit({
        at: iso(), op: "submit", phase: "run", target: job.trigger,
        exitCode: "no_key", executed: false, ok: false, verified: false, maskedPreview: "",
      });
      throw new ReportWriteBridgeError("ssh_unavailable", "SSH 私钥不存在（remote.key）：本次未触发任何提交。");
    }

    /* run-now：固定模板 + sanitize 过的配置值（TRIGGER_PATTERN 已在配置层把关）；单 argv 无本地 shell。 */
    sawEnoent = false;
    const remoteCommand = `${remote.bin} automation run-now --waker-id ${remote.wakerId} --automation-id ${job.trigger}`;
    const result = await runSsh(trackingRun, { host: remote.host, keyPath, remoteCommand, timeoutMs: remote.timeoutMs });
    const executed = !sawEnoent && result.code !== "ENOENT";
    const payload = parseJsonLoose(String(result.stdout ?? ""));
    let failure: ReportWriteBridgeError | null = null;
    if (!executed) {
      failure = new ReportWriteBridgeError(
        "ssh_unavailable",
        "本机 ssh 命令缺失（ENOENT）：本次未触发任何提交，请检查本机 SSH 客户端。",
      );
    } else if (payload && (isNonEmptyError(payload.error) || payload.ok === false)) {
      failure = new ReportWriteBridgeError("submit_failed", `远端拒绝触发：${safeDetail(remoteErrorMessage(payload), 200)}`);
    } else if (result.code !== 0 && !payload) {
      failure = new ReportWriteBridgeError(
        "submit_failed",
        `SSH 触发失败（退出 ${String(result.code)}，可能超时）：${safeDetail(lastLine(result.stderr || result.stdout)) || "无错误输出"}`,
      );
    }
    const runAudited = await appendAudit({
      at: iso(), op: "submit", phase: "run", target: job.trigger,
      exitCode: result.code, executed, ok: failure === null, verified: false, maskedPreview: "",
    });
    if (failure) throw failure;

    /* 成功与否都回读校验（到这里 run-now 已真实发出）：读 outbox 看新提交是否已可见。 */
    let verified = false;
    let submittedN = before.n;
    try {
      const after = await outboxToday(daily);
      submittedN = after.n;
      verified = after.n > before.n;
    } catch {
      verified = false;
    }
    await appendAudit({
      at: iso(), op: "submit", phase: "verify", target: job.trigger,
      exitCode: 0, executed: false, ok: verified, verified, maskedPreview: "",
    });
    return {
      at: iso(),
      executed: true,
      runId: String(payload?.runId ?? ""),
      sessionId: String(payload?.sessionId ?? payload?.primarySessionId ?? ""),
      verified,
      submittedN,
      audited: runAudited,
      note: verified
        ? "已触发提交且 outbox 回读看到新提交。"
        : "已触发提交；远端任务约 1–3 分钟完成，outbox 回读暂未可见新提交（如实结果，请稍后刷新页面核对，勿重复触发）。",
    };
  }

  /* ---------------- writes / handle ---------------- */

  async function writes(): Promise<ReportWritesView> {
    const rows = await store.readWrites();
    return { writes: rows.slice(Math.max(0, rows.length - WRITES_TAIL)).reverse(), total: rows.length };
  }

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_WRITE_BODY_BYTES) {
      throw new ReportWriteBridgeError("report_invalid_request", `请求体过大（上限 ${Math.round(MAX_WRITE_BODY_BYTES / 1024)}KB）。`);
    }
    const text = await request.text();
    if (text.length > MAX_WRITE_BODY_BYTES) {
      throw new ReportWriteBridgeError("report_invalid_request", `请求体过大（上限 ${Math.round(MAX_WRITE_BODY_BYTES / 1024)}KB）。`);
    }
    if (text.trim() === "") return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) {
        throw new ReportWriteBridgeError("report_invalid_request", "请求体必须是 JSON 对象。");
      }
      return parsed;
    } catch (error) {
      if (error instanceof ReportWriteBridgeError) throw error;
      throw new ReportWriteBridgeError("report_invalid_request", "请求体不是合法 JSON。");
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
    const route = REPORT_WRITE_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非写路由（含 4 条只读 GET）：交回主路由，行为字节不变
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}。` } },
        405,
      );
    }
    try {
      if (route.operation === "writes") return jsonResponse({ ok: true, data: await writes() });
      if (route.operation === "submitDry") return jsonResponse({ ok: true, data: await submitDry() });
      const body = await readBody(request);
      if (route.operation === "saveDry") return jsonResponse({ ok: true, data: await saveDry(body) });
      if (route.operation === "saveConfirm") return jsonResponse({ ok: true, data: await saveConfirm(body) });
      return jsonResponse({ ok: true, data: await submitConfirm(body) });
    } catch (error) {
      if (error instanceof ReportWriteBridgeError) {
        const envelope: Record<string, unknown> = {
          ok: false,
          error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
        };
        return jsonResponse(envelope, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "write_unavailable", message: "日报回写服务遇到未知故障：本次未假装成功，请稍后重试。" } },
        502,
      );
    }
  }

  return { saveDry, saveConfirm, submitDry, submitConfirm, writes, handle };
}

/* ---------------- 内部视图类型 ---------------- */

interface ReportTodayView {
  readonly recordId: string;
  readonly modifiedAt: string;
  readonly topic: string;
  readonly dept: string;
  readonly workStatus: string;
  readonly followup: string;
  readonly opportunity: string;
  readonly risk: string;
  readonly other: string;
}
