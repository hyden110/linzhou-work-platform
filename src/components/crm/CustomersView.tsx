import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  customerLifecycle,
  customersByGaap,
  overviewBoard,
  projectsByCustomer,
  topBoard,
  type CustomerLifecycle,
  type OverviewBoard,
} from "../../lib/crm-model";
import type { TopChecks } from "../../lib/crm-types";
import { ViewHeading } from "../shared";
import { useCrm } from "./CrmProvider";
import { CustomerDrawer } from "./CustomerDrawer";
import { CrmGate, MetricCard, RefreshControl, SourceBanner, formatDateTime, formatGaap } from "./crm-shared";

const TABLE_LIMIT = 50;

function countNote(board: OverviewBoard, listCount: number): string {
  if (board.customerCount === null) return "总览客户数缺失，等待下一次刷新";
  if (board.customerCountMatches) return `与客户列表自动核对一致（${listCount}）`;
  return `总览 ${board.customerCount} ≠ 客户列表 ${listCount} · 口径待确认`;
}

function checksText(checks: TopChecks | null): string {
  if (checks === null) return "缺少 checks 元信息";
  return [
    !checks.gaapMonotonicDesc && "gaapMonotonicDesc=false（GAAP 未按降序）",
    !checks.countWithinLimit && "countWithinLimit=false（条数超出查询上限）",
  ].filter(Boolean).join("；");
}

function SignedRate({ rate }: { rate: number | null }) {
  if (rate === null) return null;
  return <small className={rate < 0 ? "is-down" : "is-up"}>{rate > 0 ? "+" : ""}{rate.toFixed(1)}%</small>;
}

