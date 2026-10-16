import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { parseFinalAnswer, type CommandRunner } from "./crm-bridge.ts";

/**
 * Local-only bridge for the cockpit FBI metric cards. The workbench asks the
 * configured FBI report (via the local fbi-skill scripts) one fixed, whitelisted
 * question per refresh; the answer is parsed into a small JSON artifact (0600)
 * that the cockpit renders. Question text is never taken from the browser and
 * credentials never leave the child processes.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const WORKSPACE_ROOT = resolvePath(PROJECT_ROOT, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const FBI_SCRIPTS = join(homedir(), ".qwenworkcn", "skills", "fbi-skill", "scripts");

const FBI_CREATE_TIMEOUT_MS = 2 * 60_000;
const FBI_POLL_TIMEOUT_MS = 31 * 60_000;
const FBI_ONESHOT_TIMEOUT_MS = 60_000;
const MAX_METRICS_AGE_MS = 24 * 60 * 60_000;
const RESOURCE_ID_PATTERN = /^\d{1,32}$/;
const REPORT_URL_PATTERN = /^https:\/\/fbi\.alibaba-inc\.com\/[^\s"'<>\\]{1,400}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Fixed question template: the only question this bridge will ever ask FBI. */
export const FBI_METRICS_QUESTION = [
  "请查询这张报表中日数据最新一天（或最新有数据的一天）的核心指标数值。",
  "只输出一个 JSON 对象，不要输出其他任何文字：",
  '{"date":"YYYY-MM-DD","dailyGaap":数值,"validCustomers":数值,"callVolume":数值,"moMRate":数值或null}。',
  "其中 dailyGaap=日GAAP（元），validCustomers=有效客户数，callVolume=当日调用量，moMRate=日GAAP环比昨日比例。数值无法取得时填 null。",
].join("");

export interface FbiMetrics {
  readonly schemaVersion: 1;
  readonly state: "running" | "done" | "failed";
  readonly generatedAt: string;
  readonly reportResourceId: string;
  readonly date: string | null;
  readonly dailyGaap: number | null;
  readonly validCustomers: number | null;
  readonly callVolume: number | null;
  readonly moMRate: number | null;
  readonly error: string | null;
}

export type FbiMetricsStatus =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly startedAt: string }
  | { readonly state: "succeeded" | "failed"; readonly startedAt: string; readonly finishedAt: string; readonly error: string | null };

export type FbiMetricsStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "not_configured" | "busy" };

export interface FbiMetricsBridge {
  readonly metrics: () => Promise<FbiMetrics | null>;
  readonly status: () => FbiMetricsStatus;
  /** True when there is no usable artifact and a refresh is worthwhile. */
  readonly needsRefresh: () => Promise<boolean>;
  readonly start: () => Promise<FbiMetricsStartResult>;
}

export interface FbiMetricsBridgeOptions {
  readonly cacheDir?: string;
  readonly run?: CommandRunner;
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
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

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract the fixed-schema JSON object out of an FBI finalAnswer string. */
export function parseMetricsAnswer(answer: string): Partial<FbiMetrics> | undefined {
  const first = answer.indexOf("{");
  const last = answer.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answer.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const date = typeof parsed.date === "string" && DATE_PATTERN.test(parsed.date) ? parsed.date : null;
  if (!date) return undefined;
  return {
    date,
    dailyGaap: asNumberOrNull(parsed.dailyGaap),
    validCustomers: asNumberOrNull(parsed.validCustomers),
    callVolume: asNumberOrNull(parsed.callVolume),
    moMRate: asNumberOrNull(parsed.moMRate),
  };
}

function asMetrics(raw: unknown): FbiMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const state = record.state;
  if (state !== "running" && state !== "done" && state !== "failed") return null;
  const date = typeof record.date === "string" && DATE_PATTERN.test(record.date) ? record.date : null;
  return {
    schemaVersion: 1,
    state,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
    reportResourceId: typeof record.reportResourceId === "string" ? record.reportResourceId : "",
    date,
    dailyGaap: asNumberOrNull(record.dailyGaap),
    validCustomers: asNumberOrNull(record.validCustomers),
    callVolume: asNumberOrNull(record.callVolume),
    moMRate: asNumberOrNull(record.moMRate),
    error: typeof record.error === "string" ? record.error : null,
  };
}

const defaultFbiRunner: CommandRunner = (file, args, options) =>
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

