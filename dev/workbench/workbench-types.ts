/**
 * Shared contract for `npm run init` / `npm run doctor` (workbench bootstrap).
 *
 * 口径：每个检查项只输出「分组 / 检查项名 / 状态 / 说明」。说明里只允许出现
 * 变量名、文件名、计数、权限位、时间等非敏感信息——任何环境变量值、凭据、
 * 客户数据都不进入行（env 只报已设置/未设置）。
 * 退出码：任一 error → 1；warn/info 不影响退出码。
 */

export type CheckStatus = "ok" | "info" | "warn" | "error";

export interface CheckRow {
  readonly group: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export type CheckTool = "init" | "doctor";

export interface CheckReport {
  readonly ok: boolean;
  readonly tool: CheckTool;
  readonly generatedAt: string;
  readonly summary: Readonly<Record<CheckStatus, number>>;
  readonly checks: readonly CheckRow[];
}

export const STATUS_ORDER: readonly CheckStatus[] = ["ok", "info", "warn", "error"];

export function checkRow(group: string, name: string, status: CheckStatus, detail: string): CheckRow {
  return { group, name, status, detail };
}

export function summarize(rows: readonly CheckRow[]): Readonly<Record<CheckStatus, number>> {
  const count = (status: CheckStatus): number => rows.filter((row) => row.status === status).length;
  return { ok: count("ok"), info: count("info"), warn: count("warn"), error: count("error") };
}

export function buildReport(tool: CheckTool, rows: readonly CheckRow[], nowMs: number): CheckReport {
  const summary = summarize(rows);
  return {
    ok: summary.error === 0,
    tool,
    generatedAt: new Date(nowMs).toISOString(),
    summary,
    checks: [...rows],
  };
}

/** error 级失败 → 1；其余（含 warn）→ 0。 */
export function exitCodeOf(report: CheckReport): number {
  return report.summary.error > 0 ? 1 : 0;
}

/** 异常首行（供单组降级行使用；错误上下文里不含任何 env 值或文件内容）。 */
export function firstLineOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split("\n")[0] ?? "";
}
