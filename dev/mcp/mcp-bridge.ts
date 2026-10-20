import { randomBytes as nodeRandomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { createAuditLog, type McpAuditLog } from "./mcp-audit.ts";
import {
  createConnectorRegistry,
  defaultConnectorSources,
  type ConnectorRegistry,
  type ConnectorSourceSpec,
} from "./mcp-connector.ts";
import { createKeyStore, isValidScopes, type McpKeyStore } from "./mcp-keys.ts";
import { buildMcpTools, scopesOf, type McpTool } from "./mcp-tools.ts";
import {
  McpBridgeError,
  MCP_AUDIT_TAIL,
  MCP_CONNECTOR_NAME_MAX,
  MCP_DRY_TOKEN_CAP,
  MCP_DRY_TOKEN_TTL_MS,
  MCP_ROUTES,
  MCP_SCOPES,
  type McpBridge,
  type McpCheckView,
  type McpConfirmResult,
  type McpConnectorOp,
  type McpConnectorsView,
  type McpDryResult,
  type McpErrorCode,
  type McpKeyCreateResult,
  type McpKeyView,
  type McpKeysView,
  type McpScope,
  type McpServiceState,
  type McpSpawnFn,
  type McpToggleResult,
} from "./mcp-types.ts";
import type { WritePlan } from "./mcp-connector.ts";

/**
 * MCP bridge — 服务状态 / API KEY 管理 / 连接器发现·体检·dry→confirm 写。
 * donor: scripts/lib/mcpserver/index.js + scripts/lib/mcp.js + bridge.js /mcp* 路由语义。
 *
 * 红线（与任务口径一致，不可放宽）：
 * - key 明文只在创建应答出现一次；落盘/审计/视图一律 sha256（对外只报前 8 位 hint）；
 * - 审计 append-only jsonl 0600，绝不落 key 材料（旁路：写失败不阻断主流程但如实尽力）；
 * - 服务默认关；toggle 需 body.confirm 严格 === true（布尔）才生效；
 * - 连接器写一律 dry→confirm：confirm 严格 === dry 铸造的一次性 token，写前备份 .bak、
 *   原子写、失败回滚如实报错；体检与写入各有单飞锁防并发；
 * - JSON-RPC 入口（mcp-rpc.ts）为纯函数，本批不挂监听端口。
 */

/* dev/mcp/ 位于 dev/ 下，上跳两级才是项目根。 */
const PROJECT_ROOT = resolvePath(import.meta.dirname, "..", "..");
const DEFAULT_MCP_DIR = joinPath(PROJECT_ROOT, ".local-cache", "mcp");

/** 请求体体积上限：普通路由 16KB；dry 定义可能带 env/headers，放宽到 64KB。 */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DRY_BODY_BYTES = 64 * 1024;

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface McpBridgeOptions {
  /** 存储目录（缺省 .local-cache/mcp；测试注入临时目录）。 */
  readonly dir?: string;
  /** 宿主 home（~ 展示与默认连接器来源；测试注入临时目录）。 */
  readonly home?: string;
  readonly now?: () => number;
  readonly randomBytes?: (n: number) => Uint8Array;
  /** stdio 握手注入点（测试合成子进程，零真实 spawn）。 */
  readonly spawnFn?: McpSpawnFn;
  /** HTTP 握手注入点（测试 mock fetch，零真实网络）。 */
  readonly fetchImpl?: typeof fetch;
  /** 连接器来源覆盖（缺省 workbench 本地登记 + ~/.qoder 两处宿主配置只读）。 */
  readonly sources?: readonly ConnectorSourceSpec[];
  /** 宿主配置写开关（缺省 false：宿主来源只读，dry 直接拒绝）。 */
  readonly hostWrite?: boolean;
  readonly keyStore?: McpKeyStore;
  readonly auditLog?: McpAuditLog;
  readonly registry?: ConnectorRegistry;
  /** 单连接器握手超时（缺省 MCP_HANDSHAKE_TIMEOUT_MS；测试用短超时）。 */
  readonly timeoutMs?: number;
  /** 批量体检总预算（缺省 MCP_CHECK_BUDGET_MS）。 */
  readonly budgetMs?: number;
  /** 原子写注入点（回滚测试用）。 */
  readonly writeFileAtomic?: (path: string, text: string, mode: number) => Promise<void>;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...(extraHeaders ?? {}) },
  });
}

