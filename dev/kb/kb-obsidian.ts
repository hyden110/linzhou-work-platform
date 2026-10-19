import { realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";

import type { KbAdapter } from "./kb-adapter-shared.ts";
import type {
  KbAdapterHit,
  KbDoc,
  KbObsidianSource,
  KbSpace,
} from "./kb-types.ts";
import { snippetOf, terms } from "./kb-util.ts";

/**
 * Obsidian vault 只读适配器。
 * Ported semantics from base/sa-workbench scripts/lib/kb/obsidian.js:
 * TTL 增量索引（mtime 变化才重读）；realpath 后必须仍在 vault 根下（挡 ../ 与软链越界）。
 * 本机无 vault：适配器移植后保持禁用态即可。
 */

const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 1000;

export interface ObsidianAdapterOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface NoteEntry {
  readonly title: string;
  readonly mtime: number;
  readonly size: number;
  readonly text: string;
  readonly low: string;
  readonly tags: string[];
}

export function tagsOfHead(head: string): string[] {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(head);
  if (!front) return [];
  const body = front[1]!;
  const inline = /^tags:\s*\[([^\]]*)\]/m.exec(body);
  if (inline) {
    return inline[1]!.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).slice(0, 12);
  }
  const multiline = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(body);
  return multiline
    ? multiline[1]!.split("\n").map((item) => item.replace(/^\s*-\s*/, "").trim()).filter(Boolean).slice(0, 12)
    : [];
}

export function createObsidianAdapter(options: ObsidianAdapterOptions = {}): KbAdapter {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  /* vault 绝对路径（仅进程内存键）→ { at, notes: Map<rel, entry> } */
  const cache = new Map<string, { at: number; notes: Map<string, NoteEntry> }>();

  function vaultRoot(source: KbObsidianSource): string | null {
    try {
      return realpathSync(source.vault);
    } catch {
      return null;
    }
  }

  function index(root: string): Map<string, NoteEntry> {
    const previous = cache.get(root);
    if (previous && now() - previous.at < ttlMs) return previous.notes;
    const old = previous?.notes ?? new Map<string, NoteEntry>();
    const notes = new Map<string, NoteEntry>();
    const walk = (dir: string, depth: number): void => {
      if (notes.size >= MAX_FILES || depth > 10) return;
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (notes.size >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const filePath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(filePath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        try {
          const stats = statSync(filePath);
          if (stats.size > MAX_BYTES) continue;
          const rel = relative(root, filePath).split("\\").join("/");
          const cachedNote = old.get(rel);
          if (cachedNote && cachedNote.mtime === stats.mtimeMs) {
            notes.set(rel, cachedNote);
            continue;
          }
          const text = readFileSync(filePath, "utf8");
          notes.set(rel, {
            title: entry.name.replace(/\.md$/i, ""),
            mtime: stats.mtimeMs,
            size: stats.size,
            text,
            low: text.toLowerCase(),
            tags: tagsOfHead(text.slice(0, 4096)),
          });
        } catch {
          /* 单文件失败不阻断 */
        }
      }
    };
    walk(root, 0);
    cache.set(root, { at: now(), notes });
    return notes;
  }

  function inDirs(rel: string, dirs: readonly string[]): boolean {
    return !dirs || !dirs.length || dirs.some((dir) => rel === dir || rel.startsWith(`${dir.replace(/\/+$/, "")}/`));
  }

  /* 只读 vault 内的 .md：realpath 后必须仍在 vault 根下（挡 ../ 与软链越界）。 */
  function safePath(root: string, rel: string): string | null {
    if (typeof rel !== "string" || !rel || rel.length > 1024 || rel.includes("\0") || !/\.md$/i.test(rel)) return null;
    let filePath: string;
    try {
      filePath = realpathSync(resolvePath(root, rel));
    } catch {
      return null;
    }
    return filePath.startsWith(`${root}${sep}`) ? filePath : null;
  }

  function toHit(source: KbObsidianSource, rel: string, note: NoteEntry): KbAdapterHit {
    return {
      sourceId: source.id,
      type: "obsidian",
      id: rel,
      key: `obs:${rel}`,
      title: note.title,
      space: rel.includes("/") ? rel.split("/")[0]! : "",
      path: rel,
      url: `obsidian://open?vault=${encodeURIComponent(basename(source.vault))}&file=${encodeURIComponent(rel.replace(/\.md$/i, ""))}`,
      mtime: new Date(note.mtime).toISOString(),
      tags: note.tags,
    } as KbAdapterHit;
  }

  return {
    type: "obsidian",
    label: "本地 Obsidian",

    spaces: async (rawSource) => {
      const source = rawSource as KbObsidianSource;
      const root = vaultRoot(source);
      if (!root) throw new Error("vault 路径不存在");
      const counts = new Map<string, number>();
      for (const rel of index(root).keys()) {
        if (!inDirs(rel, source.dirs)) continue;
        const top = rel.includes("/") ? rel.split("/")[0]! : "";
        counts.set(top, (counts.get(top) ?? 0) + 1);
      }
      const spaces: KbSpace[] = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ id, name: id || "（根目录）", leaf: true, count }));
      return spaces;
    },

    search: async (rawSource, query, k) => {
      const source = rawSource as KbObsidianSource;
      const root = vaultRoot(source);
      if (!root) throw new Error("vault 路径不存在");
      const queryTerms = terms(query);
      if (!queryTerms.length) return [];
      const hits: (KbAdapterHit & { score: number; mtime: string })[] = [];
      for (const [rel, note] of index(root)) {
        if (!inDirs(rel, source.dirs)) continue;
        const title = note.title.toLowerCase();
        let score = 0;
        let allMatched = true;
        for (const term of queryTerms) {
          const inTitle = title.includes(term);
          const inTag = note.tags.some((tag) => tag.toLowerCase().includes(term));
          let count = 0;
          let at = note.low.indexOf(term);
          while (at >= 0 && count < 10) {
            count += 1;
            at = note.low.indexOf(term, at + term.length);
          }
          if (!inTitle && !inTag && !count) {
            allMatched = false;
            break;
          }
          score += (inTitle ? 6 : 0) + (inTag ? 3 : 0) + count;
        }
        if (!allMatched) continue;
        const mtime = new Date(note.mtime).toISOString();
        hits.push({
          ...toHit(source, rel, note),
          score,
          mtime,
          snippet: snippetOf(note.text.replace(/^---[\s\S]*?\n---/, ""), queryTerms),
        });
      }
      hits.sort((a, b) => b.score - a.score || b.mtime.localeCompare(a.mtime));
      return hits.slice(0, k).map((hit, position) => ({ ...hit, rank: position + 1 }));
    },

    read: async (rawSource, id) => {
      const source = rawSource as KbObsidianSource;
      const root = vaultRoot(source);
      if (!root) throw new Error("vault 路径不存在");
      const filePath = safePath(root, id);
      if (!filePath) throw new Error("非法路径");
      const body = readFileSync(filePath, "utf8").slice(0, 200 * 1024);
      const doc: KbDoc = {
        title: basename(filePath).replace(/\.md$/i, ""),
        format: "md",
        body,
        url: `obsidian://open?vault=${encodeURIComponent(basename(source.vault))}&file=${encodeURIComponent(String(id).replace(/\.md$/i, ""))}`,
      };
      return doc;
    },
  };
}
