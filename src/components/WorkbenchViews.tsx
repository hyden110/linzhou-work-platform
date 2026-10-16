import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDot,
  Clock3,
  Cloud,
  Database,
  Filter,
  Layers3,
  Link2,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatBytes, formatDate } from "../data/format";
import { ALL_CUSTOMERS, ALL_TRACKS, UNCLASSIFIED_CUSTOMER, UNCLASSIFIED_TRACK } from "../data/facets";
import { useCrm } from "./crm/CrmProvider";
import { REFRESH_ERRORS, SOURCE_LABELS, formatClock, formatDateTime } from "./crm/crm-shared";
import type { SourceKey, SourceStatus } from "../lib/crm-types";
import { groupCitationsByDocument, retrieveKnowledge, type RetrievalResponse } from "../lib/retrieval-client";
import { DocumentFacetFilter, type DocumentFacets } from "./FacetFilter";
import { DocumentRow } from "./DocumentRow";
import { ShelfGrid } from "./ShelfGrid";
import { StatusBadge, ViewHeading, numberedAnswer, retrievalErrorMessage, type ViewProps } from "./shared";

export function OverviewView({ index, documents, onNavigate }: ViewProps) {
  const topTypes = index.stats.byType.slice(0, 5);
  const topTopics = index.stats.byTopic.slice(0, 7);
  const maxTopicCount = Math.max(...topTopics.map((topic) => topic.count), 1);
  const recent = documents.length === index.documents.length ? index.recentDocuments.slice(0, 6) : documents.slice(0, 6);
  const classifiedTracks = index.stats.bySolutionTrack.filter((row) => row.name !== UNCLASSIFIED_TRACK).length;
  const classifiedCustomers = index.stats.byCustomer.filter((row) => row.name !== UNCLASSIFIED_CUSTOMER).length;
  const unfiledTracks = index.stats.bySolutionTrack.find((row) => row.name === UNCLASSIFIED_TRACK)?.count ?? 0;

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="ARCHITECT'S CONSOLE / 01"
        title="早上好，架构师"
        description="从本地事实出发，快速定位材料、建立知识关联、准备客户方案。"
        aside={<div className="heading-status"><span className="pulse-dot" /> 本地索引可用 <small>{formatDate(index.generatedAt)}</small></div>}
      />

      <section className="metric-grid" aria-label="索引概览">
        <article className="metric-card metric-card--primary">
          <div className="metric-card__icon"><Database size={20} /></div>
          <span>已索引资料</span>
          <strong>{index.stats.totalDocuments.toLocaleString("zh-CN")}</strong>
          <small><TrendingUp size={13} /> {formatBytes(index.stats.totalBytes)} 元数据盘点</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon"><Layers3 size={20} /></div>
          <span>方案与客户</span>
          <strong>{classifiedTracks}</strong>
          <small>{classifiedCustomers} 个客户 · {unfiledTracks} 份待归类</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon"><RefreshCw size={20} /></div>
          <span>本次盘点</span>
          <strong>+{index.syncSummary.added.toLocaleString("zh-CN")}</strong>
          <small>{index.syncSummary.skipped.toLocaleString("zh-CN")} 跳过 · {index.syncSummary.failed} 异常</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon"><ShieldCheck size={20} /></div>
          <span>数据边界</span>
          <strong>LOCAL</strong>
          <small>原始资料未复制、未上传</small>
        </article>
      </section>

      <section className="launch-grid">
        <button className="launch-card launch-card--ask" onClick={() => onNavigate("ask")}>
          <Bot size={23} />
          <div><span>AI 问答</span><strong>带着引用找答案</strong><small>基于受控证据生成回答</small></div>
          <ArrowRight size={18} />
        </button>
        <button className="launch-card" onClick={() => onNavigate("map")}>
          <Network size={23} />
          <div><span>知识地图</span><strong>按四个维度找资料</strong><small>方案 / 客户 / 活动 / 主题</small></div>
          <ArrowRight size={18} />
        </button>
        <button className="launch-card" onClick={() => onNavigate("assistant")}>
          <Sparkles size={23} />
          <div><span>方案助手</span><strong>组合客户材料</strong><small>基于证据生成方案建议</small></div>
          <ArrowRight size={18} />
        </button>
        <button className="launch-card" onClick={() => onNavigate("yunqi")}>
          <Cloud size={23} />
          <div><span>云栖大会</span><strong>六层趋势与论坛</strong><small>本机整理稿提炼的重点内容</small></div>
          <ArrowRight size={18} />
        </button>
      </section>

      <ShelfGrid index={index} onNavigate={onNavigate} />

      <div className="dashboard-grid">
        <section className="panel panel--documents">
          <div className="panel__header">
            <div><span className="eyebrow">RECENT SIGNALS</span><h2>最近更新</h2></div>
            <button className="text-button" onClick={() => onNavigate("documents")}>查看全部 <ArrowRight size={14} /></button>
          </div>
          <div className="document-list">
            {recent.map((document) => <DocumentRow key={document.id} document={document} compact />)}
          </div>
        </section>

        <section className="panel topic-panel">
          <div className="panel__header">
            <div><span className="eyebrow">KNOWLEDGE CLUSTERS</span><h2>主题雷达</h2></div>
            <StatusBadge tone="blue">规则聚类预览</StatusBadge>
          </div>
          <div className="topic-bars">
            {topTopics.map((topic, indexValue) => (
              <button key={topic.name} onClick={() => onNavigate("map", "topics", topic.name)}>
                <span className="topic-bars__rank">{String(indexValue + 1).padStart(2, "0")}</span>
                <div><strong>{topic.name}</strong><i style={{ width: `${Math.max((topic.count / maxTopicCount) * 100, 7)}%` }} /></div>
                <b>{topic.count}</b>
              </button>
            ))}
          </div>
        </section>

        <section className="panel source-panel">
          <div className="panel__header"><div><span className="eyebrow">SOURCE MATRIX</span><h2>资料构成</h2></div></div>
          <div className="source-total"><strong>{index.stats.totalDocuments.toLocaleString("zh-CN")}</strong><span>FILES</span></div>
          <div className="source-legend">
            {topTypes.map((item) => (
              <div key={item.name}><i className={`legend-dot legend-dot--${item.name.toLowerCase()}`} /><span>{item.name}</span><strong>{item.count.toLocaleString("zh-CN")}</strong></div>
            ))}
          </div>
          <div className="source-note"><CircleDot size={14} /> 钉钉缺少完整枚举接口 · 云栖 CLI 待登录</div>
        </section>
      </div>
    </div>
  );
}

