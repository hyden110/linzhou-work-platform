import { createHash } from "node:crypto";

import type { PublishedCase, RawCase } from "./cases-types.ts";

/**
 * Pure case-ledger model, ported from base/sa-workbench
 * assets/models/cases-model.js + tools/fetch/cases_fetch.js (groupUnits).
 * No I/O, no clocks — fully unit-testable.
 */

/* 静态资源 / 模板目录不是案例（各源通用，配置 exclude 叠加其上）。 */
export const BUILTIN_EXCLUDE = [
  "assets", "static", "css", "js", "img", "images", "fonts", "lib", "vendor",
  "node_modules", "_*", ".*",
];

/** 跨源合并键：目录名 / 仓库名归一（小写、去分隔符）。 */
export function caseKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\.html?$/, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

/** 文件路径 → 展示标题（index 空串回落名称）。 */
export function fileTitle(path: string): string {
  const base = String(path ?? "").split("/").pop()?.replace(/\.html?$/i, "") ?? "";
  return base === "index" ? "" : base.replace(/[_-]+/g, " ").trim();
}

/** `*` 通配匹配（大小写不敏感），其余字符按字面量。 */
export function globMatch(name: string, patterns: readonly string[]): boolean {
  return (patterns ?? []).some((pattern) =>
    new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(name),
  );
}

/** 逐段 encode，保留 `/`。 */
export function encodePath(path: string): string {
  return String(path ?? "").split("/").map(encodeURIComponent).join("/");
}

export interface UnitFile {
  readonly path: string;
  readonly mtime?: string;
}

export interface CaseUnit {
  readonly name: string;
  readonly dir: string;
  readonly entry: UnitFile;
  readonly updatedAt: string;
  readonly files: readonly UnitFile[];
}

/**
 * html 文件 → 案例单元。mode collection = 发布根一级子目录为单元（根 index 是
 * 导航不是案例），site = 整体一个单元。entry 取最浅的 index.html，否则最浅最短路径。
 */
export function groupUnits(
  files: readonly UnitFile[],
  options: { readonly mode: "site" | "collection"; readonly name?: string; readonly exclude?: readonly string[] },
): CaseUnit[] {
  const units = new Map<string, { name: string; dir: string; files: UnitFile[] }>();
  for (const file of files) {
    if (!/\.html?$/i.test(file.path)) continue;
    const segments = file.path.split("/");
    let name: string;
    let dir: string;
    if (options.mode === "site") {
      name = options.name ?? "";
      dir = "";
    } else if (segments.length === 1) {
      if (/^index\.html?$/i.test(segments[0]!)) continue;
      name = segments[0]!.replace(/\.html?$/i, "");
      dir = "";
    } else {
      name = segments[0]!;
      dir = segments[0]!;
    }
    if (globMatch(name, [...BUILTIN_EXCLUDE, ...(options.exclude ?? [])])) continue;
    const id = dir || `/${name}`;
    if (!units.has(id)) units.set(id, { name, dir, files: [] });
    units.get(id)!.files.push(file);
  }
  const depth = (path: string) => path.split("/").length;
  return Array.from(units.values()).map((unit) => {
    const indexes = unit.files
      .filter((file) => /(^|\/)index\.html?$/i.test(file.path))
      .sort((a, b) => depth(a.path) - depth(b.path));
    const entry = indexes[0]
      ?? [...unit.files].sort((a, b) => depth(a.path) - depth(b.path) || a.path.length - b.path.length)[0]!;
    const updatedAt = unit.files.map((file) => file.mtime ?? "").sort().pop() ?? "";
    return { ...unit, entry, updatedAt };
  });
}

export function idFromKey(key: string): string {
  return `c${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

const SRC_ORDER: readonly string[] = ["oss", "code"];

/**
 * 跨源合并：aliases[key] 并键（同参考实现）；custAliases[key] 给客户别名；
 * 按 updatedAt 倒序。代表字段按 oss → code 渠道优先级取第一个非空。
 */
export function mergeRawCases(
  raws: readonly RawCase[],
  aliases: Readonly<Record<string, string>>,
  custAliases: Readonly<Record<string, string>>,
): PublishedCase[] {
  const groups = new Map<string, RawCase[]>();
  for (const raw of raws) {
    const master = aliases[raw.key] ?? raw.key;
    const list = groups.get(master) ?? [];
    groups.set(master, [...list, raw]);
  }
  const merged: (PublishedCase & { readonly sortKey: string })[] = Array.from(groups.entries())
    .map(([key, list]) => {
      const ordered = [...list].sort((a, b) => SRC_ORDER.indexOf(a.src) - SRC_ORDER.indexOf(b.src));
      const first = ordered[0]!;
      const title = ordered.map((raw) => raw.title).find(Boolean) ?? "";
      const updatedAt = ordered.map((raw) => raw.updatedAt).sort().pop() ?? "";
      return {
        id: idFromKey(key),
        name: first.name,
        title,
        cust: custAliases[key] ?? "",
        updatedAt,
        entryUrl: ordered.map((raw) => raw.url).find(Boolean) ?? "",
        srcs: Array.from(new Set(ordered.map((raw) => raw.src))),
        pageCount: Math.max(...ordered.map((raw) => raw.pageCount || 1)),
        sortKey: key,
      };
    });
  merged.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.sortKey.localeCompare(b.sortKey));
  return merged.map(({ sortKey: _sortKey, ...published }) => published);
}

/** 入口 URL 护栏：只放行 http(s)，其余（javascript:/data:/相对路径）一律空串。 */
export function safeEntryUrl(url: unknown): string {
  const text = String(url ?? "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}
