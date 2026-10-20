import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import "../okr.css";
import { StatusBadge, ViewHeading } from "./shared";
import {
  fetchOkrOverview,
  okrErrorMessage,
  OkrClientError,
  refreshOkrSnapshot,
  runOkrSyncConfirm,
  runOkrSyncDry,
  type OkrDiffItem,
  type OkrEditDraft,
  type OkrObjective,
  type OkrOverview,
} from "../lib/okr-client";

/**
 * OKR 目标（CRD）完整读写视图：周期切换 / 目标树（O→KR→进展，进展时间倒序）/
 * 进展编辑表单（本地暂存）/ dry-run 差异表（逐行勾选，冲突行红色标注）/
 * 两步确认写入（acceptConflicts 需二次输入目标标题）→ 提交后刷新快照。
 *
 * 红线：写远端只有 sync-dry（不落远端）→ sync-confirm（仅勾选键）两步；
 * 冲突项未单独确认时提交按钮不可用；无会话 / 无快照时给诚实引导态
 * （文案指向「个人中心」视图；本视图未接线 ViewId，不做路由跳转）。
 */

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "标题", desc: "描述", weight: "权重", targetValue: "目标值", unit: "单位",
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  pending: "待同步", written: "已写入", already: "CRD 已是该值",
  conflict: "冲突 · 需单独确认", "kr-missing": "KR 已不在 CRD", failed: "失败",
};

const O_FIELDS = ["title", "desc", "weight"] as const;
const KR_FIELDS = ["title", "weight", "targetValue", "unit"] as const;

export interface OkrViewProps {
  /** 可选：由负责人接线到「个人中心」视图（ViewId 未接线前仅渲染文案引导）。 */
  readonly onOpenProfile?: () => void;
}

type Phase = "idle" | "dry" | "confirmed";

function draftKey(draft: Pick<OkrEditDraft, "oId" | "krId" | "field">): string {
  return `${draft.oId}|${draft.krId ?? ""}|${draft.field}`;
}

function currentFieldValue(objective: OkrObjective, krId: string | null, field: string): string {
  if (krId === null) {
    if (field === "title") return objective.title;
    if (field === "desc") return objective.desc;
    if (field === "weight") return objective.weight === null ? "" : String(objective.weight);
    return "";
  }
  const kr = objective.keyResults.find((entry) => entry.id === krId);
  if (!kr) return "";
  if (field === "title") return kr.title;
  if (field === "weight") return kr.weight === null ? "" : String(kr.weight);
  if (field === "targetValue") return kr.indicator?.targetValue ?? "";
  if (field === "unit") return kr.indicator?.unit ?? "";
  return "";
}

