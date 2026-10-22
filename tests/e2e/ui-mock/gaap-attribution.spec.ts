// test:frontend-ui：工单 #10074 R1/R2 的 UI 行为（GAAP 阈值配置、抽屉 FBI 归因、CRM AI 助理解释）。
// 运行真实前端（vite dev），CRM 快照与刷新链路由 ./crm-mock.ts 受控提供；
// 归因端点（/local/crm/attribution*）由本文件在基座之上叠层 Mock：
// 本 handler 注册晚于基座（后注册者优先），未命中的路径 route.fallback() 交还基座的 fail-closed 检查。
// 不访问真实业务后端、真实账号、真实 FBI/DWS/钉钉；无登录体系，无需模拟认证注入。
import type { Page, Route } from "@playwright/test";
import { NEW_GENERATED_AT, allOk, expect, succeededRefresh, test } from "./crm-mock";
import type {
  AttributionRecord,
  CrmAiExplainRecord,
  CrmSnapshot,
  CustomerItem,
} from "../../../src/lib/crm-types";

/* ---------- 快照与记录构造 ---------- */

function customerOf(partial: Partial<CustomerItem>): CustomerItem {
  return {
    cid: "cid001",
    name: "示例客户",
    industry: "云计算",
    area: "华东",
    level: "P1",
    formal: null,
    opportunity: null,
    lastMonthGaap: 2_000_000,
    yesterdayGaap: 1_350_000,
    yesterdayGaapRate: 35,
    yesterdayGaapDiff: 350_000,
    lastNoteAt: null,
    relatedAt: null,
    ...partial,
  };
}

function customerSnapshot(customers: CustomerItem[]): CrmSnapshot {
  const snapshot = allOk(NEW_GENERATED_AT);
  snapshot.customers = customers;
  return snapshot;
}

const ATTRIBUTION_ROWS = [
  { level1: "模型服务", level2: "推理", current: 500_000, previous: 250_000 },
  { level1: "模型服务", level2: "训练", current: 300_000, previous: 150_000 },
  { level1: "计算", level2: null, current: 300_000, previous: 250_000 },
] as const;

function runningAttribution(): AttributionRecord {
  return {
    schemaVersion: 1,
    cid: "cid001",
    state: "running",
    createdAt: NEW_GENERATED_AT,
    finishedAt: null,
    reportResourceId: "1842553",
    currentDate: null,
    previousDate: null,
    rows: [],
    reason: null,
    droppedRows: 0,
    error: null,
  };
}

function doneAttribution(): AttributionRecord {
  return {
    schemaVersion: 1,
    cid: "cid001",
    state: "done",
    createdAt: NEW_GENERATED_AT,
    finishedAt: NEW_GENERATED_AT,
    reportResourceId: "1842553",
    currentDate: "2026-10-21",
    previousDate: "2026-10-20",
    rows: ATTRIBUTION_ROWS.map((row) => ({ ...row })),
    reason: null,
    droppedRows: 0,
    error: null,
  };
}

function failedAttribution(error: string): AttributionRecord {
  return {
    schemaVersion: 1,
    cid: "cid001",
    state: "failed",
    createdAt: NEW_GENERATED_AT,
    finishedAt: NEW_GENERATED_AT,
    reportResourceId: "1842553",
    currentDate: null,
    previousDate: null,
    rows: [],
    reason: null,
    droppedRows: 0,
    error,
  };
}

function explainRecord(state: "done" | "failed"): CrmAiExplainRecord {
  const base = {
    schemaVersion: 1 as const,
    cid: "cid001",
    createdAt: NEW_GENERATED_AT,
    finishedAt: NEW_GENERATED_AT,
    question: "系统模板问题（示例客户 × 鲲鹏异动卡 × FBI 产品拆分摘要，不携带凭据）",
    askedAt: NEW_GENERATED_AT,
  };
  if (state === "done") {
    return { ...base, state: "done", answer: "从 FBI 拆分看，增长主要由模型服务（推理扩容、训练新增）带动。（模拟 CRM AI 助理回复）", answerAt: NEW_GENERATED_AT, error: null };
  }
  return { ...base, state: "failed", answer: null, answerAt: null, error: "crm_ai_timeout" };
}

/* ---------- 归因端点叠层 Mock（契约与 dev/local-router.ts 一致） ---------- */

