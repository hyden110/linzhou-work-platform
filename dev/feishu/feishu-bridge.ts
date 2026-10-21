/**
 * Feishu bridge（飞书办公台账）— 只读聚合 HTTP 桥：本机 lark-cli 探测 + 白名单投影。
 *
 * 路由（FEISHU_ROUTES）：
 * - GET /local/feishu          聚合视图（缓存 TTL 300s + 单飞：并发第二请求复用在飞结果）
 * - GET /local/feishu/refresh  清缓存重跑，返回同形状
 * 非本桥路径 handle() 返回 undefined，交回主路由（local-router 委托契约）。
 *
 * 诚实态：CLI 找不到 → cli_missing（sections 全空 + sectionErrors 说明）；
 * CLI 在但 user 不可用 → auth_required（loginCommand 指引，桥绝不代跑登录）；
 * user 可用 → ok（单区失败走 sectionErrors，互不拖累）。响应沿仓库桥先例
 * {ok:true,data} / {ok:false,error:{code,message}}；纯只读，无本地写、无凭据接触。
 */

import { homedir } from "node:os";

import {
  createExecFileRunner,
  defaultFeishuCandidates,
  discoverFeishuCli,
  probeFeishuAuth,
  probeFeishuVersion,
  runReadonlyJson,
  type FeishuAuthProbe,
} from "./feishu-cli.ts";
import {
  buildFeishuSummary,
  projectAtMeRows,
  projectChatRows,
  projectTaskRows,
} from "./feishu-project.ts";
import {
  FeishuBridgeError,
  FEISHU_ATME_ARGS,
  FEISHU_CACHE_TTL_MS,
  FEISHU_CHATS_ARGS,
  FEISHU_LOGIN_COMMAND,
  FEISHU_ROUTES,
  FEISHU_TASKS_ARGS,
  type FeishuAuthView,
  type FeishuBridge,
  type FeishuBridgeOptions,
  type FeishuLedgerView,
  type FeishuRunner,
  type FeishuSectionErrors,
} from "./feishu-types.ts";

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const EMPTY_SUMMARY = { groups: 0, p2p: 0, external: 0, atMe: 0, tasksOpen: 0, tasksDueToday: 0, tasksOverdue: 0 } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

/** 稳定错误码 → HTTP：405 方法 / 502 未知故障（诚实态在 data.status 里，恒 200）。 */
function statusFor(code: FeishuBridgeError["code"]): number {
  return code === "method_not_allowed" ? 405 : 502;
}

/** section 全空 + 逐区说明的诚实外壳（cli_missing / auth_required 共用）。 */
function honestShell(
  status: FeishuLedgerView["status"],
  updatedAt: string,
  cli: FeishuLedgerView["cli"],
  auth: FeishuAuthView,
  reason: string,
): FeishuLedgerView {
  const sectionErrors: FeishuSectionErrors = { chats: reason, atMe: reason, tasks: reason };
  return {
    status, updatedAt, cli, auth,
    summary: EMPTY_SUMMARY,
    chats: [], atMe: [], tasks: [],
    sectionErrors,
  };
}

function authViewOf(probe: FeishuAuthProbe, requireLogin: boolean): FeishuAuthView {
  return {
    identity: probe.identity,
    userName: probe.userName,
    tokenStatus: probe.tokenStatus,
    loginCommand: requireLogin ? FEISHU_LOGIN_COMMAND : "",
    note: requireLogin
      ? probe.probeFailed
        ? `授权探针未成功（${probe.note}）请先在终端执行 lark-cli auth status 核实；需要登录时自行执行 loginCommand——本桥只读，绝不代跑登录。`
        : `user 身份${probe.tokenStatus === "expired" ? "授权已过期" : "未授权或缺失"}：请在终端自行执行 loginCommand 完成登录（本桥只读，绝不代跑登录），完成后点刷新重新聚合。`
      : "",
  };
}