export function CustomersView() {
  const { snapshot } = useCrm();
  const [openCid, setOpenCid] = useState("");
  const closeDrawer = useCallback(() => setOpenCid(""), []);

  const lifecycleRows = useMemo(() => {
    if (!snapshot) return new Map<string, CustomerLifecycle>();
    const grouped = projectsByCustomer(snapshot.customers, snapshot.projects);
    return new Map(snapshot.customers.map((customer) => [
      customer.cid,
      customerLifecycle(customer, grouped.get(customer.cid) ?? []),
    ] as const));
  }, [snapshot]);

  const board = useMemo(() => (snapshot ? overviewBoard(snapshot) : null), [snapshot]);
  const top = useMemo(() => (snapshot ? topBoard(snapshot) : null), [snapshot]);
  const rows = useMemo(() => (snapshot ? customersByGaap(snapshot.customers) : []), [snapshot]);
  const openRow = openCid ? lifecycleRows.get(openCid) ?? null : null;

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="CUSTOMER OPS / ACCOUNTS"
        title="客户盘面"
        description="客户池金额总览、上月 GAAP TOP 榜与鲲鹏分层视图；口径与自检异常会在页面上显式标注。"
        aside={<RefreshControl />}
      />
      <CrmGate>
        {snapshot && board && top && (
          <>
            <SourceBanner keys={["overview", "top", "mygroups", "customers"]} />

            <section className="metric-grid crm-metrics crm-metrics--four" aria-label="客户池总览">
              <MetricCard
                label="上月 GAAP（客户求和）"
                value={formatGaap(board.lastMonthGaapSum)}
                note={`${snapshot.customers.length} 个客户 lastMonthGaap 求和口径`}
                primary
              />
              <MetricCard
                label="昨日 GAAP"
                value={formatGaap(board.yesterdayGaap)}
                note={board.payBasis ? "鲲鹏总览 · 支付口径" : "鲲鹏总览口径"}
              />
              <MetricCard
                label="日 GAAP 环比"
                value={board.yesterdayGaapRate === null ? "—" : `${board.yesterdayGaapRate > 0 ? "+" : ""}${board.yesterdayGaapRate.toFixed(1)}%`}
                note={board.yesterdayGaapDiff === null ? "环比涨跌额暂缺" : `涨跌额 ${formatGaap(board.yesterdayGaapDiff)} · ${board.payBasis ? "支付口径" : "总览口径"}`}
              />
              <MetricCard
                label="客户数"
                value={board.customerCount === null ? "—" : String(board.customerCount)}
                note={countNote(board, snapshot.customers.length)}
                warning={!board.customerCountMatches}
              />
            </section>

            <section className="panel">
              <header className="panel__header">
                <div><span className="eyebrow">TOP ACCOUNTS</span><h2>上月 GAAP TOP {top.items.length}</h2></div>
                <span>
                  {top.total === null ? "" : `共 ${top.total} 个客户`}
                  {top.queriedAt ? ` · 查询于 ${top.queriedAt}` : ""}
                </span>
              </header>
              {!top.checksOk && (
                <div className="crm-banner crm-banner--inline" role="alert">
                  <AlertTriangle size={15} />
                  <div>
                    <p><strong>鲲鹏 TOP 榜自检未通过</strong>：{checksText(top.checks)}。</p>
                    <small>榜单数字可能失真，请人工复核后再使用；刷新不会掩盖该告警。</small>
                  </div>
                </div>
              )}
              {top.items.length === 0
                ? <p className="crm-muted">暂无 TOP 数据；点击右上角「刷新数据」从鲲鹏拉取。</p>
                : (
                  <div className="crm-table-wrap">
                    <table className="crm-table">
                      <thead>
                        <tr><th>#</th><th>客户</th><th>GC 等级</th><th>上月 GAAP</th><th>昨日 GAAP</th></tr>
                      </thead>
                      <tbody>
                        {top.items.map((item) => (
                          <tr key={item.cid}>
                            <td>{item.rank}</td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => setOpenCid(item.cid)}
                                disabled={!lifecycleRows.has(item.cid)}
                                title={lifecycleRows.has(item.cid) ? "打开客户详情" : "客户不在当前快照列表"}
                              >
                                {item.name}
                              </button>
                              <small>{[item.industry, item.area].filter(Boolean).join(" · ") || "—"}</small>
                            </td>
                            <td>{item.level ?? "—"}</td>
                            <td>{formatGaap(item.lastMonthGaap)}</td>
                            <td>{formatGaap(item.yesterdayGaap)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>

            <section className="panel">
              <header className="panel__header">
                <div><span className="eyebrow">SEGMENTS</span><h2>分层视图</h2></div>
                <span>{snapshot.mygroups.length} 个视图 · 计数取自鲲鹏 cidCount</span>
              </header>
              {snapshot.mygroups.length === 0
                ? <p className="crm-muted">暂无分层视图数据。</p>
                : (
                  <div className="crm-tier-grid">
                    {snapshot.mygroups.map((view) => (
                      <article key={view.id} className={`crm-tier-card ${view.id === "186" ? "is-primary" : ""}`}>
                        <span>{view.name}</span>
                        <strong>{view.count}</strong>
                        <small>视图 {view.id}{view.group ? ` · ${view.group}` : ""}</small>
                      </article>
                    ))}
                  </div>
                )}
            </section>

            <section className="panel">
              <header className="panel__header">
                <div><span className="eyebrow">ACCOUNTS</span><h2>客户列表</h2></div>
                <span>按上月 GAAP 降序 · 显示 {Math.min(rows.length, TABLE_LIMIT)} / {rows.length}</span>
              </header>
              {rows.length === 0
                ? <p className="crm-muted">暂无客户数据；点击右上角「刷新数据」从鲲鹏拉取。</p>
                : (
                  <div className="crm-table-wrap">
                    <table className="crm-table">
                      <thead>
                        <tr><th>客户</th><th>等级</th><th>上月 GAAP</th><th>昨日 GAAP</th><th>最近拜访</th></tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, TABLE_LIMIT).map((customer) => (
                          <tr key={customer.cid}>
                            <td>
                              <button className="text-button" onClick={() => setOpenCid(customer.cid)}>{customer.name}</button>
                              <small>{[customer.industry, customer.area].filter(Boolean).join(" · ") || "—"}</small>
                            </td>
                            <td>{customer.level ?? "—"}</td>
                            <td>{formatGaap(customer.lastMonthGaap)}</td>
                            <td>
                              {formatGaap(customer.yesterdayGaap)} <SignedRate rate={customer.yesterdayGaapRate} />
                            </td>
                            <td>{formatDateTime(customer.lastNoteAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > TABLE_LIMIT && (
                      <p className="crm-table-note">共 {rows.length} 个客户，为保持浏览流畅当前展示前 {TABLE_LIMIT} 项。</p>
                    )}
                  </div>
                )}
            </section>

            {openRow && <CustomerDrawer row={openRow} onClose={closeDrawer} />}
          </>
        )}
      </CrmGate>
    </div>
  );
}