interface AttributionScenario {
  /** 抽屉挂载时 GET 返回的初始归因记录（默认 null = 未归因）。 */
  initialAttribution?: AttributionRecord | null;
  /** POST /local/crm/attribution 返回并落为当前记录（202 + reused:false）。 */
  postAttribution: AttributionRecord;
  /** 当前记录为 running 时，下一次 GET 轮询切换为该值（模拟后台分析完成）。 */
  afterGetAttribution?: AttributionRecord;
  /** 抽屉挂载时 GET 返回的初始解释记录（默认 null）。 */
  initialExplain?: CrmAiExplainRecord | null;
  /** POST /local/crm/attribution/explain 返回并落为当前记录（202 + reused:false）。 */
  postExplain: CrmAiExplainRecord;
}

class AttributionMockServer {
  private attribution: AttributionRecord | null;
  private explain: CrmAiExplainRecord | null;
  private attributionPosts = 0;
  private explainPosts = 0;

  constructor(private readonly scenario: AttributionScenario) {
    this.attribution = scenario.initialAttribution ?? null;
    this.explain = scenario.initialExplain ?? null;
  }

  async install(page: Page): Promise<void> {
    await page.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      if (path === "/local/crm/attribution" && (method === "GET" || method === "POST")) {
        if (method === "GET") {
          if (this.attribution?.state === "running" && this.scenario.afterGetAttribution) {
            this.attribution = this.scenario.afterGetAttribution;
          }
          return route.fulfill(this.json({ ok: true, data: this.attribution }));
        }
        this.attributionPosts += 1;
        this.attribution = this.scenario.postAttribution;
        return route.fulfill({ ...this.json({ ok: true, data: this.attribution, reused: false }), status: 202 });
      }
      if (path === "/local/crm/attribution/explain" && (method === "GET" || method === "POST")) {
        if (method === "GET") {
          return route.fulfill(this.json({ ok: true, data: this.explain }));
        }
        this.explainPosts += 1;
        this.explain = this.scenario.postExplain;
        return route.fulfill({ ...this.json({ ok: true, data: this.explain, reused: false }), status: 202 });
      }
      return route.fallback();
    });
  }

  /** 已提交的归因 POST 次数：断言单次点击只发起一次分析。 */
  getAttributionPosts(): number {
    return this.attributionPosts;
  }

  /** 已提交的解释 POST 次数：断言单次点击只发送一次、不重试轰炸。 */
  getExplainPosts(): number {
    return this.explainPosts;
  }

  private json(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
  }
}

/**
 * 设置页伴生端点（leads / kb / mcp）：与基座 Mock 同层叠注册，给最小受控响应，
 * 保证用例只依赖 GAAP 阈值契约本身；其余路径 route.fallback() 交还基座 fail-closed 检查。
 */
async function installSettingsCompanions(page: Page): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const companions: Record<string, unknown> = {
      "/local/leads": { configured: false, hasData: false, rows: [] },
      "/local/kb/sources": { sources: [] },
      "/local/mcp/service": { enabled: false, keys: { active: 0, revoked: 0 }, toolNames: [], auditTail: [] },
      "/local/mcp/keys": { keys: [], active: 0, revoked: 0 },
      "/local/mcp/connectors": { sources: [], servers: [] },
    };
    if (method === "GET" && path in companions) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: companions[path] }),
      });
    }
    return route.fallback();
  });
}

/* ---------- 导航与公共选择器 ---------- */

function navButton(page: Page, label: string) {
  return page.locator('nav[aria-label="主导航"]').getByRole("button", { name: label });
}

async function openView(page: Page, navLabel: string, heading: string) {
  await navButton(page, navLabel).click();
  await expect(page.locator("h1", { hasText: heading })).toBeVisible();
}

async function openCustomerDrawer(page: Page) {
  await page.locator(".gaap-alert-card__main").first().click();
  await expect(page.locator(".crm-drawer h2", { hasText: "示例客户" })).toBeVisible();
  await expect(page.locator(".crm-attribution h3", { hasText: "GAAP 异动归因" })).toBeVisible();
}

const settingsSection = (page: Page) => page.locator('section[aria-label="GAAP 异动阈值"]');
const currentNote = (page: Page) => page.locator(".settings-threshold-actions__current");
const saveButton = (page: Page) => page.locator(".settings-threshold-actions").getByRole("button", { name: "保存" });
const resetButton = (page: Page) => page.locator(".settings-threshold-actions").getByRole("button", { name: "恢复默认" });

