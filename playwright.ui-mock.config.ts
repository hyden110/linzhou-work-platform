import { defineConfig } from "@playwright/test";

// test:frontend-ui 专用配置（tests/e2e/ui-mock/）：
// - 使用真实前端代码（vite dev server），业务 API 全部由测试内受控 Mock 提供。
// - 所有业务 API（/local/**、/functions/**）fail-closed：未显式 Mock 的请求立即失败。
// - 禁止真实业务后端、真实账号、数据库和真实数据副作用。
// - webServer 由 Playwright 托管：启动本地前端、就绪检测、结束/失败后自动清理。
// 与 deploy-smoke 套件（playwright.deploy-smoke.config.ts）互不混用。
export default defineConfig({
  testDir: "./tests/e2e/ui-mock",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_UI_BASE_URL ?? "http://127.0.0.1:5177",
    // 固定语言与时区，让“10/22 09:30”这类时间断言与运行环境无关。
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
  webServer: {
    command: "npm run dev -- --port 5177 --strictPort",
    url: "http://127.0.0.1:5177",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
