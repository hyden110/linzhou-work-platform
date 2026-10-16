import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import {
  OPS_REFRESH_ERRORS,
  OpsClientError,
  fetchOpsCard,
  fetchOpsWechatLinks,
  opsErrorMessage,
  registerOpsWechatLink,
} from "../../lib/ops-client";
import {
  OPS_SOURCE_BADGES,
  OPS_SOURCE_ORDER,
  groupOpsItemsByDay,
  opsStatusLabel,
  opsStatusTone,
} from "../../lib/ops-model";
import type { OpsCard, OpsItem, OpsWechatLink } from "../../lib/ops-types";
import { StatusBadge, ViewHeading } from "../shared";
import { formatDateTime } from "../crm/crm-shared";
import { useOps } from "./OpsProvider";

const WECHAT_STATUS: Record<OpsWechatLink["status"], { label: string; tone: "green" | "amber" | "muted" }> = {
  registered: { label: "已登记", tone: "muted" },
  fetched: { label: "已抓取", tone: "green" },
  fetch_failed: { label: "抓取失败", tone: "amber" },
};

function OpsRefreshControl() {
  const { digest, refresh, refreshNow } = useOps();
  const running = refresh?.state === "running";
  const label = running
    ? "正在刷新…"
    : refresh?.state === "failed"
      ? OPS_REFRESH_ERRORS[refresh.error ?? ""] ?? "刷新失败"
      : digest
        ? `摘要 ${formatDateTime(digest.generatedAt)}`
        : "尚无摘要";
  return (
    <div className="crm-refresh">
      <span className={refresh?.state === "failed" ? "is-failed" : undefined}>{label}</span>
      <button className="primary-button" onClick={refreshNow} disabled={running}>
        {running ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新数据
      </button>
    </div>
  );
}

function OpsGate({ children }: { children: React.ReactNode }) {
  const { digest, loading, error, missing } = useOps();
  if (digest) return <>{children}</>;
  if (loading) return <div className="panel crm-empty"><LoaderCircle className="spin" size={18} /><p>读取本机运营摘要…</p></div>;
  return (
    <div className="panel crm-empty">
      <AlertTriangle size={18} />
      <p>{missing ? "还没有运营摘要，点击右上角“刷新数据”采集第一份。" : error}</p>
    </div>
  );
}

function CardEntryRow({ entry }: { entry: OpsCard["groups"][number]["items"][number] }) {
  return (
    <li className="ops-entry">
      <div>
        {entry.url
          ? <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title}<ExternalLink size={11} /></a>
          : <strong>{entry.title}</strong>}
        {entry.summary && <span>{entry.summary}</span>}
      </div>
      <time>{entry.publishedAt ? formatDateTime(entry.publishedAt) : "—"}</time>
      <StatusBadge tone="blue">{OPS_SOURCE_BADGES[entry.sourceType]}</StatusBadge>
    </li>
  );
}

function BoardRow({ item }: { item: OpsItem }) {
  return (
    <li className="ops-entry">
      <div>
        {item.url
          ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}<ExternalLink size={11} /></a>
          : <strong>{item.title}</strong>}
        {item.summary && <span>{item.summary}</span>}
      </div>
      <time>{item.publishedAt ? formatDateTime(item.publishedAt) : "—"}</time>
      <StatusBadge tone="blue">{OPS_SOURCE_BADGES[item.sourceType]}</StatusBadge>
    </li>
  );
}