const DEFAULT_NOTE = "当前生效：口径：昨日 GAAP 环比；阈值 T3 环比 ±50% / T2 涨跌 ±30 万 / T1 涨跌 ±5 万，多档取最高档；上月基数低于 30 万只报环比档并标「低基数」。";
const noteWith = (notice: string) =>
  `当前生效：口径：昨日 GAAP 环比；阈值 T3 环比 ±50% / T2 涨跌 ±30 万 / T1 涨跌 ±${notice}，多档取最高档；上月基数低于 30 万只报环比档并标「低基数」。`;

/* ---------- R1：设置页阈值配置 ---------- */

test("R1 设置页：非法输入被阻止并给字段级错误，保存后立即生效并广播到客户盘面，恢复默认可回退", async ({ page, crmMock }) => {
  crmMock.setup({ initial: customerSnapshot([customerOf({})]), result: succeededRefresh() });
  await installSettingsCompanions(page);

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "设置", "设置");

  await expect(settingsSection(page).getByRole("heading", { name: "GAAP 异动阈值" })).toBeVisible();
  await expect(currentNote(page)).toHaveText(DEFAULT_NOTE);

  // 非法：T1 下限 ≥ T2 下限 → 字段级错误，保存被禁用，原配置不被破坏。
  const noticeInput = page.getByLabel("T1 涨跌额下限（元）");
  await noticeInput.fill("100000");
  await expect(saveButton(page)).toBeEnabled();
  await noticeInput.fill("400000");
  await expect(settingsSection(page).locator(".settings-threshold-field__error").first()).toHaveText("T1 下限必须小于 T2 下限");
  await expect(noticeInput).toHaveAttribute("aria-invalid", "true");
  await expect(saveButton(page)).toBeDisabled();
  await expect(currentNote(page)).toHaveText(DEFAULT_NOTE);

  // 合法保存：当前生效与字段提示同步更新。
  await noticeInput.fill("100000");
  await expect(settingsSection(page).locator(".settings-threshold-field__error")).toHaveCount(0);
  await saveButton(page).click();
  await expect(currentNote(page)).toHaveText(noteWith("10 万"));

  // 同会话广播：客户盘面口径文案随新阈值实时变化（SPA 导航，无刷新）。
  await openView(page, "客户盘面", "客户盘面");
  await expect(page.locator(".gaap-alerts__note")).toHaveText(
    "口径：昨日 GAAP 环比；阈值 T3 环比 ±50% / T2 涨跌 ±30 万 / T1 涨跌 ±10 万，多档取最高档；上月基数低于 30 万只报环比档并标「低基数」。",
  );

  // 恢复默认：回到默认口径。
  await openView(page, "设置", "设置");
  await resetButton(page).click();
  await expect(currentNote(page)).toHaveText(DEFAULT_NOTE);
});

test("R1 客户盘面：阈值变化实时改变异动集合与档位，口径文案同源生成", async ({ page, crmMock }) => {
  const t1Customer = customerOf({
    cid: "cid002", name: "甲客户", lastMonthGaap: 1_000_000,
    yesterdayGaap: 1_100_000, yesterdayGaapRate: 10, yesterdayGaapDiff: 100_000,
  });
  const t2Customer = customerOf({
    cid: "cid003", name: "乙客户", lastMonthGaap: 2_000_000,
    yesterdayGaap: 2_400_000, yesterdayGaapRate: 20, yesterdayGaapDiff: 400_000,
  });
  crmMock.setup({ initial: customerSnapshot([t1Customer, t2Customer]), result: succeededRefresh() });
  await installSettingsCompanions(page);

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "客户盘面", "客户盘面");

  // 默认阈值：T2 乙客户 + T1 甲客户，共 2 条。
  await expect(page.locator('section[aria-label="GAAP 异动分析"] header > span')).toContainText("2 条异动");
  await expect(page.locator(".gaap-alert-card")).toHaveCount(2);
  await expect(page.locator(".gaap-alert-card").first()).toContainText("乙客户");
  await expect(page.locator(".gaap-alert-card").first().locator(".gaap-alert-card__tier")).toHaveText("T2 · 关注");
  await expect(page.locator(".gaap-alert-card").last()).toContainText("甲客户");
  await expect(page.locator(".gaap-alert-card").last().locator(".gaap-alert-card__tier")).toHaveText("T1 · 提示");

  // 调高 T1 下限到 15 万：甲客户（+10 万）不再命中，异动集合实时收缩为 1 条。
  await openView(page, "设置", "设置");
  await page.getByLabel("T1 涨跌额下限（元）").fill("150000");
  await saveButton(page).click();
  await expect(currentNote(page)).toHaveText(noteWith("15 万"));

  await openView(page, "客户盘面", "客户盘面");
  await expect(page.locator('section[aria-label="GAAP 异动分析"] header > span')).toContainText("1 条异动");
  await expect(page.locator(".gaap-alert-card")).toHaveCount(1);
  await expect(page.locator(".gaap-alert-card").first()).toContainText("乙客户");
  await expect(page.locator(".gaap-alerts__note")).toContainText("T1 涨跌 ±15 万");
});

