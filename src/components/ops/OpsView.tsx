import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Eye, Link2, LoaderCircle, RefreshCw, Send } from "lucide-react";
import {
  OPS_REFRESH_ERRORS,
  OPS_WECHAT_BATCH_MAX,
  fetchOpsCard,
  fetchOpsWechatLinks,
  opsErrorMessage,
  previewOpsPush,
  registerOpsWechatLinks,
  sendOpsPush,
  shouldDiscardPushPreview,
} from "../../lib/ops-client";
import type { WechatBatchEntry } from "../../lib/ops-client";
import {
  OPS_SOURCE_BADGES,
  OPS_SOURCE_ORDER,
  groupOpsItemsByDay,
  opsStatusLabel,
  opsStatusTone,
  splitWechatLinks,
} from "../../lib/ops-model";
import type { OpsCard, OpsItem, OpsPushPreview, OpsWechatLink } from "../../lib/ops-types";
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

/** D2 推送逐次确认：dry-run 预览 → 二次点击确认才发送；确认状态不保存，换预览即作废。 */
function PushPanel() {
  const [preview, setPreview] = useState<OpsPushPreview | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPreview = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await previewOpsPush();
      setPreview(next);
      setArmed(false);
    } catch (caught) {
      setError(opsErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const requestSend = async () => {
    if (!preview || busy || preview.mode === "sent") return;
    // 二次确认：第一次点击只进入待确认态，绝不发送；刷新页面即取消。
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const sent = await sendOpsPush(preview.previewId);
      setPreview(sent);
      setArmed(false);
    } catch (caught) {
      // 预览已作废（preview_stale / preview_consumed）：丢弃旧预览，提示重新生成，避免对旧内容反复确认。
      if (shouldDiscardPushPreview(caught)) setPreview(null);
      setError(opsErrorMessage(caught));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  const sent = preview?.mode === "sent";
  return (
    <section className="panel" aria-label="钉钉日报推送">
      <header className="panel__header">
        <div><span className="eyebrow">DINGTALK PUSH</span><h2>日报推送（逐次确认）</h2></div>
        <span>{sent ? "已发送" : preview ? `预览 ${preview.date} · ${preview.entryCount} 条` : "未生成预览"}</span>
      </header>
      <p className="crm-table-note">
        先生成 dry-run 预览，二次点击确认才发送；确认状态不保存，重新生成预览或刷新页面即作废。
        真发仅推送到 env 配置的本人单聊，且需要总开关 OPS_DINGTALK_PUSH_ENABLED；没有任何群发路径。
      </p>
      <div className="ops-push__actions">
        <button className="primary-button" onClick={loadPreview} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Eye size={14} />}生成预览
        </button>
        {preview && (
          <button
            className={`primary-button ${armed ? "ops-push__confirm" : ""}`}
            onClick={requestSend}
            disabled={busy || sent}
          >
            {busy && armed ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
            {armed ? "再次点击确认发送" : "确认发送"}
          </button>
        )}
      </div>
      {error && <p className="ops-wechat__error">{error}</p>}
      {preview && (
        <div className="ops-push__preview">
          <div className="ops-push__meta">
            <StatusBadge tone={sent ? "green" : "blue"}>{sent ? "已发送" : "dry-run 预览"}</StatusBadge>
            <small>previewId {preview.previewId}</small>
          </div>
          <small>{preview.note}</small>
          <pre>{preview.cardText}</pre>
        </div>
      )}
    </section>
  );
}

export function OpsView() {
  const { digest, error } = useOps();
  const [card, setCard] = useState<OpsCard | null>(null);
  const [links, setLinks] = useState<readonly OpsWechatLink[]>([]);
  const [wechatInput, setWechatInput] = useState("");
  const [wechatBusy, setWechatBusy] = useState(false);
  const [wechatError, setWechatError] = useState("");
  const [wechatInvalid, setWechatInvalid] = useState<readonly string[]>([]);
  const [wechatResults, setWechatResults] = useState<readonly WechatBatchEntry[]>([]);

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

  const submitWechatLinks = async (event: React.FormEvent) => {
    event.preventDefault();
    if (wechatBusy) return;
    // 批量解析：按行/空白拆分、去重、空段忽略；非 http(s) 只拒绝不中断。
    const { valid, invalid } = splitWechatLinks(wechatInput);
    setWechatInvalid(invalid);
    setWechatResults([]);
    if (valid.length === 0) {
      setWechatError(invalid.length > 0 ? "没有可登记的链接。" : "请先粘贴至少一个链接。");
      return;
    }
    setWechatBusy(true);
    setWechatError("");
    try {
      // 超过单次上限时客户端整批拒绝（不发请求），这里如实提示分批。
      const results = await registerOpsWechatLinks(valid);
      setWechatResults(results);
      const succeeded = results.flatMap((entry) => (entry.link ? [entry.link] : []));
      if (succeeded.length > 0) {
        setLinks((current) => [
          ...succeeded,
          ...current.filter((existing) => !succeeded.some((link) => link.id === existing.id)),
        ]);
      }
      if (succeeded.length === valid.length) {
        setWechatInput("");
      } else if (succeeded.length === 0) {
        setWechatError("全部登记失败，请稍后重试（失败原因见逐条列表）。");
      }
    } catch (caught) {
      setWechatError(`${opsErrorMessage(caught)}（本次 ${valid.length} 条）`);
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

            <PushPanel />

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
              <form className="ops-wechat__form" onSubmit={submitWechatLinks}>
                <Link2 size={14} />
                <textarea
                  value={wechatInput}
                  onChange={(event) => setWechatInput(event.target.value)}
                  placeholder={`每行一个公众号文章链接（https://mp.weixin.qq.com/…），可一次粘贴多个（单次最多 ${OPS_WECHAT_BATCH_MAX} 条）；空行忽略，自动去重`}
                  aria-label="公众号文章链接（可多个，每行一个）"
                  rows={3}
                />
                <button className="primary-button" type="submit" disabled={wechatBusy || !wechatInput.trim()}>
                  {wechatBusy ? <LoaderCircle className="spin" size={14} /> : null}批量登记
                </button>
              </form>
              {wechatInvalid.length > 0 && (
                <p className="ops-wechat__error">已忽略 {wechatInvalid.length} 个非 http(s) 输入：{wechatInvalid.join("、")}</p>
              )}
              {wechatError && <p className="ops-wechat__error">{wechatError}</p>}
              <p className="crm-table-note">公众号文章无公开自动抓取通道，v1 仅登记链接供人工查看；白名单域名会尝试抓取并如实标注成败。批量登记逐条独立执行，单条失败不影响其他条。</p>
              {wechatResults.length > 0 && (
                <ul className="ops-list ops-list--padded">
                  {wechatResults.map((entry) => (
                    <li key={entry.url} className="ops-entry">
                      <div>
                        {entry.link
                          ? <a href={entry.link.url} target="_blank" rel="noopener noreferrer">{entry.link.title ?? entry.link.url}<ExternalLink size={11} /></a>
                          : <strong>{entry.url}</strong>}
                        <span>{entry.error ?? entry.link?.note}</span>
                      </div>
                      <time>{entry.link ? formatDateTime(entry.link.registeredAt) : "—"}</time>
                      <StatusBadge tone={entry.link ? "green" : "amber"}>{entry.link ? "已登记" : "失败"}</StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
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
