import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, LoaderCircle, Search, Sparkles, X } from "lucide-react";
import { loadTriage, type TriageMap } from "../../lib/action-feed";
import { crmErrorMessage, fetchInsight, startInsight } from "../../lib/crm-client";
import {
  STAGES,
  customerLifecycle,
  filterFollowupByStage,
  pplFollowupBoard,
  projectStage,
  projectsByCustomer,
} from "../../lib/crm-model";
import type { CustomerLifecycle, MaasOverrides, MaasStatus, PplFollowupCustomer } from "../../lib/crm-model";
import type { CustomerItem, InsightRecord, MaasCandidatesFile, ProjectItem } from "../../lib/crm-types";
import {
  LIFECYCLE_PHASES,
  TOUCH_SOURCE_LABEL,
  customerTimeline,
  filterFollowupByPhase,
  phaseNavCounts,
} from "../../lib/lifecycle-model";
import type { PhaseKey, TouchSource } from "../../lib/lifecycle-model";
import {
  MAAS_SCREEN_VALUE,
  PplClientError,
  fetchMaasCandidates,
  fetchMaasOverridesState,
  fetchPplInspection,
  maasReviewChoice,
  maasReviewSelection,
  pplErrorMessage,
  saveMaasOverride,
} from "../../lib/ppl-client";
import type { MaasOverrideStatus, PplInspectionBundle } from "../../lib/ppl-client";
import { StatusBadge, ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CrmGate, RefreshControl, SourceBanner, formatDateTime, formatGaap } from "./crm-shared";
import "../../lifecycle.css";

/**
 * 人工覆盖表加载：优先本机 .local-cache/maas-overrides.json（可写可审计），
 * 本机服务不可用时回退 public/data/maas-overrides.json（保持 {}，无真实数据）。
 * 本机覆盖表损坏时如实标记 corrupt（不静默回落），视图据此提示修复并暂停保存。
 */
async function loadMaasOverrides(): Promise<{ overrides: MaasOverrides; corrupt: boolean }> {
  try {
    const state = await fetchMaasOverridesState();
    return { overrides: state.overrides, corrupt: state.source === "corrupt" };
  } catch {
    return { overrides: await loadStaticOverrides(), corrupt: false };
  }
}

