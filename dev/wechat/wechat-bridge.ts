/**
 * Wechat bridge（微信办公台账）— 只读快照投影 + 本地绑定写的 HTTP 桥。
 * donor: base/sa-workbench scripts/bridge.js GET /wechat + PUT /wechat(action=bind)
 * + scripts/lib/custorg.js（导入语义）、assets/pages/wechat.js（台账/待办/单聊/qr-tree
 * 页面语义）——搬语义不搬代码。响应形状沿 reply/worklog 桥先例（{ok,data}/{ok:false,error}）。
 *
 * 路由（WECHAT_ROUTES）：
 * - GET    /local/wechat                快照白名单投影（缺失 → 200 status:"missing" + 修复指引）
 * - GET    /local/wechat/bindings       群↔客户绑定台账（含审计尾）
 * - PUT    /local/wechat/bindings       本地台账写（白名单校验；0600 原子 + 备份 + 单飞 + 审计）
 * - DELETE /local/wechat/bindings       解绑（同闸门）
 * - POST   /local/wechat/custorg-import dry→confirm 两步（confirm 严格 === token 才写盘）
 * - GET    /local/wechat/custorg        本地客户组织台账只读回显（导入可核对，不是只写）
 * - GET    /local/wechat/tree           qr-tree 分组只读（客户 → 群 两层树）
 * 非本桥路径 handle() 返回 undefined，交回主路由（local-router 委托契约）。
 *
 * 红线：快照只读、绝不触碰解密库/密钥；消息正文只出 ≤24 字掩码；个人 wxid 不出桥；
 * 本地文件写全走 0600/原子/备份/单飞/审计；错误消息不含服务器绝对路径；无凭据接触。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { DEFAULT_AGENTS_CONFIG_PATH, sanitizeAgentsConfig } from "../agents/agents-config.ts";
import {
  buildWechatQrTree,
  type WechatQrTreeView,
  type WechatSnapshotView,
} from "../../src/lib/wechat-model.ts";
import { diffCustorgImport, custorgToken, parseCustorgImport } from "./wechat-custorg.ts";
import { missingWechatSnapshotView, projectWechatSnapshot, readSnapshotText } from "./wechat-snapshot.ts";
import { createWechatStore, DEFAULT_WECHAT_DIR, type WechatStore } from "./wechat-store.ts";
import {
  WechatBridgeError,
  WECHAT_BIND_NOTE_MAX,
  WECHAT_CUST_KEY_MAX,
  WECHAT_CUSTORG_MAX_TEXT,
  WECHAT_GROUP_ID_PATTERN,
  WECHAT_MAX_BODY_BYTES,
  WECHAT_MAX_CUST_KEYS,
  WECHAT_ROUTES,
  type WechatBindingsView,
  type WechatBridge,
  type WechatCustorgImportResult,
  type WechatCustorgLedgerEntry,
  type WechatCustorgLedgerView,
  type WechatErrorCode,
} from "./wechat-types.ts";

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface WechatBridgeOptions {
  /** bindings/custorg 台账目录（缺省 .local-cache/wechat；测试注入临时目录）。 */
  readonly dir?: string;
  /** 显式快照路径覆盖（缺省读 agents 配置的 wechat.snapshotPath）。 */
  readonly snapshotPath?: string;
  /** agents 配置路径（缺省 .local-cache/agents.json；测试注入临时配置）。 */
  readonly configPath?: string;
  readonly now?: () => number;
  readonly store?: WechatStore;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

/** 稳定错误码 → HTTP：400 校验 / 404 台账缺行 / 405 方法 / 409 单飞与确认闸门 / 500 存储 / 502 未知。 */
function statusFor(code: WechatErrorCode): number {
  if (code === "method_not_allowed") return 405;
  if (code === "binding_not_found") return 404;
  if (code === "wechat_busy" || code === "confirm_mismatch") return 409;
  if (code === "wechat_store_failed") return 500;
  if (code === "wechat_unavailable") return 502;
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new WechatBridgeError("wechat_invalid_request", "请求体必须是 JSON 对象。");
  }
  return body;
}

/** 群 id 白名单形态：微信 chatroom id；个人 wxid / 路径穿越 / 空串一律如实拒绝。 */
function groupIdOf(body: Record<string, unknown>): string {
  const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
  if (!groupId || !WECHAT_GROUP_ID_PATTERN.test(groupId)) {
    throw new WechatBridgeError(
      "wechat_invalid_request",
      "群 id 形态不合法：必须是微信 chatroom id（…@chatroom，≤64 位前缀），个人 wxid 与路径字符一律拒绝。",
    );
  }
  return groupId;
}

