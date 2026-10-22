// test:frontend-smoke：工单 #10074 部署后只读冒烟检查（GAAP 阈值设置区）。
// 只导航到「设置」并断言 GAAP 异动阈值区块渲染（该区块只读 localStorage，不依赖 /local 业务接口）。
// 部署环境可能没有本机 dev:function 桥，/local/** 失败属预期：
// 客户盘面的异动面板与抽屉归因依赖快照数据，不在部署冒烟中断言（研发阶段由 ui-mock 套件覆盖）。
// 不点击「刷新数据」、不做任何写操作；base URL 只由 PLAYWRIGHT_BASE_URL 运行时注入。
import { expect, test } from "@playwright/test";

const navButton = (page: import("@playwright/test").Page, label: string) =>
  page.locator('nav[aria-label="主导航"]').getByRole("button", { name: label });

test("部署冒烟：设置页 GAAP 异动阈值区块渲染（只读）", async ({ page }) => {
  const fatalErrors: string[] = [];
  page.on("pageerror", (error) => fatalErrors.push(error.message));

  await page.goto("/");
  await expect(page.locator("h1", { hasText: "驾驶舱" })).toBeVisible({ timeout: 20_000 });

  await navButton(page, "设置").click();
  await expect(page.locator("h1", { hasText: "设置" })).toBeVisible();

  const section = page.locator('section[aria-label="GAAP 异动阈值"]');
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "GAAP 异动阈值" })).toBeVisible();
  // 四个阈值输入按默认值渲染，当前生效口径为默认文案（部署环境无持久化配置）。
  await expect(section.locator(".settings-threshold-grid input")).toHaveCount(4);
  await expect(section.locator(".settings-threshold-actions__current")).toContainText("当前生效：");
  await expect(section.locator(".settings-threshold-actions__current")).toContainText("T3 环比 ±50%");

  expect((await page.locator("body").innerText()).trim().length, "页面不应白屏").toBeGreaterThan(0);
  expect(fatalErrors, "不应有未捕获的页面错误").toEqual([]);
});
