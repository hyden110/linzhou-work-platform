import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import type { CommandRunner } from "./crm-bridge.ts";

/**
 * Local-only bridge for the PPL inspection panel (plan: docs/ppl-inspection-plan.md).
 *
 * 铁律：本桥只读巡检产物 + 写本地 approvals.json；创建执行永远留给 agent 会话调
 * 鲲鹏创建 skill（双闸门之二）。这里不存在任何创建调用。
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const CACHE_DIR = join(PROJECT_ROOT, ".local-cache");
const INSPECTION_DIR = join(CACHE_DIR, "ppl-inspection");
const INSPECTION_SCRIPT = join(PROJECT_ROOT, "sync", "ppl_daily_report.py");

const REFRESH_TIMEOUT_MS = 5 * 60_000;
const DECISION_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

export type PplDecisionAction = "approve" | "discard";

export type PplDecision = {
  readonly id: string;
  readonly recommendationId: string;
  readonly action: PplDecisionAction;
  readonly decidedAt: string;
  readonly note: string | null;
  /** 推荐指纹（返工 #2）：CID+建议项目名+金额；读取时指纹不符视为新待处理，不复用旧同意。 */
  readonly fingerprint: string | null;
};

export type PplApprovalState =
  | "pending"
  | "approved"
  | "discarded"
  | "creating"
  | "created"
  | "failed";

export interface PplRecommendation {
  readonly id: string;
  /** 内容派生稳定 ID（返回工 #2）：CID+报告日期+建议项目名哈希前缀。 */
  readonly fingerprint: string | null;
  readonly customerName: string;
  readonly cid: string | null;
  readonly suggestedProjectName: string;
  readonly opportunityType: string;
  readonly amountYuan: number | null;
  readonly blocked: boolean;
  readonly blockReason: string | null;
  readonly dedupe: {
    readonly status: "exists" | "suspected" | "new";
    readonly evidence: unknown;
  };
  readonly changeNote: string | null;
  readonly state: PplApprovalState | string;
}

export interface PplInspection {
  readonly schemaVersion: 1;
  readonly state: "ok" | "failed" | string;
  readonly generatedAt: string;
  readonly snapshotGeneratedAt: string | null;
  readonly snapshotStale: boolean;
  readonly reportCount: number;
  readonly recommendations: readonly PplRecommendation[];
  readonly summary: Record<string, number>;
  readonly error: string | null;
}

export type PplDecisionResult =
  | { readonly ok: true; readonly decision: PplDecision; readonly state: PplApprovalState }
  | { readonly ok: false; readonly error: "invalid_request" | "not_found" | "already_decided" | "blocked_recommendation" };

export type PplRefreshStatus =
  | { readonly state: "idle" }
  | { readonly state: "running"; readonly startedAt: string }
  | { readonly state: "succeeded" | "failed"; readonly startedAt: string; readonly finishedAt: string; readonly error: string | null };

export interface PplInspectionBridge {
  readonly inspection: () => Promise<PplInspection | undefined>;
  readonly decisions: () => Promise<readonly PplDecision[]>;
  readonly refreshStatus: () => PplRefreshStatus;
  readonly startRefresh: () => PplRefreshStatus;
  readonly decide: (recommendationId: string, action: PplDecisionAction, note?: string) => Promise<PplDecisionResult>;
}

export interface PplInspectionBridgeOptions {
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

function asRecommendation(raw: unknown): PplRecommendation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.customerName !== "string") return undefined;
  const dedupe = record.dedupe && typeof record.dedupe === "object" && !Array.isArray(record.dedupe)
    ? record.dedupe as PplRecommendation["dedupe"]
    : { status: "suspected", evidence: null };
  return {
    id: record.id,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : null,
    customerName: record.customerName,
    cid: typeof record.cid === "string" ? record.cid : null,
    suggestedProjectName: typeof record.suggestedProjectName === "string" ? record.suggestedProjectName : "",
    opportunityType: typeof record.opportunityType === "string" ? record.opportunityType : "",
    amountYuan: typeof record.amountYuan === "number" ? record.amountYuan : null,
    blocked: record.blocked === true,
    blockReason: typeof record.blockReason === "string" ? record.blockReason : null,
    dedupe,
    changeNote: typeof record.changeNote === "string" ? record.changeNote : null,
    state: typeof record.state === "string" ? record.state : "pending",
  };
}

function asInspection(raw: unknown): PplInspection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (typeof record.generatedAt !== "string") return undefined;
  return {
    schemaVersion: 1,
    state: typeof record.state === "string" ? record.state : "ok",
    generatedAt: record.generatedAt,
    snapshotGeneratedAt: typeof record.snapshotGeneratedAt === "string" ? record.snapshotGeneratedAt : null,
    snapshotStale: record.snapshotStale === true,
    reportCount: typeof record.reportCount === "number" ? record.reportCount : 0,
    recommendations: Array.isArray(record.recommendations)
      ? record.recommendations
        .map(asRecommendation)
        .filter((item): item is PplRecommendation => item !== undefined)
      : [],
    summary: (record.summary && typeof record.summary === "object" && !Array.isArray(record.summary))
      ? record.summary as Record<string, number>
      : {},
    error: typeof record.error === "string" ? record.error : null,
  };
}

