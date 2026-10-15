import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseSolutionPlan,
  type SolutionDegradeCode,
  type SolutionEngine,
  type SolutionPlan,
} from "../src/lib/assistant-contract.ts";
import type { SolutionRetrievalStatus } from "./solution-assistant.ts";

/**
 * Local-only version store for 方案助手 output. Every successful generation is
 * appended as a new version of the series identified by customer + industry + goal,
 * so re-running the same request builds a reviewable history instead of overwriting.
 * Files live under `.local-cache/` and never enter the build output or the browser
 * bundle; the store only ever persists already-validated, redacted plan content.
 */

export const MAX_VERSIONS_PER_SERIES = 20;
export const MAX_LISTED_SERIES = 50;

const SERIES_ID_PATTERN = /^[a-f0-9]{16}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export interface SolutionSeriesKey {
  readonly customer: string;
  readonly industry: string;
  readonly goal: string;
  readonly constraints: string;
}

export interface SolutionVersion {
  readonly versionId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly requestId: string;
  readonly engine: SolutionEngine;
  readonly degraded?: SolutionDegradeCode;
  readonly retrieval: SolutionRetrievalStatus;
  readonly plan: SolutionPlan;
}

export interface SolutionSeries {
  readonly seriesId: string;
  readonly key: SolutionSeriesKey;
  readonly versions: readonly SolutionVersion[];
}

export interface SolutionSeriesSummary {
  readonly seriesId: string;
  readonly customer: string;
  readonly industry: string;
  readonly goal: string;
  readonly title: string;
  readonly versionCount: number;
  readonly latestVersion: number;
  readonly updatedAt: string;
  readonly latestEngine: SolutionEngine;
  readonly latestDegraded?: SolutionDegradeCode;
}

export interface SolutionAppendInput {
  readonly key: SolutionSeriesKey;
  readonly requestId: string;
  readonly plan: SolutionPlan;
  readonly retrieval: SolutionRetrievalStatus;
}