/** 本机服务不可用时的静态表回退（public 保持 {}）。 */
async function loadStaticOverrides(): Promise<MaasOverrides> {
  try {
    const response = await fetch("/data/maas-overrides.json");
    if (!response.ok) return {};
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const overrides: Record<string, "maas" | "non_maas"> = {};
    for (const [cid, value] of Object.entries(payload as Record<string, unknown>)) {
      if (value === "maas" || value === "non_maas") overrides[cid] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

const LANE_META: readonly { id: MaasStatus; label: string; hint: string }[] = [
  { id: "maas", label: "MaaS", hint: "关键词初筛命中（标「疑似」）或人工覆盖确认" },
  { id: "non_maas", label: "非 MaaS", hint: "仅人工覆盖确认；不因关键词未命中而自动归入" },
  { id: "unconfirmed", label: "未分类", hint: "无法判定，不硬二分；待鲲鹏字段补拉或人工覆盖" },
];

const MAAS_BADGE_LABEL: Record<MaasStatus, string> = {
  maas: "MaaS",
  non_maas: "非 MaaS",
  unconfirmed: "未分类",
};

// ---------------------------------------------------------------------------
// 触达时间轴（lifecycle-model）：来源徽章色调 + 日粒度格式化
// ---------------------------------------------------------------------------

const TOUCH_TONE: Record<TouchSource, "green" | "amber" | "blue" | "muted"> = {
  followup: "green",
  relate: "blue",
  project: "muted",
  contract: "amber",
  gaap: "amber",
  inspection: "blue",
  approval: "green",
  triage: "muted",
};

function formatTimelineDay(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

type InspectionFetchState = "loading" | "ready" | "unavailable";

/** 时间轴本机来源：PPL 巡检产物（打开抽屉时拉一次）+ 行动队列 triage（localStorage）。 */
function useTimelineSources(cid: string) {
  const [inspection, setInspection] = useState<PplInspectionBundle | null>(null);
  const [inspectionState, setInspectionState] = useState<InspectionFetchState>("loading");
  const [triage] = useState<TriageMap>(() => loadTriage());
  // 计划/实际标记的基准时刻：抽屉打开时固定，避免渲染期间跳动。
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setInspection(null);
    setInspectionState("loading");
    fetchPplInspection()
      .then((bundle) => {
        if (cancelled) return;
        setInspection(bundle);
        setInspectionState("ready");
      })
      .catch(() => {
        if (!cancelled) setInspectionState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);

  return { inspection, inspectionState, triage, now };
}

function TouchTimelineSection({
  customer,
  projects,
  inspection,
  inspectionState,
  triage,
  now,
}: {
  customer: CustomerItem;
  projects: readonly ProjectItem[];
  inspection: PplInspectionBundle | null;
  inspectionState: InspectionFetchState;
  triage: TriageMap;
  now: number;
}) {
  const timeline = customerTimeline({ customer, projects, inspection, triage, now });
  return (
    <section className="crm-drawer__section">
      <h3>触达时间轴 <small>{timeline.events.length} 条 · 跳过 {timeline.skipped} 条无法定位</small></h3>
      <p className="crm-table-note">
        合并本机八源：跟进 / 关联 / 项目创建 / 预计签约 / GAAP 起算 / 巡检推荐 / 授权决策 / 行动队列处理记录；
        缺失或无法解析的时间不计入、不臆造（计入「跳过」）。
      </p>
      {inspectionState === "unavailable" && (
        <p className="crm-muted">本机巡检产物暂不可用，时间轴暂不含巡检 / 授权事件。</p>
      )}
      {timeline.events.length === 0
        ? <p className="crm-muted">尚无可定位的触达事件。</p>
        : (
          <ul className="lifecycle-timeline">
            {timeline.events.map((event) => (
              <li key={event.key} className="lifecycle-timeline__item">
                <time dateTime={new Date(event.at).toISOString()}>
                  {event.dayOnly ? formatTimelineDay(event.at) : formatDateTime(event.at)}
                </time>
                <StatusBadge tone={TOUCH_TONE[event.source]}>{TOUCH_SOURCE_LABEL[event.source]}</StatusBadge>
                <div className="lifecycle-timeline__body">
                  <strong>{event.title}</strong>
                  {event.detail && <span>{event.detail}</span>}
                </div>
                <span className={`lifecycle-timeline__mark${event.planned ? " is-planned" : ""}`}>
                  {event.planned ? "计划" : "实际"}
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 客户详情抽屉（PPL 视图本地等价物）：与 CustomerDrawer 同结构（客户事实 / 在途
// 项目 / ECID 待接入说明 / FBI 解读），本批次新增「触达时间轴」段。
// 受文件边界约束不改动 CustomerDrawer.tsx（客户视图继续用它），FBI 轮询逻辑为
// 同语义受约束复刻；后续可将两者抽成共享 hook。
// ---------------------------------------------------------------------------

const INSIGHT_POLL_MS = 10_000;
const REUSE_MS = 24 * 3_600_000;

function useInsightRecord(cid: string) {
  const [record, setRecord] = useState<InsightRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(cid);

  useEffect(() => {
    active.current = cid;
    setRecord(null);
    setError("");
    fetchInsight(cid)
      .then((value) => { if (active.current === cid) setRecord(value); })
      .catch((caught: unknown) => { if (active.current === cid) setError(crmErrorMessage(caught)); });
  }, [cid]);

  const running = record?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchInsight(cid)
        .then((value) => { if (active.current === cid) setRecord(value); })
        .catch((caught: unknown) => { if (active.current === cid) setError(crmErrorMessage(caught)); });
    }, INSIGHT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [cid, running]);

  const start = useCallback(() => {
    setSubmitting(true);
    setError("");
    startInsight(cid)
      .then((value) => { if (active.current === cid) setRecord(value); })
      .catch((caught: unknown) => { if (active.current === cid) setError(crmErrorMessage(caught)); })
      .finally(() => setSubmitting(false));
  }, [cid]);

  return { record, error, submitting, start };
}

function InsightSection({ cid }: { cid: string }) {
  const { record, error, submitting, start } = useInsightRecord(cid);
  const running = record?.state === "running";
  const fresh = record?.state === "done" && Date.now() - new Date(record.createdAt).getTime() < REUSE_MS;
  const canStart = !submitting && !running && !fresh;
  return (
    <section className="crm-insight">
      <header>
        <div><span className="eyebrow">FBI</span><h3>消耗异动解读</h3></div>
        <button className="primary-button" onClick={start} disabled={!canStart}>
          {submitting || running ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
          {running ? "FBI 分析中" : fresh ? "今日已生成" : record?.state === "done" ? "重新解读" : "生成解读"}
        </button>
      </header>
      <p className="crm-insight__note">由本机 FBI 助手生成，同一客户 24 小时内只分析一次；分析通常需要几分钟，可关闭抽屉稍后再看。</p>
      {error && <p className="crm-insight__error">{error}</p>}
      {record && (
        <div className="crm-insight__body">
          <small>
            {record.state === "running" && `已提交 ${formatDateTime(record.createdAt)}，完成后自动显示`}
            {record.state === "done" && `生成于 ${formatDateTime(record.finishedAt ?? record.createdAt)}`}
            {record.state === "failed" && "上次解读未完成，可以重新提交"}
          </small>
          {record.state === "done" && <div className="crm-insight__answer">{record.answer ?? "FBI 未返回文字结论。"}</div>}
        </div>
      )}
    </section>
  );
}

function PplCustomerDrawer({
  row,
  projects,
  onClose,
}: {
  row: CustomerLifecycle;
  projects: readonly ProjectItem[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { customer } = row;
  const stage = STAGES.find((item) => item.id === row.stage);
  const { inspection, inspectionState, triage, now } = useTimelineSources(customer.cid);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rate = customer.yesterdayGaapRate;
  const facts: [string, string][] = [
    ["行业", customer.industry ?? "—"],
    ["区域", customer.area ?? "—"],
    ["等级", customer.level ?? "—"],
    ["上月 GAAP", formatGaap(customer.lastMonthGaap)],
    ["昨日 GAAP", `${formatGaap(customer.yesterdayGaap)}${rate === null ? "" : `（${rate > 0 ? "+" : ""}${rate.toFixed(1)}%）`}`],
    ["最近拜访记录", formatDateTime(customer.lastNoteAt)],
  ];

  return createPortal(
    <>
      <button className="crm-drawer__scrim" onClick={onClose} aria-label="关闭客户详情" tabIndex={-1} />
      <aside className="crm-drawer" role="dialog" aria-modal="true" aria-labelledby="crm-drawer-title">
        <header className="crm-drawer__header">
          <div>
            <span className="eyebrow">CID {customer.cid}</span>
            <h2 id="crm-drawer-title">{customer.name}</h2>
            {stage && <StatusBadge>{stage.id} · {stage.label}</StatusBadge>}
          </div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <dl className="crm-facts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>

        <section className="crm-drawer__section">
          <h3>在途项目 <small>{row.activeProjects.length}</small></h3>
          {row.activeProjects.length === 0
            ? <p className="crm-muted">鲲鹏中没有在途项目。</p>
            : (
              <ul className="crm-projects">
                {row.activeProjects.map((project) => (
                  <li key={project.id} className={project.id === row.leadProject?.id ? "is-lead" : undefined}>
                    <strong>{project.name}</strong>
                    <span>
                      {projectStage(project)} · {project.stageName ?? "阶段未知"}
                      {project.winRate !== null && ` · 赢率 ${project.winRate}%`}
                      {project.price !== null && ` · ${formatGaap(project.price)}`}
                    </span>
                    {project.expectedContractDate && <small>预计签约 {formatDateTime(project.expectedContractDate)}</small>}
                  </li>
                ))}
              </ul>
            )}
        </section>

        <TouchTimelineSection
          customer={customer}
          projects={projects}
          inspection={inspection}
          inspectionState={inspectionState}
          triage={triage}
          now={now}
        />

        <section className="crm-drawer__section">
          <h3>ECID 画像 <small>鲲鹏企业画像</small></h3>
          <p className="crm-muted">
            本轮不展示画像数值：鲲鹏 CLI 的 customers 行没有 ecid 字段（CID ≠ ECID），
            直接查询会返回「提交的 ecid 不存在」，value 等画像接口对无效 ID 不报错、只返回全空。
            CID → ECID 的取数口径确认后再接入，这里不会用占位数字代替。
          </p>
          <button className="primary-button" disabled title="CID → ECID 口径待定，暂无法取数">
            ECID 画像待接入（CID → ECID 口径待定）
          </button>
        </section>

        <InsightSection cid={customer.cid} />
      </aside>
    </>,
    document.body,
  );
}

function PplCard({ project }: { project: ProjectItem }) {
  return (
    <div className="crm-ppl-card">
      <strong>{project.name}</strong>
      <small>
        {project.stageName ?? "阶段未知"}
        {project.winRate !== null && ` · 赢率 ${project.winRate}%`}
      </small>
      <small>
        预估收入 {formatGaap(project.price)}
        {project.expectedContractDate && ` · 预计合同 ${formatDateTime(project.expectedContractDate)}`}
        {project.expectedGaapStartDate && ` · GAAP 起算 ${formatDateTime(project.expectedGaapStartDate)}`}
      </small>
      {project.createdAt && <small>项目创建 {formatDateTime(project.createdAt)}</small>}
    </div>
  );
}

function FollowupCustomerCard({ row, onOpen }: { row: PplFollowupCustomer; onOpen: () => void }) {
  const { customer, maas, projects } = row;
  return (
    <li className="crm-followup-customer">
      <div className="crm-followup-customer__head">
        <button className="text-button" onClick={onOpen} title="打开客户详情">{customer.name}</button>
        <span className={`crm-maas-badge crm-maas-badge--${maas.status}`}>
          {maas.basis === "keyword" ? "疑似 MaaS" : MAAS_BADGE_LABEL[maas.status]}
        </span>
      </div>
      <div className="crm-followup-customer__meta">
        <span>{customer.level ?? "—"}</span>
        <span>上月 GAAP <b>{formatGaap(customer.lastMonthGaap)}</b></span>
        <span>PPL <b>{projects.length}</b></span>
      </div>
      <small className="crm-ppl-card__flags">
        最近跟进 {formatDateTime(customer.lastNoteAt)}
        <em title="快照暂无逐项目跟进文本字段；跟进明细需补拉鲲鹏字段后接入">需补拉项目跟进字段</em>
      </small>
      {projects.length === 0
        ? <small className="crm-ppl-card__flags">无在途 PPL（空态，不计入漏斗）</small>
        : projects.map((project) => <PplCard key={project.id} project={project} />)}
    </li>
  );
}

export function PplFollowupView() {
  const { snapshot } = useCrm();
  const [openCid, setOpenCid] = useState("");
  const [keyword, setKeyword] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [phase, setPhase] = useState<PhaseKey | null>(null);
  const [activeLane, setActiveLane] = useState<MaasStatus>("maas");
  const [overrides, setOverrides] = useState<MaasOverrides>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [candidates, setCandidates] = useState<MaasCandidatesFile | null>(null);
  const [candidatesState, setCandidatesState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [savingCid, setSavingCid] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [overridesCorrupt, setOverridesCorrupt] = useState(false);
  const closeDrawer = useCallback(() => setOpenCid(""), []);
  // 取消标记：卸载后不再落 state（StrictMode 的挂载→卸载→挂载会重新置 true）。
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    void loadMaasOverrides().then((loaded) => {
      if (cancelled) return;
      setOverrides(loaded.overrides);
      setOverridesCorrupt(loaded.corrupt);
    });
    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, []);

  const board = useMemo(
    () => (snapshot ? pplFollowupBoard(snapshot, overrides) : null),
    [snapshot, overrides],
  );
  const navCounts = useMemo(() => (board ? phaseNavCounts(board) : null), [board]);
  const stageNames = useMemo(() => {
    if (!snapshot) return [];
    return [...new Set(snapshot.projects.map((project) => project.stageName ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [snapshot]);

  const needle = keyword.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!board) return null;
    // 阶段（A→D / 未归类）→ 阶段名（精确）→ 客户名搜索，三层过滤依次收窄。
    const byPhase = filterFollowupByPhase(board, phase);
    const byStage = filterFollowupByStage(byPhase, stageFilter === "" ? null : stageFilter);
    if (!needle) return byStage;
    const match = (row: PplFollowupCustomer) => row.customer.name.toLowerCase().includes(needle);
    return {
      ...byStage,
      lanes: {
        maas: byStage.lanes.maas.filter(match),
        non_maas: byStage.lanes.non_maas.filter(match),
        unconfirmed: byStage.lanes.unconfirmed.filter(match),
      },
    };
  }, [board, needle, phase, stageFilter]);

  const groupedProjects = useMemo(
    () => (snapshot ? projectsByCustomer(snapshot.customers, snapshot.projects) : new Map<string, ProjectItem[]>()),
    [snapshot],
  );
  const lifecycleRows = useMemo(() => {
    if (!snapshot) return new Map<string, CustomerLifecycle>();
    return new Map(snapshot.customers.map((customer) => [
      customer.cid,
      customerLifecycle(customer, groupedProjects.get(customer.cid) ?? []),
    ] as const));
  }, [snapshot, groupedProjects]);

  const openRow = openCid ? lifecycleRows.get(openCid) ?? null : null;
  const openProjects = openRow ? groupedProjects.get(openRow.customer.cid) ?? [] : [];
  const customersReady = snapshot?.sources.customers?.status === "ok";
  const visibleProjects = filtered
    ? Object.values(filtered.lanes).reduce((sum, lane) => sum + lane.reduce((count, row) => count + row.projects.length, 0), 0)
    : 0;

  // 候选复核：列出全部快照客户（含无在途 PPL 的客户，不受泳道/搜索筛选影响），逐客户人工分类。
  const reviewRows = useMemo(() => {
    if (!board) return [];
    return [...board.lanes.maas, ...board.lanes.non_maas, ...board.lanes.unconfirmed];
  }, [board]);
  const candidateByCid = useMemo(
    () => new Map((candidates?.candidates ?? []).map((candidate) => [candidate.cid, candidate])),
    [candidates],
  );
  const overrideCount = reviewRows.filter((row) => row.maas.basis === "override").length;

  // 请求在事件处理里发起（不放进 setState 更新函数，StrictMode 不会双发）。
  const toggleReview = useCallback(() => {
    const next = !reviewOpen;
    setReviewOpen(next);
    if (!next || candidatesState !== "idle") return;
    setCandidatesState("loading");
    fetchMaasCandidates()
      .then((file) => {
        if (!aliveRef.current) return;
        setCandidates(file);
        setCandidatesState("ready");
      })
      .catch(() => {
        if (aliveRef.current) setCandidatesState("unavailable");
      });
  }, [reviewOpen, candidatesState]);

  const saveOverride = useCallback(async (cid: string, status: MaasOverrideStatus) => {
    setSavingCid(cid);
    setReviewError("");
    try {
      // 用服务端返回的最新覆盖表驱动看板重排：保存后立即生效，刷新页面亦然。
      const saved = await saveMaasOverride(cid, status);
      if (aliveRef.current) setOverrides(saved);
    } catch (caught) {
      if (!aliveRef.current) return;
      if (caught instanceof PplClientError && caught.code === "overrides_corrupt") setOverridesCorrupt(true);
      setReviewError(caught instanceof PplClientError ? pplErrorMessage(caught) : "保存未完成，请稍后重试。");
    } finally {
      if (aliveRef.current) setSavingCid("");
    }
  }, []);

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / PPL FOLLOWUP"
        title="PPL 跟进"
        description="按 MaaS / 非 MaaS / 未分类三泳道逐客户跟进在途 PPL；MaaS 判定为关键词初筛（标「疑似」）+ 人工覆盖，无法判定不硬二分。"
        aside={<RefreshControl />}
      />
      <CrmGate>
        {snapshot && filtered && (
          <>
            <SourceBanner keys={["customers", "projects"]} />
            {navCounts && board && (
              <nav className="panel lifecycle-nav" aria-label="PPL 生命周期阶段导航">
                <div className="lifecycle-nav__tabs">
                  <button
                    type="button"
                    className="lifecycle-nav__tab"
                    data-active={phase === null}
                    onClick={() => setPhase(null)}
                  >
                    <b><i>ALL</i>全部</b>
                    <span>{navCounts.totalProjects} 项目 · {board.counts.customers} 客户</span>
                  </button>
                  {LIFECYCLE_PHASES.map((meta) => (
                    <button
                      key={meta.id}
                      type="button"
                      className="lifecycle-nav__tab"
                      data-active={phase === meta.id}
                      onClick={() => setPhase((current) => (current === meta.id ? null : meta.id))}
                      title={meta.hint}
                      aria-pressed={phase === meta.id}
                    >
                      <b><i>{meta.id === "unclassified" ? "?" : meta.id}</i>{meta.name}</b>
                      <span>{navCounts.phases[meta.id].projects} 项目 · {navCounts.phases[meta.id].customers} 客户</span>
                    </button>
                  ))}
                </div>
                <p className="lifecycle-nav__note">
                  A→D 按鲲鹏阶段名精确映射（未知阶段不按 code / 赢率猜）；未匹配项目 {navCounts.unmatchedProjects}
                  {" · "}无 PPL 客户 {navCounts.customersWithoutPpl}（不落阶段）
                  {phase !== null && " · 已按生命周期阶段过滤，点「全部」或再次点击当前阶段恢复"}
                </p>
              </nav>
            )}
            <section className="panel crm-toolbar">
              <span className="crm-toolbar__summary">
                {customersReady
                  ? `${filtered.counts.customers} 个客户 · ${visibleProjects} 个 PPL`
                    + (filtered.unmatched.length > 0 ? ` · ${filtered.unmatched.length} 个未匹配项目` : "")
                  : "鲲鹏客户数据暂不可用"}
              </span>
              <label>
                <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)} aria-label="按阶段筛选">
                  <option value="">全部阶段</option>
                  {stageNames.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
                </select>
              </label>
              <label className="crm-search">
                <Search size={14} />
                <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索客户" aria-label="搜索客户" />
              </label>
            </section>

            <section className="panel crm-maas-review" aria-label="MaaS 候选复核">
              <header className="panel__header">
                <div>
                  <span className="eyebrow">MAAS REVIEW</span>
                  <h2>
                    <button className="text-button" onClick={toggleReview} aria-expanded={reviewOpen}>
                      {reviewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      MaaS 候选复核
                    </button>
                  </h2>
                </div>
                <span>
                  {customersReady && board
                    ? `人工覆盖 ${overrideCount}/${reviewRows.length} · 未分类 ${board.counts.unconfirmed}`
                    : "鲲鹏客户数据暂不可用"}
                </span>
              </header>
              {overridesCorrupt && (
                <p className="crm-maas-review__error" role="alert">
                  本机覆盖表损坏，请先修复 .local-cache/maas-overrides.json；修复前人工分类不显示、保存已暂停（不会覆盖原文件）。
                </p>
              )}
              {reviewOpen && (
                <>
                  <p className="crm-table-note">
                    列出全部快照客户（含无在途 PPL 的客户，不受泳道与搜索筛选影响）。候选由关键词初筛生成、只标「疑似」；
                    逐客户选择 MaaS / 非 MaaS / 未分类并保存，写入本机覆盖表（.local-cache，0600），保存后看板即时生效。
                    选「未分类」= 清除覆盖、回到关键词初筛口径。
                  </p>
                  {candidatesState === "loading" && <p className="crm-muted">正在生成候选…</p>}
                  {candidatesState === "unavailable" && (
                    <p className="crm-muted">候选生成不可用（本机服务未响应或鲲鹏快照缺失）；仍可在此手动逐客户分类。</p>
                  )}
                  {candidatesState === "ready" && candidates && candidates.candidates.length === 0 && (
                    <p className="crm-muted">无关键词命中候选（{candidates.totalCustomers} 个客户全部未命中初筛词表），仍可手动分类。</p>
                  )}
                  {reviewError && <p className="crm-maas-review__error">{reviewError}</p>}
                  <ul className="crm-maas-review__list">
                    {reviewRows.map((row) => {
                      const candidate = candidateByCid.get(row.customer.cid);
                      const selection = maasReviewSelection(row.maas);
                      return (
                        <li key={row.customer.cid} className="crm-maas-review__row">
                          <div className="crm-maas-review__who">
                            <button className="text-button" onClick={() => setOpenCid(row.customer.cid)} title="打开客户详情">
                              {row.customer.name}
                            </button>
                            <small>
                              PPL {row.projects.length}
                              {candidate
                                ? ` · 疑似命中：${candidate.evidence
                                  .map((entry) => `${entry.source === "customer" ? "客户名" : "项目"}「${entry.name}」${entry.keywords.join("/")}`)
                                  .join("；")}`
                                : " · 无关键词命中"}
                            </small>
                          </div>
                          <span className={`crm-maas-badge crm-maas-badge--${row.maas.status}`}>
                            {row.maas.basis === "keyword" ? "疑似 MaaS" : MAAS_BADGE_LABEL[row.maas.status]}
                          </span>
                          <label>
                            <select
                              value={selection.value}
                              disabled={overridesCorrupt || savingCid === row.customer.cid}
                              onChange={(event) => {
                                // 非人工覆盖行以「初筛：…」占位为当前值，选 MaaS 才是真实变更并保存。
                                const choice = maasReviewChoice(event.target.value);
                                if (choice) void saveOverride(row.customer.cid, choice);
                              }}
                              aria-label={`分类 ${row.customer.name}`}
                            >
                              {selection.placeholder && (
                                <option value={MAAS_SCREEN_VALUE} disabled>{selection.placeholder}</option>
                              )}
                              <option value="maas">MaaS</option>
                              <option value="non_maas">非 MaaS</option>
                              <option value="unconfirmed">未分类</option>
                            </select>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>

            <div className="crm-lane-tabs" role="tablist" aria-label="泳道切换（移动端）">
              {LANE_META.map((lane) => (
                <button
                  key={lane.id}
                  className={`text-button ${activeLane === lane.id ? "is-active" : ""}`}
                  onClick={() => setActiveLane(lane.id)}
                  aria-pressed={activeLane === lane.id}
                >
                  {lane.label} {filtered.lanes[lane.id].length}
                </button>
              ))}
            </div>

            <div className="crm-followup-board">
              {LANE_META.map((lane) => {
                const rows = filtered.lanes[lane.id];
                return (
                  <section
                    key={lane.id}
                    className="panel crm-followup-lane"
                    aria-label={lane.label}
                    data-hidden={activeLane !== lane.id ? "true" : "false"}
                  >
                    <header>
                      <h2>{lane.label}</h2>
                      <b>{rows.length}</b>
                      <p>{lane.hint}</p>
                    </header>
                    {rows.length === 0
                      ? <p className="crm-muted">{customersReady ? "暂无客户" : "等待鲲鹏数据"}</p>
                      : (
                        <ul>
                          {rows.map((row) => (
                            <FollowupCustomerCard key={row.customer.cid} row={row} onOpen={() => setOpenCid(row.customer.cid)} />
                          ))}
                        </ul>
                      )}
                  </section>
                );
              })}
            </div>

            <section className="panel crm-followup-unmatched" aria-label="未匹配客户的项目">
              <header className="panel__header">
                <div><span className="eyebrow">UNMATCHED</span><h2>未匹配客户的项目</h2></div>
                <span>{filtered.unmatched.length} 个 · cid/客户名均对不上快照客户，显式列出不丢弃</span>
              </header>
              {filtered.unmatched.length === 0
                ? <p className="crm-muted">全部项目均已归属客户。</p>
                : (
                  <ul>
                    {filtered.unmatched.map((project) => (
                      <li key={project.id}>
                        {project.name} · 归属 {project.customerName ?? "—"}{project.cid ? ` (CID ${project.cid})` : "（无 CID）"} · {project.stageName ?? "阶段未知"}
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            {openRow && (
              <PplCustomerDrawer
                key={openRow.customer.cid}
                row={openRow}
                projects={openProjects}
                onClose={closeDrawer}
              />
            )}
          </>
        )}
      </CrmGate>
    </div>
  );
}
