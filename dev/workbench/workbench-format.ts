import type { CheckReport, CheckStatus } from "./workbench-types.ts";

/**
 * 表格文本渲染：分组 / 名称 / 状态符号 / 说明 + 汇总行；init 额外附
 * 「下一步」引导（doctor 不附）。纯函数，无 IO。
 */

export const STATUS_SYMBOL: Readonly<Record<CheckStatus, string>> = {
  ok: "✓",
  info: "○",
  warn: "△",
  error: "✗",
};

const MAX_NAME_WIDTH = 36;

function titleOf(tool: CheckReport["tool"]): string {
  return tool === "init" ? "初始化体检" : "环境体检";
}

function rowLines(report: CheckReport): string[] {
  const width = Math.min(
    Math.max(8, ...report.checks.map((row) => row.name.length)),
    MAX_NAME_WIDTH,
  );
  const lines: string[] = [];
  let currentGroup = "";
  for (const row of report.checks) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      lines.push(`[${currentGroup}]`);
    }
    lines.push(`  ${row.name.padEnd(width)}  ${STATUS_SYMBOL[row.status]} ${row.status.padEnd(5)}  ${row.detail}`);
  }
  return lines;
}

export function formatReport(report: CheckReport): string {
  const summary = report.summary;
  const lines = [
    `SA 工作台 · ${titleOf(report.tool)}（npm run ${report.tool}）  生成于 ${report.generatedAt}`,
    "",
    ...rowLines(report),
    "",
    `汇总：ok ${summary.ok} · info ${summary.info} · warn ${summary.warn} · error ${summary.error}`
      + "（任一 error → 退出码 1，其余不影响）",
  ];
  return lines.join("\n");
}

/** init 的「下一步」引导：语义移植自静态版 init.js 末尾的下一步清单（本仓语境改写）。 */
export const INIT_NEXT_STEPS: readonly string[] = [
  "下一步：",
  "  1. 依赖缺失时先 npm ci（本终端需 Node 22.12+，见 runtime 组）",
  "  2. 需要本地 AI 问答/语义检索：复制 .env.example 为 .env.local 并填写 DASHSCOPE_API_KEY",
  "  3. 按需启用功能：复制 config/<名>.json.example 为 .local-cache/<名>.json 并填写（见 config 组各行修法）",
  "  4. 启动：npm run dev（前端）＋ npm run dev:function（本地桥，端口 8000）",
  "  5. 复查：npm run doctor",
];

export function renderToolOutput(report: CheckReport): string {
  const table = formatReport(report);
  return report.tool === "init" ? `${table}\n\n${INIT_NEXT_STEPS.join("\n")}` : table;
}
