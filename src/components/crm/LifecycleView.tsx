import { useCallback, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { lifecycleBoard, type CustomerLifecycle } from "../../lib/crm-model";
import { ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CustomerDrawer } from "./CustomerDrawer";
import { CrmGate, RefreshControl, SourceBanner, formatGaap } from "./crm-shared";

const COLUMN_PREVIEW = 30;

function CustomerCard({ row, onOpen }: { row: CustomerLifecycle; onOpen: () => void }) {
  const { customer, leadProject, activeProjects } = row;
  const rate = customer.yesterdayGaapRate;
  return (
    <li>
      <button className="crm-customer" onClick={onOpen}>
        <strong>{customer.name}</strong>
        <span>{[customer.industry, customer.level].filter(Boolean).join(" · ") || "—"}</span>
        <div className="crm-customer__numbers">
          <b>{formatGaap(customer.lastMonthGaap)}</b>
          {rate !== null && <em className={rate < 0 ? "is-down" : "is-up"}>{rate > 0 ? "+" : ""}{rate.toFixed(1)}%</em>}
        </div>
        {leadProject && <small>{leadProject.stageName ?? "阶段未知"} · {activeProjects.length} 个在途项目</small>}
      </button>
    </li>
  );
}

export function LifecycleView() {
  const { snapshot } = useCrm();
  const [keyword, setKeyword] = useState("");
  const [openCid, setOpenCid] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const closeDrawer = useCallback(() => setOpenCid(""), []);

  const columns = useMemo(() => (snapshot ? lifecycleBoard(snapshot) : []), [snapshot]);
  const needle = keyword.trim().toLowerCase();
  const filtered = useMemo(() => columns.map((column) => ({
    ...column,
    customers: needle ? column.customers.filter((row) => row.customer.name.toLowerCase().includes(needle)) : column.customers,
  })), [columns, needle]);

  const openRow = columns.flatMap((column) => column.customers).find((row) => row.customer.cid === openCid) ?? null;
  const customersReady = snapshot?.sources.customers?.status === "ok";

  return (
    <div className="view-stack">
      <ViewHeading eyebrow="CUSTOMER OPS / LIFECYCLE" title="客户全生命周期" description="按鲲鹏在途项目把客户分到四个阶段，列内按上月 GAAP 排序。点击客户查看在途项目和 FBI 异动解读。" aside={<RefreshControl />} />
      <CrmGate>
        {snapshot && (
          <>
            <SourceBanner keys={["customers", "projects"]} />
            <section className="panel crm-toolbar">
              <span className="crm-toolbar__summary">
                {customersReady ? `${snapshot.customers.length} 个客户 · ${snapshot.projects.length} 个项目` : "鲲鹏客户数据暂不可用"}
              </span>
              <label className="crm-search">
                <Search size={14} />
                <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索客户" aria-label="搜索客户" />
              </label>
            </section>
            <div className="crm-board">
              {filtered.map((column) => {
                const showAll = expanded[column.stage.id] ?? false;
                const rows = showAll ? column.customers : column.customers.slice(0, COLUMN_PREVIEW);
                return (
                  <section key={column.stage.id} className="panel crm-column" aria-label={column.stage.label}>
                    <header>
                      <div>
                        <span className="crm-column__id">{column.stage.id}</span>
                        <h2>{column.stage.label}</h2>
                      </div>
                      <b>{column.customers.length}</b>
                      <p>{column.stage.hint}</p>
                      <small>GAAP {formatGaap(column.gaap)}</small>
                    </header>
                    {rows.length === 0
                      ? <p className="crm-muted">{customersReady ? "暂无客户" : "等待鲲鹏数据"}</p>
                      : <ul>{rows.map((row) => <CustomerCard key={row.customer.cid} row={row} onOpen={() => setOpenCid(row.customer.cid)} />)}</ul>}
                    {column.customers.length > COLUMN_PREVIEW && (
                      <button className="text-button crm-more" onClick={() => setExpanded((current) => ({ ...current, [column.stage.id]: !showAll }))}>
                        {showAll ? "收起" : `展开全部 ${column.customers.length}`}
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
            {openRow && (
              <CustomerDrawer row={openRow} onClose={closeDrawer} />
            )}
          </>
        )}
      </CrmGate>
    </div>
  );
}