/* ---------- R2.2：抽屉 FBI 归因 ---------- */

test("R2.2 抽屉归因：开始归因 → 轮询完成，产品拆分/口径对账/数据来源如实展示，单次点击只发起一次", async ({ page, crmMock }) => {
  crmMock.setup({ initial: customerSnapshot([customerOf({})]), result: succeededRefresh() });
  const server = new AttributionMockServer({
    postAttribution: runningAttribution(),
    afterGetAttribution: doneAttribution(),
    postExplain: explainRecord("done"),
  });
  await server.install(page);

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "客户盘面", "客户盘面");
  await openCustomerDrawer(page);

  // 初始：未归因，只能开始归因；CRM AI 解释被前置条件挡住并如实说明。
  const startButton = page.locator(".crm-attribution > header").getByRole("button");
  await expect(startButton).toHaveText("开始归因");
  await expect(page.locator('.crm-attribution__explain button')).toBeDisabled();
  await expect(page.locator(".crm-attribution__explain")).toContainText("先完成 FBI 产品拆分，再请 CRM AI 助理解释。");

  // 提交后进入 running（轮询 10s 间隔，默认 expect 超时 15s 足以覆盖）。
  await startButton.click();
  await expect(startButton).toBeDisabled();
  await expect(page.locator(".crm-attribution .crm-insight__body small").first()).toContainText("已提交");
  await expect(page.locator(".crm-attribution .crm-insight__body small").first()).toContainText("完成后自动显示");

  // 轮询到 done：元信息、对账、产品拆分表全部按记录渲染。
  const meta = page.locator(".crm-attribution .crm-insight__body small").first();
  await expect(meta).toContainText("数据日期 2026-10-21 vs 2026-10-20", { timeout: 20_000 });
  await expect(meta).toContainText("数据来源 FBI 报表 1842553");
  await expect(startButton).toHaveText("重新分析");

  // 对账：FBI 45 万 vs 鲲鹏异动卡 35 万，超容差 → 显式口径差异标注，不强行对齐。
  const recon = page.locator(".crm-attribution__recon");
  await expect(recon).toHaveClass(/is-mismatch/);
  await expect(recon).toContainText("FBI 客户总变化（业绩分成口径）");
  await expect(recon).toContainText("+45 万");
  await expect(recon).toContainText("鲲鹏异动卡涨跌额（主关联人归属口径）");
  await expect(recon).toContainText("+35 万");
  await expect(recon.locator("small")).toHaveText("绝对差 10 万，容差 1 万：超出容差，属口径差异，以鲲鹏数据为准。");

  // 产品拆分表：一级按 |变化额| 降序，变化额/变化率/贡献度如实展示。
  const table = page.locator(".crm-attribution__table");
  await expect(table).toContainText("模型服务");
  await expect(table).toContainText("计算");
  await expect(table).toContainText("+40 万");
  await expect(table).toContainText("+100.0%");
  await expect(table).toContainText("+88.9%");
  await expect(table).toContainText("+5 万");
  await expect(table).toContainText("+20.0%");

  // 二级明细：模型服务可展开（推理/训练），计算未拆二级不展示展开按钮。
  await expect(page.locator(".crm-attribution__expand")).toHaveCount(1);
  await page.getByRole("button", { name: "展开 模型服务 的二级产品" }).click();
  await expect(page.locator(".crm-attribution__child")).toHaveCount(2);
  await expect(page.locator(".crm-attribution__child").first()).toContainText("└ 推理");
  await expect(page.locator(".crm-attribution__child").first()).toContainText("+25 万");
  await expect(page.locator(".crm-attribution__child").last()).toContainText("└ 训练");
  expect(server.getAttributionPosts(), "单次点击只发起一次 FBI 归因").toBe(1);
});

