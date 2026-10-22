import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import {
  CID_PATTERN,
  customerName,
  parseAnswerMessageId,
  parseFinalAnswer,
  type CommandRunner,
} from "./crm-bridge.ts";

/**
 * Local-only bridge for GAAP product attribution (工单 #10074 R2.2): asks the
 * configured FBI report (via the local fbi-skill scripts) one fixed, whitelisted
 * per-customer question and parses the answer into a small JSON artifact (0600)
 * under .local-cache/crm-attribution/. Question text is never taken from the
 * browser and credentials never leave the child processes.
 *
 * 按需触发 + 复用：done 记录在未强制刷新时直接复用（展示数据日期与生成时间）；
 * 重新分析（force）才再次发起 FBI 会话。数据不足（无产品行）如实落 reason，不编造行。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const WORKSPACE_ROOT = resolvePath(PROJECT_ROOT, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const ATTRIBUTION_DIR = join(CACHE_DIR, "crm-attribution");
const SNAPSHOT_PATH = join(CACHE_DIR, "crm-snapshot.json");
const FBI_SCRIPTS = join(homedir(), ".qwenworkcn", "skills", "fbi-skill", "scripts");

const FBI_CREATE_TIMEOUT_MS = 2 * 60_000;
const FBI_POLL_TIMEOUT_MS = 31 * 60_000;
const FBI_ONESHOT_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_ATTRIBUTIONS = 2;
const RESOURCE_ID_PATTERN = /^\d{1,32}$/;
const REPORT_URL_PATTERN = /^https:\/\/fbi\.alibaba-inc\.com\/[^\s"'<>\\]{1,400}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 固定问题模板：本桥向 FBI 报表提出的唯一形态的问题（按客户代入）。 */
export function attributionQuestion(name: string, cid: string): string {
  return [
    `请查询报表中客户「${name}」（CID ${cid}）最近两个有数据日期、按一级产品和二级产品拆分的日 GAAP。`,
    "只输出一个 JSON 对象，不要输出其他任何文字：",
    '{"currentDate":"YYYY-MM-DD","previousDate":"YYYY-MM-DD或null","rows":[{"level1":"一级产品","level2":"二级产品或null","current":数值或null,"previous":数值或null}]}。',
    "current/previous 分别是该产品在 currentDate/previousDate 的日 GAAP（元），取不到填 null；无二级产品时 level2 填 null；报表中无该客户数据时 rows 填 []。",
  ].join("");
}

export interface AttributionRow {
  readonly level1: string;
  readonly level2: string | null;
  readonly current: number | null;
  readonly previous: number | null;
}

export interface AttributionRecord {
  readonly schemaVersion: 1;
  readonly cid: string;
  readonly state: "running" | "done" | "failed";
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly answerMessageId: string | null;
  readonly reportResourceId: string;
  /** 报表数据日（当日）与前一日；done 且有行时必有。 */
  readonly currentDate: string | null;
  readonly previousDate: string | null;
  readonly rows: readonly AttributionRow[];
  /** done 且 rows 为空时的具体原因（数据不足口径明示）；其余为 null。 */
  readonly reason: string | null;
  /** 解析时无法通过校验被丢弃的行数（明示，不静默丢）。 */
  readonly droppedRows: number;
  readonly error: string | null;
}

export type AttributionStartResult =
  | { readonly ok: true; readonly record: AttributionRecord; readonly reused: boolean }
  | { readonly ok: false; readonly error: "invalid_cid" | "customer_not_found" | "busy" | "not_configured" };

export interface CrmAttributionBridge {
  readonly attribution: (cid: string) => Promise<AttributionRecord | undefined>;
  readonly start: (cid: string, force?: boolean) => Promise<AttributionStartResult>;
}

export interface CrmAttributionBridgeOptions {
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

function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return cleaned || null;
}

export interface ParsedAttributionAnswer {
  readonly currentDate: string | null;
  readonly previousDate: string | null;
  readonly rows: readonly AttributionRow[];
  readonly droppedRows: number;
}

/** Extract the fixed-schema JSON object out of an FBI finalAnswer string. */
export function parseAttributionAnswer(answer: string): ParsedAttributionAnswer | undefined {
  const first = answer.indexOf("{");
  const last = answer.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answer.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const currentDate = typeof parsed.currentDate === "string" && DATE_PATTERN.test(parsed.currentDate)
    ? parsed.currentDate
    : null;
  const previousDate = typeof parsed.previousDate === "string" && DATE_PATTERN.test(parsed.previousDate)
    ? parsed.previousDate
    : null;
  // currentDate 是表头数据日，必须有效（有行无日期或空行无日期都无法诚实展示）。
  if (currentDate === null) return undefined;
  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows: AttributionRow[] = [];
  let droppedRows = 0;
  for (const item of rawRows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      droppedRows += 1;
      continue;
    }
    const row = item as Record<string, unknown>;
    const level1 = cleanName(row.level1, 80);
    if (!level1) {
      droppedRows += 1;
      continue;
    }
    const level2 = cleanName(row.level2, 80);
    rows.push({ level1, level2, current: asNumberOrNull(row.current), previous: asNumberOrNull(row.previous) });
  }
  return { currentDate, previousDate, rows, droppedRows };
}

