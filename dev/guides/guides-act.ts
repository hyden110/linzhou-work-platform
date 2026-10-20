/**
 * 指引 action 步执行器（TS 移植自 base/sa-workbench scripts/lib/guides.js actStep）。
 *
 * 三类动作，安全语义分层：
 *   terminal           只回显命令文本（obj.command），绝不执行任何子进程；
 *   aitable-provision  needConfirm 步必经 body.confirm === true（严格布尔，
 *                      "true"/1 都不算），确认后经注入 runner execFile dws；
 *   refresh            委托桥注入的 actRefresh（未注入 → guides_unavailable，不伪造成功）。
 */

import type { Guide, GuideStep } from "../../src/lib/guides-model.ts";
import { provisionSchemas } from "./aitable-provision.ts";
import { GuidesBridgeError, type GuideCommandRunner } from "./guides-types.ts";

export interface ActDeps {
  readonly run?: GuideCommandRunner;
  readonly dwsBin?: string;
  readonly cacheDir?: string;
  readonly timeoutMs?: number;
  readonly actRefresh?: (group: string | null) => Promise<Record<string, unknown>>;
}

export interface ActOutcome {
  readonly code: number;
  readonly obj: Record<string, unknown>;
}

const TERMINAL_NOTE = "请在本机终端执行后回来点「重新检测」";

/** 执行一个 action 步；step.kind !== "action" 由调用方（bridge）先行拦截。 */
export async function actStep(guide: Guide, step: GuideStep, body: unknown, deps: ActDeps): Promise<ActOutcome> {
  const action = step.action;
  if (!action) throw new GuidesBridgeError("guides_not_found", `指引「${guide.id}」步「${step.id}」没有动作定义`);
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  if (action.type === "terminal") {
    /* 红线：terminal 动作绝不触碰 runner，只把命令文本原样回显给页面。 */
    return { code: 200, obj: { ok: true, terminal: true, command: action.cmd ?? "", note: TERMINAL_NOTE } };
  }

  if (action.type === "aitable-provision") {
    if (step.needConfirm && record.confirm !== true) {
      throw new GuidesBridgeError("guides_confirm_required", "需要二次确认", step.confirm ?? "");
    }
    if (!deps.run || !deps.dwsBin || !deps.cacheDir) {
      throw new GuidesBridgeError("guides_unavailable", "桥未注入 dws 运行器 / 缓存目录，无法执行建表");
    }
    const provision = await provisionSchemas(action.schemas ?? [], {
      run: deps.run,
      dwsBin: deps.dwsBin,
      cacheDir: deps.cacheDir,
      timeoutMs: deps.timeoutMs,
    });
    return { code: 200, obj: { ok: true, provision } };
  }

  if (action.type === "refresh") {
    if (typeof deps.actRefresh !== "function") {
      throw new GuidesBridgeError("guides_unavailable", "桥未注入刷新能力");
    }
    return { code: 200, obj: await deps.actRefresh(action.group ?? null) };
  }

  throw new GuidesBridgeError("guides_invalid_request", `未知动作类型 ${String((action as { type?: unknown }).type ?? "")}`);
}