export interface SolutionStore {
  list(): Promise<SolutionSeriesSummary[]>;
  get(seriesId: string): Promise<SolutionSeries | undefined>;
  append(input: SolutionAppendInput, now?: () => Date): Promise<{ series: SolutionSeries; version: SolutionVersion } | undefined>;
  remove(seriesId: string, versionId: string): Promise<number | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Constraints are excluded: tweaking them should extend the same solution thread, not fork it. */
export function seriesIdFor(key: SolutionSeriesKey): string {
  const material = [key.customer, key.industry, key.goal].map((part) => part.trim()).join("\u0000");
  return createHash("sha256").update(material, "utf-8").digest("hex").slice(0, 16);
}

function normalizeRetrieval(value: unknown): SolutionRetrievalStatus {
  const record = isRecord(value) ? value : {};
  const queries = Array.isArray(record.queries)
    ? record.queries.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
  return {
    status: record.status === "results-only" ? "results-only" : "insufficient-evidence",
    vectorSearch: record.vectorSearch === "semantic" ? "semantic" : "keyword-only",
    resultCount: typeof record.resultCount === "number" && Number.isFinite(record.resultCount)
      ? Math.max(0, Math.min(999, Math.trunc(record.resultCount)))
      : 0,
    queries,
  };
}

function normalizeVersion(value: unknown): SolutionVersion | undefined {
  if (!isRecord(value)) return undefined;
  const versionId = typeof value.versionId === "string" && VERSION_ID_PATTERN.test(value.versionId)
    ? value.versionId
    : undefined;
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    ? value.createdAt
    : undefined;
  const plan = parseSolutionPlan(value.plan);
  if (!versionId || !createdAt || !plan) return undefined;
  const version = typeof value.version === "number" && Number.isFinite(value.version)
    ? Math.max(1, Math.trunc(value.version))
    : undefined;
  if (version === undefined) return undefined;
  const degraded = plan.degraded;
  return {
    versionId,
    version,
    createdAt,
    requestId: typeof value.requestId === "string" ? value.requestId.slice(0, 100) : "",
    engine: plan.engine,
    ...(degraded ? { degraded } : {}),
    retrieval: normalizeRetrieval(value.retrieval),
    plan,
  };
}

function normalizeKey(value: unknown): SolutionSeriesKey | undefined {
  if (!isRecord(value)) return undefined;
  const read = (field: string) => (typeof value[field] === "string" ? (value[field] as string).slice(0, 500) : "");
  const customer = read("customer");
  const goal = read("goal");
  if (!customer || !goal) return undefined;
  return { customer, industry: read("industry"), goal, constraints: read("constraints") };
}

function normalizeSeries(seriesId: string, value: unknown): SolutionSeries | undefined {
  if (!isRecord(value)) return undefined;
  const key = normalizeKey(value.key);
  if (!key) return undefined;
  const versions = Array.isArray(value.versions)
    ? value.versions.map(normalizeVersion).filter((item): item is SolutionVersion => item !== undefined)
    : [];
  if (!versions.length) return undefined;
  const ordered = [...versions].sort((left, right) => left.version - right.version);
  return { seriesId, key, versions: ordered };
}

function summarize(series: SolutionSeries): SolutionSeriesSummary {
  const latest = series.versions[series.versions.length - 1]!;
  return {
    seriesId: series.seriesId,
    customer: series.key.customer,
    industry: series.key.industry,
    goal: series.key.goal,
    title: latest.plan.title,
    versionCount: series.versions.length,
    latestVersion: latest.version,
    updatedAt: latest.createdAt,
    latestEngine: latest.engine,
    ...(latest.degraded ? { latestDegraded: latest.degraded } : {}),
  };
}

async function readSeries(baseDir: string, seriesId: string): Promise<SolutionSeries | undefined> {
  try {
    const raw = await readFile(join(baseDir, `${seriesId}.json`), "utf-8");
    return normalizeSeries(seriesId, JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Writes through a temp file so a crash can never leave a half-written history file. */
async function writeSeries(baseDir: string, series: SolutionSeries): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const target = join(baseDir, `${series.seriesId}.json`);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(series, null, 2)}\n`, "utf-8");
  await rename(temporary, target);
}

export function createSolutionStore(baseDir: string): SolutionStore {
  const list = async (): Promise<SolutionSeriesSummary[]> => {
    let entries: string[];
    try {
      entries = await readdir(baseDir);
    } catch {
      return [];
    }
    const summaries: SolutionSeriesSummary[] = [];
    for (const entry of entries) {
      const match = /^([a-f0-9]{16})\.json$/.exec(entry);
      if (!match) continue;
      const series = await readSeries(baseDir, match[1]!);
      if (series) summaries.push(summarize(series));
    }
    return summaries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.seriesId.localeCompare(right.seriesId))
      .slice(0, MAX_LISTED_SERIES);
  };

  const get = (seriesId: string): Promise<SolutionSeries | undefined> =>
    SERIES_ID_PATTERN.test(seriesId) ? readSeries(baseDir, seriesId) : Promise.resolve(undefined);

  const append = async (input: SolutionAppendInput, now: () => Date = () => new Date()) => {
    const plan = parseSolutionPlan(input.plan);
    if (!plan) return undefined;
    const seriesId = seriesIdFor(input.key);
    const existing = await readSeries(baseDir, seriesId);
    const nextVersion = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const version: SolutionVersion = {
      versionId: crypto.randomUUID(),
      version: nextVersion,
      createdAt: now().toISOString(),
      requestId: input.requestId,
      engine: plan.engine,
      ...(plan.degraded ? { degraded: plan.degraded } : {}),
      retrieval: input.retrieval,
      plan,
    };
    const kept = [...(existing?.versions ?? []), version].slice(-MAX_VERSIONS_PER_SERIES);
    const renumbered = kept.map((item, index) => ({ ...item, version: index + 1 }));
    const series: SolutionSeries = { seriesId, key: input.key, versions: renumbered };
    await writeSeries(baseDir, series);
    return { series, version: renumbered[renumbered.length - 1]! };
  };

  const remove = async (seriesId: string, versionId: string): Promise<number | undefined> => {
    if (!SERIES_ID_PATTERN.test(seriesId) || !VERSION_ID_PATTERN.test(versionId)) return undefined;
    const existing = await readSeries(baseDir, seriesId);
    if (!existing) return undefined;
    const remaining = existing.versions.filter((item) => item.versionId !== versionId);
    if (remaining.length === existing.versions.length) return existing.versions.length;
    if (!remaining.length) {
      await rm(join(baseDir, `${seriesId}.json`), { force: true });
      return 0;
    }
    const renumbered = remaining.map((item, index) => ({ ...item, version: index + 1 }));
    await writeSeries(baseDir, { seriesId, key: existing.key, versions: renumbered });
    return renumbered.length;
  };

  return { list, get, append, remove };
}
