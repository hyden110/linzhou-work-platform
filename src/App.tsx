import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Menu, Search, SlidersHorizontal, X } from "lucide-react";
import { LocalRuntimeProvider } from "./components/LocalRuntimeProvider";
import { AssistantView } from "./components/AssistantView";
import { CockpitView } from "./components/crm/CockpitView";
import { CrmProvider } from "./components/crm/CrmProvider";
import { CustomersView } from "./components/crm/CustomersView";
import { DingtalkView } from "./components/crm/DingtalkView";
import { PplFollowupView } from "./components/crm/PplFollowupView";
import { LeadsView } from "./components/crm/LeadsView";
import { InboxView } from "./components/InboxView";
import { NotifyBell } from "./components/NotifyBell";
import { KnowledgeMapView } from "./components/KnowledgeMapView";
import { ReportsView } from "./components/report/ReportsView";
import { AgentsView } from "./components/agents/AgentsView";
import { DemoModeBadge, SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { OpsProvider } from "./components/ops/OpsProvider";
import { OpsView } from "./components/ops/OpsView";
import { AskView, DocumentsView, OverviewView, SyncView } from "./components/WorkbenchViews";
import { YunqiView } from "./components/YunqiView";
import type { DocumentFacets } from "./components/FacetFilter";
import {
  ALL_CUSTOMERS,
  ALL_SOURCES,
  ALL_TRACKS,
  ALL_TYPES,
  UNCLASSIFIED_CUSTOMER,
  UNCLASSIFIED_TRACK,
  facetCounts,
  selectDocuments,
  withSelectedFacet,
} from "./data/facets";
import type { KnowledgeDocument, KnowledgeIndex, ShelfId, ViewId } from "./types";

const viewTitles: Record<ViewId, string> = {
  cockpit: "驾驶舱",
  customers: "客户盘面",
  dingtalk: "钉群盘面",
  lifecycle: "PPL 跟进",
  leads: "拓新雷达",
  overview: "总览",
  ask: "AI 问答",
  map: "知识地图",
  assistant: "方案助手",
  documents: "全部资料",
  yunqi: "云栖大会",
  sync: "同步中心",
  ops: "运营推广",
  report: "日周报",
  inbox: "消息中心",
  agents: "数字员工",
  settings: "设置",
};

const EMPTY_DOCUMENTS: KnowledgeDocument[] = [];

function normalizeDocument(document: KnowledgeDocument): KnowledgeDocument {
  return {
    ...document,
    topics: document.topics ?? [],
    solutionTracks: document.solutionTracks ?? [],
    customers: document.customers ?? [],
    events: document.events ?? [],
  };
}

function normalizeIndex(index: KnowledgeIndex): KnowledgeIndex {
  return {
    ...index,
    stats: {
      ...index.stats,
      bySolutionTrack: index.stats.bySolutionTrack ?? [],
      byCustomer: index.stats.byCustomer ?? [],
      byEvent: index.stats.byEvent ?? [],
    },
    documents: index.documents.map(normalizeDocument),
    recentDocuments: index.recentDocuments.map(normalizeDocument),
  };
}

function isKnowledgeIndex(value: unknown): value is KnowledgeIndex {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KnowledgeIndex>;
  return candidate.mode === "local-index-preview"
    && Array.isArray(candidate.documents)
    && Boolean(candidate.stats)
    && typeof candidate.stats?.totalDocuments === "number";
}

function Workbench() {
  const [activeView, setActiveView] = useState<ViewId>("cockpit");
  const [mapShelf, setMapShelf] = useState<ShelfId>("solutions");
  const [mapGroup, setMapGroup] = useState("");
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(ALL_SOURCES);
  const [fileType, setFileType] = useState(ALL_TYPES);
  const [track, setTrack] = useState(ALL_TRACKS);
  const [customer, setCustomer] = useState(ALL_CUSTOMERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/knowledge-index.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`索引请求失败 (${response.status})`);
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (!isKnowledgeIndex(payload)) throw new Error("索引格式无效");
        setIndex(normalizeIndex(payload));
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "无法加载本地索引");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const filter = useMemo(
    () => ({ query, source, fileType, track, customer }),
    [customer, fileType, query, source, track],
  );
  const documents = index?.documents ?? EMPTY_DOCUMENTS;
  const filteredDocuments = useMemo(() => selectDocuments(documents, filter), [documents, filter]);
  const trackScope = useMemo(() => selectDocuments(documents, filter, "track"), [documents, filter]);
  const customerScope = useMemo(() => selectDocuments(documents, filter, "customer"), [documents, filter]);
  const trackRows = useMemo(
    () => withSelectedFacet(facetCounts(trackScope, "solutionTracks", UNCLASSIFIED_TRACK), track, ALL_TRACKS),
    [track, trackScope],
  );
  const customerRows = useMemo(
    () => withSelectedFacet(facetCounts(customerScope, "customers", UNCLASSIFIED_CUSTOMER), customer, ALL_CUSTOMERS),
    [customer, customerScope],
  );

  const navigate = (view: ViewId, shelf?: ShelfId, group?: string) => {
    if (shelf) setMapShelf(shelf);
    setMapGroup(group ?? "");
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    navigate("documents");
  };

  const clearFilters = () => {
    setQuery("");
    setSource(ALL_SOURCES);
    setFileType(ALL_TYPES);
    setTrack(ALL_TRACKS);
    setCustomer(ALL_CUSTOMERS);
  };

  const hasFilters = Boolean(query)
    || source !== ALL_SOURCES
    || fileType !== ALL_TYPES
    || track !== ALL_TRACKS
    || customer !== ALL_CUSTOMERS;

  if (!index) {
    return (
      <main className="boot-screen">
        <div className="brand__mark"><Command size={20} /></div>
        <span>SA / KNOWLEDGE OPS</span>
        {loadError ? <><h1>本地索引加载失败</h1><p>{loadError}</p></> : <><i /><h1>正在装载工作台</h1><p>读取本地元数据索引…</p></>}
      </main>
    );
  }

  const commonProps = { index, documents: filteredDocuments, onNavigate: navigate };
  const facets: DocumentFacets = {
    track,
    customer,
    trackRows,
    customerRows,
    trackTotal: trackScope.length,
    customerTotal: customerScope.length,
    onTrackChange: setTrack,
    onCustomerChange: setCustomer,
  };
  const view = {
    cockpit: <CockpitView />,
    customers: <CustomersView />,
    dingtalk: <DingtalkView />,
    lifecycle: <PplFollowupView />,
    leads: <LeadsView />,
    overview: <OverviewView {...commonProps} />,
    ask: <AskView {...commonProps} />,
    map: <KnowledgeMapView {...commonProps} initialShelf={mapShelf} initialGroup={mapGroup} />,
    assistant: <AssistantView {...commonProps} />,
    documents: <DocumentsView {...commonProps} facets={facets} />,
    yunqi: <YunqiView {...commonProps} />,
    sync: <SyncView {...commonProps} />,
    ops: <OpsView />,
    report: <ReportsView />,
    inbox: <InboxView />,
    agents: <AgentsView />,
    settings: <SettingsView {...commonProps} />,
  }[activeView];

  return (
    <div className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileOpen}
        onNavigate={navigate}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        onCloseMobile={() => setMobileOpen(false)}
      />
      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="关闭导航遮罩" />}

      <div className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
          <div className="topbar__crumb"><span>个人知识域</span><b>/</b><strong>{viewTitles[activeView]}</strong></div>
          <form className="global-search" onSubmit={submitSearch}>
            <Search size={17} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料、方案、客户、活动或技术…" aria-label="全局搜索" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={15} /></button>}
            <kbd>⌘ K</kbd>
          </form>
          <button
            className={`filter-button ${filtersOpen || hasFilters ? "is-active" : ""}`}
            onClick={() => setFiltersOpen((current) => !current)}
            aria-label="筛选资料"
            aria-expanded={filtersOpen}
            aria-controls="global-filters"
          >
            <SlidersHorizontal size={16} /><span>筛选</span>{hasFilters && <i />}
          </button>
          <DemoModeBadge />
          <NotifyBell onOpenInbox={() => navigate("inbox")} />
          <div className="avatar" role="img" aria-label="当前用户 SA">SA</div>
        </header>

        {filtersOpen && (
          <section id="global-filters" className="filter-strip" aria-label="全局筛选">
            <span>全局筛选</span>
            <label>方案
              <select value={track} onChange={(event) => setTrack(event.target.value)}>
                <option>{ALL_TRACKS}</option>
                {trackRows.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}
              </select>
            </label>
            <label>客户
              <select value={customer} onChange={(event) => setCustomer(event.target.value)}>
                <option>{ALL_CUSTOMERS}</option>
                {customerRows.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}
              </select>
            </label>
            <label>来源<select value={source} onChange={(event) => setSource(event.target.value)}><option>{ALL_SOURCES}</option>{index.stats.bySource.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
            <label>类型<select value={fileType} onChange={(event) => setFileType(event.target.value)}><option>{ALL_TYPES}</option>{index.stats.byType.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
            <strong>{filteredDocuments.length.toLocaleString("zh-CN")} 项匹配</strong>
            {hasFilters && <button onClick={clearFilters}>清除全部</button>}
          </section>
        )}

        <main className="content">{view}</main>
        <footer className="workspace-footer"><span>SA KNOWLEDGE WORKBENCH</span><span>本地索引预览 · 原始资料未上传</span><span>INDEX / {index.schemaVersion}.0</span></footer>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <LocalRuntimeProvider>
      <CrmProvider>
        <OpsProvider>
          <Workbench />
        </OpsProvider>
      </CrmProvider>
    </LocalRuntimeProvider>
  );
}
