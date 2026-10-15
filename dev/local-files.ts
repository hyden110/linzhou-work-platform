import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath, sep } from "node:path";

/**
 * Local-only file access. This module deliberately lives in `dev/` and is never
 * imported by `functions/`, so it cannot be deployed: it shells out to `open` and
 * streams bytes off the developer's disk.
 *
 * The browser only ever supplies an opaque document id. Absolute paths are resolved
 * server-side from the private index state and are never returned to the client.
 */

const PROJECT_ROOT = resolvePath(import.meta.dirname, "..");
const STATE_PATH = join(PROJECT_ROOT, ".local-cache", "local-index-state.json");
const HIGHLIGHTS_PATH = join(PROJECT_ROOT, ".local-cache", "yunqi-highlights.json");

export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ppt",
  ".pptx",
  ".pdf",
  ".md",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".html",
]);

const PREVIEW_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".pdf", "application/pdf"],
  [".md", "text/plain; charset=utf-8"],
]);

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const TEMPORARY_PREFIXES = ["~$", ".~lock."];
const DOCUMENT_ID = /^[a-f0-9]{16}$/;
const HIGHLIGHTS_SOURCE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const OPEN_BINARY = "/usr/bin/open";

export interface ResolvedFile {
  readonly id: string;
  readonly absolutePath: string;
  readonly extension: string;
  readonly bytes: number;
}

interface RegistryEntry {
  readonly rootPath: string;
  readonly relativePath: string;
}

export interface FileRegistry {
  resolve(id: string): Promise<ResolvedFile | undefined>;
  previewable(resolved: ResolvedFile): string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function entriesFromState(state: unknown): Map<string, RegistryEntry> {
  const entries = new Map<string, RegistryEntry>();
  const record = asRecord(state);
  if (!record) return entries;

  const roots = new Map<string, string>();
  for (const root of Array.isArray(record.roots) ? record.roots : []) {
    const parsed = asRecord(root);
    const id = asString(parsed?.id);
    const absolutePath = asString(parsed?.absolutePath);
    if (id && absolutePath) roots.set(id, absolutePath);
  }

  for (const document of Array.isArray(record.documents) ? record.documents : []) {
    const parsed = asRecord(document);
    const id = asString(parsed?.id);
    const source = asString(parsed?.source);
    const relativePath = asString(parsed?.relativePath);
    const rootPath = source ? roots.get(source) : undefined;
    if (id && relativePath && rootPath) entries.set(id, { rootPath, relativePath });
  }
  return entries;
}

function entriesFromHighlights(highlights: unknown): Map<string, RegistryEntry> {
  const entries = new Map<string, RegistryEntry>();
  const source = asRecord(asRecord(highlights)?.source);
  const id = asString(source?.id);
  const absolutePath = asString(source?.absolutePath);
  const relativePath = asString(source?.relativePath);
  if (!id || !absolutePath || !relativePath) return entries;
  // The root is the source file with its own relative path removed.
  const normalized = absolutePath.split("/").join(sep);
  const suffix = relativePath.split("/").join(sep);
  if (!normalized.endsWith(suffix)) return entries;
  const rootPath = normalized.slice(0, normalized.length - suffix.length).replace(/[/\\]+$/, "") || sep;
  entries.set(id, { rootPath, relativePath });
  return entries;
}

interface Cache {
  readonly mtimeMs: number;
  readonly entries: Map<string, RegistryEntry>;
}

async function readJson(path: string): Promise<{ mtimeMs: number; value: unknown } | undefined> {
  try {
    const info = await stat(path);
    const text = await readFile(path, "utf-8");
    return { mtimeMs: info.mtimeMs, value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function isTemporaryName(name: string): boolean {
  return TEMPORARY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function toResolvedFile(id: string, entry: RegistryEntry): Promise<ResolvedFile | undefined> {
  const extension = extname(entry.relativePath).toLowerCase();
  if (!OPENABLE_EXTENSIONS.has(extension)) return undefined;
  if (isTemporaryName(basename(entry.relativePath))) return undefined;

  const candidate = resolvePath(entry.rootPath, entry.relativePath);
  let realRoot: string;
  let realFile: string;
  let info;
  try {
    [realRoot, realFile] = await Promise.all([realpath(entry.rootPath), realpath(candidate)]);
    info = await lstat(candidate);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isFile()) return undefined;
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return undefined;

  return { id, absolutePath: realFile, extension, bytes: info.size };
}

export function createFileRegistry(paths: {
  statePath?: string;
  highlightsPath?: string;
} = {}): FileRegistry {
  const statePath = paths.statePath ?? STATE_PATH;
  const highlightsPath = paths.highlightsPath ?? HIGHLIGHTS_PATH;
  let stateCache: Cache | undefined;
  let highlightsCache: Cache | undefined;

  async function load(): Promise<Map<string, RegistryEntry>> {
    const state = await readJson(statePath);
    stateCache = state && state.mtimeMs === stateCache?.mtimeMs
      ? stateCache
      : state
      ? { mtimeMs: state.mtimeMs, entries: entriesFromState(state.value) }
      : undefined;

    const highlights = await readJson(highlightsPath);
    highlightsCache = highlights && highlights.mtimeMs === highlightsCache?.mtimeMs
      ? highlightsCache
      : highlights
      ? { mtimeMs: highlights.mtimeMs, entries: entriesFromHighlights(highlights.value) }
      : undefined;

    return new Map([...(stateCache?.entries ?? []), ...(highlightsCache?.entries ?? [])]);
  }

  return {
    async resolve(id: string): Promise<ResolvedFile | undefined> {
      const isDocument = DOCUMENT_ID.test(id);
      if (!isDocument && !HIGHLIGHTS_SOURCE_ID.test(id)) return undefined;
      const entry = (await load()).get(id);
      if (!entry) return undefined;
      return toResolvedFile(id, entry);
    },
    previewable(resolved: ResolvedFile): string | undefined {
      const contentType = PREVIEW_CONTENT_TYPES.get(resolved.extension);
      return contentType && resolved.bytes <= MAX_PREVIEW_BYTES ? contentType : undefined;
    },
  };
}

export interface OpenResult {
  readonly ok: boolean;
  readonly reason?: "spawn_failed";
}

export function openWithDefaultApplication(resolved: ResolvedFile): Promise<OpenResult> {
  return new Promise((resolveOpen) => {
    const child = spawn(OPEN_BINARY, [resolved.absolutePath], { stdio: "ignore" });
    child.once("error", () => resolveOpen({ ok: false, reason: "spawn_failed" }));
    child.once("spawn", () => resolveOpen({ ok: true }));
  });
}

export async function readPreview(
  resolved: ResolvedFile,
): Promise<Uint8Array | undefined> {
  try {
    const buffer = await readFile(resolved.absolutePath);
    return buffer.byteLength > MAX_PREVIEW_BYTES ? undefined : new Uint8Array(buffer);
  } catch {
    return undefined;
  }
}