function asAttributionRecord(raw: unknown, cid: string): AttributionRecord | undefined {
  const record = raw as Partial<AttributionRecord> | undefined;
  if (!record || record.cid !== cid || record.schemaVersion !== 1 || typeof record.createdAt !== "string") {
    return undefined;
  }
  if (record.state !== "running" && record.state !== "done" && record.state !== "failed") return undefined;
  if (!Array.isArray(record.rows)) return undefined;
  return record as AttributionRecord;
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

export function createCrmAttributionBridge(options: CrmAttributionBridgeOptions = {}): CrmAttributionBridge {
  const attributionDir = options.cacheDir ? join(options.cacheDir, "crm-attribution") : ATTRIBUTION_DIR;
  const snapshotPath = options.cacheDir ? join(options.cacheDir, "crm-snapshot.json") : SNAPSHOT_PATH;
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const iso = () => new Date(now()).toISOString();
  const fbiEnv = { ...process.env, PWD: WORKSPACE_ROOT };
  const polling = new Map<string, Promise<void>>();

  const recordPath = (cid: string) => join(attributionDir, `${cid}.json`);
  const readRecord = async (cid: string) => asAttributionRecord(await readJson(recordPath(cid)), cid);
  const saveRecord = async (record: AttributionRecord) => {
    await mkdir(attributionDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(recordPath(record.cid), record);
    return record;
  };

  const failedRecord = (
    base: AttributionRecord,
    error: string,
  ): AttributionRecord => ({
    ...base,
    state: "failed",
    finishedAt: iso(),
    error,
  });

  const poll = (record: AttributionRecord): void => {
    if (polling.has(record.cid) || !record.answerMessageId) return;
    const task = run("python3", [join(FBI_SCRIPTS, "query_chat_result.py"), record.answerMessageId, "5"], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_POLL_TIMEOUT_MS,
    })
      .then(async (result) => {
        const answer = result.code === 0 ? parseFinalAnswer(result.stdout) : undefined;
        const parsed = answer ? parseAttributionAnswer(answer) : undefined;
        if (!parsed) {
          await saveRecord(failedRecord(record, "fbi_parse_failed"));
          return;
        }
        await saveRecord({
          ...record,
          state: "done",
          finishedAt: iso(),
          currentDate: parsed.currentDate,
          previousDate: parsed.previousDate,
          rows: parsed.rows,
          reason: parsed.rows.length === 0 ? "no_rows" : null,
          droppedRows: parsed.droppedRows,
          error: null,
        });
      })
      .catch(async () => {
        await saveRecord(failedRecord(record, "fbi_poll_failed")).catch(() => undefined);
      })
      .finally(() => polling.delete(record.cid));
    polling.set(record.cid, task);
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

  const start = async (cid: string, force = false): Promise<AttributionStartResult> => {
    if (!CID_PATTERN.test(cid)) return { ok: false, error: "invalid_cid" };
    if (polling.has(cid)) return { ok: false, error: "busy" };
    const existing = await readRecord(cid);
    if (!force && existing?.state === "done") return { ok: true, record: existing, reused: true };
    if (polling.size >= MAX_CONCURRENT_ATTRIBUTIONS) return { ok: false, error: "busy" };
    const name = customerName(await readJson(snapshotPath), cid);
    if (!name) return { ok: false, error: "customer_not_found" };
    const resourceId = await resolveResourceId();
    if (!resourceId) return { ok: false, error: "not_configured" };

    const startedAt = iso();
    const pending: AttributionRecord = {
      schemaVersion: 1,
      cid,
      state: "running",
      createdAt: startedAt,
      finishedAt: null,
      answerMessageId: null,
      reportResourceId: resourceId,
      currentDate: null,
      previousDate: null,
      rows: [],
      reason: null,
      droppedRows: 0,
      error: null,
    };
    const created = await run("python3", [
      join(FBI_SCRIPTS, "create_chat.py"),
      attributionQuestion(name, cid),
      JSON.stringify({ resourceId, resourceType: "report" }),
    ], {
      cwd: WORKSPACE_ROOT,
      env: fbiEnv,
      timeoutMs: FBI_CREATE_TIMEOUT_MS,
    }).catch(() => ({ code: null, stdout: "" }));
    const answerMessageId = parseAnswerMessageId(created.stdout);
    if (!answerMessageId) {
      return { ok: true, record: await saveRecord(failedRecord(pending, "fbi_create_failed")), reused: false };
    }
    const record = await saveRecord({ ...pending, answerMessageId });
    poll(record);
    return { ok: true, record, reused: false };
  };

  return {
    attribution: async (cid) => {
      if (!CID_PATTERN.test(cid)) return undefined;
      const record = await readRecord(cid);
      if (record?.state === "running") poll(record);
      return record;
    },
    start,
  };
}