export function createFbiMetricsBridge(options: FbiMetricsBridgeOptions = {}): FbiMetricsBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const metricsPath = join(cacheDir, "fbi-metrics.json");
  const run = options.run ?? defaultFbiRunner;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const iso = () => new Date(now()).toISOString();
  const fbiEnv = { ...process.env, PWD: WORKSPACE_ROOT };
  let status: FbiMetricsStatus = { state: "idle" };

  const readMetrics = async () => asMetrics(await readJson(metricsPath));

  const saveMetrics = async (record: FbiMetrics) => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(metricsPath, record);
    return record;
  };

  /** Resolve the report resource id from env: direct id or (fallback) a URL to parse. */
  const resolveResourceId = async (): Promise<string | null> => {
    const direct = (env.FBI_REPORT_RESOURCE_ID ?? "").trim();
    if (RESOURCE_ID_PATTERN.test(direct)) return direct;
    const url = (env.FBI_REPORT_URL ?? "").trim();
    if (!REPORT_URL_PATTERN.test(url)) return null;
    const result = await run("python3", [join(FBI_SCRIPTS, "search_report.py"), url], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_ONESHOT_TIMEOUT_MS,
    }).catch(() => ({ code: null, stdout: "" }));
    if (result.code !== 0) return null;
    const match = /"resource_id"\s*:\s*"(\d{1,32})"/.exec(result.stdout);
    return match?.[1] ?? null;
  };

  const start = async (): Promise<FbiMetricsStartResult> => {
    if (status.state === "running") return { ok: false, error: "busy" };
    const resourceId = await resolveResourceId();
    if (!resourceId) {
      status = { state: "failed", startedAt: iso(), finishedAt: iso(), error: "not_configured" };
      return { ok: false, error: "not_configured" };
    }
    const startedAt = iso();
    status = { state: "running", startedAt };
    await saveMetrics({
      schemaVersion: 1,
      state: "running",
      generatedAt: startedAt,
      reportResourceId: resourceId,
      date: null,
      dailyGaap: null,
      validCustomers: null,
      callVolume: null,
      moMRate: null,
      error: null,
    });

    const created = await run("python3", [
      join(FBI_SCRIPTS, "create_chat.py"),
      FBI_METRICS_QUESTION,
      JSON.stringify({ resourceId, resourceType: "report" }),
    ], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_CREATE_TIMEOUT_MS,
    }).catch(() => ({ code: null, stdout: "" }));
    const answerMessageId = /answerMessageId:\s*([A-Za-z0-9_-]{8,128})/.exec(created.stdout)?.[1];
    if (!answerMessageId) {
      await saveMetrics({
        schemaVersion: 1, state: "failed", generatedAt: startedAt, reportResourceId: resourceId,
        date: null, dailyGaap: null, validCustomers: null, callVolume: null, moMRate: null, error: "fbi_create_failed",
      });
      status = { state: "failed", startedAt, finishedAt: iso(), error: "fbi_create_failed" };
      return { ok: true };
    }

    void run("python3", [join(FBI_SCRIPTS, "query_chat_result.py"), answerMessageId, "5"], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_POLL_TIMEOUT_MS,
    })
      .then(async (result) => {
        const answer = result.code === 0 ? parseFinalAnswer(result.stdout) : undefined;
        const parsed = answer ? parseMetricsAnswer(answer) : undefined;
        if (!parsed?.date) {
          await saveMetrics({
            schemaVersion: 1, state: "failed", generatedAt: startedAt, reportResourceId: resourceId,
            date: null, dailyGaap: null, validCustomers: null, callVolume: null, moMRate: null, error: "fbi_parse_failed",
          });
          status = { state: "failed", startedAt, finishedAt: iso(), error: "fbi_parse_failed" };
          return;
        }
        await saveMetrics({
          schemaVersion: 1,
          state: "done",
          generatedAt: startedAt,
          reportResourceId: resourceId,
          date: parsed.date,
          dailyGaap: parsed.dailyGaap ?? null,
          validCustomers: parsed.validCustomers ?? null,
          callVolume: parsed.callVolume ?? null,
          moMRate: parsed.moMRate ?? null,
          error: null,
        });
        status = { state: "succeeded", startedAt, finishedAt: iso(), error: null };
      })
      .catch(async () => {
        await saveMetrics({
          schemaVersion: 1, state: "failed", generatedAt: startedAt, reportResourceId: resourceId,
          date: null, dailyGaap: null, validCustomers: null, callVolume: null, moMRate: null, error: "fbi_poll_failed",
        }).catch(() => undefined);
        status = { state: "failed", startedAt, finishedAt: iso(), error: "fbi_poll_failed" };
      });
    return { ok: true };
  };

  return {
    metrics: readMetrics,
    status: () => status,
    needsRefresh: async () => {
      const record = await readMetrics();
      if (!record) return true;
      if (record.state !== "done") return true;
      return now() - Date.parse(record.generatedAt) > MAX_METRICS_AGE_MS;
    },
    start,
  };
}