function asDecisions(raw: unknown): PplDecision[] {
  if (!Array.isArray(raw)) return [];
  const decisions: PplDecision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.recommendationId !== "string") continue;
    if (record.action !== "approve" && record.action !== "discard") continue;
    decisions.push({
      id: typeof record.id === "string" ? record.id : "",
      recommendationId: record.recommendationId,
      action: record.action,
      decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : "",
      note: typeof record.note === "string" ? record.note : null,
      fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : null,
    });
  }
  return decisions;
}

/** 状态机投影：最新决策覆盖推荐初始 state（pending→approved/discarded）。
 * 指纹防错套（返工 #2）：指纹不匹配的旧决策不复用 → 视为新待处理条目。 */
export function projectState(
  recommendationState: string | undefined,
  decisions: readonly PplDecision[],
  recommendationId: string,
  recommendationFingerprint?: string | null,
): PplApprovalState | string {
  const matching = decisions.filter(
    (decision) => decision.recommendationId === recommendationId
      && decision.fingerprint != null
      && decision.fingerprint === (recommendationFingerprint ?? null),
  );
  const decided = matching[matching.length - 1];
  if (decided) return decided.action === "approve" ? "approved" : "discarded";
  const raw = recommendationState ?? "pending";
  return ["pending", "approved", "discarded", "creating", "created", "failed"].includes(raw)
    ? (raw as PplApprovalState)
    : "pending";
}

export function createPplInspectionBridge(options: PplInspectionBridgeOptions = {}): PplInspectionBridge {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const inspectionDir = join(cacheDir, "ppl-inspection");
  const approvalsPath = join(inspectionDir, "approvals.json");
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  let refresh: PplRefreshStatus = { state: "idle" };

  const readDecisions = async () => asDecisions(
    (await readJson(approvalsPath) as { decisions?: unknown } | undefined)?.decisions,
  );
  const saveDecisions = async (decisions: readonly PplDecision[]) => {
    await mkdir(inspectionDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(approvalsPath, { schemaVersion: 1, decisions });
  };

  return {
    inspection: async () => asInspection(await readJson(join(inspectionDir, "latest.json"))),

    decisions: readDecisions,

    refreshStatus: () => refresh,

    startRefresh: () => {
      if (refresh.state === "running") return refresh;
      const startedAt = iso();
      refresh = { state: "running", startedAt };
      run("python3", [INSPECTION_SCRIPT], {
        cwd: PROJECT_ROOT,
        env: process.env,
        timeoutMs: REFRESH_TIMEOUT_MS,
      })
        .then((result) => {
          refresh = result.code === 0
            ? { state: "succeeded", startedAt, finishedAt: iso(), error: null }
            : { state: "failed", startedAt, finishedAt: iso(), error: result.code === null ? "inspection_timeout" : "inspection_failed" };
        })
        .catch(() => {
          refresh = { state: "failed", startedAt, finishedAt: iso(), error: "inspection_failed" };
        });
      return refresh;
    },

    decide: async (recommendationId, action, note) => {
      if (!DECISION_PATTERN.test(recommendationId) || (action !== "approve" && action !== "discard")) {
        return { ok: false, error: "invalid_request" };
      }
      if (note !== undefined && (typeof note !== "string" || note.length > 200)) {
        return { ok: false, error: "invalid_request" };
      }
      const inspection = asInspection(await readJson(join(inspectionDir, "latest.json")));
      const target = inspection?.recommendations.find((item) => item.id === recommendationId);
      if (!inspection || !target) return { ok: false, error: "not_found" };
      const decisions = await readDecisions();
      // 指纹防错套（返工 #2）：同 id 但指纹变化（新巡检产物）→ 旧决策不复用，可重新决策。
      const targetFingerprint = target.fingerprint ?? null;
      const existing = decisions.find(
        (decision) => decision.recommendationId === recommendationId
          && decision.fingerprint != null
          && decision.fingerprint === targetFingerprint,
      );
      if (existing) return { ok: false, error: "already_decided" };
      // plan §6：金额缺失（blocked）的推荐不能进入同意——绝不猜金额。
      if (action === "approve" && target.blocked) return { ok: false, error: "blocked_recommendation" };
      const decision: PplDecision = {
        id: `d${decisions.length + 1}`,
        recommendationId,
        action,
        decidedAt: iso(),
        note: note ?? null,
        fingerprint: targetFingerprint,
      };
      await saveDecisions([...decisions, decision]);
      return { ok: true, decision, state: action === "approve" ? "approved" : "discarded" };
    },
  };
}
