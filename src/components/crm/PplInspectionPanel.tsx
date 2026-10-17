import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, FileSearch, RefreshCw } from "lucide-react";
import {
  decidePplRecommendation,
  fetchPplInspection,
  pplErrorMessage,
  pplInspectionStatus,
  startPplRefresh,
  type PplInspectionBundle,
  type PplItemState,
  type PplRecommendation,
} from "../../lib/ppl-client";
import { StatusBadge } from "../shared";

/**
 * PPL 巡检面板（plan：docs/ppl-inspection-plan.md）。
 * 铁律落点：同意 ≠ 已创建——approve 只写本地 approvals.json，
 * 真实创建永远由 agent 会话调用鲲鹏创建 skill（双闸门之二）完成。
 */

const DEDUPE_LABEL: Record<string, { label: string; tone: "amber" | "blue" | "green" | "muted" }> = {
  exists: { label: "已建 PPL", tone: "muted" },
  suspected: { label: "疑似已建", tone: "amber" },
  new: { label: "未建", tone: "green" },
};

function formatAmount(value: number | null): string {
  if (value === null) return "—（缺失）";
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万元`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元`;
}

function dedupeEvidenceText(evidence: unknown): string {
  if (!evidence) return "";
  if (Array.isArray(evidence)) {
    const names = evidence
      .map((item) => (item && typeof item === "object" ? String((item as { projectName?: unknown }).projectName ?? "") : ""))
      .filter(Boolean);
    return names.join("；");
  }
  if (typeof evidence === "object") return String((evidence as { projectName?: unknown }).projectName ?? "");
  return "";
}

function itemState(bundle: PplInspectionBundle, item: PplRecommendation): PplItemState {
  // 指纹防错套（返工 #2）：指纹不匹配的旧决策不复用 → 视为新待处理。
  const decided = [...bundle.decisions]
    .reverse()
    .find((decision) => decision.recommendationId === item.id
      && decision.fingerprint != null
      && decision.fingerprint === item.fingerprint);
  if (decided) return decided.action === "approve" ? "approved" : "discarded";
  return "pending";
}

function blockLabel(item: PplRecommendation): string {
  if (!item.blocked) return "";
  return item.blockReason === "segment_uncertain"
    ? "无法按客户可靠分段，需人工确认"
    : "金额缺失，补齐后才能同意";
}

