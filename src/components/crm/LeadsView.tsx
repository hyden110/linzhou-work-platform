import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertCircle,
  CircleCheck,
  CircleHelp,
  ExternalLink,
  LoaderCircle,
  MapPin,
  Radar,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  fetchLeadsSnapshot,
  leadsAgeHours,
  leadsErrorMessage,
  refreshLeads,
  type LeadRow,
  type LeadTier,
  type LeadsSnapshot,
} from "../../lib/leads-client";
import {
  LEAD_TIER_META,
  LEAD_TIER_ORDER,
  actionPlan,
  coopOpportunities,
  filterLeads,
  leadDistribution,
  leadDrawerSections,
  leadKpis,
  tierDistribution,
  type DistDimension,
  type LeadQuery,
  type LeadSort,
  type LeadTierFilter,
} from "../../lib/leads-model";
import { ViewHeading } from "../shared";

/**
 * 「拓新雷达」视图（F5 + 模型增强）：钉钉 AI 表格「拓新企业清单」只读拉取。
 * 线索由外部 lead-radar 写表，工作台只读、绝不回写；联系人字段白名单外物理不入快照。
 * 派生口径全部来自 src/lib/leads-model.ts（纯函数）：KPI / 判定分布 / 行动清单 /
 * 协同机会 / 赛道区域分布 / 筛选排序 / 详情抽屉；缺失值一律「—」，绝不编造。
 * 12h TTL 低成本口径：打开时读一次本机快照，此后仅手动「刷新」，不自动轮询。
 */

const ACTION_GROUP_LIMIT = 5;
const COOP_LIMIT = 6;
const ALL = "全部";

const DEFAULT_QUERY: LeadQuery = { tier: "all", track: "", province: "", crmState: "", q: "", sort: "snapshot" };

const TIER_FILTER_OPTIONS: ReadonlyArray<{ readonly value: LeadTierFilter; readonly label: string }> = [
  { value: "all", label: "全部档位" },
  { value: "open", label: "可 Name" },
  { value: "confirm", label: "待确认" },
  ...LEAD_TIER_ORDER.map((tier) => ({ value: tier as LeadTierFilter, label: LEAD_TIER_META[tier].label })),
];

const SORT_OPTIONS: ReadonlyArray<{ readonly value: LeadSort; readonly label: string }> = [
  { value: "snapshot", label: "按快照顺序" },
  { value: "score", label: "按综合分" },
  { value: "signal", label: "按最新信号" },
];

const TIER_BADGE_CLASS: Readonly<Record<LeadTier, string>> = {
  ME: "status-badge status-badge--amber",
  A: "status-badge",
  B: "status-badge",
  B2: "status-badge",
  "A?": "status-badge status-badge--amber",
  C: "status-badge status-badge--blue",
  pending: "status-badge status-badge--muted",
  D: "status-badge status-badge--muted",
};

/** 视图边界适配：桥快照行 → 模型 LeadRow。只保留 id/name 齐全的行（桥侧已投影，此处双保险），返回新数组。 */
function toLeadRows(rows: readonly LeadRow[]): LeadRow[] {
  return rows.filter((row) => row.id !== "" && row.name !== "");
}

function clock(iso: string): string {
  return iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : iso;
}

/** 入口链接护栏：只放行 http(s)，其余返回空串（渲染层不生成可点链接）。 */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

function percentOfMax(value: number, max: number): number {
  return Math.round((value * 100) / max);
}

/* ---------------- KPI ---------------- */

