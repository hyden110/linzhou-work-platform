import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  LoaderCircle,
  Radar,
  RefreshCw,
  ShieldCheck,
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
import { ViewHeading } from "../shared";

/**
 * 「拓新雷达」视图（F5）：钉钉 AI 表格「拓新企业清单」只读拉取。
 * 线索由外部 lead-radar 写表，工作台只读、绝不回写；联系人字段白名单外物理不入快照。
 * 12h TTL 低成本口径：打开时读一次本机快照（纯本地文件读），此后仅手动「刷新」，
 * 不自动轮询；快照 >24h 显示灰字过旧提示。
 */

const TIER_BUCKETS: ReadonlyArray<{ readonly key: LeadTier; readonly label: string }> = [
  { key: "ME", label: "ME" },
  { key: "A", label: "A" },
  { key: "B", label: "B" },
  { key: "B2", label: "B2" },
  { key: "A?", label: "A?" },
  { key: "C", label: "C" },
  { key: "pending", label: "待扫" },
  { key: "D", label: "D" },
];

const ALL = "全部";

/** 展开行的全量白名单字段（顺序与 FIELD_MAP 快照键一致）。 */
const DETAIL_FIELDS: ReadonlyArray<{ readonly key: keyof LeadRow; readonly label: string }> = [
  { key: "name", label: "企业名称" },
  { key: "legal", label: "法律实体" },
  { key: "crmName", label: "CRM客户名" },
  { key: "tierLabel", label: "Name判定" },
  { key: "tier", label: "判定档" },
  { key: "crmState", label: "CRM状态" },
  { key: "score", label: "综合分" },
  { key: "priority", label: "优先级" },
  { key: "province", label: "省份" },
  { key: "city", label: "城市" },
  { key: "track", label: "赛道" },
  { key: "trackRaw", label: "原始赛道" },
  { key: "summary", label: "一句话" },
  { key: "signal", label: "信号类型" },
  { key: "round", label: "融资阶段" },
  { key: "amount", label: "最新融资额" },
  { key: "investors", label: "领投方" },
  { key: "maas", label: "MaaS匹配" },
  { key: "maasWhy", label: "MaaS分析" },
  { key: "maasProduct", label: "MaaS产品" },
  { key: "agent", label: "Agent席位潜力" },
  { key: "agentWhy", label: "Agent分析" },
  { key: "risk", label: "竞争风险" },
  { key: "aliRel", label: "阿里关联" },
  { key: "sales", label: "跟进人" },
  { key: "team", label: "跟进团队" },
  { key: "uids", label: "关联UID数" },
  { key: "cid", label: "CID" },
  { key: "ecid", label: "ECID" },
  { key: "mentions", label: "提及次数(14天)" },
  { key: "signalAt", label: "最新信号时间" },
  { key: "radarAt", label: "雷达更新时间" },
  { key: "news", label: "最新资讯" },
  { key: "sources", label: "数据来源" },
  { key: "founded", label: "成立日期" },
  { key: "regCap", label: "注册资本" },
  { key: "address", label: "注册地址" },
  { key: "founder", label: "创始人" },
  { key: "website", label: "官网" },
  { key: "entStatus", label: "企典状态" },
];

function cell(value: LeadRow[keyof LeadRow]): string {
  if (value == null || value === false) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "t" in value) return String((value as { t?: unknown }).t ?? "");
  return "";
}

function clock(iso: string): string {
  return iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : iso;
}

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

function tierBadgeClass(tier: LeadTier): string {
  if (tier === "ME") return "status-badge status-badge--amber";
  if (tier === "D" || tier === "pending") return "status-badge status-badge--muted";
  return "status-badge";
}

function LeadDetail({ row }: { row: LeadRow }) {
  return (
    <dl className="leads-detail">
      {DETAIL_FIELDS.map(({ key, label }) => {
        const value = key === "news"
          ? (row.news ? (safeHref(row.news.u)
            ? <a href={row.news.u} target="_blank" rel="noreferrer">{row.news.t || row.news.u}</a>
            : row.news.t) : "")
          : key === "isPriority" ? "" : cell(row[key]);
        return (
          <div key={key} className="leads-detail__item" data-empty={value === "" ? "yes" : "no"}>
            <dt>{label}</dt>
            <dd>{value === "" ? "—" : value}</dd>
          </div>
        );
      })}
      <div className="leads-detail__item" data-empty="no">
        <dt>优先区域</dt>
        <dd>{row.isPriority ? "是（命中优先省）" : "否"}</dd>
      </div>
    </dl>
  );
}

function LeadLine({ row, expanded, onToggle }: { row: LeadRow; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="leads-row" data-tier={row.tier}>
      <button className="leads-row__head" onClick={onToggle} aria-expanded={expanded}>
        <span className="leads-row__name">
          <strong>{row.name}</strong>
          <span className={tierBadgeClass(row.tier)}>{row.tier === "pending" ? "待扫" : row.tier}</span>
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
        <span> · 信号 {row.signalAt || "—"} · 雷达 {clock(row.radarAt) || "—"}</span>
      </p>
      {expanded && <LeadDetail row={row} />}
    </div>
  );
}

