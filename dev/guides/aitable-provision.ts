/**
 * AI 表格一键 provision / verify（TS 移植自 base/sa-workbench scripts/lib/aitable_provision.js，
 * 搬语义不搬代码：同步 spawnSync 改为异步 execFile 语义运行器，全部可注入）。
 *
 * 流程：dws 登录态 → base（复用既有配置里的 baseId，避免 base 泛滥）→ 逐表找/建
 * （+base-bootstrap / +table-bootstrap）→ table get 读回字段（读回为准）→
 * 合并写回 .local-cache/*.json（0600 原子写，保留已有键）。
 * 幂等：按表名复用；重跑只补缺。失败一律抛 GuidesBridgeError("guides_provision_failed")，
 * note 先过 redactNote（凭据样文本物理不可达响应）。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redactNote } from "../health/health-redact.ts";
import { BASE_NAME, schemaOf, type SchemaTable, type TableSchema } from "./aitable-schemas.ts";
import { GuidesBridgeError, type GuideCommandRunner, type ProvisionResult } from "./guides-types.ts";

export const DEFAULT_DWS_TIMEOUT_MS = 300_000;

/* ---------------- dws 调用层 ---------------- */

export function parseJsonOutput(text: unknown): Record<string, unknown> {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("DWS 未返回 JSON");
  const parsed: unknown = JSON.parse(s.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DWS 输出不是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function provisionFailed(step: string, note: string): GuidesBridgeError {
  return new GuidesBridgeError("guides_provision_failed", `${step}：${redactNote(note).slice(0, 300)}`);
}

/** 统一 dws 调用：数组参数追加 --format json，无 shell，硬超时，失败即抛（已脱敏）。 */
async function runDws(
  run: GuideCommandRunner,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const result = await run(bin, [...args, "--format", "json"], { timeoutMs });
  if (result.code === "ENOENT") throw provisionFailed("bin", `未找到 dws CLI（${bin}）`);
  if (result.code === null) throw provisionFailed("timeout", `dws ${args.join(" ")} 超时（${Math.round(timeoutMs / 1000)}s）`);
  let payload: Record<string, unknown> | undefined;
  let parseError: unknown;
  for (const text of [result.stdout, result.stderr]) {
    try {
      payload = parseJsonOutput(text);
      break;
    } catch (error) {
      parseError = error;
    }
  }
  if (!payload) {
    const fallback = redactNote(result.stderr || result.stdout);
    throw provisionFailed("dws", result.code !== 0
      ? (fallback || `DWS 退出码 ${String(result.code)}`)
      : `DWS JSON 解析失败：${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
  const errorField = payload.error;
  const hasError = errorField && typeof errorField === "object" && Object.keys(errorField as object).length > 0;
  if (result.code !== 0 || payload.success === false || hasError) {
    const err = (errorField ?? {}) as Record<string, unknown>;
    const message = String(err.message ?? err.reason ?? "") || redactNote(result.stderr || result.stdout) || `DWS 退出码 ${String(result.code)}`;
    throw provisionFailed("dws", message);
  }
  return payload;
}

/* ---------------- 输出解析（对 dws 输出形状做宽容提取） ---------------- */

function deepFind(node: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (keys.every((k) => typeof record[k] === "string" && record[k])) return record;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = deepFind(item, keys);
        if (hit) return hit;
      }
    } else {
      const hit = deepFind(value, keys);
      if (hit) return hit;
    }
  }
  return null;
}

function deepCollect(node: unknown, pred: (value: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  if (pred(record)) out.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach((item) => deepCollect(item, pred, out));
    else deepCollect(value, pred, out);
  }
  return out;
}

const stringField = (record: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
};

async function authOk(run: GuideCommandRunner, bin: string, timeoutMs: number): Promise<boolean> {
  const payload = await runDws(run, bin, ["auth", "status"], timeoutMs);
  const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  return data.authenticated === true || data.authenticated === "true";
}

async function listTables(run: GuideCommandRunner, bin: string, baseId: string, timeoutMs: number): Promise<readonly { name: string; tableId: string }[]> {
  const payload = await runDws(run, bin, ["aitable", "+base-get", "--base-id", baseId], timeoutMs);
  return deepCollect(payload, (o) => typeof (o.name ?? o.tableName) === "string" && stringField(o, "tableId", "table_id", "nodeId") !== "")
    .map((o) => ({ name: stringField(o, "name", "tableName"), tableId: stringField(o, "tableId", "table_id", "nodeId") }));
}

async function createBase(run: GuideCommandRunner, bin: string, name: string, firstTables: readonly SchemaTable[], timeoutMs: number): Promise<string> {
  const tables = firstTables.map((t) => ({ name: t.tableName, fields: t.fields.map((x) => ({ fieldName: x.fieldName, type: x.type })) }));
  const payload = await runDws(run, bin, ["aitable", "+base-bootstrap", "--name", name, "--tables", JSON.stringify(tables), "-y"], timeoutMs);
  const hit = deepFind(payload, ["baseId"]) ?? deepFind(payload, ["base_id"]) ?? deepFind(payload, ["id"]);
  const baseId = hit ? stringField(hit, "baseId", "base_id", "id") : "";
  if (!baseId) throw provisionFailed("create", "base-bootstrap 输出中未找到 baseId");
  return baseId;
}

async function addTable(run: GuideCommandRunner, bin: string, baseId: string, table: SchemaTable, timeoutMs: number): Promise<string> {
  const fields = table.fields.map((x) => ({ fieldName: x.fieldName, type: x.type }));
  const payload = await runDws(run, bin, ["aitable", "+table-bootstrap", "--base-id", baseId, "--name", table.tableName, "--fields", JSON.stringify(fields), "-y"], timeoutMs);
  const hit = deepFind(payload, ["tableId"]) ?? deepFind(payload, ["table_id"]);
  const tableId = hit ? stringField(hit, "tableId", "table_id") : "";
  if (!tableId) throw provisionFailed("create", `table-bootstrap 输出中未找到 tableId（${table.tableName}）`);
  return tableId;
}

/** 读回字段：tableId → Map(fieldName → {id, type})。 */
async function tableFields(
  run: GuideCommandRunner,
  bin: string,
  baseId: string,
  tableIds: readonly string[],
  timeoutMs: number,
): Promise<ReadonlyMap<string, ReadonlyMap<string, { id: string; type: string }>>> {
  const payload = await runDws(run, bin, ["aitable", "table", "get", "--base-id", baseId, "--table-ids", tableIds.join(",")], timeoutMs);
  const out = new Map<string, Map<string, { id: string; type: string }>>();
  for (const table of deepCollect(payload, (o) => stringField(o, "tableId", "table_id") !== "" && Array.isArray(o.fields))) {
    const map = new Map<string, { id: string; type: string }>();
    for (const field of (table.fields as unknown[]).filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")) {
      const id = stringField(field, "fieldId", "field_id", "id");
      const name = stringField(field, "fieldName", "name");
      if (id && name) map.set(name, { id, type: stringField(field, "type") });
    }
    out.set(stringField(table, "tableId", "table_id"), map);
  }
  return out;
}

/* ---------------- 配置读写（cacheDir 相对，0600 原子写，保留已有键） ---------------- */

async function readConfigJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic0600(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(temporary, path);
}

function buildFieldsBlock(
  table: SchemaTable,
  fmap: ReadonlyMap<string, { id: string; type: string }>,
  missing: string[],
): Record<string, { id: string; name: string; type: string }> {
  const fields: Record<string, { id: string; name: string; type: string }> = {};
  for (const field of table.fields) {
    const got = fmap.get(field.fieldName);
    if (!got) {
      missing.push(field.fieldName);
      continue;
    }
    if (field.key) fields[field.key] = { id: got.id, name: field.fieldName, type: field.type };
  }
  return fields;
}

function buildConfig(
  schema: TableSchema,
  baseId: string,
  tableIds: Readonly<Record<string, string>>,
  fieldMaps: ReadonlyMap<string, ReadonlyMap<string, { id: string; type: string }>>,
  missing: string[],
): Record<string, unknown> {
  if (schema.mode === "name") {
    const t = schema.tables[0]!;
    return { baseId, tableId: tableIds[t.tableName] ?? "", tableName: t.tableName };
  }
  if (schema.mode === "fields") {
    const t = schema.tables[0]!;
    const tableId = tableIds[t.tableName] ?? "";
    return { baseId, baseName: BASE_NAME, tableId, tableName: t.tableName, fields: buildFieldsBlock(t, fieldMaps.get(tableId) ?? new Map(), missing) };
  }
  if (schema.mode === "tables-fields") {
    const tables: Record<string, unknown> = {};
    for (const t of schema.tables) {
      const tableId = tableIds[t.tableName] ?? "";
      tables[String(t.key)] = { tableId, tableName: t.tableName, fields: buildFieldsBlock(t, fieldMaps.get(tableId) ?? new Map(), missing) };
    }
    return { baseId, baseName: BASE_NAME, tables };
  }
  const tables: Record<string, unknown> = {};
  for (const t of schema.tables) tables[String(t.key)] = { id: tableIds[t.tableName] ?? "", name: t.tableName };
  return { schemaVersion: 1, baseId, baseName: BASE_NAME, tables };
}

export interface ProvisionDeps {
  readonly run: GuideCommandRunner;
  readonly dwsBin: string;
  readonly cacheDir: string;
  readonly timeoutMs?: number;
}

async function existingBaseId(schemas: readonly TableSchema[], cacheDir: string): Promise<string> {
  for (const schema of schemas) {
    const config = await readConfigJson(join(cacheDir, schema.configFile));
    if (config && typeof config.baseId === "string" && config.baseId) return config.baseId;
  }
  return "";
}

/** 一键建表并写配置；失败抛 GuidesBridgeError("guides_provision_failed")（已脱敏）。 */
export async function provisionSchemas(ids: readonly string[], deps: ProvisionDeps): Promise<ProvisionResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DWS_TIMEOUT_MS;
  const schemas = ids.map((id) => {
    const schema = schemaOf(id);
    if (!schema) throw provisionFailed("schema", `未知 schema：${id}`);
    return schema;
  });

  try {
    if (!(await authOk(deps.run, deps.dwsBin, timeoutMs))) {
      throw new GuidesBridgeError("guides_provision_failed", "钉钉授权未完成：终端执行 dws auth login 后重试");
    }
  } catch (error) {
    if (error instanceof GuidesBridgeError) throw error;
    throw new GuidesBridgeError("guides_provision_failed", `登录态检测失败：${redactNote(error instanceof Error ? error.message : error)}`);
  }

  const wanted: { schema: TableSchema; table: SchemaTable }[] = [];
  for (const schema of schemas) for (const table of schema.tables) wanted.push({ schema, table });

  let baseId = await existingBaseId(schemas, deps.cacheDir);
  const existing = baseId
    ? await listTables(deps.run, deps.dwsBin, baseId, timeoutMs).catch(() => [] as readonly { name: string; tableId: string }[])
    : [];
  const existByName = new Map(existing.map((t) => [t.name, t.tableId]));
  const plan = wanted.map((w) => ({
    schemaId: w.schema.id,
    tableName: w.table.tableName,
    action: (existByName.has(w.table.tableName) ? "reuse" : "create") as "reuse" | "create" | "created-with-base",
  }));

  const tableIds: Record<string, string> = {};
  try {
    if (!baseId) {
      const first = wanted[0]!;
      baseId = await createBase(deps.run, deps.dwsBin, BASE_NAME, [first.table], timeoutMs);
      plan[0] = { ...plan[0]!, action: "created-with-base" };
      const created = await listTables(deps.run, deps.dwsBin, baseId, timeoutMs);
      const hit = created.find((t) => t.name === first.table.tableName);
      if (!hit) throw new Error(`新建 base 后未找到表 ${first.table.tableName}`);
      tableIds[first.table.tableName] = hit.tableId;
      for (const w of wanted.slice(1)) tableIds[w.table.tableName] = await addTable(deps.run, deps.dwsBin, baseId, w.table, timeoutMs);
    } else {
      for (const w of wanted) {
        tableIds[w.table.tableName] = existByName.get(w.table.tableName)
          ?? (await addTable(deps.run, deps.dwsBin, baseId, w.table, timeoutMs));
      }
    }
  } catch (error) {
    if (error instanceof GuidesBridgeError) throw error;
    throw provisionFailed("create", error instanceof Error ? error.message : String(error));
  }

  let fieldMaps: ReadonlyMap<string, ReadonlyMap<string, { id: string; type: string }>>;
  try {
    fieldMaps = await tableFields(deps.run, deps.dwsBin, baseId, Object.values(tableIds), timeoutMs);
  } catch (error) {
    if (error instanceof GuidesBridgeError) throw error;
    throw provisionFailed("readback", `字段读回失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const configs = [];
  for (const schema of schemas) {
    const missing: string[] = [];
    const patch = buildConfig(schema, baseId, tableIds, fieldMaps, missing);
    const path = join(deps.cacheDir, schema.configFile);
    const existingConfig = (await readConfigJson(path)) ?? {};
    delete existingConfig.$comment;
    const merged: Record<string, unknown> = { ...existingConfig, ...patch };
    for (const [key, value] of Object.entries(schema.extra ?? {})) {
      if (merged[key] === undefined) merged[key] = value;
    }
    await writeJsonAtomic0600(path, merged);
    configs.push({ id: schema.id, file: schema.configFile, tableCount: schema.tables.length, missing });
  }
  return { ok: true, baseId, baseName: BASE_NAME, plan, configs };
}

/** 校验：配置在盘 + 远端表字段覆盖必需项（不写任何东西）。 */
export async function verifySchema(id: string, deps: ProvisionDeps): Promise<{ ok: boolean; note: string }> {
  const schema = schemaOf(id);
  if (!schema) return { ok: false, note: `未知 schema：${id}` };
  const config = await readConfigJson(join(deps.cacheDir, schema.configFile));
  if (!config || typeof config.baseId !== "string" || !config.baseId) {
    return { ok: false, note: `缺少接入配置 ${schema.configFile}（可经本向导一键建表接入）` };
  }
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DWS_TIMEOUT_MS;
  const tablesRecord = (config.tables && typeof config.tables === "object" ? config.tables : {}) as Record<string, Record<string, unknown>>;
  const tableIds = schema.mode === "name" || schema.mode === "fields"
    ? [String(config.tableId ?? "")]
    : schema.mode === "tables-fields"
      ? schema.tables.map((t) => String(tablesRecord[String(t.key)]?.tableId ?? ""))
      : schema.tables.map((t) => String(tablesRecord[String(t.key)]?.id ?? ""));
  if (tableIds.some((x) => !x)) return { ok: false, note: "配置里 tableId 不齐" };

  let maps: ReadonlyMap<string, ReadonlyMap<string, { id: string; type: string }>>;
  try {
    maps = await tableFields(deps.run, deps.dwsBin, String(config.baseId), tableIds, timeoutMs);
  } catch (error) {
    return { ok: false, note: redactNote(error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
  const missing: string[] = [];
  if (schema.mode === "name") {
    const map = maps.get(tableIds[0]!) ?? new Map();
    for (const name of schema.requiredNames ?? []) if (!map.has(name)) missing.push(name);
  } else {
    for (const table of schema.tables) {
      const tid = schema.mode === "tables-fields"
        ? String(tablesRecord[String(table.key)]?.tableId ?? "")
        : schema.mode === "idonly"
          ? String(tablesRecord[String(table.key)]?.id ?? "")
          : tableIds[0]!;
      const map = maps.get(tid) ?? new Map();
      for (const field of table.fields) if (!map.has(field.fieldName)) missing.push(`${table.tableName}.${field.fieldName}`);
    }
  }
  return missing.length
    ? { ok: false, note: `远端缺字段：${missing.join("、").slice(0, 240)}` }
    : { ok: true, note: "表结构与必需字段齐备" };
}
