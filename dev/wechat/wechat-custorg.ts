/**
 * Wechat custorg（微信办公桥）— 客户组织台账导入解析（dry→confirm 的纯计算层）。
 * donor: base/sa-workbench scripts/lib/custorg.js（JSON 三形态 + CSV/TSV、按客户键
 * 整体替换的合并语义、行数/客户数上限）——搬语义不搬代码。
 *
 * 口径：
 * - 解析只收字符串字段并截断（客户 40 / dept·name·title 40 / contact 60）；
 * - 有效行 = 有客户键且 dept/name/title 至少一项；坏行丢弃不猜；
 * - token = sha256(trim 后文本) 前 16 位十六进制：dry 出 token，confirm 必须
 *   严格 === 且与当次文本重算一致（防 dry/confirm 之间偷换内容）；
 * - diff 只报「将导入（新键）/ 将覆盖（已有键，双侧行数）」摘要，不落盘。
 */

import { createHash } from "node:crypto";

import {
  WECHAT_CUST_KEY_MAX,
  WECHAT_CUSTORG_MAX_CUSTOMERS,
  WECHAT_CUSTORG_MAX_ROWS_PER_CUSTOMER,
  WECHAT_CUSTORG_MAX_TEXT,
  type WechatCustorgCustomer,
  type WechatCustorgDiffEntry,
  type WechatCustorgParseOk,
  type WechatCustorgParseResult,
  type WechatCustorgRow,
} from "./wechat-types.ts";

/** 导入 token：sha256(trim 文本) 前 16 位（confirm 严格 === 才写盘）。 */
export function custorgToken(text: string): string {
  return createHash("sha256").update(String(text ?? "").trim(), "utf-8").digest("hex").slice(0, 16);
}

function clampStr(value: unknown, max: number): string {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : "";
}

function rowOf(raw: unknown): WechatCustorgRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const row: WechatCustorgRow = {
    dept: clampStr(record.dept, WECHAT_CUST_KEY_MAX),
    name: clampStr(record.name, WECHAT_CUST_KEY_MAX),
    title: clampStr(record.title, WECHAT_CUST_KEY_MAX),
    contact: clampStr(record.contact, 60),
  };
  return row.dept || row.name || row.title ? row : null;
}

type MutableMap = Record<string, { name: string; items: WechatCustorgRow[] }>;

function put(map: MutableMap, key: unknown, row: unknown): number {
  const k = clampStr(key, WECHAT_CUST_KEY_MAX);
  if (!k) return 0;
  const parsed = rowOf(row);
  if (!parsed) return 0;
  if (!map[k]) map[k] = { name: "", items: [] };
  if (map[k].items.length >= WECHAT_CUSTORG_MAX_ROWS_PER_CUSTOMER) return 0;
  map[k].items.push(parsed);
  return 1;
}

function finish(map: MutableMap): WechatCustorgParseResult {
  const keys = Object.keys(map);
  if (!keys.length) {
    return { ok: false, note: "没有解析出任何有效行（需含客户键与部门/姓名/职位至少一项）。" };
  }
  const customers: Record<string, WechatCustorgCustomer> = {};
  let rowCount = 0;
  for (const key of keys.slice(0, WECHAT_CUSTORG_MAX_CUSTOMERS)) {
    const items = map[key].items.slice(0, WECHAT_CUSTORG_MAX_ROWS_PER_CUSTOMER);
    customers[key] = { name: map[key].name, items };
    rowCount += items.length;
  }
  return { ok: true, customers, customerCount: Object.keys(customers).length, rowCount };
}