export function OpsView() {
  const { digest, error } = useOps();
  const [card, setCard] = useState<OpsCard | null>(null);
  const [links, setLinks] = useState<readonly OpsWechatLink[]>([]);
  const [wechatUrl, setWechatUrl] = useState("");
  const [wechatBusy, setWechatBusy] = useState(false);
  const [wechatError, setWechatError] = useState("");

  const generatedAt = digest?.generatedAt ?? null;
  useEffect(() => {
    if (!generatedAt) return;
    let active = true;
    fetchOpsCard()
      .then((value) => { if (active) setCard(value); })
      .catch(() => { if (active) setCard(null); });
    fetchOpsWechatLinks()
      .then((value) => { if (active) setLinks(value); })
      .catch(() => { if (active) setLinks([]); });
    return () => { active = false; };
  }, [generatedAt]);

  const board = useMemo(
    () => digest ? groupOpsItemsByDay(digest.items) : [],
    [digest],
  );

  const submitWechatLink = async (event: React.FormEvent) => {
    event.preventDefault();
    const url = wechatUrl.trim();
    if (!url || wechatBusy) return;
    setWechatBusy(true);
    setWechatError("");
    try {
      const link = await registerOpsWechatLink(url);
      setLinks((current) => [...current.filter((existing) => existing.id !== link.id), link]);
      setWechatUrl("");
    } catch (caught) {
      setWechatError(caught instanceof OpsClientError ? opsErrorMessage(caught) : "登记未完成，请稍后重试。");
    } finally {
      setWechatBusy(false);
    }
  };

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="GROWTH OPS / PROMOTION"
        title="运营推广"
        description="Qoder 官方动态、千问办公公告与千仔推送：当日运营卡 + 近 7 天展板；全部由本机只读采集，公众号内容仅登记链接。"
        aside={<OpsRefreshControl />}
      />
      {error && <div className="crm-banner crm-banner--inline" role="status"><AlertTriangle size={15} /><p>{error}</p></div>}
      <OpsGate>
        {digest && (
          <>
            <section className="panel" aria-label="数据源健康">
              <header className="panel__header">
                <div><span className="eyebrow">SOURCES</span><h2>数据源健康</h2></div>
                <span>{digest.items.length} 条摘要</span>
              </header>
              <div className="ops-sources">
                {OPS_SOURCE_ORDER.map((key) => {
                  const status = digest.sources[key];
                  return (
                    <div key={key} className="ops-source-row">
                      <strong>{OPS_SOURCE_BADGES[key]}</strong>
                      {status
                        ? <StatusBadge tone={opsStatusTone(status.status)}>{opsStatusLabel(status.status)}</StatusBadge>
                        : <StatusBadge tone="muted">未同步</StatusBadge>}
                      <span>{status ? `${status.count} 条` : "—"}</span>
                      <time>{formatDateTime(status?.fetchedAt ?? status?.lastSuccessAt ?? null)}</time>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel" aria-label="当日运营卡">
              <header className="panel__header">
                <div><span className="eyebrow">TODAY</span><h2>当日运营卡</h2></div>
                <span>{card ? `${card.total} 条` : "…"}</span>
              </header>
              {card && (
                <div className="ops-card__overview">
                  <StatusBadge tone={card.overview.kind === "ai" ? "green" : "muted"}>
                    {card.overview.kind === "ai" ? "AI 摘要" : "模板汇总"}
                  </StatusBadge>
                  <p>{card.overview.text}</p>
                  <small>{card.overview.note}</small>
                </div>
              )}
              {card && card.total === 0
                ? <p className="crm-muted">今日暂无新增运营讯息（最近动态见下方近 7 天展板）。</p>
                : card && (
                  <div>
                    {card.groups.filter((group) => group.count > 0).map((group) => (
                      <div key={group.key} className="ops-group">
                        <h3>{group.label}<span>{group.count}</span></h3>
                        <ul className="ops-list">{group.items.map((entry) => <CardEntryRow key={`${group.key}:${entry.title}`} entry={entry} />)}</ul>
                      </div>
                    ))}
                  </div>
                )}
            </section>

            <section className="panel" aria-label="近 7 天展板">
              <header className="panel__header">
                <div><span className="eyebrow">LAST 7 DAYS</span><h2>近 7 天展板</h2></div>
                <span>{board.reduce((sum, day) => sum + day.items.length, 0)} 条</span>
              </header>
              {board.length === 0
                ? <p className="crm-muted">近 7 天没有可展示的带日期讯息。</p>
                : board.map((day) => (
                  <div key={day.key} className="ops-day">
                    <h3>{day.label}{day.isToday && <StatusBadge tone="green">今天</StatusBadge>}</h3>
                    {day.note && <p className="crm-muted">{day.note}</p>}
                    <ul className="ops-list">{day.items.map((item) => <BoardRow key={item.id} item={item} />)}</ul>
                  </div>
                ))}
            </section>

            <section className="panel" aria-label="公众号链接登记">
              <header className="panel__header">
                <div><span className="eyebrow">WECHAT REGISTRY</span><h2>公众号链接登记</h2></div>
                <span>{links.length} 条</span>
              </header>
              <form className="ops-wechat__form" onSubmit={submitWechatLink}>
                <Link2 size={14} />
                <input
                  value={wechatUrl}
                  onChange={(event) => setWechatUrl(event.target.value)}
                  placeholder="粘贴公众号文章链接（https://mp.weixin.qq.com/…）"
                  aria-label="公众号文章链接"
                />
                <button className="primary-button" type="submit" disabled={wechatBusy || !wechatUrl.trim()}>
                  {wechatBusy ? <LoaderCircle className="spin" size={14} /> : null}登记
                </button>
              </form>
              {wechatError && <p className="ops-wechat__error">{wechatError}</p>}
              <p className="crm-table-note">公众号文章无公开自动抓取通道，v1 仅登记链接供人工查看；白名单域名会尝试抓取并如实标注成败。</p>
              {links.length > 0 && (
                <ul className="ops-list ops-list--padded">
                  {links.map((link) => (
                    <li key={link.id} className="ops-entry">
                      <div>
                        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title ?? link.url}<ExternalLink size={11} /></a>
                        <span>{link.note}</span>
                      </div>
                      <time>{formatDateTime(link.registeredAt)}</time>
                      <StatusBadge tone={WECHAT_STATUS[link.status].tone}>{WECHAT_STATUS[link.status].label}</StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </OpsGate>
    </div>
  );
}
