#!/usr/bin/env node
/**
 * npm run init — 新环境初始化体检 + 缺失配置引导。
 * 语义移植自 base/sa-workbench scripts/init.js（只搬语义不搬代码）：
 * - 静态版的快照占位（data/*.js.example 铺占位防 <script> 404）在 React 工作台
 *   无对应物（数据走运行时桥，缺配置时各面板自行降级为「未配置」）；
 * - 静态版的配置模板口径（缺失 = 未配置 = 对应功能隐藏，仅提示复制 .example
 *   填写，不自动写文件）完整保留为本 CLI 的 info 行 + 修法提示；
 * - 静态版的加密凭据库初始化（credctl）在本仓无对应物（凭据走 .env.local /
 *   .local-cache，同样只提示不代写）。
 * 因此本命令与 doctor 跑同一套只读检查，只是输出多一段「下一步」引导，
 * 绝不写任何文件。退出码：任一 error → 1。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorkbenchCli } from "../dev/workbench/workbench-cli.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runWorkbenchCli("init", { rootDir });
