/**
 * Worklog bridge (dev) — 个人工作台「worklog 采集与分类」只读能力的 HTTP 桥。
 * donor: base/sa-workbench tools/fetch/worklog_collect.js + worklog_classify.js +
 * worklog_live.js 的采集/分类语义（搬语义不搬代码）；响应形状沿 reply-bridge 先例。
 *
 * 路由（WORKLOG_ROUTES，全部只读 GET）：
 * - /local/worklog          分类条目 + 每类计数（query: days 或 from/to，非法 400）
 * - /local/worklog/summary  按日/按环节/按聚类聚合（同一套范围参数）
 * 非本桥路径 handle() 返回 undefined，交回主路由（local-router 委托契约）。
 *
 * 红线：采集只读（node:sqlite readOnly，源库零写入）；源库缺失 → 诚实 missing
 * 状态绝不伪造条目；无凭据接触；无子进程；错误消息不含绝对路径。
 */

import { existsSync as defaultExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { resolveWorklogRange } from "../../src/lib/worklog-model.ts";
import {
  createNodeSqliteOpener,
  defaultWorklogSources,
  scanWorklogSource,
  type SqliteOpener,
  type SourceScanResult,
} from "./worklog-collector.ts";
import {
  buildListView,
  buildSummaryView,
  entriesOf,
  overallStatusOf,
  sourceViewOf,
} from "./worklog-classifier.ts";
import {
  WorklogBridgeError,
  WORKLOG_ROUTES,
  type WorklogBridge,
  type WorklogErrorCode,
  type WorklogListView,
  type WorklogRangeView,
  type WorklogSourceView,
  type WorklogSummaryView,
} from "./worklog-types.ts";

/** 缺省扫描根：macOS Application Support（donor APP_SUPPORT 同口径）。 */
export const DEFAULT_APP_SUPPORT_DIR = join(homedir(), "Library", "Application Support");

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface WorklogBridgeOptions {
  /** 扫描根目录（缺省 ~/Library/Application Support；测试注入临时目录）。 */
  readonly appSupportDir?: string;
  readonly now?: () => number;
  readonly existsSync?: (path: string) => boolean;
  /** sqlite opener 工厂（缺省 node:sqlite readOnly；返回 null = 本机无 node:sqlite）。 */
  readonly loadOpener?: () => Promise<SqliteOpener | null>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

/** 稳定错误码 → HTTP：400 参数 / 405 方法 / 503 缺 node:sqlite / 502 扫描失败与未知故障。 */
function statusFor(code: WorklogErrorCode): number {
  if (code === "method_not_allowed") return 405;
  if (code === "worklog_sqlite_unavailable") return 503;
  if (code === "worklog_invalid_request") return 400;
  return 502;
}

export function createWorklogBridge(options: WorklogBridgeOptions = {}): WorklogBridge {
  const now = options.now ?? Date.now;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const appSupportDir = resolvePath(options.appSupportDir ?? DEFAULT_APP_SUPPORT_DIR);
  const loadOpener = options.loadOpener ?? createNodeSqliteOpener;

  function rangeOf(query: URLSearchParams): { range: WorklogRangeView; fromMs: number; toMs: number } {
    const resolved = resolveWorklogRange(query, now());
    if (!resolved.ok) {
      throw new WorklogBridgeError("worklog_invalid_request", `时间范围参数不合法：${resolved.reason}`);
    }
    return {
      range: { from: resolved.range.from, to: resolved.range.to, days: resolved.days },
      fromMs: resolved.range.fromMs,
      toMs: resolved.range.toMs,
    };
  }

  /** 扫描全部固定源（只读）；全源失败如实 502，缺失源保留 missing 状态。 */
  async function scanAll(fromMs: number, toMs: number): Promise<{
    sources: WorklogSourceView[];
    scans: SourceScanResult[];
  }> {
    const opener = await loadOpener();
    if (!opener) {
      throw new WorklogBridgeError(
        "worklog_sqlite_unavailable",
        "本机 Node 缺少 node:sqlite（需 Node ≥ 22.5）：无法只读扫描工作库，本次未生成任何条目。",
      );
    }
    const scans = defaultWorklogSources(appSupportDir).map((source) =>
      scanWorklogSource(source, { fromMs, toMs }, { existsSync, openReader: opener, root: appSupportDir }),
    );
    const sources = scans.map(sourceViewOf);
    const anyOk = sources.some((s) => s.status === "ok");
    const anyError = sources.some((s) => s.status === "error");
    if (!anyOk && anyError) {
      throw new WorklogBridgeError(
        "worklog_scan_failed",
        "检测到的本机工作库全部打开失败（可能被占用或损坏）：本次未采集到任何条目。",
      );
    }
    return { sources, scans };
  }

  async function list(query: URLSearchParams): Promise<WorklogListView> {
    const { range, fromMs, toMs } = rangeOf(query);
    const { sources, scans } = await scanAll(fromMs, toMs);
    return buildListView({
      generatedAt: new Date(now()).toISOString(),
      range,
      sources,
      status: overallStatusOf(sources),
      entries: entriesOf(scans),
    });
  }

  async function summary(query: URLSearchParams): Promise<WorklogSummaryView> {
    const { range, fromMs, toMs } = rangeOf(query);
    const { sources, scans } = await scanAll(fromMs, toMs);
    return buildSummaryView({
      generatedAt: new Date(now()).toISOString(),
      range,
      sources,
      status: overallStatusOf(sources),
      entries: entriesOf(scans),
    });
  }

  async function handle(request: Request): Promise<Response | undefined> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return undefined;
    }
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    const route = WORKLOG_ROUTES.find((entry) => entry.path === path);
    if (!route) return undefined; // 非 worklog 路径：交回主路由
    if (request.method !== route.method) {
      return jsonResponse(
        { ok: false, error: { code: "method_not_allowed", message: `${path} 只接受 ${route.method}（worklog 全链路只读）。` } },
        405,
      );
    }
    try {
      const data = route.operation === "list" ? await list(url.searchParams) : await summary(url.searchParams);
      return jsonResponse({ ok: true, data });
    } catch (error) {
      if (error instanceof WorklogBridgeError) {
        return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusFor(error.code));
      }
      return jsonResponse(
        { ok: false, error: { code: "worklog_unavailable", message: "工作清单服务遇到未知故障，请稍后重试。" } },
        502,
      );
    }
  }

  return { list, summary, handle };
}
