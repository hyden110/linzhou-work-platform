// test:frontend-ui 的受控 Mock 基座：覆盖 CRM 业务 API 的请求/响应生命周期。
// 边界（见 README.md）：
// - 业务 API（/local/**、/functions/**）fail-closed：未显式 Mock 的请求记为违规并 abort，测试结束断言违规为零。
// - 不访问真实业务后端/数据库；应用无登录体系，本套件不注入任何真实账号、Cookie 或 Token。
// - Mock 与页面同生命周期，随浏览器上下文销毁；无真实数据副作用。
import { expect, test as base, type Page, type Route } from "@playwright/test";
import type { CrmSnapshot, RefreshStatus, SourceKey, SourceStatus } from "../../../src/lib/crm-types";

export const STALE_SINCE = "2026-10-20T11:31:00+08:00";
export const OLD_GENERATED_AT = "2026-10-20T11:31:00+08:00";
export const NEW_GENERATED_AT = "2026-10-22T09:30:00+08:00";

const ALL_KEYS: readonly SourceKey[] = [
  "agenda", "todos", "groups", "mentions", "unread",
  "customers", "projects", "overview", "top", "mygroups",
];

export function okSource(fetchedAt: string): SourceStatus {
  return {
    status: "ok", error: null, fetchedAt, lastSuccessAt: fetchedAt,
    count: 0, complete: true, stale: false,
  };
}

export function failedSource(error: string, fetchedAt: string, status: SourceStatus["status"] = "error"): SourceStatus {
  return {
    status, error, fetchedAt, lastSuccessAt: STALE_SINCE,
    count: 0, complete: false, stale: true,
  };
}

export function snapshotOf(
  sources: Partial<Record<SourceKey, SourceStatus>>,
  generatedAt: string,
): CrmSnapshot {
  return {
    schemaVersion: 1, generatedAt, sources,
    agenda: [], todos: [], groups: [], mentions: [], unread: [],
    customers: [], projects: [], overview: [], top: [], mygroups: [],
  };
}

export function allOk(generatedAt: string): CrmSnapshot {
  const sources: Partial<Record<SourceKey, SourceStatus>> = {};
  for (const key of ALL_KEYS) sources[key] = okSource(generatedAt);
  return snapshotOf(sources, generatedAt);
}

export function succeededRefresh(): RefreshStatus {
  return { state: "succeeded", startedAt: NEW_GENERATED_AT, finishedAt: NEW_GENERATED_AT, error: null };
}

export function partialRefresh(failedCount: number): RefreshStatus {
  return { state: "partial", startedAt: NEW_GENERATED_AT, finishedAt: NEW_GENERATED_AT, error: null, failedCount };
}

export interface RefreshScenario {
  /** 初始 GET /local/crm/snapshot 返回的快照（页面加载时）。 */
  initial: CrmSnapshot;
  /** 触发刷新后快照切换为该值（模拟“成功源更新、失败源保留旧数据”的写盘结果）。 */
  after?: CrmSnapshot;
  /** 轮询 GET /local/crm/refresh 返回的最终刷新状态。 */
  result: RefreshStatus;
}

class CrmMockServer {
  private scenario: RefreshScenario | null = null;
  private phase: "initial" | "running" | "done" = "initial";
  private current: CrmSnapshot | null = null;
  private status: RefreshStatus = { state: "idle", startedAt: null, finishedAt: null, error: null };
  private postRefreshCount = 0;
  private readonly violations: string[] = [];

  constructor(private readonly page: Page) {}

  setup(scenario: RefreshScenario): void {
    this.scenario = scenario;
    this.current = scenario.initial;
  }

  async install(): Promise<void> {
    await this.page.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const isBusiness = path.startsWith("/local/") || path.startsWith("/functions/");
      if (!isBusiness) return route.fallback();
      // 环境端点：应用启动即拉取的伴生接口，给出最小受控响应，保证用例只依赖 CRM 契约。
      if (method === "GET" && path === "/local/status") {
        return route.fulfill(this.json({ ok: true, data: {} })); // localRuntime 缺省 → 前端判定为非本机环境
      }
      if (method === "GET" && path === "/local/ops/digest") {
        return route.fulfill(this.json({ ok: true, data: { schemaVersion: 1, sources: {}, items: [] } }));
      }
      if (method === "GET" && path === "/local/notify/state") {
        return route.fulfill(this.json({ ok: true, data: { items: [], unread: 0, total: 0, savedAt: "" } }));
      }
      if (method === "GET" && path === "/local/events") {
        // SSE 总线：立即结束流并要求 30s 后重连，测试期内不会反复建连。
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 30000\n\n" });
      }
      if (method === "GET" && path === "/local/fbi/metrics") {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "metrics_unavailable" }) });
      }
      if (method === "GET" && path === "/local/ppl/inspection") {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "ppl_inspection_unavailable" }) });
      }
      // 伴生端点：钉群盘面 DailySummaryPanel 挂载即拉取当日小结与其生成状态。
      // 404 summary_not_found 是客户端显式处理的缺省态（渲染“当日无产物”）；
      // 状态仅咨询性（idle），用例断言的 CRM 横幅与该面板内容无关。
      if (method === "GET" && path === "/local/dingtalk/summary") {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "summary_not_found" }) });
      }
      if (method === "GET" && path === "/local/dingtalk/summary/status") {
        return route.fulfill(this.json({ ok: true, data: { state: "idle" } }));
      }
      // CRM 刷新链路：按场景驱动。
      if (method === "GET" && path === "/local/crm/snapshot") {
        return route.fulfill(this.json({ ok: true, data: this.current, refresh: this.status }));
      }
      if (method === "GET" && path === "/local/crm/refresh") {
        if (this.phase === "running") {
          this.phase = "done";
          this.status = this.scenario!.result;
        }
        return route.fulfill(this.json({ ok: true, data: this.status }));
      }
      if (method === "POST" && path === "/local/crm/refresh") {
        this.postRefreshCount += 1;
        this.phase = "running";
        this.status = { state: "running", startedAt: NEW_GENERATED_AT, finishedAt: null, error: null };
        if (this.scenario!.after) this.current = this.scenario!.after;
        return route.fulfill(this.json({ ok: true, data: this.status }));
      }
      this.violations.push(`${method} ${path}`);
      return route.abort();
    });
  }

  getViolationList(): string[] {
    return [...this.violations];
  }

  /** 已提交的 POST /local/crm/refresh 次数：用于断言刷新未重复执行。 */
  getPostRefreshCount(): number {
    return this.postRefreshCount;
  }

  private json(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
  }
}

type MockFixtures = { crmMock: CrmMockServer };

export const test = base.extend<MockFixtures>({
  crmMock: async ({ page }, use) => {
    const server = new CrmMockServer(page);
    await server.install();
    await use(server);
    // fail-closed：任何未显式 Mock 的业务 API 请求都会让用例失败。
    expect(server.getViolationList(), "业务 API fail-closed：出现未 Mock 的业务请求").toEqual([]);
  },
});

export { expect };