export function createFeishuBridge(options: FeishuBridgeOptions = {}): FeishuBridge {
  const now = options.now ?? Date.now;
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? FEISHU_CACHE_TTL_MS);
  let cached: { view: FeishuLedgerView; at: number } | null = null;
  let inflight: Promise<FeishuLedgerView> | null = null;

  /** 单区取数 + 投影：失败只产出该区 note，绝不抛出（section 级隔离）。 */
  async function section<T>(
    runner: FeishuRunner,
    args: readonly string[],
    project: (payload: unknown) => readonly T[],
  ): Promise<{ rows: readonly T[]; note: string }> {
    const result = await runReadonlyJson(runner, args);
    if (!result.ok) return { rows: [], note: result.note };
    try {
      return { rows: project(result.payload), note: "" };
    } catch {
      return { rows: [], note: "输出结构不可投影：本区未取到数据（桥只读，不猜内容）。" };
    }
  }

  /** 一轮完整聚合：发现 → 版本 → 授权探针 →（user 可用才跑）三区并行取数。 */
  async function buildView(): Promise<FeishuLedgerView> {
    const nowMs = now();
    const updatedAt = new Date(nowMs).toISOString();
    const candidates = options.candidates ?? defaultFeishuCandidates(process.env, homedir());
    const cliPath = discoverFeishuCli(candidates);
    if (!cliPath) {
      return honestShell(
        "cli_missing",
        updatedAt,
        { found: false, path: "", version: "" },
        { identity: "none", userName: "", tokenStatus: "missing", loginCommand: "", note: "" },
        "未找到 lark-cli（发现顺序：FEISHU_CLI_PATH → ~/.qoderwork/bin → ~/.qwenworkcn/bin → PATH）：安装后点刷新，本区未取数。",
      );
    }
    const runner = options.runner ?? createExecFileRunner(cliPath);
    const version = await probeFeishuVersion(runner);
    const probe = await probeFeishuAuth(runner);
    const cli = { found: true, path: cliPath, version };
    if (!probe.userAvailable) {
      return honestShell(
        "auth_required",
        updatedAt,
        cli,
        authViewOf(probe, true),
        `user 身份不可用（${probe.tokenStatus === "expired" ? "授权已过期" : "未授权或缺失"}）：登录完成前本区不取数，绝不伪造数据。`,
      );
    }

    const [chats, atMe, tasks] = await Promise.all([
      section(runner, FEISHU_CHATS_ARGS, projectChatRows),
      section(runner, FEISHU_ATME_ARGS, projectAtMeRows),
      section(runner, FEISHU_TASKS_ARGS, (payload) => projectTaskRows(payload, nowMs)),
    ]);
    // 不可变构造：仅失败区占键（readonly 契约，不原地改对象）
    const sectionErrors: FeishuSectionErrors = {
      ...(chats.note ? { chats: chats.note } : {}),
      ...(atMe.note ? { atMe: atMe.note } : {}),
      ...(tasks.note ? { tasks: tasks.note } : {}),
    };
    return {
      status: "ok",
      updatedAt,
      cli,
      auth: authViewOf(probe, false),
      summary: buildFeishuSummary(chats.rows, atMe.rows, tasks.rows),
      chats: chats.rows,
      atMe: atMe.rows,
      tasks: tasks.rows,
      sectionErrors,
    };
  }

  /** 单飞：并发请求复用同一在飞 Promise；buildView 自身不抛（全兜底成诚实态）。 */
  function load(): Promise<FeishuLedgerView> {
    if (inflight) return inflight;
    const promise = (async (): Promise<FeishuLedgerView> => {
      try {
        return await buildView();
      } catch {
        // 理论不可达（各层全兜底）：真发生也如实报服务故障，不伪造数据
        const at = now();
        return honestShell(
          "cli_missing",
          new Date(at).toISOString(),
          { found: false, path: "", version: "" },
          { identity: "none", userName: "", tokenStatus: "missing", loginCommand: "", note: "" },
          "聚合过程遇到未知故障：本区未取数，请点刷新重试。",
        );
      }
    })().finally(() => {
      inflight = null;
    });
    inflight = promise;
    return promise;
  }

  async function aggregate(): Promise<FeishuLedgerView> {
    if (cached && now() - cached.at < cacheTtlMs) return cached.view;
    const view = await load();
    cached = { view, at: now() };
    return view;
  }

  async function refresh(): Promise<FeishuLedgerView> {
    cached = null;
    const view = await load();
    cached = { view, at: now() };
    return view;
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return undefined;
    }
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const candidates = FEISHU_ROUTES.filter((entry) => entry.path === path);
    if (!candidates.length) return undefined; // 非 feishu 路径：交回主路由
    const route = candidates.find((entry) => entry.method === request.method);
    if (!route) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "method_not_allowed",
            message: `${path} 只接受 ${candidates.map((entry) => entry.method).join(" / ")}（本桥纯只读）。`,
          },
        },
        405,
      );
    }
    try {
      const data = route.operation === "refresh" ? await refresh() : await aggregate();
      return jsonResponse({ ok: true, data });
    } catch (error) {
      if (error instanceof FeishuBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "feishu_unavailable", message: "飞书台账服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { aggregate, refresh, handle };
}
