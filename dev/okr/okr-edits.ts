import { OkrBridgeError, type OkrEdit } from "./okr-types.ts";

/**
 * 编辑项白名单校验 — 语义照 donor scripts/bridge.js validItem/pick 与
 * tools/sync/okr_write.py load_edits（字段映射与 fetch 快照严格互逆）：
 * - kind ∈ {o, kr}；oId 必须 24 位 hex；kr 必须带 24 位 hex krId；
 * - 字段白名单：O = title/desc/weight；KR = title/weight/targetValue/unit；
 * - from/to 只收 字符串(≤4000) / 有限数字 / null，其余（对象、布尔、超长）拒绝；
 * - 数组上限 200 条（donor 同口径）。
 */

export const OKR_ID_RE = /^[a-f0-9]{24}$/i;
export const O_FIELDS: readonly string[] = ["title", "desc", "weight"];
export const KR_FIELDS: readonly string[] = ["title", "weight", "targetValue", "unit"];
export const MAX_EDITS = 200;
export const MAX_VALUE_CHARS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 编辑键：oId|krId|field（O 级编辑 krId 槽为空）。 */
export function editKey(edit: Pick<OkrEdit, "oId" | "krId" | "field">): string {
  return `${edit.oId}|${edit.krId ?? ""}|${edit.field}`;
}

const KEY_RE = /^([a-f0-9]{24})\|([a-f0-9]{24})?\|(title|desc|weight|targetValue|unit)$/i;

/** 解析 sync-confirm 的 keys 数组元素；非法返回 null。 */
export function parseEditKey(key: unknown): { oId: string; krId: string | null; field: string } | null {
  if (typeof key !== "string" || key.length > 80) return null;
  const matched = KEY_RE.exec(key);
  if (!matched) return null;
  return { oId: matched[1]!, krId: matched[2] ? matched[2]! : null, field: matched[3]! };
}

function normalizeValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    if (value.length > MAX_VALUE_CHARS) {
      throw new OkrBridgeError("okr_invalid_request", `编辑项 ${label} 超长（上限 ${MAX_VALUE_CHARS} 字符）`);
    }
    return value;
  }
  throw new OkrBridgeError("okr_invalid_request", `编辑项 ${label} 只接受字符串 / 数字 / null`);
}

function normalizeEdit(raw: unknown, index: number): OkrEdit {
  if (!isRecord(raw)) throw new OkrBridgeError("okr_invalid_request", `第 ${index + 1} 条编辑项必须是对象`);
  const kind = raw.kind;
  if (kind !== "o" && kind !== "kr") {
    throw new OkrBridgeError("okr_invalid_request", `第 ${index + 1} 条编辑项 kind 必须是 o / kr`);
  }
  const oId = typeof raw.oId === "string" ? raw.oId : "";
  if (!OKR_ID_RE.test(oId)) {
    throw new OkrBridgeError("okr_invalid_request", `第 ${index + 1} 条编辑项 oId 必须是 24 位 hex`);
  }
  const field = typeof raw.field === "string" ? raw.field : "";
  const allowed = kind === "o" ? O_FIELDS : KR_FIELDS;
  if (!allowed.includes(field)) {
    throw new OkrBridgeError("okr_invalid_request", `第 ${index + 1} 条编辑项字段不在白名单（${allowed.join(" / ")}）`);
  }
  let krId: string | null = null;
  if (kind === "kr") {
    krId = typeof raw.krId === "string" ? raw.krId : "";
    if (!krId || !OKR_ID_RE.test(krId)) {
      throw new OkrBridgeError("okr_invalid_request", `第 ${index + 1} 条编辑项 krId 必须是 24 位 hex`);
    }
  }
  return {
    kind,
    oId,
    krId,
    field,
    from: normalizeValue(raw.from, "from"),
    to: normalizeValue(raw.to, "to"),
  };
}

export type EditsValidation =
  | { readonly ok: true; readonly edits: readonly OkrEdit[] }
  | { readonly ok: false; readonly reason: string };

/** 数组级校验：非数组 / 空 / 超上限 / 任一项非法 → {ok:false}（不抛异常，便于复用）。 */
export function validateOkrEdits(input: unknown): EditsValidation {
  if (!Array.isArray(input)) return { ok: false, reason: "edits 必须是数组" };
  if (input.length === 0) return { ok: false, reason: "没有待同步的编辑项" };
  if (input.length > MAX_EDITS) return { ok: false, reason: `编辑项超过 ${MAX_EDITS} 条上限` };
  try {
    return { ok: true, edits: input.map((raw, index) => normalizeEdit(raw, index)) };
  } catch (error) {
    if (error instanceof OkrBridgeError) return { ok: false, reason: error.message };
    return { ok: false, reason: "编辑项校验失败" };
  }
}

/** 校验并抛出（handler 用）：非法直接 OkrBridgeError → 400。 */
export function requireValidEdits(input: unknown): readonly OkrEdit[] {
  const result = validateOkrEdits(input);
  if (!result.ok) throw new OkrBridgeError("okr_invalid_request", result.reason);
  return result.edits;
}

/** 磁盘 edits.json → OkrEditsFile 白名单投影；形态不可识别返回 null（调用方按无暂存处理）。 */
export function sanitizeEditsFile(raw: unknown): { exportedAt: string; baseSnapshotAt: string; edits: readonly OkrEdit[] } | null {
  if (!isRecord(raw) || !Array.isArray(raw.edits)) return null;
  const validation = raw.edits.length === 0 ? { ok: true as const, edits: [] } : validateOkrEdits(raw.edits);
  if (!validation.ok) return null;
  return {
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt.slice(0, 40) : "",
    baseSnapshotAt: typeof raw.baseSnapshotAt === "string" ? raw.baseSnapshotAt.slice(0, 40) : "",
    edits: validation.edits,
  };
}
