import { readFile } from "node:fs/promises";

import type {
  KbAliyundocSource,
  KbBailianSource,
  KbConfig,
  KbDingtalkSource,
  KbObsidianSource,
  KbSource,
  KbSourceType,
} from "./kb-types.ts";
import { parseJsonPayload } from "./kb-util.ts";

/**
 * Config sanitize/load ported from base/sa-workbench scripts/lib/kb/index.js.
 * Deviation by task scope: a missing or corrupt `.local-cache/kb.json` means
 * "all sources disabled" and must answer honestly with empty sources — it
 * never throws and never falls back to defaults().
 */

export const KB_ID_PATTERN = /^[\w-]{1,40}$/;
const NODE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9._/-]{1,160}$/;
const BAILIAN_ID_PATTERN = /^[\w-]+$/;
const PROFILE_PATTERN = /^[\w.-]*$/;
const REGION_PATTERN = /^([a-z]{2}-[a-z0-9-]{2,28})?$/;
const LANG_PATTERN = /^[a-z]{2}(-[a-z]{2,4})?$/;
export const SUMMARY_MODEL_PATTERN = /^[\w .()-]{1,80}$/;

const MAX_SOURCES = 30;
const MAX_PRODUCTS = 40;
const MAX_SPACES = 50;
const MAX_INDICES = 30;
const MAX_DIRS = 20;

export const KB_ADAPTER_TYPES: readonly KbSourceType[] = ["obsidian", "dingtalk", "bailian", "aliyundoc"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Reference `str()`: bounded length, no control/angle characters, optional pattern. */
function str(value: unknown, max: number, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length <= max && !/[\0\n\r<>]/.test(value) && (!pattern || pattern.test(value));
}

function cleanList<T>(value: unknown, max: number, map: (item: unknown) => T | null): T[] {
  return (Array.isArray(value) ? value : []).slice(0, max)
    .map(map)
    .filter((item): item is T => item !== null);
}

function asSpaceRef(item: unknown): { id: string; name: string } | null {
  if (!isRecord(item) || !str(item.id, 80, NODE_PATTERN)) return null;
  return { id: item.id, name: str(item.name, 80) ? item.name : item.id };
}

function asIndexRef(item: unknown): { id: string; name: string } | null {
  if (!isRecord(item) || !str(item.id, 64, BAILIAN_ID_PATTERN)) return null;
  return { id: item.id, name: str(item.name, 80) ? item.name : item.id };
}

/** Product codes come from the official index paths; traversal and doubleslash die here. */
function asProductRef(item: unknown): { id: string; name: string } | null {
  if (!isRecord(item) || !str(item.id, 160, PRODUCT_CODE_PATTERN) || item.id.includes("..") || item.id.includes("//")) {
    return null;
  }
  return { id: item.id, name: str(item.name, 60) && item.name.trim() ? item.name.trim() : item.id };
}

function asSource(raw: unknown): KbSource | null {
  if (!isRecord(raw) || !KB_ADAPTER_TYPES.includes(raw.type as KbSourceType) || !str(raw.id, 40, KB_ID_PATTERN)) {
    return null;
  }
  const type = raw.type as KbSourceType;
  const name = str(raw.name, 40) && raw.name.trim() ? raw.name.trim() : type;
  const base = { id: raw.id, type, name, enabled: raw.enabled === true };
  const weight = Number(raw.weight);
  const withWeight = <T extends { weight?: number }>(source: T): T =>
    Number.isFinite(weight) && weight >= 0.1 && weight <= 5 && weight !== 1 ? { ...source, weight } : source;

  if (type === "obsidian") {
    if (!str(raw.vault, 512) || !(raw.vault as string).trim()) return null;
    const source: KbObsidianSource = {
      ...base,
      type,
      vault: (raw.vault as string).trim(),
      dirs: cleanList(raw.dirs, MAX_DIRS, (item) => {
        if (!str(item, 200) || !(item as string).trim()) return null;
        const trimmed = (item as string).trim();
        return trimmed.split("/").includes("..") ? null : trimmed.replace(/^\/+|\/+$/g, "");
      }),
    };
    return withWeight(source);
  }
  if (type === "dingtalk") {
    const source: KbDingtalkSource = {
      ...base,
      type,
      spaces: cleanList(raw.spaces, MAX_SPACES, asSpaceRef),
      enterprise: raw.enterprise === true,
    };
    return withWeight(source);
  }
  if (type === "bailian") {
    const source: KbBailianSource = {
      ...base,
      type,
      profile: str(raw.profile, 64, PROFILE_PATTERN) ? raw.profile : "",
      region: str(raw.region, 32, REGION_PATTERN) ? raw.region : "",
      workspaceId: str(raw.workspaceId, 64, BAILIAN_ID_PATTERN) ? raw.workspaceId : "",
      indices: cleanList(raw.indices, MAX_INDICES, asIndexRef),
    };
    return withWeight(source);
  }
  const source: KbAliyundocSource = {
    ...base,
    type,
    site: raw.site === "intl" ? "intl" : "cn",
    lang: str(raw.lang, 8, LANG_PATTERN) ? raw.lang : "",
    products: cleanList(raw.products, MAX_PRODUCTS, asProductRef),
  };
  return withWeight(source);
}

/** Bad ids, out-of-range products, unknown types and duplicate ids are dropped; the rest survives. */
export function sanitizeKbConfig(raw: unknown): KbConfig {
  const config = isRecord(raw) ? raw : {};
  const seen = new Set<string>();
  const sources = cleanList(config.sources, MAX_SOURCES, asSource)
    .filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    });
  const summary = isRecord(config.summary) ? config.summary : {};
  const topN = Math.round(Number(summary.topN));
  return {
    sources,
    summary: {
      model: str(summary.model, 80, SUMMARY_MODEL_PATTERN) ? summary.model : "Auto",
      topN: Number.isFinite(topN) && topN >= 3 && topN <= 12 ? topN : 8,
    },
  };
}

/** Missing / corrupt file → all sources disabled, honestly empty, never throws. */
export async function loadKbConfig(configPath: string): Promise<KbConfig> {
  let raw: unknown;
  try {
    const text = await readFile(configPath, "utf-8");
    // 宽容解析：CLI 场景常见的前置告警行不破坏加载。
    raw = text.trimStart().startsWith("{") ? JSON.parse(text) : parseJsonPayload(text);
  } catch {
    return { sources: [], summary: { model: "Auto", topN: 8 } };
  }
  return sanitizeKbConfig(raw);
}
