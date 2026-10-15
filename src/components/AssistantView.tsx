import { useEffect, useRef, useState } from "react";
import { AlertCircle, Clock3, History, RefreshCw, Sparkles, Target, TerminalSquare } from "lucide-react";
import { assistantErrorMessage, generateSolution, type AssistantResponse } from "../lib/assistant-client";
import type { SolutionDegradeCode } from "../lib/assistant-contract";
import type { SolutionVersion } from "../lib/solution-history-client";
import { useLocalRuntime } from "./LocalRuntimeProvider";
import { SolutionHistoryPanel } from "./SolutionHistoryPanel";
import { SolutionPlanView } from "./SolutionPlanView";
import { StatusBadge, ViewHeading, type ViewProps } from "./shared";

const INDUSTRIES = ["零售与消费", "制造与工业", "医疗健康", "互联网", "金融", "政企与公共", "其他"];

const GENERATION_STAGES = [
  { after: 0, label: "正在从本机索引召回受控证据（摘要与引用片段，不含原始文件）" },
  { after: 8, label: "本机 Qoder CLI 正在生成阿里云分层架构方案" },
  { after: 60, label: "仍在生成：模型正在核对产品选型与链路，实测约需 2 到 3 分钟" },
  { after: 180, label: "生成时间偏长：本机 CLI 最长等待 240 秒，超时会自动回落到参考架构模板" },
];

const DEGRADE_MESSAGES: Record<SolutionDegradeCode, string> = {
  "cli-not-found": "未找到本机 Qoder CLI，已改用阿里云参考架构模板。",
  "cli-timeout": "本机 Qoder CLI 生成超时，已改用阿里云参考架构模板。",
  "cli-failed": "本机 Qoder CLI 执行失败，已改用阿里云参考架构模板。",
  "cli-invalid-output": "本机 Qoder CLI 输出不符合方案契约，已改用阿里云参考架构模板。",
};

const EMPTY_FORM = {
  customer: "某区域零售集团",
  industry: "零售与消费",
  goal: "建设面向门店经营的 AI 助手",
  constraints: "存量系统较多，要求数据不出域",
};

function stageFor(elapsed: number): string {
  return GENERATION_STAGES.filter((stage) => elapsed >= stage.after).at(-1)?.label ?? GENERATION_STAGES[0]!.label;
}