function statusFor(code: McpErrorCode): number {
  if (code === "mcp_not_found") return 404;
  if (code === "mcp_confirm_mismatch" || code === "mcp_busy") return 409;
  if (code === "method_not_allowed") return 405;
  if (code === "mcp_store_unavailable") return 503;
  if (code === "mcp_upstream_error" || code === "mcp_unavailable") return 502;
  return 400; // mcp_invalid_request 与未知码兜底前均已显式归类
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bodyOf(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new McpBridgeError("mcp_invalid_request", "请求体必须是 JSON 对象。");
  }
  return raw;
}

/** 首行截断（错误消息出站纪律：不整段回显堆栈）。 */
function firstLine(text: unknown, max = 200): string {
  return String(text ?? "").split("\n")[0].slice(0, max);
}

export function createMcpBridge(options: McpBridgeOptions = {}): McpBridge {
  const dir = options.dir ?? DEFAULT_MCP_DIR;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const randomBytesFn = options.randomBytes ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)));
  const serviceFile = joinPath(dir, "service.json");

  const iso = (): string => new Date(now()).toISOString();
  const randomHex = (n: number): string =>
    Array.from(randomBytesFn(n)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const keyStore = options.keyStore ?? createKeyStore({
    file: joinPath(dir, "keys.json"),
    now,
    randomBytes: options.randomBytes,
  });
  const auditLog = options.auditLog ?? createAuditLog({ file: joinPath(dir, "audit.jsonl"), now });
  const registry = options.registry ?? createConnectorRegistry({
    sources: options.sources ?? defaultConnectorSources({
      home,
      workbenchFile: joinPath(dir, "connectors.json"),
      hostWrite: options.hostWrite === true,
    }),
    home,
    spawnFn: options.spawnFn,
    fetchImpl: options.fetchImpl,
    now,
    timeoutMs: options.timeoutMs,
    budgetMs: options.budgetMs,
    writeFileAtomic: options.writeFileAtomic,
  });

  /** 审计旁路：await 保证应答前落盘，但写失败不阻断主流程（本就不落 key 材料）。 */
  async function audit(action: string, fields: { keyId?: number | null; target?: string; ok?: boolean; note?: string } = {}): Promise<void> {
    await auditLog.append({ action, ...fields }).catch(() => {});
  }

  /* ---------------- 服务开关（默认关，持久化 service.json 0600） ---------------- */

  async function readEnabled(): Promise<boolean> {
    try {
      const doc = JSON.parse(await readFile(serviceFile, "utf-8")) as unknown;
      return isRecord(doc) && doc.enabled === true;
    } catch {
      return false; // 缺失/损坏 → 如实默认关
    }
  }

  async function writeEnabled(enabled: boolean): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${serviceFile}.${process.pid}.${now()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify({ version: 1, enabled, updatedAt: iso() }, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await rename(tmpPath, serviceFile);
      await chmod(serviceFile, 0o600).catch(() => {});
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw new McpBridgeError("mcp_store_unavailable", `服务开关写入失败：${firstLine((error as Error)?.message ?? error)}`);
    }
  }

  /* ---------------- 只读工具目录（JSON-RPC 面复用同一批视图函数） ---------------- */

  let tools: readonly McpTool[] | null = null;
  function toolCatalog(): readonly McpTool[] {
    if (!tools) {
      tools = buildMcpTools({
        serviceState: () => service(),
        keyList: () => keys(),
        connectorList: () => connectors(),
        auditTail: async () => ({ rows: await auditLog.recent(MCP_AUDIT_TAIL) }),
      });
    }
    return tools;
  }

  /* ---------------- 服务状态 / toggle ---------------- */

  async function service(): Promise<McpServiceState> {
    const catalog = toolCatalog();
    const [enabled, keyState, keyViews, auditTail] = await Promise.all([
      readEnabled(),
      keyStore.state(),
      keyStore.list(),
      auditLog.recent(MCP_AUDIT_TAIL),
    ]);
    return {
      enabled,
      tools: catalog.length,
      toolNames: catalog.map((t) => t.name),
      scopes: scopesOf(catalog),
      keys: { active: keyState.active, revoked: keyState.revoked },
      keyViews,
      auditTail,
      rpcMounted: false, // 本批不挂监听端口：JSON-RPC 入口是纯函数（mcp-rpc.ts）
    };
  }

  async function toggle(body: unknown): Promise<McpToggleResult> {
    const req = bodyOf(body);
    const op = req.op;
    if (op !== "enable" && op !== "disable") {
      throw new McpBridgeError("mcp_invalid_request", `未知开关操作：${firstLine(String(op ?? ""), 20)}（可选 enable/disable）。`);
    }
    if (req.confirm !== true) {
      throw new McpBridgeError("mcp_confirm_mismatch", `开关服务需要 body.confirm 严格为布尔 true（收到 ${typeof req.confirm}）。`);
    }
    const enabled = op === "enable";
    await writeEnabled(enabled);
    const at = iso();
    await audit("service_toggle", { target: op, ok: true, note: `enabled=${String(enabled)}` });
    return { enabled, at };
  }

  /* ---------------- API KEY ---------------- */

  /** scope 入参校验：缺省 = 全量白名单；给了就必须逐项合法（拆分归桥层）。 */
  function scopesFrom(raw: unknown): readonly McpScope[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    const list = typeof raw === "string"
      ? raw.split(/[\s,]+/).filter(Boolean)
      : raw;
    if (!Array.isArray(list)) {
      throw new McpBridgeError("mcp_invalid_request", "scope 必须是数组或逗号分隔字符串（取值 service/keys/connectors/meta）。");
    }
    const bad = list.filter((s) => typeof s !== "string" || !(MCP_SCOPES as readonly string[]).includes(s));
    if (bad.length || !isValidScopes(list)) {
      const shown = bad.map((b) => firstLine(String(b), 30)).join(", ");
      throw new McpBridgeError(
        "mcp_invalid_request",
        shown
          ? `未知 scope：${shown}（白名单：${MCP_SCOPES.join("/")}）。`
          : "scope 不能为空数组：要么缺省（全量白名单），要么给合法项。",
      );
    }
    return MCP_SCOPES.filter((s) => (list as readonly string[]).includes(s));
  }

  async function createKey(body: unknown): Promise<McpKeyCreateResult> {
    const req = bodyOf(body);
    const name = typeof req.name === "string" ? req.name.trim() : "";
    if (!name || name.length > 60) {
      throw new McpBridgeError("mcp_invalid_request", "缺少 name：body.name 必须为 1–60 位非空字符串（便于审计追溯）。");
    }
    const scopes = scopesFrom(req.scope);
    const note = typeof req.note === "string" ? req.note.slice(0, 200) : "";
    let result: McpKeyCreateResult;
    try {
      result = await keyStore.add(name, { ...(scopes ? { scopes } : {}), note });
    } catch (error) {
      if (error instanceof McpBridgeError) throw error;
      throw new McpBridgeError("mcp_store_unavailable", `key 存储写入失败：${firstLine((error as Error)?.message ?? error)}`);
    }
    // 审计只落 hashPrefix 级引用——明文绝不进审计。
    await audit("key_created", { keyId: result.record.id, target: name, ok: true, note: `hashPrefix ${result.record.hashPrefix}` });
    return result; // 明文仅此一次：之后任何应答只出现 hashPrefix
  }

  async function revokeKey(body: unknown): Promise<McpKeyView> {
    const req = bodyOf(body);
    const keyId = typeof req.keyId === "number" && Number.isInteger(req.keyId)
      ? req.keyId
      : (typeof req.keyId === "string" && /^\d+$/.test(req.keyId.trim()) ? Number(req.keyId.trim()) : null);
    if (keyId === null) {
      throw new McpBridgeError("mcp_invalid_request", "缺少 keyId：body.keyId 必须为正整数。");
    }
    if (typeof req.confirm !== "string" || req.confirm !== String(keyId)) {
      throw new McpBridgeError("mcp_confirm_mismatch", `吊销需要 body.confirm 严格等于字符串 "${String(keyId)}"。`);
    }
    let view: McpKeyView | null;
    try {
      view = await keyStore.revoke(keyId);
    } catch (error) {
      throw new McpBridgeError("mcp_store_unavailable", `key 存储写入失败：${firstLine((error as Error)?.message ?? error)}`);
    }
    if (!view) {
      throw new McpBridgeError("mcp_not_found", `没有这个可吊销的 key：id=${String(keyId)}（不存在或已吊销）。`);
    }
    await audit("key_revoked", { keyId: view.id, target: view.name, ok: true, note: `hashPrefix ${view.hashPrefix}` });
    return view;
  }

  async function keys(): Promise<McpKeysView> {
    const [views, state] = await Promise.all([keyStore.list(), keyStore.state()]);
    return { keys: views, active: state.active, revoked: state.revoked, scopes: [...MCP_SCOPES] };
  }

  /* ---------------- 连接器：发现 / 体检（单飞） / dry→confirm（单飞） ---------------- */

  async function connectors(): Promise<McpConnectorsView> {
    return registry.discover();
  }

  let checkInFlight = false;
  async function check(body?: unknown): Promise<McpCheckView> {
    const req = body === undefined || body === null ? {} : bodyOf(body);
    const rawName = typeof req.name === "string" ? req.name.trim() : "";
    if (rawName && rawName.length > MCP_CONNECTOR_NAME_MAX) {
      throw new McpBridgeError("mcp_invalid_request", `连接器名过长（≤${String(MCP_CONNECTOR_NAME_MAX)} 字符）。`);
    }
    const all = req.all === true;
    if (checkInFlight) {
      throw new McpBridgeError("mcp_busy", "已有一轮体检在跑：等它结束再试（体检会真起 stdio 子进程，不并发放行）。");
    }
    checkInFlight = true; // 同步上锁：并发请求在第一个 await 前即被拒
    try {
      const view = await registry.check({ ...(rawName ? { name: rawName } : {}), all });
      await audit("connector_check", { target: rawName || "*", ok: true, note: `attempted ${String(view.attempted)} skipped ${String(view.skipped)}` });
      return view;
    } finally {
      checkInFlight = false;
    }
  }

  /** 未消费 dry token（内存态：重启即作废；TTL 惰性判定 + 上限淘汰最早）。 */
  const pendingDry = new Map<string, { plan: WritePlan; expiresAt: number }>();

  async function dry(body: unknown): Promise<McpDryResult> {
    const req = bodyOf(body);
    const op = typeof req.op === "string" ? req.op : "";
    const role = typeof req.role === "string" ? req.role : "";
    const name = typeof req.name === "string" ? req.name : "";
    const plan = await registry.plan(op as McpConnectorOp, role, name, req.def);
    const token = randomHex(24);
    const expiresAt = now() + MCP_DRY_TOKEN_TTL_MS;
    const t = now();
    for (const [k, v] of pendingDry) if (v.expiresAt <= t) pendingDry.delete(k);
    pendingDry.set(token, { plan, expiresAt });
    while (pendingDry.size > MCP_DRY_TOKEN_CAP) pendingDry.delete(pendingDry.keys().next().value as string);
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      op: plan.op,
      role: plan.role,
      name: plan.name,
      existed: plan.existed,
      target: { shown: plan.source.shown, role: plan.source.role, dot: plan.source.dot },
      diff: { before: plan.diffBefore, after: plan.diffAfter },
      note: "dry-run 未写入任何文件：确认 diff 后 POST /local/mcp/connectors/confirm，body.confirm 严格等于本次 token（一次性，5 分钟内有效）。",
    };
  }

  let writeInFlight = false;
  async function confirm(body: unknown): Promise<McpConfirmResult> {
    const req = bodyOf(body);
    const token = req.confirm;
    if (typeof token !== "string" || !token) {
      throw new McpBridgeError("mcp_confirm_mismatch", "写入需要 body.confirm 严格等于 dry 铸造的一次性 token。");
    }
    const entry = pendingDry.get(token);
    const t = now();
    if (!entry || entry.expiresAt <= t) {
      if (entry) pendingDry.delete(token);
      throw new McpBridgeError("mcp_confirm_mismatch", "token 不存在、已过期或已消费：请重新 dry 获取（token 一次性有效）。");
    }
    if (writeInFlight) {
      throw new McpBridgeError("mcp_busy", "已有一笔连接器写入在进行：等它结束再试（写宿主配置不并发放行）。");
    }
    pendingDry.delete(token); // 先消费后写：失败也不留可重放 token
    writeInFlight = true;
    try {
      const result = await registry.apply(entry.plan);
      await audit("connector_write", { target: `${entry.plan.role}:${entry.plan.op}:${entry.plan.name}`, ok: true, note: `existed=${String(entry.plan.existed)}` });
      return result;
    } catch (error) {
      await audit("connector_write", { target: `${entry.plan.role}:${entry.plan.op}:${entry.plan.name}`, ok: false, note: firstLine((error as Error)?.message ?? error, 160) });
      throw error;
    } finally {
      writeInFlight = false;
    }
  }

  /* ---------------- 子路由 ---------------- */

  async function readBody(request: Request, limit: number): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > limit) {
      throw new McpBridgeError("mcp_invalid_request", `请求体过大（上限 ${String(Math.floor(limit / 1024))}KB）。`);
    }
    const text = await request.text();
    if (text.length > limit) {
      throw new McpBridgeError("mcp_invalid_request", `请求体过大（上限 ${String(Math.floor(limit / 1024))}KB）。`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new McpBridgeError("mcp_invalid_request", "请求体不是合法 JSON。");
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
    const pathRoutes = MCP_ROUTES.filter((entry) => entry.path === path);
    if (!pathRoutes.length) return undefined; // 非本桥路径：交回主路由
    const route = pathRoutes.find((entry) => entry.method === request.method);
    if (!route) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${pathRoutes.map((r) => r.method).join("/")}。` } },
        405,
      );
    }
    try {
      if (route.operation === "service") return jsonResponse({ ok: true, data: await service() });
      if (route.operation === "keys") return jsonResponse({ ok: true, data: await keys() });
      if (route.operation === "connectors") return jsonResponse({ ok: true, data: await connectors() });
      if (route.operation === "createKey") return jsonResponse({ ok: true, data: await createKey(await readBody(request, MAX_BODY_BYTES)) });
      if (route.operation === "revokeKey") return jsonResponse({ ok: true, data: await revokeKey(await readBody(request, MAX_BODY_BYTES)) });
      if (route.operation === "toggle") return jsonResponse({ ok: true, data: await toggle(await readBody(request, MAX_BODY_BYTES)) });
      if (route.operation === "check") return jsonResponse({ ok: true, data: await check(await readBody(request, MAX_BODY_BYTES)) });
      if (route.operation === "dry") return jsonResponse({ ok: true, data: await dry(await readBody(request, MAX_DRY_BODY_BYTES)) });
      return jsonResponse({ ok: true, data: await confirm(await readBody(request, MAX_BODY_BYTES)) });
    } catch (error) {
      if (error instanceof McpBridgeError) {
        return jsonResponse(
          { ok: false, error: { code: error.code, message: error.message } },
          statusFor(error.code),
          error.code === "mcp_busy" ? { "Retry-After": "10" } : undefined,
        );
      }
      return jsonResponse(
        { ok: false, error: { code: "mcp_unavailable", message: `MCP 服务遇到未知故障：${firstLine((error as Error)?.message ?? error, 160)}` } },
        502,
      );
    }
  }

  return { service, createKey, revokeKey, keys, toggle, connectors, check, dry, confirm, handle };
}