test("R2.2 归因失败：如实展示失败原因与可重试提示，不渲染任何产品行，不推测数据", async ({ page, crmMock }) => {
  crmMock.setup({ initial: customerSnapshot([customerOf({})]), result: succeededRefresh() });
  const server = new AttributionMockServer({
    postAttribution: failedAttribution("fbi_parse_failed"),
    postExplain: explainRecord("done"),
  });
  await server.install(page);

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "客户盘面", "客户盘面");
  await openCustomerDrawer(page);

  await page.locator(".crm-attribution > header").getByRole("button", { name: "开始归因" }).click();

  await expect(page.locator(".crm-insight__error").first()).toHaveText("FBI 返回内容无法解析为产品拆分：本次未产出归因，可重新分析。");
  await expect(page.locator(".crm-attribution .crm-insight__body small").first()).toContainText("上次归因未完成，可以重新分析");
  await expect(page.locator(".crm-attribution__table")).toHaveCount(0);
  await expect(page.locator(".crm-attribution__recon")).toHaveCount(0);
  // FBI 拆分失败时，CRM AI 解释保持禁用并说明前置条件。
  await expect(page.locator(".crm-attribution__explain button")).toBeDisabled();
  await expect(page.locator(".crm-attribution__explain")).toContainText("先完成 FBI 产品拆分，再请 CRM AI 助理解释。");
});

/* ---------- R2.3：CRM AI 助理解释 ---------- */

test("R2.3 CRM AI 解释：归因完成后可发起，回复原文展示并带口径与免责标注；失败时 FBI 表格保留", async ({ page, crmMock }) => {
  crmMock.setup({ initial: customerSnapshot([customerOf({})]), result: succeededRefresh() });
  const server = new AttributionMockServer({
    postAttribution: doneAttribution(),
    postExplain: explainRecord("failed"),
  });
  await server.install(page);

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "客户盘面", "客户盘面");
  await openCustomerDrawer(page);

  // 归因直接完成（POST 返回 done），FBI 表格在场。
  await page.locator(".crm-attribution > header").getByRole("button", { name: "开始归因" }).click();
  await expect(page.locator(".crm-attribution__table")).toBeVisible();
  await expect(page.locator(".crm-attribution .crm-insight__body small").first()).toContainText("数据来源 FBI 报表 1842553");

  // 发起解释：单次点击只发送一次；失败如实降级，FBI 表格不受影响。
  const explainButton = page.locator(".crm-attribution__explain button");
  await expect(explainButton).toHaveText("请 CRM AI 助理解释");
  await explainButton.click();
  await expect(page.locator(".crm-attribution__explain .crm-insight__error").first()).toHaveText("等待回复超时（5 分钟）：结果不确定，可到钉钉会话核对后重试。");
  await expect(page.locator(".crm-attribution__explain")).toContainText("上次解释未完成");
  await expect(page.locator(".crm-attribution__explain .crm-insight__answer")).toHaveCount(0);
  await expect(page.locator(".crm-attribution__table")).toBeVisible();
  await expect(page.locator(".crm-attribution .crm-insight__body small").first()).toContainText("数据来源 FBI 报表 1842553");
  expect(server.getExplainPosts(), "单次点击只发送一次，不重试轰炸").toBe(1);

  // 成功路径：重新解释（force）后返回 done，回复原文 + 口径/免责标注展示。
  const serverDone = new AttributionMockServer({
    initialAttribution: doneAttribution(),
    postAttribution: doneAttribution(),
    postExplain: explainRecord("done"),
  });
  await serverDone.install(page);
  await page.reload();
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible();
  await openView(page, "客户盘面", "客户盘面");
  await openCustomerDrawer(page);

  // 抽屉重新挂载会 GET 归因记录；已完成时直接展示并复用（无新 POST）。
  await expect(page.locator(".crm-attribution__table")).toBeVisible();
  await expect(page.locator(".crm-attribution > header").getByRole("button")).toHaveText("重新分析");
  expect(serverDone.getAttributionPosts(), "已完成归因在抽屉重开时不重复发起").toBe(0);

  await page.locator(".crm-attribution__explain button").click();
  const answer = page.locator(".crm-attribution__explain .crm-insight__answer");
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("从 FBI 拆分看，增长主要由模型服务（推理扩容、训练新增）带动。（模拟 CRM AI 助理回复）");
  await expect(page.locator(".crm-attribution__explain")).toContainText("业绩分成口径 · 仅供参考，以鲲鹏数据为准。");
  await expect(page.locator(".crm-attribution__explain button")).toHaveText("重新解释");
  expect(serverDone.getExplainPosts()).toBe(1);
});