function parseJson(text: string): WechatCustorgParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, note: `JSON 解析失败：${String((error as Error)?.message ?? error).slice(0, 80)}` };
  }
  const map: MutableMap = {};
  const walkItems = (key: unknown, items: unknown): void => {
    for (const item of Array.isArray(items) ? items : []) put(map, key, item);
  };
  if (Array.isArray(doc)) {
    for (const item of doc) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        put(map, record.customer ?? record.custKey ?? record.name, item);
      }
    }
  } else if (doc && typeof doc === "object") {
    const record = doc as Record<string, unknown>;
    const source = record.customers && typeof record.customers === "object" && !Array.isArray(record.customers)
      ? (record.customers as Record<string, unknown>)
      : record;
    for (const [key, value] of Object.entries(source)) {
      if (Array.isArray(value)) {
        walkItems(key, value);
      } else if (value && typeof value === "object") {
        const customer = value as Record<string, unknown>;
        const name = clampStr(customer.name, WECHAT_CUST_KEY_MAX);
        if (name) {
          const k = clampStr(key, WECHAT_CUST_KEY_MAX);
          if (k) map[k] = { name, items: map[k] ? map[k].items : [] };
        }
        walkItems(key, customer.items);
      }
    }
  }
  return finish(map);
}

/** 单元格切分（donor splitCsvLine）：成对双引号包裹、引号内分隔符不切、"" 转义。 */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { out.push(current); current = ""; }
    else current += ch;
  }
  out.push(current);
  return out.map((cell) => cell.trim());
}

function parseCsv(text: string): WechatCustorgParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { ok: false, note: "CSV 至少要有表头行和一行数据。" };
  const sep = lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",";
  const head = splitCsvLine(lines[0], sep).map((h) => h.replace(/^["']|["']$/g, ""));
  const idx = (name: string): number => head.findIndex((h) => h.includes(name));
  /** 表头同义词按序回退（真实组织表「职位/职务/职称」混用）：只认列名，不猜列内容。 */
  const idxAny = (...names: readonly string[]): number => {
    for (const name of names) {
      const at = idx(name);
      if (at >= 0) return at;
    }
    return -1;
  };
  const iCust = idx("客户");
  if (iCust < 0) return { ok: false, note: `表头缺少「客户」列（表头：${head.join("/")}）。` };
  const iDept = idx("部门");
  const iName = idxAny("姓名", "名字", "联系人");
  const iTitle = idxAny("职位", "职务", "职称");
  const iContact = idxAny("联系", "电话", "手机", "邮箱");
  const map: MutableMap = {};
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, sep);
    put(map, cells[iCust], {
      dept: iDept >= 0 ? cells[iDept] : "",
      name: iName >= 0 ? cells[iName] : "",
      title: iTitle >= 0 ? cells[iTitle] : "",
      contact: iContact >= 0 ? cells[iContact] : "",
    });
  }
  return finish(map);
}

/** 导入文本解析（JSON 三形态 / CSV / TSV）：上限如实拒绝，坏行丢弃不猜。 */
export function parseCustorgImport(text: unknown): WechatCustorgParseResult {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, note: "导入内容为空。" };
  if (trimmed.length > WECHAT_CUSTORG_MAX_TEXT) {
    return { ok: false, note: `导入内容超过 ${WECHAT_CUSTORG_MAX_TEXT} 字符（本地服务请求体上限内如实收敛）。` };
  }
  return trimmed[0] === "{" || trimmed[0] === "[" ? parseJson(trimmed) : parseCsv(trimmed);
}

/** dry 阶段 diff：新键 willImport、已有键 willOverwrite（按客户键整体替换语义）。 */
export function diffCustorgImport(
  parsed: Readonly<Record<string, WechatCustorgCustomer>>,
  existing: Readonly<Record<string, WechatCustorgCustomer>>,
): { willImport: readonly WechatCustorgDiffEntry[]; willOverwrite: readonly WechatCustorgDiffEntry[] } {
  const willImport: WechatCustorgDiffEntry[] = [];
  const willOverwrite: WechatCustorgDiffEntry[] = [];
  for (const key of Object.keys(parsed).sort()) {
    const incomingRows = parsed[key].items.length;
    const existingCustomer = existing[key];
    if (existingCustomer) {
      willOverwrite.push({ key, incomingRows, existingRows: existingCustomer.items.length });
    } else {
      willImport.push({ key, incomingRows, existingRows: 0 });
    }
  }
  return { willImport, willOverwrite };
}

export type { WechatCustorgParseOk };