function LeadKpi({
  icon: Icon,
  label,
  value,
  note,
  primary,
}: {
  icon: typeof Radar;
  label: string;
  value: string;
  note: string;
  primary?: boolean;
}) {
  return (
    <article className={`metric-card ${primary ? "metric-card--primary" : ""}`}>
      <Icon className="metric-card__icon" size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function LeadsKpis({ rows, priorityProvinces }: { rows: readonly LeadRow[]; priorityProvinces: readonly string[] }) {
  const kpis = useMemo(() => leadKpis(rows, Date.now()), [rows]);
  const regionNote = priorityProvinces.length
    ? `${priorityProvinces.join(" / ")} · 其中可做 ${kpis.priorityActionable}`
    : `快照未配置优先省 · 其中可做 ${kpis.priorityActionable}`;
  return (
    <section className="metric-grid crm-metrics crm-metrics--five" aria-label="线索关键指标">
      <LeadKpi icon={Radar} label="线索总数" value={String(kpis.total)} note={`近 7 天新信号 ${kpis.recent7} 条`} primary />
      <LeadKpi icon={CircleCheck} label="可 Name" value={String(kpis.open)} note={`A 直接 ${kpis.openDirect} · B/B2 申请 ${kpis.openApply}`} />
      <LeadKpi icon={CircleHelp} label="待确认" value={String(kpis.confirm)} note={`A? 人工核实 ${kpis.confirmManual} · 待雷达扫描 ${kpis.confirmPending}`} />
      <LeadKpi icon={MapPin} label="优先区域线索" value={String(kpis.priority)} note={regionNote} />
      <LeadKpi icon={Activity} label="近 7 天新信号" value={String(kpis.recent7)} note="空/坏时间不计入" />
    </section>
  );
}

/* ---------------- 判定分布 / 赛道区域分布 ---------------- */

function TierDistribution({ rows }: { rows: readonly LeadRow[] }) {
  const slices = useMemo(() => tierDistribution(rows), [rows]);
  return (
    <section className="leads-block" aria-label="Name 判定分布">
      <h3>Name 判定分布 <small>全量档位 · 整数占比</small></h3>
      <p className="leads-block__note">ME/A/B/B2 可 Name；A?/待扫需人工确认；C 伙伴关联；D 直销已占用。</p>
      <ul className="leads-tier-list">
        {slices.map((slice) => (
          <li
            key={slice.tier}
            className="leads-tier"
            data-tone={slice.tone}
            data-empty={slice.count === 0 ? "yes" : "no"}
            title={`${slice.label} · ${slice.action}`}
          >
            <span className="leads-tier__label"><b>{slice.short}</b>{slice.label}</span>
            <span className="leads-tier__bar"><i style={{ width: `${slice.percent}%` }} /></span>
            <span className="leads-tier__num">{slice.count} 条 · {slice.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LeadsDistribution({
  rows,
  dimension,
  onDimension,
}: {
  rows: readonly LeadRow[];
  dimension: DistDimension;
  onDimension: (next: DistDimension) => void;
}) {
  const buckets = useMemo(() => leadDistribution(rows, dimension), [rows, dimension]);
  const max = buckets.reduce((peak, bucket) => Math.max(peak, bucket.count), 1);
  return (
    <section className="leads-block" aria-label="赛道与区域分布">
      <div className="dimension-tabs" role="tablist" aria-label="分布维度">
        <button
          type="button"
          role="tab"
          aria-selected={dimension === "track"}
          className={dimension === "track" ? "is-active" : undefined}
          onClick={() => onDimension("track")}
        >
          赛道分布
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={dimension === "region"}
          className={dimension === "region" ? "is-active" : undefined}
          onClick={() => onDimension("region")}
        >
          区域分布
        </button>
      </div>
      <p className="leads-block__note">
        {dimension === "track"
          ? "按雷达赛道归一，空赛道计入「其他」；亮色段为可 Name。"
          : "按省份统计，省份缺失计入「未知」（不按城市猜测）；命中优先省标橙。"}
      </p>
      <ul className="leads-dist-list">
        {buckets.map((bucket) => (
          <li key={bucket.key} className="leads-dist">
            <span className="leads-dist__key">
              {bucket.key}
              {dimension === "region" && bucket.priority && <em>优先</em>}
            </span>
            <span className="leads-dist__bar">
              <i style={{ width: `${percentOfMax(bucket.count, max)}%` }} />
              <i className="is-open" style={{ width: `${percentOfMax(bucket.open, max)}%` }} />
            </span>
            <span className="leads-dist__num">{bucket.count} 条{bucket.open > 0 ? ` · 可做 ${bucket.open}` : ""}</span>
          </li>
        ))}
        {buckets.length === 0 && <li className="leads-block__empty">暂无分布数据。</li>}
      </ul>
    </section>
  );
}

/* ---------------- 行动清单 / 协同机会 ---------------- */

function ActionPlan({ rows, onOpen }: { rows: readonly LeadRow[]; onOpen: (id: string) => void }) {
  const groups = useMemo(() => actionPlan(rows, ACTION_GROUP_LIMIT), [rows]);
  return (
    <section className="leads-block" aria-label="行动清单">
      <h3>行动清单 <small>可 Name + A? 待确认 · 优先区域在前</small></h3>
      <p className="leads-block__note">按建议动作分组，每组取前 {ACTION_GROUP_LIMIT} 条（组内按优先区域 → 综合分排序）。</p>
      {groups.length === 0 ? (
        <p className="leads-block__empty">暂无可行动线索（无可 Name 或待人工确认档位）。</p>
      ) : (
        <div className="leads-groups">
          {groups.map((group) => (
            <div key={group.tier} className="leads-group" data-tone={group.tone}>
              <header>
                <b>{group.short}</b>
                <span>{group.action}</span>
                <em>共 {group.total} 条{group.total > group.items.length ? ` · 显示前 ${group.items.length}` : ""}</em>
              </header>
              <ul>
                {group.items.map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => onOpen(row.id)} title="查看线索详情">
                      <strong>{row.name}{row.isPriority ? " · 优先省" : ""}</strong>
                      <span>{row.summary || row.trackRaw || "—"}</span>
                    </button>
                    <b>{row.score != null ? row.score : "—"}</b>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CoopOpportunities({ rows, onOpen }: { rows: readonly LeadRow[]; onOpen: (id: string) => void }) {
  const coop = useMemo(() => coopOpportunities(rows, COOP_LIMIT), [rows]);
  return (
    <section className="leads-block" aria-label="协同机会">
      <h3>协同机会 <small>D 档 · MaaS / Agent 高潜力</small></h3>
      <p className="leads-block__note">直销已关联（D）不能 Name：联系跟进人做方案协同，带动 MaaS 收入与 Agent 席位。</p>
      {coop.total === 0 ? (
        <p className="leads-block__empty">暂无高潜力的直销已占线索。</p>
      ) : (
        <ul className="leads-coop">
          {coop.items.map(({ row, owner }) => (
            <li key={row.id}>
              <button type="button" onClick={() => onOpen(row.id)} title="查看线索详情">
                <strong>{row.name}</strong>
                <span>跟进人 {owner || "暂无"}</span>
              </button>
              <span className="leads-coop__meta">
                {[row.maas && `MaaS ${row.maas}`, row.agent && `Agent ${row.agent}`].filter(Boolean).join(" · ") || "—"}
              </span>
              <b>{row.score != null ? row.score : "—"}</b>
            </li>
          ))}
          {coop.total > coop.items.length && (
            <li className="leads-coop__more">还有 {coop.total - coop.items.length} 条，可在明细中按 D 档筛选。</li>
          )}
        </ul>
      )}
    </section>
  );
}

/* ---------------- 筛选排序控件 ---------------- */

function LeadQueryBar({
  query,
  options,
  priorityProvinces,
  total,
  shown,
  onChange,
}: {
  query: LeadQuery;
  options: { readonly tracks: readonly string[]; readonly provinces: readonly string[]; readonly states: readonly string[] };
  priorityProvinces: readonly string[];
  total: number;
  shown: number;
  onChange: (patch: Partial<LeadQuery>) => void;
}) {
  const dirty = query.tier !== DEFAULT_QUERY.tier
    || query.track !== "" || query.province !== "" || query.crmState !== ""
    || query.q !== "" || query.sort !== DEFAULT_QUERY.sort;
  return (
    <div className="leads-filters" aria-label="线索筛选">
      <label>档位
        <select value={query.tier} onChange={(event) => onChange({ tier: event.target.value as LeadTierFilter })}>
          {TIER_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label>赛道
        <select value={query.track} onChange={(event) => onChange({ track: event.target.value })}>
          <option value="">{ALL}</option>
          {options.tracks.map((track) => <option key={track} value={track}>{track}</option>)}
        </select>
      </label>
      <label>省份
        <select value={query.province} onChange={(event) => onChange({ province: event.target.value })}>
          <option value="">{ALL}</option>
          {options.provinces.map((province) => (
            <option key={province} value={province}>{priorityProvinces.includes(province) ? `${province}（优先省）` : province}</option>
          ))}
        </select>
      </label>
      <label>CRM状态
        <select value={query.crmState} onChange={(event) => onChange({ crmState: event.target.value })}>
          <option value="">{ALL}</option>
          {options.states.map((state) => <option key={state} value={state}>{state}</option>)}
        </select>
      </label>
      <label>排序
        <select value={query.sort} onChange={(event) => onChange({ sort: event.target.value as LeadSort })}>
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="leads-filters__search">关键词
        <input
          value={query.q}
          onChange={(event) => onChange({ q: event.target.value })}
          placeholder="搜索企业 / 赛道 / 城市 / 投资方…"
        />
      </label>
      {dirty && <button type="button" className="text-button" onClick={() => onChange(DEFAULT_QUERY)}>清除筛选</button>}
      <span className="leads-filters__count">{shown} / {total} 条</span>
    </div>
  );
}

/* ---------------- 明细行 + 详情抽屉 ---------------- */

function LeadLine({ row, onOpen }: { row: LeadRow; onOpen: () => void }) {
  return (
    <div className="leads-row" data-tier={row.tier}>
      <button className="leads-row__head" type="button" onClick={onOpen} aria-haspopup="dialog" title="查看线索详情">
        <span className="leads-row__name">
          <strong>{row.name}</strong>
          <span className={TIER_BADGE_CLASS[row.tier]}>{row.tier === "pending" ? "待扫" : row.tier}</span>
          {row.isPriority && <span className="leads-row__prio">优先省</span>}
        </span>
        <span className="leads-row__score">{row.score != null ? `综合分 ${row.score}` : "综合分 —"}</span>
        <span className="leads-row__track">{row.track}</span>
        <span className="leads-row__geo">{[row.province, row.city].filter(Boolean).join(" ") || "—"}</span>
        <span className="leads-row__state">{row.crmState || "—"}</span>
        <span className="leads-row__cid">{row.cid || "—"}</span>
      </button>
      <p className="leads-row__summary">{row.summary || "（一句话为空）"}</p>
      <p className="leads-row__meta">
        {[row.signal, row.round].filter(Boolean).join(" · ") || "信号 —"}
        <span> · 信号 {clock(row.signalAt) || "—"} · 雷达 {clock(row.radarAt) || "—"}</span>
      </p>
    </div>
  );
}

function LeadDrawer({ row, onClose }: { row: LeadRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sections = useMemo(() => leadDrawerSections(row), [row]);
  const newsUrl = row.news ? safeHref(row.news.u) : "";

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headline: ReadonlyArray<readonly [string, string]> = [
    ["综合分", row.score != null ? String(row.score) : "—"],
    ["赛道", row.track || "—"],
    ["区域", [row.province, row.city].filter(Boolean).join(" · ") || "—"],
    ["最新信号", clock(row.signalAt) || "—"],
  ];

  return createPortal(
    <>
      <button className="crm-drawer__scrim" onClick={onClose} aria-label="关闭线索详情" tabIndex={-1} />
      <aside className="crm-drawer" role="dialog" aria-modal="true" aria-labelledby="leads-drawer-title">
        <header className="crm-drawer__header">
          <div>
            <span className="eyebrow">{row.crmState || "CRM 状态 —"} · CID {row.cid || "—"}</span>
            <h2 id="leads-drawer-title">{row.name}</h2>
            <span className={TIER_BADGE_CLASS[row.tier]}>{row.tierLabel || LEAD_TIER_META[row.tier].label}</span>
            {row.isPriority && <span className="status-badge status-badge--amber">优先区域</span>}
          </div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <dl className="crm-facts">
          {headline.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>

        {sections.map((section) => (
          <section className="crm-drawer__section" key={section.title}>
            <h3>{section.title}</h3>
            <dl className="crm-facts">
              {section.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
            </dl>
            {section.notes.length > 0 && (
              <ul className="leads-drawer__notes">
                {section.notes.map((note) => (
                  <li key={note.label}><span>{note.label}</span><p>{note.value}</p></li>
                ))}
              </ul>
            )}
            {section.title === "拓新信号" && newsUrl && (
              <a className="leads-drawer__news" href={newsUrl} target="_blank" rel="noreferrer">
                最新资讯：{row.news?.t || newsUrl}<ExternalLink size={11} />
              </a>
            )}
          </section>
        ))}
      </aside>
    </>,
    document.body,
  );
}

/* ---------------- 面板骨架 ---------------- */

function LeadsMeta({ snapshot }: { snapshot: LeadsSnapshot }) {
  const staleHours = leadsAgeHours(snapshot.fetchedAt, Date.now());
  const tableUrl = safeHref(snapshot.url);
  return (
    <div className="leads-meta">
      快照时间 <time>{snapshot.fetchedAt || "—"}</time>
      {staleHours != null && staleHours > 24 && <em className="leads-stale">（已超过 24 小时，数据可能过期，建议手动刷新）</em>}
      {snapshot.tableName && <span> · 表 {snapshot.tableName}</span>}
      <span> · 共 {snapshot.total} 条</span>
      {tableUrl && (
        <a className="leads-meta__link" href={tableUrl} target="_blank" rel="noreferrer">
          打开 AI 表格<ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

function LeadsBody({
  snapshot,
  rows,
  options,
  listRows,
  query,
  dimension,
  onQuery,
  onDimension,
  onOpen,
}: {
  snapshot: LeadsSnapshot;
  rows: readonly LeadRow[];
  options: { readonly tracks: readonly string[]; readonly provinces: readonly string[]; readonly states: readonly string[] };
  listRows: readonly LeadRow[];
  query: LeadQuery;
  dimension: DistDimension;
  onQuery: (patch: Partial<LeadQuery>) => void;
  onDimension: (next: DistDimension) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <LeadsMeta snapshot={snapshot} />
      <div className="leads-insight-grid">
        <TierDistribution rows={rows} />
        <LeadsDistribution rows={rows} dimension={dimension} onDimension={onDimension} />
      </div>
      <div className="leads-insight-grid">
        <ActionPlan rows={rows} onOpen={onOpen} />
        <CoopOpportunities rows={rows} onOpen={onOpen} />
      </div>
      <LeadQueryBar
        query={query}
        options={options}
        priorityProvinces={snapshot.priorityProvinces}
        total={snapshot.total}
        shown={listRows.length}
        onChange={onQuery}
      />
      <div className="leads-list">
        {listRows.map((row) => <LeadLine key={row.id} row={row} onOpen={() => onOpen(row.id)} />)}
        {listRows.length === 0 && <p className="leads-empty">当前筛选无匹配线索。</p>}
      </div>
      <p className="leads-footnote"><ShieldCheck size={12} /> 快照只含白名单字段（无联系人字段、无凭据形态文本）；拉取过程不回写 AI 表格；详情缺失值如实显示「—」。</p>
    </>
  );
}

function uniqueSorted(rows: readonly LeadRow[], pick: (row: LeadRow) => string): string[] {
  return Array.from(new Set(rows.map(pick).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function LeadsView() {
  const [snapshot, setSnapshot] = useState<LeadsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState<LeadQuery>(DEFAULT_QUERY);
  const [dimension, setDimension] = useState<DistDimension>("track");
  const [openId, setOpenId] = useState("");

  useEffect(() => {
    // 评审 P3-2：client 不接 signal，卸载防护对 setState 无实效——保留纯加载，不设无效 controller。
    fetchLeadsSnapshot()
      .then((data) => {
        setSnapshot(data);
        setError("");
      })
      .catch((loadError: unknown) => {
        setError(leadsErrorMessage(loadError));
      });
  }, []);

  const runRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNotice("");
    setError("");
    try {
      const result = await refreshLeads();
      setSnapshot(result.snapshot);
      setNotice(`已刷新：${result.summary.total} 条线索 / 可 Name ${result.summary.open}。`);
    } catch (refreshError) {
      setNotice(leadsErrorMessage(refreshError));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const rows = useMemo(() => toLeadRows(snapshot?.rows ?? []), [snapshot]);
  const options = useMemo(() => ({
    tracks: uniqueSorted(rows, (row) => row.track),
    provinces: uniqueSorted(rows, (row) => row.province),
    states: uniqueSorted(rows, (row) => row.crmState),
  }), [rows]);
  const listRows = useMemo(() => filterLeads(rows, query), [rows, query]);
  const openRow = useMemo(() => rows.find((row) => row.id === openId) ?? null, [rows, openId]);
  const patchQuery = useCallback((patch: Partial<LeadQuery>) => setQuery((current) => ({ ...current, ...patch })), []);

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / LEADS RADAR"
        title="拓新雷达"
        description="钉钉 AI 表格「拓新企业清单」的只读镜像：线索由外部 lead-radar 写表（信源 → LLM 抽取 → Name 判定），工作台只读拉取、绝不回写；电话/邮箱/法定代表人等联系人字段白名单外，物理不入快照。"
        aside={<Radar size={22} strokeWidth={1.6} />}
      />

      {snapshot?.hasData && <LeadsKpis rows={rows} priorityProvinces={snapshot.priorityProvinces} />}

      <section className="panel leads-panel" aria-label="拓新雷达">
        <div className="panel__header">
          <div>
            <span className="eyebrow">LEADS SNAPSHOT / F5</span>
            <h2>拓新企业清单</h2>
          </div>
          <button className="text-button" onClick={runRefresh} disabled={refreshing}>
            {refreshing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {refreshing ? "刷新中…" : "刷新快照"}
          </button>
        </div>
        <p className="history-panel__note">
          只读拉取（dws aitable table get + record query），四重护栏拒绝表名漂移 / 意外空表 / 记录腰斩 / 分页不完整，
          拒绝时旧快照原样保留；快照 12h TTL 低成本口径，仅手动刷新、不自动轮询。
        </p>

        {error && <div className="answer-warning"><AlertCircle size={15} /> {error}</div>}
        {notice && !error && <div className="answer-warning"><AlertCircle size={15} /> {notice}</div>}

        {snapshot && !snapshot.configured && (
          <div className="leads-guide">
            <p><strong>尚未配置拓新雷达。</strong>本机补 <code>.local-cache/leads.json</code>（参考 <code>config/leads.json.example</code>）五个键：</p>
            <ol>
              <li><code>baseId</code> / <code>tableId</code> / <code>viewId</code>：在钉钉 AI 表格链接里取（/i/nodes/&lt;baseId&gt;?sheetId=&lt;tableId&gt;&amp;viewId=&lt;viewId&gt;）</li>
              <li><code>tableName</code>：默认「拓新企业清单」，漂移即拒绝拉取</li>
              <li><code>priorityProvinces</code>：优先拓新区域（命中行带优先省徽标）</li>
            </ol>
            <p>并在启动本机桥的终端确认 dws 已登录（<code>dws auth login</code>）后，点右上角「刷新快照」做首次拉取。</p>
          </div>
        )}

        {snapshot && snapshot.configured && !snapshot.hasData && (
          <p className="leads-guide__single">{snapshot.note || "配置已就绪，点右上角「刷新快照」做首次拉取。"}</p>
        )}

        {snapshot?.hasData && (
          <LeadsBody
            snapshot={snapshot}
            rows={rows}
            options={options}
            listRows={listRows}
            query={query}
            dimension={dimension}
            onQuery={patchQuery}
            onDimension={setDimension}
            onOpen={setOpenId}
          />
        )}
      </section>

      {openRow && <LeadDrawer row={openRow} onClose={() => setOpenId("")} />}
    </div>
  );
}