export function AssistantView(_: ViewProps) {
  const runtime = useLocalRuntime();
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState<AssistantResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);
  const [viewing, setViewing] = useState<{ version: number; customer: string; createdAt: string } | null>(null);
  const outputRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!generating) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1_000)), 1_000);
    return () => clearInterval(timer);
  }, [generating]);

  const updateField = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const generate = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (generating) return;
    setGenerating(true);
    setError("");
    setViewing(null);
    try {
      setResult(await generateSolution({
        requestId: crypto.randomUUID(),
        customer: form.customer.trim(),
        industry: form.industry.trim(),
        goal: form.goal.trim(),
        constraints: form.constraints.trim(),
      }));
      setHistoryKey((key) => key + 1);
    } catch (requestError) {
      setResult(null);
      setError(assistantErrorMessage(requestError));
    } finally {
      setGenerating(false);
    }
  };

  const openVersion = (version: SolutionVersion, customer: string) => {
    setResult({ plan: version.plan, retrieval: version.retrieval });
    setViewing({ version: version.version, customer, createdAt: version.createdAt });
    setError("");
    outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const plan = result?.plan;
  const retrieval = result?.retrieval;
  const heading = viewing
    ? { tone: "blue" as const, label: `历史版本 v${viewing.version}` }
    : plan
      ? { tone: plan.engine === "qoder-cli" ? "green" as const : "amber" as const, label: plan.engine === "qoder-cli" ? "Qoder CLI 已生成" : "模板降级" }
      : generating
        ? { tone: "blue" as const, label: `生成中 ${elapsed}s` }
        : { tone: "blue" as const, label: runtime.status.available ? "本机服务就绪" : "本机服务未启动" };

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="SOLUTION COMPOSER / 04"
        title="方案助手"
        description="输入客户上下文，本机 Qoder CLI 基于受控证据生成贴合阿里云产品的分层架构方案，并附架构图、关键链路与引用；每次生成都自动存档为可回看的历史版本。"
        aside={<StatusBadge tone={heading.tone}>{heading.label}</StatusBadge>}
      />

      <div className="assistant-layout">
        <form className="panel assistant-form" onSubmit={generate}>
          <div className="panel__header">
            <div><span className="eyebrow">CUSTOMER CONTEXT</span><h2>需求输入</h2></div>
            <Target size={21} />
          </div>
          <label>客户名称
            <input maxLength={80} value={form.customer} onChange={(event) => updateField("customer", event.target.value)} required />
          </label>
          <label>所属行业
            <select value={form.industry} onChange={(event) => updateField("industry", event.target.value)}>
              <option value="">不限</option>
              {INDUSTRIES.map((industry) => <option key={industry} value={industry}>{industry}</option>)}
            </select>
          </label>
          <label>业务目标
            <textarea maxLength={500} rows={3} value={form.goal} onChange={(event) => updateField("goal", event.target.value)} required />
          </label>
          <label>现状与约束
            <textarea maxLength={500} rows={3} value={form.constraints} onChange={(event) => updateField("constraints", event.target.value)} />
          </label>
          <button className="primary-button" type="submit" disabled={generating || form.customer.trim().length < 1 || form.goal.trim().length < 4}>
            <Sparkles size={16} /> {generating ? `生成中 ${elapsed}s…` : "生成架构方案"}
          </button>
          <p className="assistant-form__note">
            <Clock3 size={13} /> 一次生成通常需要 2 到 3 分钟；仅上传受控摘要与引用，原始文件与凭证留在本机。
          </p>
          {!runtime.status.available && (
            <div className="answer-warning"><TerminalSquare size={15} /> 未检测到本机服务，请先运行 npm run dev:function。</div>
          )}
        </form>

        <section className="panel assistant-output" aria-live="polite" ref={outputRef}>
          {generating ? (
            <div className="empty-state">
              <div><span className="spin-dot" /></div>
              <h2>正在生成方案 · {elapsed}s</h2>
              <p>{stageFor(elapsed)}</p>
            </div>
          ) : error ? (
            <div className="empty-state">
              <div><AlertCircle size={29} /></div>
              <h2>方案生成失败</h2>
              <p>{error}</p>
              <button className="secondary-button assistant-retry" onClick={() => void generate()}>
                <RefreshCw size={14} /> 重新生成
              </button>
            </div>
          ) : !plan || !retrieval ? (
            <div className="empty-state">
              <div><Sparkles size={29} /></div>
              <h2>等待生成架构方案</h2>
              <p>填写客户目标与约束后生成：输出包含分层架构图、阿里云产品选型、关键链路、诉求对应、风险应对与证据引用。</p>
            </div>
          ) : (
            <>
              <div className="output-header">
                <div>
                  <div className="plan-badges">
                    {viewing && (
                      <StatusBadge tone="blue">
                        <History size={12} /> 历史存档 v{viewing.version}
                      </StatusBadge>
                    )}
                    <StatusBadge tone={plan.engine === "qoder-cli" ? "green" : "amber"}>
                      {plan.engine === "qoder-cli" ? "Qoder CLI 生成" : "阿里云模板"}
                    </StatusBadge>
                    <StatusBadge tone={retrieval.status === "results-only" ? "blue" : "muted"}>
                      {retrieval.status === "results-only"
                        ? `召回 ${retrieval.resultCount} 份 · 证据 ${plan.evidence.length} 条`
                        : "未召回受控证据"}
                    </StatusBadge>
                    <StatusBadge tone="muted">{retrieval.vectorSearch === "semantic" ? "语义 + 关键词" : "仅关键词"}</StatusBadge>
                  </div>
                  <h2>{plan.title}</h2>
                  <p>
                    {viewing
                      ? `${viewing.customer} · 存档于 ${new Date(viewing.createdAt).toLocaleString("zh-CN", { hour12: false })} · 只读回看，重新生成会追加为新版本`
                      : `${new Date(plan.generatedAt).toLocaleString("zh-CN", { hour12: false })} · 请结合引用与官方文档核验后再对客使用`}
                  </p>
                </div>
                <button className="secondary-button" onClick={() => void generate()} disabled={generating}>
                  <RefreshCw size={14} /> 重新生成
                </button>
              </div>

              {plan.degraded && (
                <div className="answer-warning"><AlertCircle size={15} /> {DEGRADE_MESSAGES[plan.degraded]}</div>
              )}
              {retrieval.status === "insufficient-evidence" && (
                <div className="answer-warning">
                  <AlertCircle size={15} /> 本次没有召回到达到阈值的受控证据，方案基于通用最佳实践生成，未引用本地资料。
                </div>
              )}

              <p className="plan-summary">{plan.summary}</p>

              <SolutionPlanView plan={plan} />

              <div className="output-section">
                <h3><Target size={16} /> 检索依据</h3>
                <div className="query-chips">
                  {retrieval.queries.map((query) => <code key={query}>{query}</code>)}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <SolutionHistoryPanel
        available={runtime.status.available}
        refreshKey={historyKey}
        disabled={generating}
        onOpen={(version, summary) => openVersion(version, summary.customer)}
      />
    </div>
  );
}