function EditFieldForm({ label, initial, onSave, onCancel }: {
  label: string;
  initial: string;
  onSave: (to: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="okr-edit-form"
      onSubmit={(event) => { event.preventDefault(); onSave(value); }}
    >
      <label>
        <span>{label}（原值：{initial || "空"}）</span>
        <input value={value} maxLength={2000} onChange={(event) => setValue(event.target.value)} autoFocus />
      </label>
      <div className="okr-edit-form__actions">
        <button type="submit" disabled={value === initial}>暂存</button>
        <button type="button" className="okr-button-ghost" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

function ProgressList({ objective }: { objective: OkrObjective }) {
  if (objective.progressRecords.length === 0) {
    return <p className="okr-empty-inline">暂无 CRD 进展记录</p>;
  }
  return (
    <ul className="okr-progress-list">
      {objective.progressRecords.map((record, index) => (
        <li key={record.id || `${objective.id}-prog-${index}`}>
          <span className="okr-progress-list__time">{record.createdAt || "时间未知"}</span>
          <span className="okr-progress-list__text">{record.description || "（无正文）"}</span>
          {record.creator ? <span className="okr-progress-list__by">{record.creator}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function OkrView({ onOpenProfile }: OkrViewProps) {
  const [overview, setOverview] = useState<OkrOverview | null>(null);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState<"" | "refresh" | "dry" | "confirm">("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<readonly OkrEditDraft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [dryItems, setDryItems] = useState<readonly OkrDiffItem[]>([]);
  const [dryNote, setDryNote] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [acceptConflicts, setAcceptConflicts] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [confirmResult, setConfirmResult] = useState<{ wrote: number; note: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchOkrOverview();
      setOverview(loaded);
      setLoadError(null);
      setPeriodId(loaded.snapshot?.period?.id ?? "");
    } catch (error) {
      setLoadError({
        code: error instanceof OkrClientError ? error.code : "unavailable",
        message: okrErrorMessage(error),
      });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const snapshot = overview?.snapshot ?? null;

  const stageDraft = useCallback((draft: OkrEditDraft) => {
    // 不可变更新：同键覆盖生成新数组，绝不动旧引用。
    setDrafts((current) => [...current.filter((entry) => draftKey(entry) !== draftKey(draft)), draft]);
    setEditing(null);
    setPhase("idle");
    setDryItems([]);
    setNotice(`已暂存 ${draftKey(draft).split("|")[2]} 编辑（尚未预检，未写远端）`);
  }, []);

  const removeDraft = useCallback((key: string) => {
    setDrafts((current) => current.filter((entry) => draftKey(entry) !== key));
    setPhase("idle");
    setDryItems([]);
  }, []);

  const runRefresh = useCallback(async () => {
    if (busy) return;
    setBusy("refresh");
    setActionError("");
    setNotice("");
    try {
      const summary = await refreshOkrSnapshot();
      setNotice(`快照已刷新（${summary.generatedAt} · ${summary.totals.oCount} O / ${summary.totals.krCount} KR）`);
      await load();
    } catch (error) {
      setActionError(okrErrorMessage(error));
    } finally {
      setBusy("");
    }
  }, [busy, load]);

  const runDry = useCallback(async () => {
    if (busy || drafts.length === 0 || !snapshot) return;
    setBusy("dry");
    setActionError("");
    setNotice("");
    setConfirmResult(null);
    try {
      const result = await runOkrSyncDry(drafts, snapshot.generatedAt);
      setDryItems(result.items);
      setDryNote(result.note);
      setSelected(new Set(result.items.filter((item) => !item.conflict && item.state !== "kr-missing").map((item) => item.key)));
      setAcceptConflicts(false);
      setConfirmTitle("");
      setPhase("dry");
    } catch (error) {
      setActionError(okrErrorMessage(error));
    } finally {
      setBusy("");
    }
  }, [busy, drafts, snapshot]);

  const conflicts = useMemo(() => dryItems.filter((item) => item.conflict), [dryItems]);
  const conflictObjectiveTitle = useMemo(() => {
    const first = conflicts[0];
    if (!first || !snapshot) return "";
    return snapshot.objectives.find((objective) => objective.id === first.oId)?.displayTitle ?? "";
  }, [conflicts, snapshot]);
  const acceptUnlocked = conflicts.length === 0 || confirmTitle.trim() === conflictObjectiveTitle;

  const toggleKey = useCallback((key: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const runConfirm = useCallback(async () => {
    if (busy || selected.size === 0) return;
    setBusy("confirm");
    setActionError("");
    try {
      const result = await runOkrSyncConfirm([...selected], acceptConflicts && conflicts.length > 0);
      setConfirmResult({ wrote: result.wrote, note: result.note });
      setPhase("confirmed");
      // 提交后刷新快照（写入项以 CRD 最新值为准），并清掉已写入的暂存编辑。
      setDrafts((current) => current.filter((entry) => !selected.has(draftKey(entry))));
      setDryItems([]);
      setSelected(new Set());
      await refreshOkrSnapshot().catch(() => undefined);
      await load();
    } catch (error) {
      setActionError(okrErrorMessage(error));
      if (error instanceof OkrClientError && error.code === "okr_conflict") {
        // 桥侧冲突拒绝：把冲突清单回填到差异表状态，保持逐项确认口径。
        setAcceptConflicts(false);
        setConfirmTitle("");
      }
    } finally {
      setBusy("");
    }
  }, [acceptConflicts, busy, conflicts.length, load, selected]);

  if (loadError) {
    const noSession = loadError.code === "profile_no_session";
    return (
      <section className="okr-view view-stack">
        <ViewHeading eyebrow="CRD · 目标管理" title="OKR 目标" description="读取并回写 CRD（crd.aliyun-inc.com）的 O / KR / 进展。" />
        <div className="okr-guide" data-tone={noSession ? "session" : "bridge"}>
          <StatusBadge tone="muted">{noSession ? "未配置会话" : "本地桥未连接"}</StatusBadge>
          <p>{loadError.message}</p>
          {noSession ? (
            <p className="okr-guide__hint">
              在侧栏进入「个人中心」视图，填写工号并粘贴 BUC Cookie 后回到本页重试。
              {onOpenProfile ? (
                <button type="button" className="okr-button" onClick={onOpenProfile}>前往「个人中心」</button>
              ) : null}
            </p>
          ) : null}
          <button type="button" className="okr-button-ghost" onClick={() => void load()} disabled={busy !== ""}>重试</button>
        </div>
      </section>
    );
  }

  if (!overview) {
    return (
      <section className="okr-view view-stack">
        <ViewHeading eyebrow="CRD · 目标管理" title="OKR 目标" description="正在读取本机 OKR 快照…" />
        <p className="okr-loading"><LoaderCircle className="spin" size={14} /> 加载中</p>
      </section>
    );
  }

  if (!overview.hasSnapshot || !snapshot) {
    return (
      <section className="okr-view view-stack">
        <ViewHeading eyebrow="CRD · 目标管理" title="OKR 目标" description="读取并回写 CRD 的 O / KR / 进展。" />
        <div className="okr-guide" data-tone="snapshot">
          <StatusBadge tone="amber">尚无快照</StatusBadge>
          <p>本机还没有 OKR 快照（.local-cache/okr/okr.json）。会话已配置（{overview.session.masked || overview.session.empId}），点击下方按钮从 CRD 拉取一次。</p>
          {notice ? <p className="okr-guide__ok">{notice}</p> : null}
          {actionError ? <p className="okr-guide__error">{actionError}</p> : null}
          <button type="button" className="okr-button" onClick={() => void runRefresh()} disabled={busy !== ""}>
            {busy === "refresh" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} 刷新快照（只读拉取）
          </button>
        </div>
      </section>
    );
  }

  const periods = snapshot.periodsFY.length > 0 ? snapshot.periodsFY : (snapshot.period ? [{ ...snapshot.period }] : []);
  const isCurrentPeriod = periodId === "" || periodId === (snapshot.period?.id ?? "");

  return (
    <section className="okr-view view-stack">
      <ViewHeading
        eyebrow="CRD · 目标管理"
        title="OKR 目标"
        description={`快照 ${snapshot.generatedAt} · ${snapshot.totals.oCount} O / ${snapshot.totals.krCount} KR / ${snapshot.totals.crdProgressCount} 条进展${snapshot.auditLabel ? ` · 审批 ${snapshot.auditLabel}` : ""}`}
        aside={
          <div className="okr-toolbar">
            <label className="okr-period">
              <span>周期</span>
              <select value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
                {periods.map((period) => (
                  <option key={period.id || period.name} value={period.id}>{period.name}（{period.periodType}）</option>
                ))}
              </select>
            </label>
            <button type="button" className="okr-button-ghost" onClick={() => void runRefresh()} disabled={busy !== ""}>
              {busy === "refresh" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} 刷新快照
            </button>
          </div>
        }
      />

      {!isCurrentPeriod ? (
        <p className="okr-note">快照仅包含当期周期（{snapshot.period?.name}）的目标；切换到其他周期请设置 SA_OKR_PERIOD 后重新刷新快照（不伪造数据）。</p>
      ) : null}
      {notice ? <p className="okr-note okr-note--ok">{notice}</p> : null}
      {actionError ? <p className="okr-note okr-note--error">{actionError}</p> : null}

      <div className="okr-tree">
        {snapshot.objectives.map((objective) => (
          <article className="okr-o-card" key={objective.id}>
            <header>
              <strong>{objective.idx}</strong>
              <h3>{objective.displayTitle}</h3>
              <StatusBadge tone="blue">{objective.typeLabel || "未分类"}</StatusBadge>
              {objective.weight !== null ? <span className="okr-meta">权重 {objective.weight}</span> : null}
              {objective.progress !== null ? <span className="okr-meta">进展 {objective.progress}%</span> : null}
            </header>
            {objective.desc ? <p className="okr-o-card__desc">{objective.desc}</p> : null}
            <div className="okr-field-edits">
              {O_FIELDS.map((field) => (
                <span key={field}>
                  {editing === `${objective.id}||${field}` ? (
                    <EditFieldForm
                      label={`O ${FIELD_LABELS[field]}`}
                      initial={currentFieldValue(objective, null, field)}
                      onSave={(to) => stageDraft({ kind: "o", oId: objective.id, krId: null, field, from: currentFieldValue(objective, null, field) || null, to: to || null })}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <button type="button" className="okr-edit-link" onClick={() => setEditing(`${objective.id}||${field}`)}>改{FIELD_LABELS[field]}</button>
                  )}
                </span>
              ))}
            </div>

            <ul className="okr-kr-list">
              {objective.keyResults.map((kr) => (
                <li className="okr-kr-row" key={kr.id}>
                  <div className="okr-kr-row__head">
                    <strong>{kr.idx}</strong>
                    <span className="okr-kr-row__title">{kr.title || "（无标题）"}</span>
                    <StatusBadge tone="muted">{kr.typeLabel}</StatusBadge>
                    {kr.weight !== null ? <span className="okr-meta">权重 {kr.weight}</span> : null}
                    <span className="okr-meta">{kr.targetLabel}</span>
                    {kr.progress !== null ? <span className="okr-meta">{kr.progress}%</span> : null}
                  </div>
                  <div className="okr-field-edits">
                    {KR_FIELDS.map((field) => {
                      const needsIndicator = (field === "targetValue" || field === "unit") && !kr.indicator;
                      return (
                        <span key={field}>
                          {editing === `${objective.id}|${kr.id}|${field}` ? (
                            <EditFieldForm
                              label={`KR ${FIELD_LABELS[field]}`}
                              initial={currentFieldValue(objective, kr.id, field)}
                              onSave={(to) => stageDraft({ kind: "kr", oId: objective.id, krId: kr.id, field, from: currentFieldValue(objective, kr.id, field) || null, to: to || null })}
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              className="okr-edit-link"
                              disabled={needsIndicator}
                              title={needsIndicator ? "该 KR 无数值指标（krNumIndex），请先在 CRD 端创建" : undefined}
                              onClick={() => setEditing(`${objective.id}|${kr.id}|${field}`)}
                            >
                              改{FIELD_LABELS[field]}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </li>
              ))}
              {objective.keyResults.length === 0 ? <li className="okr-empty-inline">该目标暂无 KR</li> : null}
            </ul>

            <details className="okr-progress">
              <summary>CRD 进展（{objective.progressRecords.length} 条 · 时间倒序）</summary>
              <ProgressList objective={objective} />
            </details>
          </article>
        ))}
        {snapshot.objectives.length === 0 ? <p className="okr-note">当期周期没有可见目标（hasValidOkr 可能为否）。</p> : null}
      </div>

      <section className="okr-sync">
        <header className="okr-sync__head">
          <h2>待同步编辑（本地暂存 {drafts.length} 项）</h2>
          <div>
            <button type="button" className="okr-button" onClick={() => void runDry()} disabled={busy !== "" || drafts.length === 0}>
              {busy === "dry" ? <LoaderCircle className="spin" size={13} /> : null} 预检差异（dry-run · 不落远端）
            </button>
          </div>
        </header>
        {drafts.length > 0 ? (
          <ul className="okr-draft-list">
            {drafts.map((draft) => (
              <li key={draftKey(draft)}>
                <code>{draft.kind === "o" ? "O" : "KR"} · {FIELD_LABELS[draft.field] ?? draft.field}</code>
                <span className="okr-draft-list__from">{draft.from ?? "空"}</span>
                <span>→</span>
                <span className="okr-draft-list__to">{draft.to ?? "空"}</span>
                <button type="button" className="okr-edit-link" onClick={() => removeDraft(draftKey(draft))}>移除</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="okr-empty-inline">在上方目标树点「改标题 / 改权重 / 改目标值…」暂存编辑；所有写远端操作都从这里的逐项预检开始。</p>
        )}

        {phase === "dry" || phase === "confirmed" ? (
          <div className="okr-diff">
            <p className="okr-diff__note">{dryNote || "逐项核对差异后勾选写入项；冲突行（红色）默认不勾选。"}</p>
            <table className="okr-diff-table">
              <thead>
                <tr><th>写入</th><th>键</th><th>字段</th><th>原值 → 新值</th><th>CRD 当前</th><th>状态</th></tr>
              </thead>
              <tbody>
                {dryItems.map((item) => (
                  <tr key={item.key} className={item.conflict ? "is-conflict" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(item.key)}
                        onChange={(event) => toggleKey(item.key, event.target.checked)}
                        disabled={phase === "confirmed"}
                      />
                    </td>
                    <td><code>{item.kind === "o" ? "O" : "KR"} {item.oId.slice(-4)}{item.krId ? `·${item.krId.slice(-4)}` : ""}</code></td>
                    <td>{FIELD_LABELS[item.field] ?? item.field}</td>
                    <td><span className="okr-diff-table__before">{item.before ?? "空"}</span> → <span className="okr-diff-table__after">{item.after ?? "空"}</span></td>
                    <td>{item.crd ?? "（无法读取）"}</td>
                    <td><StatusBadge tone={item.conflict || item.state === "failed" ? "amber" : item.state === "written" ? "green" : "muted"}>{STATE_LABELS[item.state] ?? item.state}</StatusBadge>{item.note ? <span className="okr-diff-table__note">{item.note}</span> : null}</td>
                  </tr>
                ))}
                {dryItems.length === 0 ? <tr><td colSpan={6} className="okr-empty-inline">预检没有返回差异项</td></tr> : null}
              </tbody>
            </table>

            {conflicts.length > 0 && phase === "dry" ? (
              <div className="okr-conflict-gate">
                <label className="okr-conflict-gate__title">
                  <span>存在 {conflicts.length} 个冲突项（CRD 已被他人修改）。如仍要覆盖，请输入受影响目标标题以二次确认：</span>
                  <strong>{conflictObjectiveTitle}</strong>
                  <input
                    value={confirmTitle}
                    onChange={(event) => setConfirmTitle(event.target.value)}
                    placeholder="逐字输入上面的目标标题"
                    disabled={busy !== ""}
                  />
                </label>
                <label className="okr-conflict-gate__check">
                  <input
                    type="checkbox"
                    checked={acceptConflicts}
                    disabled={!acceptUnlocked || busy !== ""}
                    onChange={(event) => setAcceptConflicts(event.target.checked)}
                  />
                  我确认以新值覆盖上述冲突项（--accept-conflicts）
                </label>
              </div>
            ) : null}

            {phase === "dry" ? (
              <footer className="okr-sync__actions">
                <button
                  type="button"
                  className="okr-button okr-button--danger"
                  onClick={() => void runConfirm()}
                  disabled={busy !== "" || selected.size === 0 || (conflicts.some((item) => selected.has(item.key)) && !(acceptConflicts && acceptUnlocked))}
                >
                  {busy === "confirm" ? <LoaderCircle className="spin" size={13} /> : null}
                  确认写入 CRD（{selected.size} 项）
                </button>
                <span className="okr-meta">写通道：find → patch → PUT objective/user/update；审计落 .local-cache/okr/audit.jsonl</span>
              </footer>
            ) : null}
            {confirmResult && phase === "confirmed" ? (
              <p className="okr-note okr-note--ok">已写入 {confirmResult.wrote} 项，快照已重新拉取。{confirmResult.note}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  );
}
