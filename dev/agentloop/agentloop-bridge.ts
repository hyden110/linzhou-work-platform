/**
 * AgentLoop bridge — 凭据管理 + 只读连接测试 + SLS 两步出票（子路由 handle 闭环）。
 * donor: scripts/lib/agentloop.js + scripts/bridge.js /agentloop/*（搬语义不搬代码）。
 *
 * 数据面：
 * - 凭据落 .local-cache/agentloop/creds.json（0600 原子写），只写不回显，应答一律掩码视图；
 * - 探活视图取 .local-cache/agents.json 的 agentloop.views（沿 F7 页面既有指引，只读消费，
 *   经 sanitizeAgentsConfig 白名单投影）；无视图时 test 如实「异常 + 原因」；
 * - 出票两步闸门：dry 零网络铸造一次性 token（5 分钟有效），confirm 严格比对 token 后
 *   才真实 POST /tickets（cn-shanghai，HMAC-SHA1）；每次真实尝试必落审计（成败都记，票据只落掩码）；
 * - 审计 tickets.jsonl append-only，GET /tickets 回尾 50（最新在前）；
 * - 凭据变更（PUT/DELETE）立即作废全部未消费的 dry token（旧凭据的预检不带入新凭据）。
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { DEFAULT_AGENTS_CONFIG_PATH, sanitizeAgentsConfig, type AgentLoopViewInput } from "../agents/agents-config.ts";
import { maskAccessKey, maskTicket, sanitizeUpstreamDetail, validateCredentials } from "./agentloop-model.ts";
import { createSlsClient, defaultSlsFetch, SlsRequestError } from "./agentloop-sls.ts";
import { createAgentloopStore, DEFAULT_AGENTLOOP_DIR, type AgentloopStore } from "./agentloop-store.ts";
import {
  AgentloopBridgeError,
  AGENTLOOP_DRY_TOKEN_TTL_MS,
  AGENTLOOP_API_VERSION,
  AGENTLOOP_PROBE_TIMEOUT_MS,
  AGENTLOOP_ROUTES,
  AGENTLOOP_SIGNATURE_METHOD,
  AGENTLOOP_TICKETS_TAIL,
  AGENTLOOP_TICKET_HOST,
  AGENTLOOP_TICKET_REGION,
  AGENTLOOP_TICKET_TIMEOUT_MS,
  AGENTLOOP_TICKET_TTL_SEC,
  type AgentloopBridge,
  type AgentloopCreds,
  type AgentloopCredsView,
  type AgentloopErrorCode,
  type AgentloopProbeTarget,
  type AgentloopTestView,
  type AgentloopTicketAudit,
  type AgentloopTicketConfirmView,
  type AgentloopTicketDryView,
  type AgentloopTicketsView,
  type SlsFetch,
} from "./agentloop-types.ts";

/** 请求体体积上限：凭据/confirm token 都是短串，16KB 足够；超限如实拒绝。 */
const MAX_BODY_BYTES = 16 * 1024;
/** 未消费 dry token 上限（防内存无限膨胀；插入序淘汰最早的）。 */
const MAX_PENDING_TOKENS = 100;

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface AgentloopBridgeOptions {
  /** 存储目录（缺省 .local-cache/agentloop；测试注入临时目录）。 */
  readonly dir?: string;
  /** agents.json 路径（只读取 agentloop.views；测试注入临时文件）。 */
  readonly configPath?: string;
  readonly now?: () => number;
  /** SLS 网络注入点（测试用 stub 绝不真联网；缺省真 fetch + 硬超时）。 */
  readonly slsFetch?: SlsFetch;
  readonly store?: AgentloopStore;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function statusFor(code: AgentloopErrorCode): number {
  if (code === "agentloop_not_found") return 404;
  if (code === "method_not_allowed") return 405;
  if (code === "agentloop_creds_missing" || code === "agentloop_confirm_mismatch") return 409;
  if (code === "agentloop_store_unavailable") return 503;
  if (code === "agentloop_upstream_auth" || code === "agentloop_upstream_error" || code === "agentloop_unavailable") return 502;
  return 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createAgentloopBridge(options: AgentloopBridgeOptions = {}): AgentloopBridge {
  const now = options.now ?? Date.now;
  const configPath = options.configPath ?? DEFAULT_AGENTS_CONFIG_PATH;
  const store = options.store ?? createAgentloopStore(options.dir ?? DEFAULT_AGENTLOOP_DIR, { now });
  const sls = createSlsClient(options.slsFetch ?? defaultSlsFetch);

  const iso = (): string => new Date(now()).toISOString();
  const dateGmt = (): string => new Date(now()).toUTCString();

  /** 未消费的 dry token（token → 过期时刻 ms）；内存态，重启即作废（重新预检即可）。 */
  const pendingTokens = new Map<string, number>();

  function invalidatePendingTokens(): void {
    pendingTokens.clear();
  }

  /** 存储故障统一映射 503（内部错误细节不透出）。 */
  async function withStore<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AgentloopBridgeError) throw error;
      console.error(JSON.stringify({
        event: "agentloop_store_failed",
        reason: sanitizeUpstreamDetail(String((error as Error)?.message ?? error), 120),
      }));
      throw new AgentloopBridgeError(
        "agentloop_store_unavailable",
        "凭据存储读写失败（本机 .local-cache/agentloop）：请检查磁盘与权限后重试。",
      );
    }
  }

  function credsViewOf(creds: AgentloopCreds | null): AgentloopCredsView {
    return creds
      ? { set: true, mask: maskAccessKey(creds.ak), updatedAt: creds.updatedAt || null, storage: "file-0600" }
      : { set: false, mask: null, updatedAt: null, storage: "file-0600" };
  }

  async function loadViews(): Promise<readonly AgentLoopViewInput[]> {
    try {
      return sanitizeAgentsConfig(JSON.parse(await readFile(configPath, "utf-8"))).agentloop.views;
    } catch {
      return []; // 配置缺失/损坏：如实「无视图」，探活据此报异常原因
    }
  }

  async function creds(): Promise<AgentloopCredsView> {
    return credsViewOf(await withStore(() => store.loadCreds()));
  }

  async function setCreds(body: unknown): Promise<AgentloopCredsView> {
    if (!isRecord(body)) {
      throw new AgentloopBridgeError("agentloop_invalid_request", "请求体必须是 JSON 对象：{accessKeyId, accessKeySecret}。");
    }
    const reason = validateCredentials(body.accessKeyId, body.accessKeySecret);
    if (reason) {
      throw new AgentloopBridgeError("agentloop_invalid_request", `${reason}：本次未写入任何内容。`);
    }
    invalidatePendingTokens(); // 换号后旧凭据铸造的预检 token 立即作废
    const saved = await withStore(() => store.saveCreds(String(body.accessKeyId), String(body.accessKeySecret)));
    return credsViewOf(saved);
  }

  async function clearCreds(): Promise<AgentloopCredsView & { readonly removed: boolean }> {
    invalidatePendingTokens();
    const removed = await withStore(() => store.clearCreds());
    return { ...credsViewOf(null), removed };
  }

  async function test(): Promise<AgentloopTestView> {
    const credsNow = await withStore(() => store.loadCreds());
    const checkedAt = iso();
    if (!credsNow) {
      return { state: "unset", note: "尚未配置凭据：请先保存 AccessKey 后再测试连接。", targets: [], checkedAt };
    }
    const views = await loadViews();
    if (views.length === 0) {
      return {
        state: "error",
        note: "未配置观测视图（.local-cache/agents.json 的 agentloop.views）：无法只读探活。",
        targets: [],
        checkedAt,
      };
    }
    /* 只读探活：逐视图 GET /logstores，绝不出票、绝不改云端状态（donor test 语义收紧）。 */
    const targets: AgentloopProbeTarget[] = [];
    for (const view of views) {
      try {
        const stores = await sls.listLogstores(view.project, view.region, credsNow, AGENTLOOP_PROBE_TIMEOUT_MS, dateGmt());
        const has = stores.includes(view.logstore);
        targets.push({
          id: view.id,
          t: view.t,
          ok: has,
          note: has ? `logstore ${view.logstore} 可读` : `项目可访问但未见 ${view.logstore}（可能尚未上报）`,
        });
      } catch (error) {
        targets.push({ id: view.id, t: view.t, ok: false, note: describeUpstream(error) });
      }
    }
    const bad = targets.filter((target) => !target.ok);
    return {
      state: bad.length === 0 ? "ok" : "error",
      note: bad.length === 0
        ? `凭据有效：${targets.length} 个观测视图只读探活通过（未出票）。`
        : `${bad.length}/${targets.length} 个视图异常：${bad[0].note}`,
      targets,
      checkedAt,
    };
  }

  async function ticketDry(): Promise<AgentloopTicketDryView> {
    const credsNow = await withStore(() => store.loadCreds());
    if (!credsNow) {
      throw new AgentloopBridgeError("agentloop_creds_missing", "尚未配置凭据：出票预检需要先保存 AccessKey。");
    }
    /* 铸造一次性 token（零网络）；顺手清过期项并限量，防内存膨胀。 */
    const expiresAtMs = now() + AGENTLOOP_DRY_TOKEN_TTL_MS;
    for (const [token, expiry] of pendingTokens) {
      if (expiry <= now()) pendingTokens.delete(token);
    }
    while (pendingTokens.size >= MAX_PENDING_TOKENS) {
      const oldest = pendingTokens.keys().next();
      if (oldest.done) break;
      pendingTokens.delete(oldest.value);
    }
    const token = randomBytes(24).toString("hex");
    pendingTokens.set(token, expiresAtMs);
    const mask = maskAccessKey(credsNow.ak);
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      credsMask: mask,
      request: {
        method: "POST",
        host: AGENTLOOP_TICKET_HOST,
        resource: `/tickets?expirationTime=${AGENTLOOP_TICKET_TTL_SEC}`,
        apiVersion: AGENTLOOP_API_VERSION,
        signatureMethod: AGENTLOOP_SIGNATURE_METHOD,
        authorizationPreview: `SLS ${mask}:<签名于确认时计算，不下发>`,
        ttlSec: AGENTLOOP_TICKET_TTL_SEC,
        region: AGENTLOOP_TICKET_REGION,
        externalWrite: true,
      },
    };
  }

  async function ticketConfirm(body: unknown): Promise<AgentloopTicketConfirmView> {
    if (!isRecord(body)) {
      throw new AgentloopBridgeError("agentloop_invalid_request", "请求体必须是 JSON 对象：{confirm}。");
    }
    /* 人工确认闸门先于一切：confirm 必须严格 === dry 铸造且未过期的 token。 */
    if (typeof body.confirm !== "string" || !body.confirm) {
      throw new AgentloopBridgeError(
        "agentloop_confirm_mismatch",
        "人工确认未完成：confirm 必须严格等于出票预检返回的 token（页面弹窗逐条勾选后才下发）。本次未执行任何出票。",
      );
    }
    const expiry = pendingTokens.get(body.confirm);
    if (expiry === undefined) {
      throw new AgentloopBridgeError(
        "agentloop_confirm_mismatch",
        "确认 token 与有效预检不匹配（未知或已被消费）：本次未执行任何出票，请重新预检。",
      );
    }
    if (expiry <= now()) {
      pendingTokens.delete(body.confirm);
      throw new AgentloopBridgeError(
        "agentloop_not_found",
        `出票预检已过期（${Math.round(AGENTLOOP_DRY_TOKEN_TTL_MS / 60_000)} 分钟内有效）：本次未执行出票，请重新预检后再确认。`,
      );
    }
    /* token 单次有效：真实尝试前即消费，重放绝不再出票。 */
    pendingTokens.delete(body.confirm);

    const credsNow = await withStore(() => store.loadCreds());
    if (!credsNow) {
      throw new AgentloopBridgeError("agentloop_creds_missing", "尚未配置凭据：本次未执行出票，请先保存 AccessKey。");
    }

    const issuedAt = iso();
    let ticket: string;
    let ttl: number;
    try {
      const result = await sls.createTicket(credsNow, AGENTLOOP_TICKET_TTL_SEC, AGENTLOOP_TICKET_TIMEOUT_MS, dateGmt());
      ticket = result.ticket;
      ttl = result.ttl;
    } catch (error) {
      const reason = describeUpstream(error);
      const audited = await appendAudit({
        at: issuedAt, action: "ticket", status: "error", ticketMask: "", ttl: 0, expireAt: "", reason,
      });
      const code: AgentloopErrorCode = error instanceof SlsRequestError && error.code === "auth"
        ? "agentloop_upstream_auth"
        : "agentloop_upstream_error";
      const prefix = code === "agentloop_upstream_auth" ? "SLS 鉴权失败（401/403）" : "SLS 出票失败";
      throw new AgentloopBridgeError(code, `${prefix}：${reason}${audited ? "" : "（审计写入失败）"}`);
    }

    const ticketMaskValue = maskTicket(ticket);
    const expireAt = new Date(now() + ttl * 1000).toISOString();
    const audited = await appendAudit({
      at: issuedAt, action: "ticket", status: "ok", ticketMask: ticketMaskValue, ttl, expireAt, reason: "",
    });
    /* 票据是 bearer 凭据：应答只回掩码 + 有效期（V2 无 iframe 内嵌，收紧于 donor）。 */
    return {
      ticketMask: ticketMaskValue,
      ttl,
      issuedAt,
      expireAt,
      region: AGENTLOOP_TICKET_REGION,
      audited,
    };
  }

  /** 审计是旁路：写失败不吞结果，如实回 audited:false（红线仍为 append-only）。 */
  async function appendAudit(audit: AgentloopTicketAudit): Promise<boolean> {
    try {
      await store.appendTicketAudit(audit);
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        event: "agentloop_audit_write_failed",
        reason: sanitizeUpstreamDetail(String((error as Error)?.message ?? error), 120),
      }));
      return false;
    }
  }

  async function tickets(): Promise<AgentloopTicketsView> {
    const all = await withStore(() => store.readTicketAudits(Number.MAX_SAFE_INTEGER));
    return { tickets: all.slice(0, AGENTLOOP_TICKETS_TAIL), total: all.length };
  }

  async function readBody(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new AgentloopBridgeError("agentloop_invalid_request", "请求体过大：凭据与 confirm token 都是短串，远不需要这么多内容。");
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new AgentloopBridgeError("agentloop_invalid_request", "请求体过大：凭据与 confirm token 都是短串，远不需要这么多内容。");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentloopBridgeError("agentloop_invalid_request", "请求体不是合法 JSON。");
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
    const route = AGENTLOOP_ROUTES.find((entry) => entry.path === path && entry.method === request.method);
    if (!route) {
      const allowed = AGENTLOOP_ROUTES.filter((entry) => entry.path === path).map((entry) => entry.method);
      if (allowed.length === 0) return undefined; // 非本桥路径：交回主路由
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${allowed.join("/")}。` } },
        405,
      );
    }
    try {
      if (route.operation === "creds-get") return jsonResponse({ ok: true, data: await creds() });
      if (route.operation === "creds-put") return jsonResponse({ ok: true, data: await setCreds(await readBody(request)) });
      if (route.operation === "creds-delete") return jsonResponse({ ok: true, data: await clearCreds() });
      if (route.operation === "test") return jsonResponse({ ok: true, data: await test() });
      if (route.operation === "ticket-dry") return jsonResponse({ ok: true, data: await ticketDry() });
      if (route.operation === "ticket-confirm") {
        return jsonResponse({ ok: true, data: await ticketConfirm(await readBody(request)) });
      }
      return jsonResponse({ ok: true, data: await tickets() });
    } catch (error) {
      if (error instanceof AgentloopBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "agentloop_unavailable", message: "AgentLoop 服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { creds, setCreds, clearCreds, test, ticketDry, ticketConfirm, tickets, handle };
}

/** 上游/网络错误 → 可展示原因（已脱敏截断，凭据形态串不出桥）。 */
function describeUpstream(error: unknown): string {
  if (error instanceof SlsRequestError) return sanitizeUpstreamDetail(error.message, 120);
  return sanitizeUpstreamDetail(String((error as Error)?.message ?? error), 120);
}
