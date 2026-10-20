import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  EyeOff,
  History,
  KeyRound,
  ListChecks,
  LoaderCircle,
  PlugZap,
  Save,
  Ticket,
  Trash2,
  X,
} from "lucide-react";
import {
  agentloopErrorMessage,
  confirmAgentloopTicket,
  deleteAgentloopCreds,
  dryAgentloopTicket,
  fetchAgentloopCreds,
  fetchAgentloopTickets,
  saveAgentloopCreds,
  testAgentloopConnection,
  type AgentloopCredsSnapshot,
  type AgentloopTestSnapshot,
  type AgentloopTicketAuditRow,
  type AgentloopTicketConfirmSnapshot,
  type AgentloopTicketDrySnapshot,
} from "../../lib/agentloop-client";
import "../../agents.css";

/**
 * AgentLoop 凭据管理 + 连接测试 + 两步出票面板（F7 扩展，唯一写入口）。
 * 红线（与 dev/agentloop 桥契约一致）：
 * - 凭据只写不回显：粘贴框 type=password 不回显、保存后立即清空，页面任何位置只出现掩码；
 * - 连接测试只读探活，诚实三态：未设置 / 有效 / 异常 + 原因，绝不假绿；
 * - 出票是外部写：dry 预检（零网络）→ 确认弹窗逐条勾选 → confirm 严格带 token 下发；
 *   票据明文不回显（只有掩码 + 有效期），每次真实尝试都进本机 append-only 审计。
 */

const TEST_STATE_LABEL: Record<AgentloopTestSnapshot["state"], string> = {
  unset: "未设置",
  ok: "有效",
  error: "异常",
};

/** 确认弹窗勾选项（逐条人工确认，全勾才允许真实出票）。 */
function confirmChecks(dry: AgentloopTicketDrySnapshot): readonly string[] {
  return [
    `这是外部写操作：将向 SLS ${dry.request.region}（${dry.request.host}）的 ${dry.request.resource} 真实出票，票据有效 ${Math.round(dry.request.ttlSec / 3600)} 小时（账号内票据配额有限，可能驱逐旧票）。`,
    `将使用当前已配置凭据（掩码 ${dry.credsMask}）以 ${dry.request.signatureMethod.toUpperCase()} 经典签名提交，签名值仅在提交瞬间计算，不落盘、不回显。`,
    "票据明文不会回显到页面：结果只有掩码与有效期，且本次出票（无论成败）都会记入本机 append-only 审计。",
  ];
}