export function LeadsView() {
  const [snapshot, setSnapshot] = useState<LeadsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [trackFilter, setTrackFilter] = useState(ALL);
  const [provinceFilter, setProvinceFilter] = useState(ALL);
  const [stateFilter, setStateFilter] = useState(ALL);

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

  const buckets = useMemo(() => {
    const counts = new Map<LeadTier, number>(TIER_BUCKETS.map(({ key }) => [key, 0]));
    for (const row of snapshot?.rows ?? []) counts.set(row.tier, (counts.get(row.tier) ?? 0) + 1);
    return TIER_BUCKETS.map(({ key, label }) => ({ key, label, count: counts.get(key) ?? 0 }));
  }, [snapshot]);

  const options = useMemo(() => {
    const rows = snapshot?.rows ?? [];
    const unique = (pick: (row: LeadRow) => string): string[] =>
      Array.from(new Set(rows.map(pick).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
    return {
      tracks: unique((row) => row.track),
      provinces: unique((row) => row.province),
      states: unique((row) => row.crmState),
    };
  }, [snapshot]);

  const rows = useMemo(() => (snapshot?.rows ?? []).filter((row) =>
    (trackFilter === ALL || row.track === trackFilter)
    && (provinceFilter === ALL || row.province === provinceFilter)
    && (stateFilter === ALL || row.crmState === stateFilter)), [snapshot, trackFilter, provinceFilter, stateFilter]);

  const staleHours = leadsAgeHours(snapshot?.fetchedAt ?? "", Date.now());
  const stale = staleHours != null && staleHours > 24;
  const tableUrl = safeHref(snapshot?.url ?? "");
  const hasFilters = trackFilter !== ALL || provinceFilter !== ALL || stateFilter !== ALL;

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / LEADS RADAR"
        title="拓新雷达"
        description="钉钉 AI 表格「拓新企业清单」的只读镜像：线索由外部 lead-radar 写表（信源 → LLM 抽取 → Name 判定），工作台只读拉取、绝不回写；电话/邮箱/法定代表人等联系人字段白名单外，物理不入快照。"
        aside={<Radar size={22} strokeWidth={1.6} />}
      />

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
          <>
            <div className="leads-meta">
              快照时间 <time>{snapshot.fetchedAt || "—"}</time>
              {stale && <em className="leads-stale">（已超过 24 小时，数据可能过期，建议手动刷新）</em>}
              {snapshot.tableName && <span> · 表 {snapshot.tableName}</span>}
              <span> · 共 {snapshot.total} 条</span>
              {tableUrl && (
                <a className="leads-meta__link" href={tableUrl} target="_blank" rel="noreferrer">
                  打开 AI 表格<ExternalLink size={11} />
                </a>
              )}
            </div>

            <div className="leads-buckets" aria-label="判定档分桶">
              {buckets.map(({ key, label, count }) => (
                <span key={key} className="leads-bucket" data-tier={key} title={`判定档 ${label}`}>
                  <b>{count}</b>{label}
                </span>
              ))}
            </div>

            <div className="leads-filters" aria-label="线索筛选">
              <label>赛道
                <select value={trackFilter} onChange={(event) => setTrackFilter(event.target.value)}>
                  <option>{ALL}</option>
                  {options.tracks.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label>省份
                <select value={provinceFilter} onChange={(event) => setProvinceFilter(event.target.value)}>
                  <option>{ALL}</option>
                  {options.provinces.map((item) => (
                    <option key={item}>{snapshot.priorityProvinces.includes(item) ? `${item}（优先省）` : item}</option>
                  ))}
                </select>
              </label>
              <label>CRM状态
                <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                  <option>{ALL}</option>
                  {options.states.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              {hasFilters && <button className="text-button" onClick={() => { setTrackFilter(ALL); setProvinceFilter(ALL); setStateFilter(ALL); }}>清除筛选</button>}
              <span className="leads-filters__count">{rows.length} / {snapshot.total} 条</span>
            </div>

            <div className="leads-list">
              {rows.map((row) => (
                <LeadLine
                  key={row.id}
                  row={row}
                  expanded={expandedId === row.id}
                  onToggle={() => setExpandedId((current) => (current === row.id ? "" : row.id))}
                />
              ))}
              {rows.length === 0 && <p className="leads-empty">当前筛选无匹配线索。</p>}
            </div>

            <p className="leads-footnote"><ShieldCheck size={12} /> 快照只含白名单字段（无联系人字段、无凭据形态文本）；拉取过程不回写 AI 表格。</p>
          </>
        )}
      </section>
    </div>
  );
}
