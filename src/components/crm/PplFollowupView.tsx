import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  customerLifecycle,
  filterFollowupByStage,
  pplFollowupBoard,
  projectsByCustomer,
} from "../../lib/crm-model";
import type { CustomerLifecycle, MaasOverrides, MaasStatus, PplFollowupCustomer } from "../../lib/crm-model";
import type { ProjectItem } from "../../lib/crm-types";
import { ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CustomerDrawer } from "./CustomerDrawer";
import { CrmGate, RefreshControl, SourceBanner, formatDateTime, formatGaap } from "./crm-shared";

/** 人工覆盖表：public/data/maas-overrides.json（CID → maas/non_maas）；缺失或格式非法 → 空表（全走初筛）。 */
async function loadMaasOverrides(): Promise<MaasOverrides> {
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
  const [activeLane, setActiveLane] = useState<MaasStatus>("maas");
  const [overrides, setOverrides] = useState<MaasOverrides>({});
  const closeDrawer = useCallback(() => setOpenCid(""), []);

  useEffect(() => {
    let cancelled = false;
    void loadMaasOverrides().then((loaded) => {
      if (!cancelled) setOverrides(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const board = useMemo(
    () => (snapshot ? pplFollowupBoard(snapshot, overrides) : null),
    [snapshot, overrides],
  );
  const stageNames = useMemo(() => {
    if (!snapshot) return [];
    return [...new Set(snapshot.projects.map((project) => project.stageName ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [snapshot]);

  const needle = keyword.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!board) return null;
    const byStage = filterFollowupByStage(board, stageFilter === "" ? null : stageFilter);
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
  }, [board, needle, stageFilter]);

  const lifecycleRows = useMemo(() => {
    if (!snapshot) return new Map<string, CustomerLifecycle>();
    const grouped = projectsByCustomer(snapshot.customers, snapshot.projects);
    return new Map(snapshot.customers.map((customer) => [
      customer.cid,
      customerLifecycle(customer, grouped.get(customer.cid) ?? []),
    ] as const));
  }, [snapshot]);

  const openRow = openCid ? lifecycleRows.get(openCid) ?? null : null;
  const customersReady = snapshot?.sources.customers?.status === "ok";
  const visibleProjects = filtered
    ? Object.values(filtered.lanes).reduce((sum, lane) => sum + lane.reduce((count, row) => count + row.projects.length, 0), 0)
    : 0;

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

            {openRow && <CustomerDrawer row={openRow} onClose={closeDrawer} />}
          </>
        )}
      </CrmGate>
    </div>
  );
}
