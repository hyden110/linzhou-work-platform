import { defineConfig } from "@playwright/test";

// test:frontend-smoke 专用配置（tests/e2e/deploy-smoke/）：
// - 只做部署后无副作用检查：入口可达、关键视图、资源加载、无白屏、无致命浏览器错误。
// - base URL 只允许通过 PLAYWRIGHT_BASE_URL 由 QA SDLC 运行时注入；不内置任何环境地址。
// - 不启动任何本地服务，不回退到 UI Mock 套件，不执行任何写操作/刷新数据。
const baseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
if (!baseURL) {
  throw new Error(
    "test:frontend-smoke 需要 PLAYWRIGHT_BASE_URL（由 QA SDLC 运行时注入固定部署地址）。" +
      "本套件不内置任何环境地址，也不会启动本地服务；研发阶段可用占位地址做配置加载/用例发现校验。",
  );
}

export default defineConfig({
  testDir: "./tests/e2e/deploy-smoke",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL },
});