/** custKeys 白名单：字符串数组、逐个非空 ≤40 字、去重后 ≤8 个；空数组 = 清除人工绑定（合法）。 */
function custKeysOf(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.custKeys)) {
    throw new WechatBridgeError("wechat_invalid_request", "custKeys 必须是客户键字符串数组（空数组 = 清除人工绑定）。");
  }
  const keys: string[] = [];
  for (const raw of body.custKeys) {
    if (typeof raw !== "string") {
      throw new WechatBridgeError("wechat_invalid_request", "custKeys 含非字符串项：客户键必须是字符串。");
    }
    const key = raw.trim();
    if (!key) continue;
    if (key.length > WECHAT_CUST_KEY_MAX) {
      throw new WechatBridgeError("wechat_invalid_request", `客户键超过 ${WECHAT_CUST_KEY_MAX} 字：请用客户短名（如「甲科技（合成）」）。`);
    }
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length > WECHAT_MAX_CUST_KEYS) {
    throw new WechatBridgeError("wechat_invalid_request", `每群最多绑定 ${WECHAT_MAX_CUST_KEYS} 个客户键（当前 ${keys.length} 个）。`);
  }
  return keys;
}

function noteOf(body: Record<string, unknown>): string {
  if (body.note === undefined || body.note === null) return "";
  if (typeof body.note !== "string") {
    throw new WechatBridgeError("wechat_invalid_request", "备注必须是字符串。");
  }
  const note = body.note.trim();
  if (note.length > WECHAT_BIND_NOTE_MAX) {
    throw new WechatBridgeError("wechat_invalid_request", `备注超过 ${WECHAT_BIND_NOTE_MAX} 字：请精简后重试。`);
  }
  return note;
}

