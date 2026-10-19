import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import type { CommandRunner } from "./crm-bridge.ts";

/**
 * Local-only bridge for DingTalk todos and the unread-group daily digest.
 *
 * Boundary rules (plan: docs/dingtalk-todos-unread-summary-plan.md):
 * - The only write command this bridge can build is ``todo +create``. Any other
 *   subcommand is rejected before the runner is called.
 * - Creation is gated by a requestId map (replay returns the stored result,
 *   an in-flight id is rejected) and always runs ``--dry-run`` first.
 * - The digest script is read-only; this bridge only starts it and projects its
 *   artifacts. No path, credential or executor id reaches the browser.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const DAILY_SCRIPT = join(PROJECT_ROOT, "sync", "dingtalk_daily.py");

const DWS_TIMEOUT_MS = 120_000;
const PROFILE_TIMEOUT_MS = 30_000;
const SUMMARY_TIMEOUT_MS = 10 * 60_000;
/** Grace period before a persisted "running" row is treated as a dead process. */
const SUMMARY_STALE_MARGIN_MS = 60_000;
/** A creating row older than this may have reached dws; never retry it blindly. */
const TODO_STALE_MARGIN_MS = 60_000;
const MAX_WRITES_SHOWN = 50;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_ID_PATTERN = /^[A-Za-z0-9_=+/:.-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WRITE_PREFIX = ["todo", "+create"] as const;
const READBACK_PREFIX = ["todo", "task", "get"] as const;
const PRIORITIES = new Set([10, 20, 30, 40]);
const TITLE_MAX = 200;
const DUE_MAX = 40;
const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type TodoPriority = 10 | 20 | 30 | 40;

export interface TodoCreateInput {
  readonly requestId: string;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: TodoPriority;
  readonly executor: "self";
}

export type TodoWriteState = "creating" | "created" | "failed";

export interface TodoWriteRecord {
  readonly requestId: string;
  readonly state: TodoWriteState;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: number;
  readonly taskId: string | null;
  readonly dryRun: "passed" | "failed" | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export type TodoCreateError =
  | "invalid_request"
  | "user_id_unavailable"
  | "busy"
  | "dws_missing"
  | "todo_write_failed"
  | "todo_verify_failed"
  | "todo_manual_check_required";

export type TodoCreateResult =
  | { readonly ok: true; readonly record: TodoWriteRecord; readonly reused: boolean }
  | { readonly ok: false; readonly error: TodoCreateError; readonly record?: TodoWriteRecord };

export interface SummaryStatus {
  readonly state: "idle" | "running" | "succeeded" | "failed";
  readonly date: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  /** 摘要通道来源标记（env/isolated/default），不含任何路径或凭据。 */
  readonly modelSource?: string | null;
  /** 本轮生成耗时，便于按 20 群 × 200 条场景校准。 */
  readonly elapsedMs?: number | null;
  /** 浏览器安全的告警码（如 isolated 日志 chmod 失败），不阻断摘要。 */
  readonly warnings?: readonly string[];
}

export interface SummaryStartResult {
  readonly ok: boolean;
  readonly error?: "invalid_date" | "historical_read_only";
  readonly status: SummaryStatus;
  readonly reused: boolean;
}

export interface DailyMessage {
  readonly messageId: string;
  readonly sender: string;
  readonly text: string;
  readonly time: string;
}

export interface DailyMessages {
  readonly date: string;
  readonly chatId: string;
  readonly complete: boolean;
  readonly messages: readonly DailyMessage[];
}

export interface DingtalkBridge {
  readonly createTodo: (input: unknown) => Promise<TodoCreateResult>;
  readonly writes: () => Promise<readonly TodoWriteRecord[]>;
  readonly summary: (date?: string) => Promise<unknown | undefined>;
  readonly summaryStatus: () => Promise<SummaryStatus>;
  readonly startSummary: (date?: string) => Promise<SummaryStartResult>;
  readonly dailyMessages: (date: string, chatId: string) => Promise<DailyMessages | undefined>;
}

export interface DingtalkBridgeOptions {
  readonly cacheDir?: string;
  readonly run?: CommandRunner;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}

const defaultRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function parseJson(stdout: string): unknown | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function localDate(moment: number): string {
  const date = new Date(moment);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** dws wraps success as {ok,outcome}; list commands may only carry {result}. */
function dwsSucceeded(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  if (record.ok === false || record.success === false) return false;
  if (typeof record.outcome === "string" && record.outcome !== "success") return false;
  if (typeof record.errorCode === "number" && record.errorCode !== 0) return false;
  return true;
}

/**
 * Extract only the current profile's userId from `dws profile list`.
 *
 * The real payload also carries corpId/userName/clientId; those must never be
 * persisted, logged, audited or returned. This helper returns the id alone and
 * drops everything else immediately.
 */
function profileUserId(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record || record.success === false) return null;
  const current = typeof record.currentProfile === "string" ? record.currentProfile.trim() : "";
  const separator = current.lastIndexOf(":");
  if (separator >= 0) {
    const candidate = current.slice(separator + 1).trim();
    if (USER_ID_PATTERN.test(candidate)) return candidate;
  }
  const profiles = Array.isArray(record.profiles) ? record.profiles : [];
  for (const item of profiles) {
    const profile = asRecord(item);
    if (profile?.isCurrent !== true) continue;
    const candidate = typeof profile.userId === "string" ? profile.userId.trim() : "";
    if (USER_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

function dryRunConfirmed(payload: unknown, input: TodoCreateInput, executorId: string): boolean {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (data?.executed === true) return false;
  if (record?.dry_run !== true || data?.dryRun !== true) return false;
  const params = asRecord(asRecord(data?.params)?.PersonalTodoCreateVO);
  if (!params) return true;
  if (titleText(params.subject) !== input.title) return false;
  if (typeof params.priority === "number" && params.priority !== input.priority) return false;
  const executors = Array.isArray(params.executorIds) ? params.executorIds.map(String) : [];
  return executors.length === 0 || executors.includes(executorId);
}

function findTaskId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTaskId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record.taskId;
  if ((typeof direct === "string" || typeof direct === "number") && TASK_ID_PATTERN.test(String(direct))) {
    return String(direct);
  }
  for (const item of Object.values(record)) {
    const found = findTaskId(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findDetail(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDetail(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.todoDetailModel !== undefined) return asRecord(record.todoDetailModel);
  for (const item of Object.values(record)) {
    const found = findDetail(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function titleText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateCreate(input: unknown): { ok: true; value: TodoCreateInput } | { ok: false; error: "invalid_request" } {
  const record = asRecord(input);
  if (!record) return { ok: false, error: "invalid_request" };
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const title = titleText(record.title);
  const dueAt = typeof record.dueAt === "string" ? record.dueAt.trim() : "";
  const priority = record.priority;
  if (!REQUEST_ID_PATTERN.test(requestId) || BLOCKED_KEYS.has(requestId)) return { ok: false, error: "invalid_request" };
  if (!title || title.length > TITLE_MAX || /[\r\n]/.test(title)) return { ok: false, error: "invalid_request" };
  if (!dueAt || dueAt.length > DUE_MAX || !DUE_PATTERN.test(dueAt) || Number.isNaN(Date.parse(dueAt))) {
    return { ok: false, error: "invalid_request" };
  }
  if (typeof priority !== "number" || !PRIORITIES.has(priority)) return { ok: false, error: "invalid_request" };
  if (record.executor !== "self") return { ok: false, error: "invalid_request" };
  return { ok: true, value: { requestId, title, dueAt, priority: priority as TodoPriority, executor: "self" } };
}

export function createTodoCommand(
  input: TodoCreateInput,
  executorId: string,
  dryRun: boolean,
): string[] {
  const command = [
    ...WRITE_PREFIX,
    "--title", input.title,
    "--due", input.dueAt,
    "--priority", String(input.priority),
    "--executors", executorId,
    ...(dryRun ? ["--dry-run"] : []),
    "--yes",
    "--format", "json",
  ];
  // Defence in depth: the builder is the only place a write command exists.
  if (command[0] !== WRITE_PREFIX[0] || command[1] !== WRITE_PREFIX[1]) {
    throw new Error("command_not_allowed");
  }
  return command;
}

export function readbackCommand(taskId: string): string[] {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("command_not_allowed");
  return [...READBACK_PREFIX, "--task-id", taskId, "--format", "json"];
}

function asWriteRecord(raw: unknown): TodoWriteRecord | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (record.state !== "creating" && record.state !== "created" && record.state !== "failed") return undefined;
  if (typeof record.requestId !== "string" || typeof record.title !== "string") return undefined;
  return {
    requestId: record.requestId,
    state: record.state,
    title: record.title,
    dueAt: typeof record.dueAt === "string" ? record.dueAt : "",
    priority: typeof record.priority === "number" ? record.priority : 0,
    taskId: typeof record.taskId === "string" ? record.taskId : null,
    dryRun: record.dryRun === "passed" || record.dryRun === "failed" ? record.dryRun : null,
    error: typeof record.error === "string" ? record.error : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
  };
}

function asSummary(raw: unknown): unknown | undefined {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) return undefined;
  if (typeof record.date !== "string" || !Array.isArray(record.chats)) return undefined;
  return record;
}

export function createDingtalkBridge(options: DingtalkBridgeOptions = {}): DingtalkBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const writesPath = join(cacheDir, "dingtalk-todo-writes.json");
  const auditPath = join(cacheDir, "dingtalk-todo-audit.jsonl");
  const dailyDir = join(cacheDir, "dingtalk-daily");
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const iso = () => new Date(now()).toISOString();
  const inflight = new Set<string>();

  let writeChain: Promise<unknown> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(work, work);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const readWrites = async (): Promise<Record<string, TodoWriteRecord>> => {
    const raw = await readJson(writesPath);
    const records = asRecord(raw)?.writes;
    if (!asRecord(records)) return Object.create(null) as Record<string, TodoWriteRecord>;
    const result = Object.create(null) as Record<string, TodoWriteRecord>;
    for (const [key, value] of Object.entries(asRecord(records)!)) {
      const record = asWriteRecord(value);
      if (record) result[key] = record;
    }
    return result;
  };

  const saveWrites = async (writes: Record<string, TodoWriteRecord>): Promise<void> => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(writesPath, { schemaVersion: 1, writes });
  };

  const persist = (record: TodoWriteRecord) => serialise(async () => {
    const writes = await readWrites();
    writes[record.requestId] = record;
    await saveWrites(writes);
  });

  const audit = async (entry: Record<string, unknown>): Promise<void> => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await appendFile(
      auditPath,
      JSON.stringify({ ts: iso(), ...entry }) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  };

  const finishFailed = async (
    record: TodoWriteRecord,
    error: TodoCreateError,
    extra: Record<string, unknown> = {},
  ): Promise<TodoCreateResult> => {
    const failed: TodoWriteRecord = {
      ...record, state: "failed", error, finishedAt: iso(),
    };
    await persist(failed);
    await audit({ event: "create_failed", requestId: record.requestId, error, ...extra });
    return { ok: false, error, record: failed };
  };

  /**
   * A "creating" row whose process died leaves the requestId permanently busy.
   * Once the write window plus a grace period has passed the todo may already
   * exist, so settle the ledger as failed and never retry creation blindly.
   */
  const replayWrite = async (record: TodoWriteRecord): Promise<TodoCreateResult> => {
    if (record.state === "created") return { ok: true, record, reused: true };
    if (record.state === "creating") {
      const started = Date.parse(record.createdAt);
      const stale = !Number.isFinite(started)
        || now() >= started + DWS_TIMEOUT_MS + TODO_STALE_MARGIN_MS;
      if (!stale) return { ok: false, error: "busy", record };
      return await finishFailed(record, "todo_manual_check_required", { reason: "stale_creating" });
    }
    return { ok: false, error: (record.error as TodoCreateError | null) ?? "todo_write_failed", record };
  };

  /**
   * Resolve the operator's own userId without any manual .env entry.
   *
   * Precedence: a valid DINGTALK_USER_ID (manual override) then the read-only
   * `dws profile list`. Only the id leaves this function; corpId/userName/
   * clientId are discarded immediately and never audited, logged or returned.
   */
  const resolveExecutorId = async (): Promise<string | null> => {
    const fromEnv = (env.DINGTALK_USER_ID ?? "").trim();
    if (USER_ID_PATTERN.test(fromEnv)) return fromEnv;
    try {
      const result = await run("dws", ["profile", "list", "--format", "json"], {
        cwd: PROJECT_ROOT, env: process.env, timeoutMs: PROFILE_TIMEOUT_MS,
      });
      if (result.code !== 0) return null;
      return profileUserId(parseJson(result.stdout));
    } catch {
      return null;
    }
  };

  let summary: SummaryStatus = { state: "idle", date: null, startedAt: null, finishedAt: null, error: null };
  let summaryLoaded = false;
  /** True while the python digest started by this process is still running. */
  let activeRun = false;

  const runsPath = join(dailyDir, "runs.json");

  const readWarnings = (record: Record<string, unknown>): string[] | undefined => {
    if (!Array.isArray(record.warnings)) return undefined;
    const warnings = record.warnings.filter((item): item is string => typeof item === "string");
    return warnings.length > 0 ? warnings.slice(0, 10) : undefined;
  };

  const markRunStale = async (
    record: Record<string, unknown>,
    startedAt: string | null,
    elapsedMs: number | null,
  ): Promise<SummaryStatus> => {
    const finishedAt = iso();
    // Atomic write-back so a restart cannot inherit the same dead "running" row
    // again. Serialised to avoid two status polls racing on the temp file.
    try {
      await serialise(async () => {
        await mkdir(dailyDir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(runsPath, {
          ...record,
          schemaVersion: 1,
          state: "failed",
          error: "summary_stale",
          finishedAt,
          elapsedMs,
        });
      });
    } catch {
      // The status below is still reported as failed; the next poll retries the
      // write instead of blocking the panel forever.
    }
    return {
      state: "failed",
      date: typeof record.date === "string" ? record.date : null,
      startedAt,
      finishedAt,
      error: "summary_stale",
      modelSource: typeof record.modelSource === "string" ? record.modelSource : null,
      elapsedMs,
      warnings: readWarnings(record),
    };
  };

  const readRunsStatus = async (): Promise<SummaryStatus | undefined> => {
    const raw = await readJson(runsPath);
    const record = asRecord(raw);
    if (!record) return undefined;
    const state = record.state === "running" || record.state === "succeeded" || record.state === "failed"
      ? record.state
      : "idle";
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : null;
    if (state === "running" && !activeRun) {
      // A persisted "running" row from a crashed/killed process would otherwise
      // lock the panel forever: nothing will ever settle it.
      const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
      const stale = !Number.isFinite(started)
        || now() >= started + SUMMARY_TIMEOUT_MS + SUMMARY_STALE_MARGIN_MS;
      if (stale) {
        const elapsedMs = Number.isFinite(started) ? Math.max(0, now() - started) : null;
        return await markRunStale(record, startedAt, elapsedMs);
      }
    }
    return {
      state,
      date: typeof record.date === "string" ? record.date : null,
      startedAt,
      finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
      error: typeof record.error === "string" ? record.error : null,
      modelSource: typeof record.modelSource === "string" ? record.modelSource : null,
      elapsedMs: typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
        ? record.elapsedMs
        : null,
      warnings: readWarnings(record),
    };
  };

  /** Attach the script's own duration/channel labels when they describe this run. */
  const mergeRunDetails = (status: SummaryStatus, disk: SummaryStatus | undefined): SummaryStatus => {
    if (!disk || disk.state !== status.state || disk.date !== status.date) return status;
    return {
      ...status,
      modelSource: disk.modelSource ?? status.modelSource ?? null,
      elapsedMs: disk.elapsedMs ?? status.elapsedMs ?? null,
      warnings: disk.warnings ?? status.warnings,
    };
  };

  const summaryStatus = async (): Promise<SummaryStatus> => {
    // The in-memory run owns the status while this process is actually running
    // it; only then may a "running" row be fresh despite an old timestamp.
    if (activeRun) return summary;
    const disk = await readRunsStatus();
    if (!summaryLoaded || summary.state === "idle") {
      if (disk) summary = disk;
      summaryLoaded = true;
      return summary;
    }
    if (summary.state === "running") {
      // Not active in this process: the disk is the only truth (readRunsStatus
      // already settles stale rows). Without a row there is nothing to wait on.
      summary = disk ?? {
        ...summary,
        state: "failed",
        finishedAt: iso(),
        error: "summary_stale",
      };
      return summary;
    }
    return mergeRunDetails(summary, disk);
  };

  const latestSummaryDate = async (): Promise<string | undefined> => {
    try {
      const names = await readdir(dailyDir);
      const dates = names
        .map((name) => /^summary-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
        .filter((date): date is string => date !== undefined)
        .sort()
        .reverse();
      return dates[0];
    } catch {
      return undefined;
    }
  };

  return {
    createTodo: async (input) => {
      const validation = validateCreate(input);
      if (!validation.ok) return validation;
      const value = validation.value;
      if (inflight.has(value.requestId)) return { ok: false, error: "busy" };

      const existing = (await readWrites())[value.requestId];
      if (existing) return replayWrite(existing);

      const executorId = await resolveExecutorId();
      if (!executorId) {
        await audit({ event: "create_rejected", requestId: value.requestId, error: "user_id_unavailable" });
        return { ok: false, error: "user_id_unavailable" };
      }
      // Profile resolution is an await: another call may have completed the same
      // requestId meanwhile, so re-read the ledger before claiming it.
      const raced = (await readWrites())[value.requestId];
      if (raced) return replayWrite(raced);
      // Check+add is synchronous, so a concurrent call cannot slip through here.
      if (inflight.has(value.requestId)) return { ok: false, error: "busy" };
      inflight.add(value.requestId);
      const started = iso();
      const record: TodoWriteRecord = {
        requestId: value.requestId,
        state: "creating",
        title: value.title,
        dueAt: value.dueAt,
        priority: value.priority,
        taskId: null,
        dryRun: null,
        error: null,
        createdAt: started,
        finishedAt: null,
      };
      try {
        await persist(record);
        await audit({
          event: "create_started",
          requestId: value.requestId,
          title: value.title,
          dueAt: value.dueAt,
          priority: value.priority,
          dryRun: "pending",
        });

        const dry = await run("dws", createTodoCommand(value, executorId, true), {
          cwd: PROJECT_ROOT, env: process.env, timeoutMs: DWS_TIMEOUT_MS,
        });
        const dryPayload = parseJson(dry.stdout);
        const dryOk = dry.code === 0 && dwsSucceeded(dryPayload)
          && dryRunConfirmed(dryPayload, value, executorId);
        await audit({
          event: "dry_run",
          requestId: value.requestId,
          command: ["todo", "+create"],
          flags: ["title", "due", "priority", "executors", "dry-run", "yes", "format"],
          dryRun: dryOk ? "passed" : "failed",
          error: dryOk ? null : dry.code === null ? "dws_missing" : "todo_write_failed",
        });
        if (!dryOk) {
          const error = dry.code === null ? "dws_missing" : "todo_write_failed";
          return await finishFailed({ ...record, dryRun: "failed" }, error);
        }

        const created = await run("dws", createTodoCommand(value, executorId, false), {
          cwd: PROJECT_ROOT, env: process.env, timeoutMs: DWS_TIMEOUT_MS,
        });
        const createdPayload = parseJson(created.stdout);
        const taskId = created.code === 0 && dwsSucceeded(createdPayload)
          ? findTaskId(createdPayload)
          : undefined;
        await audit({
          event: "create",
          requestId: value.requestId,
          command: ["todo", "+create"],
          flags: ["title", "due", "priority", "executors", "yes", "format"],
          taskId: taskId ?? null,
          result: created.code === 0 && dwsSucceeded(createdPayload) ? "accepted" : "failed",
        });
        if (created.code === null) {
          return await finishFailed(record, "dws_missing");
        }
        if (created.code !== 0 || !dwsSucceeded(createdPayload)) {
          return await finishFailed(record, "todo_write_failed");
        }
        if (!taskId) {
          // The todo may exist now; never retry blindly.
          return await finishFailed(record, "todo_verify_failed", { reason: "task_id_missing" });
        }

        const readback = await run("dws", readbackCommand(taskId), {
          cwd: PROJECT_ROOT, env: process.env, timeoutMs: DWS_TIMEOUT_MS,
        });
        const detail = readback.code === 0 ? findDetail(parseJson(readback.stdout)) : undefined;
        const subject = titleText(detail?.subject);
        const dueTime = typeof detail?.dueTime === "number" ? detail.dueTime : null;
        const executorIds = Array.isArray(detail?.executorIds)
          ? detail.executorIds.map(String)
          : [];
        const verified = Boolean(detail)
          && String(detail?.taskId ?? "") === taskId
          && subject === value.title
          && dueTime === Date.parse(value.dueAt)
          && detail?.isDone !== true
          && (executorIds.length === 0 || executorIds.includes(executorId));
        await audit({
          event: "readback",
          requestId: value.requestId,
          command: ["todo", "task", "get"],
          taskId,
          actorField: "executorIds",
          result: verified ? "verified" : "mismatch",
        });
        if (!verified) {
          return await finishFailed({ ...record, taskId }, "todo_verify_failed", { reason: "readback_mismatch" });
        }

        const done: TodoWriteRecord = {
          ...record,
          state: "created",
          dryRun: "passed",
          taskId,
          finishedAt: iso(),
        };
        await persist(done);
        await audit({ event: "create_succeeded", requestId: value.requestId, taskId, result: "created" });
        return { ok: true, record: done, reused: false };
      } finally {
        inflight.delete(value.requestId);
      }
    },

    writes: async () => Object.values(await readWrites())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_WRITES_SHOWN),

    summary: async (date) => {
      const target = date ?? await latestSummaryDate();
      if (!target || !DATE_PATTERN.test(target)) return undefined;
      return asSummary(await readJson(join(dailyDir, `summary-${target}.json`)));
    },

    summaryStatus,

    startSummary: async (date) => {
      const today = localDate(now());
      const target = date ?? today;
      if (!DATE_PATTERN.test(target)) {
        return { ok: false, error: "invalid_date", status: await summaryStatus(), reused: false };
      }
      // Past days are read-only: their artifacts stay readable, but a new run
      // only ever continues from the current watermark.
      if (target !== today) {
        return { ok: false, error: "historical_read_only", status: await summaryStatus(), reused: false };
      }
      // Reconcile the persisted row at the entry point too: a stale "running"
      // from a dead process must be settled before we decide to reuse it.
      if (activeRun) return { ok: true, status: summary, reused: true };
      const disk = await readRunsStatus();
      summary = disk ?? summary;
      summaryLoaded = true;
      if (summary.state === "running") {
        // Fresh row from a run that is still alive (possibly another process).
        return { ok: true, status: summary, reused: true };
      }
      const startedAt = iso();
      const elapsedFrom = (finishedAt: string) =>
        Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) || 0;
      const finishRun = async (state: "succeeded" | "failed", error: string | null) => {
        const finishedAt = iso();
        activeRun = false;
        summary = {
          state,
          date: target,
          startedAt,
          finishedAt,
          error,
          elapsedMs: elapsedFrom(finishedAt),
        };
        summary = mergeRunDetails(summary, await readRunsStatus());
      };
      summary = { state: "running", date: target, startedAt, finishedAt: null, error: null };
      summaryLoaded = true;
      activeRun = true;
      void run("python3", [
        DAILY_SCRIPT,
        "--date", target,
        "--cache-dir", cacheDir,
        "--snapshot", join(cacheDir, "crm-snapshot.json"),
      ], { cwd: PROJECT_ROOT, env: process.env, timeoutMs: SUMMARY_TIMEOUT_MS })
        .then(
          (result) => finishRun(
            result.code === 0 ? "succeeded" : "failed",
            result.code === 0 ? null : result.code === null ? "summary_timeout" : "summary_failed",
          ),
          () => finishRun("failed", "summary_failed"),
        );
      return { ok: true, status: summary, reused: false };
    },

    dailyMessages: async (date, chatId) => {
      if (!DATE_PATTERN.test(date) || !CHAT_ID_PATTERN.test(chatId)) return undefined;
      const digest = createHash("sha256").update(chatId, "utf-8").digest("hex").slice(0, 24);
      const raw = asRecord(await readJson(join(dailyDir, "raw", date, `chat_${digest}.json`)));
      if (!raw || !Array.isArray(raw.messages)) return undefined;
      const messages: DailyMessage[] = [];
      for (const item of raw.messages) {
        const record = asRecord(item);
        if (!record || typeof record.messageId !== "string") continue;
        messages.push({
          messageId: record.messageId,
          sender: typeof record.sender === "string" ? record.sender : "",
          text: typeof record.text === "string" ? record.text : "",
          time: typeof record.time === "string" ? record.time : "",
        });
      }
      return { date, chatId, complete: raw.complete === true, messages };
    },
  };
}
