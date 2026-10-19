import type { KbAdapterContext } from "./kb-adapter-shared.ts";
import { runCliJson, summaryRunnerEnv, summaryWorkingDir } from "./kb-adapter-shared.ts";
import type { KbSummaryHit, KbSummaryResult } from "./kb-types.ts";
import { trunc } from "./kb-util.ts";

/**
 * AI 摘要（qodercli 只读调用）。
 * Ported semantics from base/sa-workbench scripts/lib/kb/summary.js:
 * - topN 3-12（默认 8，由配置 sanitize 负责）；
 * - 摘要输入只含 标题/路径/摘要片段 —— 绝不携带客户数据或本地索引字段；
 * - 同一时刻只允许一个总结在生成（RUNNING 单飞闸门）；
 * - 失败向上抛 KbBridgeError(kb_summary_failed)，由上层降级为「无摘要」，
 *   绝不阻塞检索结果返回。
 */

export const SUMMARY_PROMPT_HEADER = [
  "你是解决方案架构师助理。仅依据下面的知识库检索片段回答问题：",
  "每条结论后用 [n] 标注出处编号；片段不足以回答时，明确说明证据不足。",
  "不要编造片段之外的细节，不要输出与问题无关的内容。",
].join("\n");

/** 单飞：同一时刻只允许一个总结在生成。 */
let running = false;

export interface KbSummarizer {
  readonly summarize: (query: string, hits: readonly KbSummaryHit[]) => Promise<KbSummaryResult>;
}

/**
 * Build the qodercli prompt from sanitized hits ONLY. Anything not passed in
 * (customer fields, absolute paths, local index payloads) physically cannot
 * enter the prompt because it is composed field-by-field here.
 */
export function buildSummaryPrompt(query: string, hits: readonly KbSummaryHit[]): string {
  const blocks = hits.map((hit, index) => {
    const origin = hit.space ? `${trunc(hit.source, 40)} · ${trunc(hit.space, 60)}` : trunc(hit.source, 40);
    return `[${index + 1}] 《${trunc(hit.title, 80)}》（${origin}）\n${trunc(hit.snippet, 800)}`;
  });
  return `${SUMMARY_PROMPT_HEADER}\n\n问题：${trunc(query, 200)}\n\n检索片段：\n\n${blocks.join("\n\n")}`;
}

export function createKbSummarizer(context: { run: KbAdapterContext["run"]; model: string; timeoutMs: number }): KbSummarizer {
  const { run, model, timeoutMs } = context;

  return {
    summarize: async (query, hits) => {
      if (running) throw new Error("上一个总结还在生成");
      const args = ["-p", "--tools", "", "-o", "json"];
      if (model && model !== "Auto" && /^[\w .()-]{1,80}$/.test(model)) args.push("-m", model);
      running = true;
      try {
        const payload = await runCliJson(
          run,
          "qodercli",
          args,
          timeoutMs,
          "未找到 qodercli",
          {
            stdin: buildSummaryPrompt(query, hits),
            cwd: summaryWorkingDir(),
            env: summaryRunnerEnv(),
          },
        );
        const record = payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {};
        const answer = record.result;
        if (record.is_error === true || typeof answer !== "string" || !answer.trim()) {
          throw new Error(typeof answer === "string" && answer.trim() ? answer : "qodercli 无结果");
        }
        return {
          answer: answer.slice(0, 8_000),
          ms: typeof record.duration_ms === "number" ? record.duration_ms : null,
          degraded: false as const,
        };
      } finally {
        running = false;
      }
    },
  };
}