export function createWechatBridge(options: WechatBridgeOptions = {}): WechatBridge {
  const store = options.store ?? createWechatStore(resolvePath(options.dir ?? DEFAULT_WECHAT_DIR), { now: options.now });
  const configPath = options.configPath ?? DEFAULT_AGENTS_CONFIG_PATH;

  /** 快照路径：显式覆盖 > agents 配置 wechat.snapshotPath（复用既有配置口径，只读）。 */
  async function resolveSnapshotPath(): Promise<string> {
    const override = (options.snapshotPath ?? "").trim();
    if (override) return override;
    try {
      const config = sanitizeAgentsConfig(JSON.parse(await readFile(configPath, "utf-8")), homedir());
      return config.wechat.snapshotPath.trim();
    } catch {
      return ""; // 配置缺失/坏 JSON：如实按未配置处理（missing 指引）
    }
  }

  async function snapshot(): Promise<WechatSnapshotView> {
    const path = await resolveSnapshotPath();
    if (!path) return missingWechatSnapshotView("no-path", "");
    const text = await readSnapshotText(path);
    if (text === null) return missingWechatSnapshotView("no-file", "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return missingWechatSnapshotView("malformed", "");
    }
    const bindings = await store.loadBindings();
    const view = projectWechatSnapshot(parsed, bindings.entries);
    return view.status === "ok" ? view : missingWechatSnapshotView("template", "");
  }

  async function tree(): Promise<WechatQrTreeView> {
    const view = await snapshot();
    if (view.status !== "ok") {
      return { status: "missing", missingNote: view.missingNote, steps: view.steps, nodes: [] };
    }
    return { status: "ok", missingNote: "", steps: [], nodes: buildWechatQrTree(view.groups) };
  }

  async function bindings(): Promise<WechatBindingsView> {
    return store.loadBindings();
  }

  async function putBinding(body: unknown): Promise<WechatBindingsView> {
    const record = bodyOf(body);
    const entry = { groupId: groupIdOf(record), custKeys: custKeysOf(record), note: noteOf(record) };
    return store.putBinding(entry);
  }

  async function deleteBinding(body: unknown): Promise<WechatBindingsView> {
    return store.deleteBinding(groupIdOf(bodyOf(body)));
  }

  async function custorgImport(body: unknown): Promise<WechatCustorgImportResult> {
    const record = bodyOf(body);
    if (typeof record.text !== "string" || !record.text.trim()) {
      throw new WechatBridgeError("wechat_invalid_request", "缺少导入文本：body.text 必须为非空字符串（JSON 或 CSV/TSV）。");
    }
    const text = record.text;
    if (text.length > WECHAT_CUSTORG_MAX_TEXT) {
      throw new WechatBridgeError("wechat_invalid_request", `导入文本超过 ${WECHAT_CUSTORG_MAX_TEXT} 字符：请拆分后分批导入。`);
    }
    const parsed = parseCustorgImport(text);
    if (!parsed.ok) {
      throw new WechatBridgeError("wechat_invalid_request", `导入内容解析失败：${parsed.note}`);
    }
    const token = custorgToken(text);

    if (record.confirm !== undefined) {
      /* confirm 闸门：严格 === 本次文本 token，否则一个字都不写（防 dry/confirm 间偷换内容）。 */
      if (typeof record.confirm !== "string" || record.confirm !== token || record.token !== token) {
        throw new WechatBridgeError(
          "confirm_mismatch",
          "确认未完成：confirm 必须严格等于本次文本的 dry token（文本变化后旧 token 失效）。本次未写入任何内容。",
        );
      }
      const saved = await store.saveCustorgMerge(parsed.customers, {
        customers: parsed.customerCount,
        rows: parsed.rowCount,
      });
      return {
        phase: "confirmed",
        token,
        customerCount: parsed.customerCount,
        rowCount: parsed.rowCount,
        totalCustomers: saved.totalCustomers,
        totalRows: saved.totalRows,
        updatedAt: saved.updatedAt,
      };
    }

    const existing = await store.loadCustorg();
    const diff = diffCustorgImport(parsed.customers, existing.customers);
    return {
      phase: "dry",
      token,
      customerCount: parsed.customerCount,
      rowCount: parsed.rowCount,
      willImport: diff.willImport,
      willOverwrite: diff.willOverwrite,
      note: `确认导入请再次 POST：{text, token:"${token}", confirm:"${token}"}（confirm 严格 === token 才写本地 custorg.json）。`,
    };
  }

  /**
   * custorg 台账只读回显：客户按 key 稳定排序（响应可复现，不受对象插入序影响）；
   * name 缺失回落 key；空台账如实空数组 + 空 updatedAt（绝不编造样例数据）。
   * 只读 store.loadCustorg()，坏行在 store 投影层已被丢弃，这里不再猜。
   */
  async function custorg(): Promise<WechatCustorgLedgerView> {
    const doc = await store.loadCustorg();
    const customers: WechatCustorgLedgerEntry[] = Object.entries(doc.customers)
      .map(([key, customer]) => ({
        key,
        name: customer.name.trim() || key,
        rows: customer.items,
        rowCount: customer.items.length,
      }))
      .sort((a, b) => a.key.localeCompare(b.key, "zh-Hans-CN"));
    return {
      updatedAt: doc.updatedAt,
      customers,
      totalCustomers: customers.length,
      totalRows: customers.reduce((sum, customer) => sum + customer.rowCount, 0),
    };
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > WECHAT_MAX_BODY_BYTES) {
      throw new WechatBridgeError("wechat_invalid_request", "请求体过大：本地服务整机上限 40KB，导入文本请拆分。");
    }
    const text = await request.text();
    if (text.length > WECHAT_MAX_BODY_BYTES) {
      throw new WechatBridgeError("wechat_invalid_request", "请求体过大：本地服务整机上限 40KB，导入文本请拆分。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new WechatBridgeError("wechat_invalid_request", "请求体不是合法 JSON。");
    }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    /* 路由按 path+method 双键匹配：同一路径挂多方法（bindings GET/PUT/DELETE），
     * 只按 path 找第一条会把 PUT/DELETE 误判成 405。 */
    const candidates = WECHAT_ROUTES.filter((entry) => entry.path === path);
    if (!candidates.length) return undefined; // 非 wechat 路径：交回主路由
    const route = candidates.find((entry) => entry.method === request.method);
    if (!route) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "method_not_allowed",
            message: `${path} 只接受 ${candidates.map((entry) => entry.method).join(" / ")}。`,
          },
        },
        405,
      );
    }
    try {
      if (route.operation === "snapshot") return jsonResponse({ ok: true, data: await snapshot() });
      if (route.operation === "tree") return jsonResponse({ ok: true, data: await tree() });
      if (route.operation === "bindings-list") return jsonResponse({ ok: true, data: await bindings() });
      if (route.operation === "bindings-put") return jsonResponse({ ok: true, data: await putBinding(await readBody(request)) });
      if (route.operation === "bindings-delete") return jsonResponse({ ok: true, data: await deleteBinding(await readBody(request)) });
      if (route.operation === "custorg-list") return jsonResponse({ ok: true, data: await custorg() });
      return jsonResponse({ ok: true, data: await custorgImport(await readBody(request)) });
    } catch (error) {
      if (error instanceof WechatBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "wechat_unavailable", message: "微信台账服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { snapshot, bindings, putBinding, deleteBinding, custorgImport, custorg, tree, handle };
}
