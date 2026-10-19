import { readFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

import type { CasesConfig, CasesOssSpec, CasesRepoSpec } from "./cases-types.ts";

/**
 * Config sanitize/load for the published-cases ledger (F3).
 * Shape mirrors base/sa-workbench tools/cases.json.example; the file lives at
 * .local-cache/cases.json (gitignored, personal-only).
 * Deviation by task scope, same contract as the kb bridge: a missing or corrupt
 * config means "unconfigured" and must answer honestly with configured:false —
 * it never throws and never fabricates cases.
 */

/* cases-bridge.ts 位于 dev/cases/，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
export const DEFAULT_CASES_CONFIG_PATH = joinPath(PROJECT_ROOT, ".local-cache", "cases.json");

const REPO_PATTERN = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9._/\u4e00-\u9fa5-]{0,159}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PUBLIC_BASE_PATTERN = /^https?:\/\/[A-Za-z0-9._-]+(:\d{2,5})?(\/[A-Za-z0-9._/-]*)?$/;
const CASE_KEY_PATTERN = /^[a-z0-9\u4e00-\u9fa5]{1,120}$/;
const CUST_NAME_PATTERN = /^[^<>{}\\]{1,40}$/;

const MAX_REPOS = 30;
const MAX_EXCLUDES = 20;
const MAX_ALIAS_ENTRIES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Reference `str()`: bounded length, no control/angle characters, optional pattern. */
function str(value: unknown, max: number, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length <= max && !/[\0\n\r<>]/.test(value) && (!pattern || pattern.test(value));
}

function cleanList(value: unknown, max: number, map: (item: unknown) => string | null): string[] {
  return (Array.isArray(value) ? value : []).slice(0, max).map(map).filter((item): item is string => item !== null);
}

function asExclude(item: unknown): string | null {
  if (!str(item, 80) || !(item as string).trim()) return null;
  return (item as string).trim();
}

/** 仓库路径：拒绝 ".."、反斜杠、首尾分隔符等一切越界形态。 */
function asRepoSpec(raw: unknown): CasesRepoSpec | null {
  if (!isRecord(raw)) return null;
  if (!str(raw.repo, 160, REPO_PATTERN) || (raw.repo as string).includes("..") || (raw.repo as string).includes("//")) {
    return null;
  }
  const publishDirRaw = str(raw.publishDir, 120) ? (raw.publishDir as string).trim().replace(/^\/+|\/+$/g, "") : "";
  const publishDir = !publishDirRaw || publishDirRaw.split("/").includes("..") ? "" : publishDirRaw;
  return {
    repo: raw.repo as string,
    mode: raw.mode === "collection" ? "collection" : "site",
    publishDir,
    exclude: cleanList(raw.exclude, MAX_EXCLUDES, asExclude),
  };
}

function asOssSpec(raw: unknown): CasesOssSpec | null {
  if (!isRecord(raw) || !str(raw.bucket, 63, BUCKET_PATTERN)) return null;
  const publicBase = str(raw.publicBase, 200, PUBLIC_BASE_PATTERN) && !(raw.publicBase as string).includes("..")
    ? (raw.publicBase as string).replace(/\/+$/, "")
    : "";
  return {
    bucket: raw.bucket as string,
    publicBase,
    exclude: cleanList(raw.exclude, MAX_EXCLUDES, asExclude),
  };
}

/** 键值映射：键必须是归一化案例键，值过界即整条剔除。 */
function asAliasMap(raw: unknown, valuePattern: RegExp, valueMax: number): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_ALIAS_ENTRIES)) {
    if (!CASE_KEY_PATTERN.test(key)) continue;
    if (!str(value, valueMax, valuePattern)) continue;
    out[key] = value;
  }
  return out;
}

/** 坏 repo 条目 / 坏桶名 / 坏 publicBase / 坏别名逐条剔除；其余存活。 */
export function sanitizeCasesConfig(raw: unknown): CasesConfig {
  const config = isRecord(raw) ? raw : {};
  const code = isRecord(config.code) ? config.code : {};
  const oss = isRecord(config.oss) ? config.oss : null;
  const repos = cleanList(code.repos, MAX_REPOS, asRepoSpec);
  const seen = new Set<string>();
  const uniqueRepos = repos.filter((spec) => {
    if (seen.has(spec.repo)) return false;
    seen.add(spec.repo);
    return true;
  });
  return {
    repos: uniqueRepos,
    codeExclude: cleanList(code.exclude, MAX_EXCLUDES, asExclude),
    oss: oss ? asOssSpec(oss) : null,
    aliases: asAliasMap(config.aliases, CASE_KEY_PATTERN, 120),
    custAliases: asAliasMap(config.custAliases, CUST_NAME_PATTERN, 40),
  };
}

/** Missing / corrupt file → null（未配置），如实降级，绝不抛错、绝不造数据。 */
export async function loadCasesConfig(configPath: string): Promise<CasesConfig | null> {
  let raw: unknown;
  try {
    const text = await readFile(configPath, "utf-8");
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return sanitizeCasesConfig(raw);
}
