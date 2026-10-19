import { runCliJson, type CasesCommandRunner } from "./cases-cli.ts";
import { caseKey, encodePath, fileTitle, groupUnits, safeEntryUrl, type UnitFile } from "./cases-model.ts";
import type { CasesChannelResult, CasesRepoSpec, RawCase } from "./cases-types.ts";

/**
 * Code 平台渠道（bin:a1，只读）：`repo file list` 拉 HTML 文件清单、
 * `repo list` 取仓库最近活跃作为「最近发布」、`pages view` 取站点入口
 * （未开通 Pages 时如实回落仓库链接，与参考实现一致）。
 * 绝不读 HTML 正文 —— 标题取文件名归一，不抓头部（与本批范围一致）。
 */

const FILE_LIST_TIMEOUT_MS = 60_000;
const ACTIVITY_TIMEOUT_MS = 30_000;
const PAGES_TIMEOUT_MS = 20_000;
const A1_NOT_FOUND = "a1 CLI 不可用（未安装或不在 PATH）";

export interface CasesCodeChannelOptions {
  readonly run: CasesCommandRunner;
  readonly a1Bin: string;
}

function asFilePaths(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.type === "blob" && typeof item.path === "string")
    .map((item) => item.path as string)
    .filter((path) => /\.html?$/i.test(path) && !path.includes(".."));
}

async function repoActivity(run: CasesCommandRunner, a1Bin: string): Promise<Record<string, string>> {
  try {
    const payload = await runCliJson(
      run, a1Bin, ["repo", "list", "--per-page", "100", "--order-by", "last_activity_at"], ACTIVITY_TIMEOUT_MS, A1_NOT_FOUND,
    );
    const activity: Record<string, string> = {};
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (typeof record.pathWithNamespace === "string" && typeof record.lastActivityAt === "string") {
            activity[record.pathWithNamespace] = record.lastActivityAt;
          }
        }
      }
    }
    return activity;
  } catch {
    return {}; /* 活跃时间拿不到只影响「最近发布」精度，不挡案例本身 */
  }
}

export function createCasesCodeChannel(options: CasesCodeChannelOptions) {
  const { run, a1Bin } = options;
  return {
    id: "code" as const,
    fetch: async (repos: readonly CasesRepoSpec[], sharedExclude: readonly string[]): Promise<CasesChannelResult> => {
      const activity = await repoActivity(run, a1Bin);
      const results = await Promise.all(repos.map(async (spec): Promise<{ raws: RawCase[]; note: string } | null> => {
        try {
          const payload = await runCliJson(
            run, a1Bin, ["repo", "file", "list", "--repo", spec.repo, "--type", "RECURSIVE"], FILE_LIST_TIMEOUT_MS, A1_NOT_FOUND,
          );
          const htmlPaths = asFilePaths(payload);
          const publishDir = spec.publishDir || (htmlPaths.some((path) => path.startsWith("public/")) ? "public" : "");
          const prefix = publishDir ? `${publishDir}/` : "";
          const files: UnitFile[] = htmlPaths
            .filter((path) => path.startsWith(prefix))
            .map((path) => ({ path: path.slice(prefix.length) }));
          const units = groupUnits(files, {
            mode: spec.mode,
            name: spec.repo.split("/").pop() ?? spec.repo,
            exclude: [...sharedExclude, ...spec.exclude],
          });
          const webUrl = `https://code.alibaba-inc.com/${spec.repo}`;
          let site = "";
          try {
            const pages = await runCliJson(run, a1Bin, ["pages", "view", "--repo", spec.repo], PAGES_TIMEOUT_MS, A1_NOT_FOUND);
            const candidate = pages && typeof pages === "object" && !Array.isArray(pages)
              ? (pages as Record<string, unknown>).url
              : undefined;
            site = safeEntryUrl(candidate);
          } catch {
            site = "";
          }
          const note = site ? "" : `${spec.repo} 未开通 Aone Pages（仅仓库链接）`;
          const raws: RawCase[] = units.map((unit) => ({
            key: caseKey(unit.name),
            name: unit.name,
            title: fileTitle(unit.entry.path) || unit.name,
            updatedAt: activity[spec.repo] ?? "",
            url: site ? safeEntryUrl(`${site}/${encodePath(unit.entry.path)}`) : webUrl,
            src: "code",
            pageCount: unit.files.length,
          }));
          return { raws, note };
        } catch (error) {
          return { raws: [], note: `${spec.repo} ${error instanceof Error ? error.message : String(error)}` };
        }
      }));
      const raws = results.flatMap((result) => result?.raws ?? []);
      const failures = results.filter((result) => result === null || (result.note && !result.raws.length));
      const warnings = Array.from(new Set(results
        .map((result) => (result?.note ?? ""))
        .filter(Boolean)));
      const state = failures.length === results.length ? "error" : failures.length ? "degraded" : "ok";
      return { state, note: warnings.join("；"), raws } satisfies CasesChannelResult;
    },
  };
}