export function AskView(_: ViewProps) {
  const [question, setQuestion] = useState("零售客户建设全栈 AI 能力，有哪些可复用案例？");
  const [result, setResult] = useState<RetrievalResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = question.trim();
    if (!query || loading) return;
    setLoading(true);
    setError("");
    try {
      setResult(await retrieveKnowledge({ query, mode: "qa", requestId: crypto.randomUUID() }));
    } catch (requestError) {
      setResult(null);
      setError(retrievalErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  };

  const status = result?.status === "answered"
    ? { label: "AI 已基于证据回答", tone: "green" as const }
    : result?.status === "insufficient-evidence"
      ? { label: "证据不足", tone: "amber" as const }
      : result
        ? { label: result.diagnosticId ? "AI 调用降级" : "AI 未启用", tone: "amber" as const }
        : { label: "AI 服务待命", tone: "blue" as const };
  const citationGroups = result ? groupCitationsByDocument(result.citations) : [];

  return (
    <div className="view-stack ask-layout">
      <ViewHeading eyebrow="EVIDENCE Q&A / 02" title="AI 问答" description="先检索受控摘要与引用，再由 AI 生成可核验答案；证据不足时明确拒答。" aside={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
      <form className="ask-box" onSubmit={submit}>
        <Bot size={24} />
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="问题" rows={2} maxLength={500} placeholder="输入客户、场景或技术问题…" />
        <button type="submit" disabled={!question.trim() || loading}><Sparkles size={16} /> {loading ? "AI 分析中…" : "向 AI 提问"}</button>
        <div className="ask-box__hints"><span>可试：</span>{["制造业智能体案例", "数据中台架构", "云栖 AI 原生应用"].map((hint) => <button type="button" key={hint} onClick={() => setQuestion(hint)}>{hint}</button>)}</div>
      </form>

      {error && <div className="answer-warning retrieval-error"><AlertCircle size={16} /> {error}</div>}
      {result && (
        <section className="answer-grid" aria-live="polite">
          <article className="panel answer-card">
            <div className="answer-card__status"><span className="pulse-dot" /> {result.status === "answered" ? "AI 证据回答" : "安全降级"}<small>{result.vectorSearch === "semantic" ? "语义 + 关键词检索" : "仅关键词检索"} · 引用约束</small></div>
            {result.status === "answered" ? (
              <><h2>AI 回答</h2><p className="answer-text">{numberedAnswer(result)}</p></>
            ) : result.status === "insufficient-evidence" ? (
              <><h2>现有资料不足以回答</h2><p>没有召回达到阈值的受控证据。请换一种问法，或等待下一次知识同步补充资料。</p></>
            ) : result.diagnosticId ? (
              <><h2>已找到相关证据，但 AI 回答未通过校验</h2><p>模型调用失败或回答未绑定到可用引用，已按安全策略丢弃，仅展示检索到的证据。</p></>
            ) : (
              <><h2>已找到相关证据，但 AI 未启用</h2><p>本地 Function 未读取到百炼密钥，语义检索与 AI 回答均未启用，当前只按关键词召回。请在已配置百炼密钥的终端中重新启动本地 Function。</p></>
            )}
            {result.diagnosticId && <div className="answer-warning"><AlertCircle size={16} /> AI 调用已安全降级 · 诊断编号：{result.diagnosticId}</div>}
          </article>
          <aside className="panel citations-panel">
            <div className="panel__header"><div><span className="eyebrow">CITATIONS</span><h2>引用来源</h2></div><span>{citationGroups.length} 份 · {result.citations.length} 处</span></div>
            {citationGroups.map((group) => (
              <article className="citation" key={group.documentId}>
                <span>[{group.items.map((item) => item.number).join(",")}]</span>
                <div>
                  <strong>{group.title}</strong><small>{group.sourceLabel}</small>
                  {group.items.map(({ number, citation }) => (
                    <p key={citation.referenceId}>{group.items.length > 1 && <b>[{number}] </b>}{citation.locator.kind} {citation.locator.value} · {citation.text}</p>
                  ))}
                </div>
                <Link2 size={15} />
              </article>
            ))}
          </aside>
        </section>
      )}
    </div>
  );
}

export function DocumentsView({ documents, index, facets }: ViewProps & { facets: DocumentFacets }) {
  const [sort, setSort] = useState("updated");
  const sorted = useMemo(() => [...documents].sort((a, b) => sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : b.modifiedAt.localeCompare(a.modifiedAt)), [documents, sort]);
  const activeFacets = [
    facets.track === ALL_TRACKS ? "" : `场景：${facets.track}`,
    facets.customer === ALL_CUSTOMERS ? "" : `客户：${facets.customer}`,
  ].filter(Boolean);

  return (
    <div className="view-stack">
      <ViewHeading eyebrow="SOURCE LIBRARY / 05" title="全部资料" description={`当前显示 ${documents.length.toLocaleString("zh-CN")} / ${index.stats.totalDocuments.toLocaleString("zh-CN")} 份本地元数据；默认仅显示相对定位。`} aside={<StatusBadge>本地索引预览</StatusBadge>} />
      <DocumentFacetFilter facets={facets} />
      <section className="panel library-panel">
        <div className="library-toolbar">
          <div><Filter size={15} /><span>{activeFacets.length > 0 ? activeFacets.join(" · ") : "未启用分类筛选"}</span></div>
          <label>排序<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">最近更新</option><option value="name">名称 A–Z</option></select></label>
        </div>
        <div className="library-columns"><span>文件</span><span>分类</span><span>来源 / 更新</span><span /></div>
        <div className="document-list document-list--full">
          {sorted.slice(0, 80).map((document) => <DocumentRow key={document.id} document={document} />)}
          {sorted.length === 0 && <div className="empty-state empty-state--small"><Search size={24} /><h2>没有匹配资料</h2><p>试试清除上方的场景或客户分类，或调整关键词、来源与类型筛选。</p></div>}
        </div>
        {sorted.length > 80 && <div className="list-limit">共 {sorted.length.toLocaleString("zh-CN")} 份命中，为保持浏览流畅当前展示前 80 项 · 用分类或搜索继续缩小范围</div>}
      </section>
    </div>
  );
}

const DWS_SOURCE_KEYS: readonly SourceKey[] = ["agenda", "todos", "groups", "mentions", "unread"];
const KUNPENG_SOURCE_KEYS: readonly SourceKey[] = ["customers", "projects", "overview", "top", "mygroups"];
const SOURCE_KEY_ORDER = Object.keys(SOURCE_LABELS) as SourceKey[];

type BadgeTone = "green" | "amber" | "blue" | "muted";

function connectorState(
  sources: Partial<Record<SourceKey, SourceStatus>>,
  keys: readonly SourceKey[],
): { label: string; tone: BadgeTone } {
  const states = keys.flatMap((key) => (sources[key] ? [sources[key] as SourceStatus] : []));
  if (states.length === 0) return { label: "未初始化", tone: "muted" };
  if (states.some((state) => state.status === "auth_required")) return { label: "待授权", tone: "amber" };
  if (states.some((state) => state.status === "error")) return { label: "部分失败", tone: "amber" };
  if (states.every((state) => state.status === "ok" && !state.stale)) return { label: "已连接", tone: "green" };
  return { label: "部分接入", tone: "amber" };
}

function sourceState(state: SourceStatus | undefined): { label: string; tone: BadgeTone } {
  if (!state) return { label: "未同步", tone: "muted" };
  if (state.status === "auth_required") return { label: "待授权", tone: "amber" };
  if (state.status === "error") return { label: "读取失败", tone: "amber" };
  if (state.status === "partial") return { label: "部分数据", tone: "amber" };
  if (state.status === "missing") return { label: "未同步", tone: "muted" };
  return state.stale ? { label: "已过期", tone: "amber" } : { label: "正常", tone: "green" };
}

export function SyncView({ index }: ViewProps) {
  const { snapshot, refresh, refreshNow } = useCrm();
  const running = refresh?.state === "running";
  const sources = snapshot?.sources ?? {};
  const dwsState = connectorState(sources, DWS_SOURCE_KEYS);
  const kunpengState = connectorState(sources, KUNPENG_SOURCE_KEYS);
  const summary = index.syncSummary;

  const completedAt = refresh?.finishedAt ?? snapshot?.generatedAt ?? null;
  const completedTime = completedAt ? Date.parse(completedAt) : Number.NaN;
  const completedClock = Number.isNaN(completedTime) ? "—" : formatClock(completedTime);
  const schedule = running
    ? {
        clock: "同步中",
        tone: "amber" as const,
        label: "运行中",
        note: "正在本机执行只读刷新（钉钉 dws + 鲲鹏 ecid 全量拉取），完成后快照自动更新。",
      }
    : refresh?.state === "failed"
      ? {
          clock: completedClock,
          tone: "amber" as const,
          label: "上次失败",
          note: `上次同步失败：${REFRESH_ERRORS[refresh.error ?? ""] ?? "刷新失败"}。请检查本机 dev:function 日志后重试。`,
        }
      : snapshot
        ? {
            clock: completedClock,
            tone: "blue" as const,
            label: "按需触发",
            note: `未配置定时任务；点击“手动同步”在本机触发一次只读刷新（POST /local/crm/refresh）。最近完成 ${formatDateTime(completedAt)}。`,
          }
        : {
            clock: "—",
            tone: "amber" as const,
            label: "尚无快照",
            note: "还没有客户快照；点击“手动同步”生成第一份。",
          };

  const connectors: { name: string; detail: string; status: string; tone: BadgeTone; icon: LucideIcon; meta: string }[] = [
    { name: "本地资料", detail: "案例库 + 场景库", status: "已盘点", tone: "green", icon: Database, meta: `${index.stats.totalDocuments.toLocaleString("zh-CN")} 份元数据` },
    { name: "钉钉连接器", detail: "dws 只读：日程 · 待办 · 群 · @我 · 未读", status: dwsState.label, tone: dwsState.tone, icon: Link2, meta: snapshot ? `群 ${snapshot.groups.length} · @我 ${snapshot.mentions.length} · 未读 ${snapshot.unread.length}` : "等待首次同步" },
    { name: "鲲鹏客户数据", detail: "ecid 只读：客户 · 项目 · TOP · 分层视图", status: kunpengState.label, tone: kunpengState.tone, icon: Layers3, meta: snapshot ? `客户 ${snapshot.customers.length} · 项目 ${snapshot.projects.length}` : "等待首次同步" },
    { name: "云栖大会", detail: "当前为本地 HTML 整理稿解析", status: "已解析", tone: "green", icon: Cloud, meta: "qianwen CLI 已存在但未登录" },
  ];

  return (
    <div className="view-stack">
      <ViewHeading eyebrow="SYNC OPERATIONS / 07" title="同步中心" description="监控本地索引和外部连接器；浏览器不会直接读取磁盘或持有凭证。" aside={<button className="primary-button" onClick={refreshNow} disabled={running}>{running ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {running ? "同步中…" : "手动同步"}</button>} />
      <div className="connector-grid">{connectors.map((connector) => { const Icon = connector.icon; return <article className="panel connector-card" key={connector.name}><div className="connector-card__icon"><Icon size={21} /></div><div><h2>{connector.name}</h2><p>{connector.detail}</p></div><StatusBadge tone={connector.tone}>{connector.status}</StatusBadge><small>{connector.meta}</small></article>; })}</div>
      {snapshot && (
        <section className="panel sync-sources">
          <div className="panel__header">
            <div><span className="eyebrow">SOURCE HEALTH</span><h2>数据源明细</h2></div>
            <span className="sync-sources__hint">共 {SOURCE_KEY_ORDER.length} 个只读数据源</span>
          </div>
          <div className="sync-sources-grid">
            {SOURCE_KEY_ORDER.map((key) => {
              const state = snapshot.sources[key];
              const badge = sourceState(state);
              return (
                <div className="sync-source-row" key={key}>
                  <strong>{SOURCE_LABELS[key]}</strong>
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                  <span>{state ? `${state.count.toLocaleString("zh-CN")} 条` : "—"}</span>
                  <time>{formatDateTime(state?.fetchedAt ?? state?.lastSuccessAt ?? null)}</time>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <div className="sync-layout">
        <section className="panel sync-run">
          <div className="panel__header"><div><span className="eyebrow">LATEST RUN</span><h2>最近盘点记录</h2></div><StatusBadge><CheckCircle2 size={12} /> 完成</StatusBadge></div>
          <div className="run-timeline"><i /><div><span>{formatDate(index.generatedAt)}</span><strong>本地元数据盘点完成</strong><p>扫描允许格式，保留相对路径、时间、大小和文件指纹。</p></div></div>
          <div className="run-stats"><div><span>新增</span><strong>+{summary.added}</strong></div><div><span>更新</span><strong>{summary.updated}</strong></div><div><span>跳过</span><strong>{summary.skipped}</strong></div><div><span>删除</span><strong>{summary.deleted}</strong></div><div><span>失败</span><strong className={summary.failed ? "text-amber" : ""}>{summary.failed}</strong></div></div>
          <div className="privacy-strip"><ShieldCheck size={18} /><div><strong>隐私边界已启用</strong><span>前端仅含相对路径与展示元数据；文件指纹只保存在本机私有缓存。</span></div></div>
        </section>
        <aside className="panel schedule-card"><span className="eyebrow">SYNC MODE</span><Clock3 size={25} /><h2>按需手动同步</h2><strong>{schedule.clock}</strong><p>{schedule.note}</p><StatusBadge tone={schedule.tone}>{schedule.label}</StatusBadge></aside>
      </div>
    </div>
  );
}