function CredsSection({
  creds,
  onChanged,
  onError,
}: {
  creds: AgentloopCredsSnapshot | null;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [working, setWorking] = useState(false);

  /* 粘贴框不回显：type=password + 保存/删除后立即清空（凭据值不停留在 DOM）。 */
  const save = () => {
    setWorking(true);
    saveAgentloopCreds({ accessKeyId, accessKeySecret })
      .then(() => { setAccessKeyId(""); setAccessKeySecret(""); setDeleteArmed(false); onChanged(); })
      .catch(onError)
      .finally(() => setWorking(false));
  };
  const remove = () => {
    setWorking(true);
    deleteAgentloopCreds()
      .then(() => { setAccessKeyId(""); setAccessKeySecret(""); setDeleteArmed(false); onChanged(); })
      .catch(onError)
      .finally(() => setWorking(false));
  };

  return (
    <div className="al-creds">
      <div className="al-creds__state" data-set={creds?.set ? "yes" : "no"}>
        <KeyRound size={14} />
        {creds?.set ? (
          <span>已设置 · AK 掩码 <code>{creds.mask ?? "—"}</code> · 更新于 {creds.updatedAt ?? "—"}</span>
        ) : (
          <span>未设置：尚未保存 AgentLoop 上报账号的阿里云 AccessKey。</span>
        )}
      </div>
      <div className="al-creds__form">
        <label className="al-field">
          <span>AccessKey ID</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="粘贴后不回显（10–64 位字母数字）"
            value={accessKeyId}
            onChange={(event) => setAccessKeyId(event.target.value)}
          />
        </label>
        <label className="al-field">
          <span>AccessKey Secret</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="粘贴后不回显（24–64 位字母数字）"
            value={accessKeySecret}
            onChange={(event) => setAccessKeySecret(event.target.value)}
          />
        </label>
        <div className="al-creds__actions">
          <button className="primary-button" onClick={save} disabled={working || !accessKeyId || !accessKeySecret}>
            {working ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}保存凭据
          </button>
          {creds?.set && !deleteArmed && (
            <button className="text-button al-danger-text" onClick={() => setDeleteArmed(true)} disabled={working}>
              <Trash2 size={13} />删除
            </button>
          )}
          {creds?.set && deleteArmed && (
            <button className="text-button al-danger-text" onClick={remove} disabled={working}>
              <Trash2 size={13} />确认删除（0600 存储文件将被移除）
            </button>
          )}
        </div>
      </div>
      <p className="al-note"><EyeOff size={12} /> 只写不回显：保存落本机 0600 文件（目录 0700），任何接口与日志都只出掩码。</p>
    </div>
  );
}

function TestSection({
  result,
  busy,
  credsSet,
  onRun,
}: {
  result: AgentloopTestSnapshot | null;
  busy: boolean;
  credsSet: boolean;
  onRun: () => void;
}) {
  const state = result?.state ?? null;
  return (
    <div className="al-test">
      <div className="al-test__head">
        <button className="primary-button" onClick={onRun} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={13} /> : <PlugZap size={13} />}测试连接
        </button>
        {state && (
          <span className="al-badge" data-state={state}>
            {state === "ok" && <CheckCircle2 size={12} />}
            {state === "error" && <AlertCircle size={12} />}
            {TEST_STATE_LABEL[state]}
          </span>
        )}
        {!state && !credsSet && <span className="al-badge" data-state="unset">未设置</span>}
        {result && <span className="al-test__time">探测于 {result.checkedAt || "—"}</span>}
      </div>
      {result && result.note && <p className="al-note">{result.note}</p>}
      {result && result.targets.length > 0 && (
        <ul className="al-targets">
          {result.targets.map((target) => (
            <li key={target.id} data-ok={target.ok ? "yes" : "no"}>
              <strong>{target.t}</strong>
              <span>{target.note}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="al-note al-note--dim">只读探活：仅对配置视图执行 SLS listLogstores（GET），绝不改云端状态、绝不出票。</p>
    </div>
  );
}

function ConfirmDialog({
  dry,
  busy,
  onConfirm,
  onCancel,
}: {
  dry: AgentloopTicketDrySnapshot;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [checks, setChecks] = useState<readonly boolean[]>(() => confirmChecks(dry).map(() => false));
  const allChecked = checks.every(Boolean);
  const items = confirmChecks(dry);
  return (
    <div className="al-dialog-overlay" onClick={onCancel}>
      <div className="al-dialog" role="dialog" aria-modal="true" aria-label="出票确认" onClick={(event) => event.stopPropagation()}>
        <div className="al-dialog__head">
          <Ticket size={15} />
          <strong>确认真实出票（外部写）</strong>
          <button className="text-button" onClick={onCancel} aria-label="关闭"><X size={14} /></button>
        </div>
        <dl className="al-summary">
          <div><dt>请求</dt><dd>{dry.request.method} https://{dry.request.host}{dry.request.resource}</dd></div>
          <div><dt>签名</dt><dd>{dry.request.signatureMethod} · apiversion {dry.request.apiVersion} · {dry.request.authorizationPreview}</dd></div>
          <div><dt>凭据</dt><dd>掩码 {dry.credsMask}（明文不出桥）</dd></div>
          <div><dt>预检有效期</dt><dd>{dry.expiresAt}（一次性 token，过期需重新预检）</dd></div>
        </dl>
        <ul className="al-checks">
          {items.map((item, index) => (
            <li key={item.slice(0, 12)}>
              <label>
                <input
                  type="checkbox"
                  checked={checks[index] === true}
                  onChange={(event) => setChecks(checks.map((value, i) => (i === index ? event.target.checked : value)))}
                />
                <span>{item}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="al-dialog__actions">
          <button className="primary-button" onClick={onConfirm} disabled={busy || !allChecked}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <ListChecks size={13} />}
            {allChecked ? "确认出票（真实下发）" : "逐条勾选后才可确认"}
          </button>
          <button className="text-button" onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
}

export function AgentloopOpsPanel() {
  const [creds, setCreds] = useState<AgentloopCredsSnapshot | null>(null);
  const [test, setTest] = useState<AgentloopTestSnapshot | null>(null);
  const [dry, setDry] = useState<AgentloopTicketDrySnapshot | null>(null);
  const [outcome, setOutcome] = useState<AgentloopTicketConfirmSnapshot | null>(null);
  const [audits, setAudits] = useState<{ rows: readonly AgentloopTicketAuditRow[]; total: number }>({ rows: [], total: 0 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"" | "creds" | "test" | "dry" | "confirm">("");

  const loadCreds = useCallback(() => {
    fetchAgentloopCreds().then(setCreds).catch(setError);
  }, []);
  const loadAudits = useCallback(() => {
    fetchAgentloopTickets()
      .then((view) => setAudits({ rows: view.tickets, total: view.total }))
      .catch(setError);
  }, []);

  useEffect(() => { loadCreds(); loadAudits(); }, [loadCreds, loadAudits]);

  const run = (kind: "creds" | "test" | "dry" | "confirm", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    action()
      .catch(setError)
      .finally(() => setBusy(""));
  };

  const onTest = () => run("test", async () => { setTest(await testAgentloopConnection()); });
  const onDry = () => run("dry", async () => { setOutcome(null); setDry(await dryAgentloopTicket()); });
  const onConfirm = () => {
    if (!dry) return;
    run("confirm", async () => {
      setOutcome(await confirmAgentloopTicket(dry.token));
      setDry(null);
      loadAudits();
    });
  };

  return (
    <section className="panel agents-panel al-ops" aria-label="AgentLoop 凭据与出票">
      <div className="panel__header">
        <div>
          <span className="eyebrow">AGENTLOOP / CREDS &amp; TICKETING</span>
          <h2>凭据与出票</h2>
        </div>
        <button className="text-button" onClick={() => { loadCreds(); loadAudits(); }} disabled={busy !== ""}>
          <LoaderCircle size={14} className={busy !== "" ? "spin" : undefined} />刷新
        </button>
      </div>
      {error !== null && (
        <div className="answer-warning"><AlertCircle size={15} /> {agentloopErrorMessage(error)}</div>
      )}
      <CredsSection
        creds={creds}
        onChanged={() => { setTest(null); setDry(null); loadCreds(); }}
        onError={setError}
      />
      <TestSection
        result={test}
        busy={busy === "test"}
        credsSet={creds?.set === true}
        onRun={onTest}
      />
      <div className="al-ticket">
        <div className="al-test__head">
          <button className="primary-button" onClick={onDry} disabled={busy !== "" || creds?.set !== true}>
            {busy === "dry" ? <LoaderCircle className="spin" size={13} /> : <Ticket size={13} />}出票预检
          </button>
          {creds?.set !== true && <span className="al-note al-note--inline">保存凭据后才能预检出票。</span>}
        </div>
        {outcome && (
          <div className="al-outcome" data-audited={outcome.audited ? "yes" : "no"}>
            <CheckCircle2 size={14} />
            <span>
              出票成功 · 票据掩码 <code>{outcome.ticketMask}</code> · 有效至 {outcome.expireAt}（{outcome.region}）
              {outcome.audited ? " · 已记审计" : " · 审计写入失败（如实标注）"}
            </span>
          </div>
        )}
      </div>
      {dry && (
        <ConfirmDialog dry={dry} busy={busy === "confirm"} onConfirm={onConfirm} onCancel={() => setDry(null)} />
      )}
      <details className="al-audit">
        <summary><History size={13} /> 出票审计（尾 {audits.rows.length} / 共 {audits.total}，append-only，票据只落掩码）</summary>
        {audits.rows.length === 0 ? (
          <p className="al-note al-note--dim">尚无出票记录。</p>
        ) : (
          <ul className="al-audit__rows">
            {audits.rows.map((row, index) => (
              <li key={`${row.at}-${index}`} data-status={row.status}>
                <span className="al-audit__at">{row.at}</span>
                <span className="al-badge" data-state={row.status === "ok" ? "ok" : "error"}>
                  {row.status === "ok" ? "成功" : "失败"}
                </span>
                <code>{row.ticketMask || "—"}</code>
                {row.ttl > 0 && <span className="al-note--dim">ttl {row.ttl}s</span>}
                {row.reason && <span className="al-audit__reason">{row.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
