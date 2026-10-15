import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/**
 * Local-only bridge between the workbench and the CRM snapshot / FBI scripts.
 * Credentials stay inside the child processes; only projected fields reach the browser.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const WORKSPACE_ROOT = resolvePath(PROJECT_ROOT, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const FBI_SCRIPTS = join(homedir(), ".qwenworkcn", "skills", "fbi-skill", "scripts");

const REFRESH_TIMEOUT_MS = 10 * 60_000;
const FBI_CREATE_TIMEOUT_MS = 2 * 60_000;
const FBI_POLL_TIMEOUT_MS = 31 * 60_000;
const INSIGHT_REUSE_MS = 24 * 60 * 60_000;
const MAX_ANSWER_CHARS = 4000;
const MAX_CONCURRENT_INSIGHTS = 2;
const FINAL_MARKER = "========== 最终结果 ==========";
const CID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID_PATTERN = /answerMessageId:\s*([A-Za-z0-9_-]{8,128})/;
const SNAPSHOT_SECTIONS = ["agenda", "todos", "customers", "projects"] as const;

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<CommandResult>;

export interface RefreshStatus {
  readonly state: "idle" | "running" | "succeeded" | "failed";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface InsightRecord {
  readonly cid: string;
  readonly customerName: string;
  readonly answerMessageId: string | null;
  readonly state: "running" | "done" | "failed";
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly answer: string | null;
  readonly error: string | null;
}

export type InsightStartResult =
  | { readonly ok: true; readonly record: InsightRecord; readonly reused: boolean }
  | { readonly ok: false; readonly error: "invalid_cid" | "customer_not_found" | "busy" };

export interface CrmBridge {
  readonly snapshot: () => Promise<unknown | undefined>;
  readonly refreshStatus: () => RefreshStatus;
  readonly startRefresh: () => RefreshStatus;
  readonly insight: (cid: string) => Promise<InsightRecord | undefined>;
  readonly startInsight: (cid: string) => Promise<InsightStartResult>;
}

export interface CrmBridgeOptions {
  readonly cacheDir?: string;
  readonly run?: CommandRunner;
  readonly now?: () => number;
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

function projectSnapshot(raw: unknown): unknown | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  const sections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((key) => [key, Array.isArray(record[key]) ? record[key] : []]),
  );
  return { schemaVersion: 1, generatedAt: record.generatedAt ?? null, sources: record.sources ?? {}, ...sections };
}

function customerName(snapshot: unknown, cid: string): string | undefined {
  const customers = (snapshot as { customers?: unknown[] } | undefined)?.customers ?? [];
  const match = customers.find((item) => (item as { cid?: unknown })?.cid === cid) as { name?: unknown } | undefined;
  if (typeof match?.name !== "string") return undefined;
  const cleaned = match.name.replace(/[\u0000-\u001f\u007f「」]/g, "").trim().slice(0, 80);
  return cleaned || undefined;
}

export function insightQuestion(name: string, cid: string): string {
  return `请分析客户「${name}」（CID ${cid}）近期的消耗异动，说明主要变化、可能原因和需要关注的风险点。`;
}

export function parseAnswerMessageId(stdout: string): string | undefined {
  return MESSAGE_ID_PATTERN.exec(stdout)?.[1];
}

export function parseFinalAnswer(stdout: string): string | undefined {
  const index = stdout.lastIndexOf(FINAL_MARKER);
  if (index < 0) return undefined;
  try {
    const result = JSON.parse(stdout.slice(index + FINAL_MARKER.length)) as Record<string, unknown>;
    const answer = typeof result.finalAnswer === "string" ? result.finalAnswer.trim() : "";
    if (answer) return answer.slice(0, MAX_ANSWER_CHARS);
    return result.finalize ? "FBI 已生成报告，请在 FBI 中查看完整内容。" : undefined;
  } catch {
    return undefined;
  }
}

function isFresh(record: InsightRecord, now: number): boolean {
  return record.state !== "failed" && now - Date.parse(record.createdAt) < INSIGHT_REUSE_MS;
}

function asInsightRecord(raw: unknown, cid: string): InsightRecord | undefined {
  const record = raw as Partial<InsightRecord> | undefined;
  if (!record || record.cid !== cid || typeof record.createdAt !== "string") return undefined;
  if (record.state !== "running" && record.state !== "done" && record.state !== "failed") return undefined;
  return record as InsightRecord;
}

export function createCrmBridge(options: CrmBridgeOptions = {}): CrmBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const insightDir = join(cacheDir, "fbi-insights");
  const snapshotPath = join(cacheDir, "crm-snapshot.json");
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const fbiEnv = { ...process.env, PWD: WORKSPACE_ROOT };
  const polling = new Map<string, Promise<void>>();
  let refresh: RefreshStatus = { state: "idle", startedAt: null, finishedAt: null, error: null };

  const insightPath = (cid: string) => join(insightDir, `${cid}.json`);
  const readInsight = async (cid: string) => asInsightRecord(await readJson(insightPath(cid)), cid);
  const saveInsight = async (record: InsightRecord) => {
    await mkdir(insightDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(insightPath(record.cid), record);
    return record;
  };

  const finishInsight = (record: InsightRecord, answer: string | undefined, error: string | null) =>
    saveInsight({
      ...record,
      state: answer ? "done" : "failed",
      answer: answer ?? null,
      error: answer ? null : error ?? "fbi_no_answer",
      finishedAt: iso(),
    });

  const poll = (record: InsightRecord): void => {
    if (polling.has(record.cid) || !record.answerMessageId) return;
    const task = run("python3", [join(FBI_SCRIPTS, "query_chat_result.py"), record.answerMessageId, "5"], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_POLL_TIMEOUT_MS,
    })
      .then((result) => finishInsight(record, parseFinalAnswer(result.stdout), result.code === 0 ? null : "fbi_query_failed"))
      .then(() => undefined)
      .catch(() => {
        console.error(JSON.stringify({ event: "fbi_insight_poll_failed", cid: record.cid }));
      })
      .finally(() => polling.delete(record.cid));
    polling.set(record.cid, task);
  };

  return {
    snapshot: async () => projectSnapshot(await readJson(snapshotPath)),

    refreshStatus: () => refresh,

    startRefresh: () => {
      if (refresh.state === "running") return refresh;
      refresh = { state: "running", startedAt: iso(), finishedAt: null, error: null };
      run("python3", [join(PROJECT_ROOT, "sync", "crm_snapshot.py")], {
        cwd: PROJECT_ROOT,
        env: process.env,
        timeoutMs: REFRESH_TIMEOUT_MS,
      })
        .then((result) => {
          refresh = result.code === 0
            ? { ...refresh, state: "succeeded", finishedAt: iso() }
            : { ...refresh, state: "failed", finishedAt: iso(), error: result.code === null ? "refresh_timeout" : "all_sources_failed" };
        })
        .catch(() => {
          refresh = { ...refresh, state: "failed", finishedAt: iso(), error: "refresh_failed" };
        });
      return refresh;
    },

    insight: async (cid) => {
      if (!CID_PATTERN.test(cid)) return undefined;
      const record = await readInsight(cid);
      if (record?.state === "running") poll(record);
      return record;
    },

    startInsight: async (cid) => {
      if (!CID_PATTERN.test(cid)) return { ok: false, error: "invalid_cid" };
      const existing = await readInsight(cid);
      if (existing && isFresh(existing, now())) {
        if (existing.state === "running") poll(existing);
        return { ok: true, record: existing, reused: true };
      }
      if (polling.size >= MAX_CONCURRENT_INSIGHTS) return { ok: false, error: "busy" };
      const name = customerName(await readJson(snapshotPath), cid);
      if (!name) return { ok: false, error: "customer_not_found" };

      const pending: InsightRecord = {
        cid,
        customerName: name,
        answerMessageId: null,
        state: "running",
        createdAt: iso(),
        finishedAt: null,
        answer: null,
        error: null,
      };
      const created = await run("python3", [join(FBI_SCRIPTS, "create_chat.py"), insightQuestion(name, cid)], {
        cwd: WORKSPACE_ROOT,
        env: fbiEnv,
        timeoutMs: FBI_CREATE_TIMEOUT_MS,
      }).catch(() => ({ code: null, stdout: "" }));
      const answerMessageId = parseAnswerMessageId(created.stdout);
      if (!answerMessageId) {
        return { ok: true, reused: false, record: await finishInsight(pending, undefined, "fbi_create_failed") };
      }
      const record = await saveInsight({ ...pending, answerMessageId });
      poll(record);
      return { ok: true, record, reused: false };
    },
  };
}
