#!/usr/bin/env node
/**
 * npm run doctor — 纯只读环境体检。
 * 语义移植自 base/sa-workbench scripts/doctor.js（只搬语义不搬代码）：
 * - 静态版的「能力矩阵 ✓/○/△/✗」落为六组检查行（runtime/config/env/tools/
 *   ports/security），未配置与未安装项如实显示灰行 + 修法提示（不隐藏）；
 * - 退出码口径按本仓 CheckReport 契约（任一 error → 1；warn/info 不影响），
 *   与静态版「至少一项能力就绪即 0」不同，属任务指定的契约偏离；
 * - 静态版的 kunpeng 漂移检查与 data/_caps.js 物化在本仓无对应物，不移植。
 * 全程不写任何文件、不启动任何服务。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorkbenchCli } from "../dev/workbench/workbench-cli.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runWorkbenchCli("doctor", { rootDir });