export function PplInspectionPanel() {
  const [bundle, setBundle] = useState<PplInspectionBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBundle(await fetchPplInspection());
      setError(null);
    } catch (cause) {
      setError(pplErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await startPplRefresh();
      setFlash("巡检已启动，约 1-2 分钟后刷新查看。");
    } catch (cause) {
      setError(pplErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const decide = useCallback(async (id: string, action: "approve" | "discard") => {
    setBusy(true);
    setConfirming(null);
    try {
      await decidePplRecommendation(id, action);
      setFlash(action === "approve" ? "已记录同意（仅授权，未创建）。" : "已放弃该条推荐。");
      await load();
    } catch (cause) {
      setError(pplErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const inspection = bundle?.inspection;
  const status = pplInspectionStatus(inspection);
  const pending = inspection
    ? inspection.recommendations.filter((item) => itemState(bundle, item) === "pending")
    : [];
  const decided = inspection
    ? inspection.recommendations.filter((item) => itemState(bundle, item) !== "pending")
    : [];

  return (
    <section className="panel ppl-panel">
      <header className="panel__header">
        <div>
          <span className="eyebrow">PPL INSPECTION</span>
          <h2>PPL 巡检</h2>
        </div>
        <span>{inspection ? `${pending.length} 待处理 / ${inspection.summary.total ?? 0} 条` : "未巡检"}</span>
      </header>

      {flash && <p className="ppl-flash">{flash}</p>}
      {error && <p className="crm-banner ppl-error"><CircleAlert size={15} /> {error}</p>}

      {!inspection ? (
        <div className="ppl-empty">
          <FileSearch size={16} />
          <div>
            <p>还没有巡检产物。</p>
            <button className="text-button" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={12} className={busy ? "spin" : undefined} /> 立即巡检（只读）
            </button>
          </div>
        </div>
      ) : status === "failed" ? (
        <>
          <p className="crm-banner ppl-error">
            <CircleAlert size={15} /> 巡检失败{inspection.error ? `（原因：${inspection.error}）` : ""}，本次结果不可用，不会据此生成推荐。
          </p>
          <p className="ppl-meta">
            巡检 {inspection.generatedAt.slice(0, 16).replace("T", " ")} · 状态 失败
            <button className="text-button ppl-refresh" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={12} className={busy ? "spin" : undefined} /> 重新巡检
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="ppl-meta">
            巡检 {inspection.generatedAt.slice(0, 16).replace("T", " ")} · 日报 {inspection.reportCount} 份 · 快照 {inspection.snapshotStale ? "已过期" : "新鲜"}
            {inspection.snapshotStale && inspection.snapshotGeneratedAt ? `（${inspection.snapshotGeneratedAt.slice(0, 10)}）` : ""}
            <button className="text-button ppl-refresh" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={12} className={busy ? "spin" : undefined} /> 重新巡检
            </button>
          </p>

          {pending.length === 0 && decided.length === 0 && (
            <p className="crm-muted">本期日报未发现 PPL 候选。</p>
          )}

          {pending.length > 0 && (
            <ul className="ppl-list">
              {pending.map((item) => {
                const dedupe = DEDUPE_LABEL[item.dedupe.status] ?? DEDUPE_LABEL.suspected!;
                const evidence = dedupeEvidenceText(item.dedupe.evidence);
                return (
                  <li key={item.id} className="ppl-item">
                    <div className="ppl-item__main">
                      <strong>{item.customerName}{item.cid ? ` · CID ${item.cid}` : " · 待补 CID"}</strong>
                      <span className="ppl-item__project">{item.suggestedProjectName}</span>
                      <span className="ppl-item__meta">
                        机会点 {item.opportunityType} · 金额 {formatAmount(item.amountYuan)}
                        {item.blocked ? ` · 阻塞（${blockLabel(item)}）` : ""}
                      </span>
                      <span className="ppl-item__evidence">
                        {dedupe.label}{evidence ? ` · 证据：${evidence}` : ""}
                      </span>
                    </div>
                    <div className="ppl-item__actions">
                      <StatusBadge tone={dedupe.tone}>{dedupe.label}</StatusBadge>
                      <button
                        className="text-button"
                        onClick={() => setConfirming(confirming === item.id ? null : item.id)}
                        disabled={busy || item.blocked}
                        title={item.blocked ? blockLabel(item) : "同意仅授权，不代表已创建"}
                      >
                        同意
                      </button>
                      <button className="text-button" onClick={() => void decide(item.id, "discard")} disabled={busy}>
                        放弃
                      </button>
                    </div>
                    {confirming === item.id && (
                      <div className="ppl-confirm">
                        <p>同意 = 授权创建。提交前 agent 会逐字段复述确认，未确认不会点确定。</p>
                        <p className="ppl-confirm__fields">
                          项目名：{item.suggestedProjectName} · 客户：{item.customerName} · 金额：{formatAmount(item.amountYuan)} · 机会点：{item.opportunityType}
                        </p>
                        <div>
                          <button className="text-button" onClick={() => void decide(item.id, "approve")} disabled={busy}>确认同意</button>
                          <button className="text-button" onClick={() => setConfirming(null)}>取消</button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {decided.length > 0 && (
            <details className="ppl-decided">
              <summary>已处理 {decided.length} 条</summary>
              <ul className="ppl-list">
                {decided.map((item) => {
                  const state = itemState(bundle, item);
                  return (
                    <li key={item.id} className="ppl-item ppl-item--decided">
                      <div className="ppl-item__main">
                        <strong>{item.customerName}</strong>
                        <span className="ppl-item__project">{item.suggestedProjectName}</span>
                      </div>
                      <StatusBadge tone={state === "approved" ? "green" : "muted"}>
                        {state === "approved" ? "已同意（待创建）" : "已放弃"}
                      </StatusBadge>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          <p className="ppl-footnote">
            <CircleCheck size={12} /> 同意仅写入本地授权记录（approvals.json），不会创建 PPL；创建由 agent 会话调用 skill 并逐字段确认后执行。
          </p>
        </>
      )}
    </section>
  );
}
