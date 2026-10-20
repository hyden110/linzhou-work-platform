import { useCallback, useEffect, useState } from "react";
import { AlertCircle, FileUp, LoaderCircle, RefreshCw, ShieldCheck, Table2 } from "lucide-react";

import {
  custorgImportConfirm,
  custorgImportDry,
  fetchWechatCustorg,
  wechatErrorMessage,
  type WechatCustorgConfirmedView,
  type WechatCustorgDryView,
  type WechatCustorgLedgerEntryView,
  type WechatCustorgLedgerView,
} from "../../lib/wechat-client";

/**
 * 客户组织表导入面板（dry → confirm 两步）+ 本地台账只读回显。
 *
 * 导入：粘贴 JSON / CSV / TSV 文本，第一步只回 diff 摘要与一次性 token（桥侧绝不落盘），
 * 第二步 confirm 严格 === token 才真实写入本地客户组织台账（0600 + 备份 + 审计）。
 * 文本只在本组件 state 内，不回显到审计、不进日志。
 *
 * 回显：GET /local/wechat/custorg 把已导入的台账读回来（挂载即拉、确认后即刷、可手动刷新），
 * 保证导入不是"只写不看"的死数据；台账为空时如实说明为空，绝不编造样例行。
 */
export function CustorgImportPanel({ onImported }: { readonly onImported: () => void }) {
  const [text, setText] = useState("");
  const [dry, setDry] = useState<WechatCustorgDryView | null>(null);
  const [done, setDone] = useState<WechatCustorgConfirmedView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "dry" | "confirm">("");
  const [ledger, setLedger] = useState<WechatCustorgLedgerView | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const loadLedger = useCallback(() => {
    setLedgerBusy(true);
    fetchWechatCustorg()
      .then((view) => { setLedger(view); setLedgerError(""); })
      .catch((cause: unknown) => { setLedger(null); setLedgerError(wechatErrorMessage(cause)); })
      .finally(() => setLedgerBusy(false));
  }, []);

  useEffect(loadLedger, [loadLedger]);

  const runDry = useCallback(() => {
    setBusy("dry");
    setError("");
    setDone(null);
    custorgImportDry(text)
      .then((view) => { setDry(view); })
      .catch((cause: unknown) => { setDry(null); setError(wechatErrorMessage(cause)); })
      .finally(() => setBusy(""));
  }, [text]);

  const runConfirm = useCallback(() => {
    if (dry === null) return;
    setBusy("confirm");
    setError("");
    custorgImportConfirm({ text, token: dry.token })
      .then((view) => {
        setDone(view);
        setDry(null);
        loadLedger(); // 写完立刻读回：台账所见即所存
        onImported();
      })
      .catch((cause: unknown) => setError(wechatErrorMessage(cause)))
      .finally(() => setBusy(""));
  }, [dry, text, onImported, loadLedger]);

  const reset = useCallback(() => {
    setText("");
    setDry(null);
    setDone(null);
    setError("");
  }, []);

  return (
    <div className="wechat-import">
      <h2 className="wechat-section">
        客户组织表导入
        <span className="wechat-dim">dry-run 出 diff → 确认才写本地台账（文本不出桥外、不进审计）</span>
      </h2>
      <textarea
        className="wechat-import__text"
        value={text}
        onChange={(event) => { setText(event.target.value); setDry(null); setDone(null); }}
        placeholder={'粘贴客户组织表（JSON 或 CSV/TSV）：每行一个联系人，表头含 客户 / 部门 / 姓名 / 职位（职务、职称同义）/ 联系方式（电话、手机、邮箱同义）…'}
        aria-label="客户组织表导入文本"
        rows={6}
      />
      <div className="wechat-import__actions">
        <button type="button" className="wechat-chip" onClick={runDry} disabled={busy !== "" || text.trim() === ""}>
          {busy === "dry" ? <LoaderCircle size={13} className="wechat-spin" /> : <FileUp size={13} />}解析（dry-run）
        </button>
        {dry !== null && (
          <button type="button" className="wechat-chip wechat-chip--danger" onClick={runConfirm} disabled={busy !== ""}>
            {busy === "confirm" ? <LoaderCircle size={13} className="wechat-spin" /> : <ShieldCheck size={13} />}确认导入（{dry.customerCount} 客户 / {dry.rowCount} 行）
          </button>
        )}
        {(dry !== null || done !== null || text !== "") && (
          <button type="button" className="wechat-chip" onClick={reset} disabled={busy !== ""}>清空</button>
        )}
      </div>

      {error !== "" && <p className="wechat-error"><AlertCircle size={14} />{error}</p>}

      {dry !== null && (
        <div className="wechat-import__diff">
          <p className="wechat-dim">{dry.note || `解析出 ${dry.customerCount} 个客户 / ${dry.rowCount} 行；token ${dry.token} 单次消费。`}</p>
          {dry.willImport.length > 0 && (
            <ul className="wechat-import__list">
              {dry.willImport.map((row) => (
                <li key={`import-${row.key}`}>
                  <span className="wechat-pill wechat-pill--green">新增</span>
                  <b>{row.key}</b>
                  <span className="wechat-dim">{row.incomingRows} 行</span>
                </li>
              ))}
            </ul>
          )}
          {dry.willOverwrite.length > 0 && (
            <ul className="wechat-import__list">
              {dry.willOverwrite.map((row) => (
                <li key={`overwrite-${row.key}`}>
                  <span className="wechat-pill wechat-pill--muted">覆盖</span>
                  <b>{row.key}</b>
                  <span className="wechat-dim">{row.existingRows} → {row.incomingRows} 行</span>
                </li>
              ))}
            </ul>
          )}
          {dry.willImport.length === 0 && dry.willOverwrite.length === 0 && (
            <p className="wechat-empty">解析成功但没有新增或覆盖的客户行。</p>
          )}
        </div>
      )}

      {done !== null && (
        <p className="wechat-import__done">
          <ShieldCheck size={14} />
          已导入 {done.customerCount} 客户 / {done.rowCount} 行；台账合计 {done.totalCustomers} 客户 / {done.totalRows} 行（{done.updatedAt}）。
        </p>
      )}

      <CustorgLedger ledger={ledger} error={ledgerError} busy={ledgerBusy} onRefresh={loadLedger} />
    </div>
  );
}

/** 台账只读回显（纯渲染）：空台账 / 读失败都给诚实文案，不显示假行。 */
function CustorgLedger({
  ledger,
  error,
  busy,
  onRefresh,
}: {
  readonly ledger: WechatCustorgLedgerView | null;
  readonly error: string;
  readonly busy: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="wechat-custorg">
      <h3 className="wechat-custorg__head">
        <Table2 size={14} />
        本地客户组织台账
        <span className="wechat-dim">.local-cache/wechat/custorg.json 只读回显 · 联系人明文仅本机可见</span>
        <button type="button" className="wechat-refresh wechat-custorg__refresh" onClick={onRefresh} disabled={busy}>
          {busy ? <LoaderCircle size={12} className="wechat-spin" /> : <RefreshCw size={12} />}刷新
        </button>
      </h3>

      {error !== "" && <p className="wechat-error"><AlertCircle size={14} />{error}</p>}

      {ledger !== null && error === "" && (
        ledger.customers.length === 0 ? (
          <p className="wechat-empty">台账还是空的：粘贴客户组织表并确认后，这里会列出每个客户与其联系人行。</p>
        ) : (
          <>
            <p className="wechat-dim">
              合计 {ledger.totalCustomers} 客户 / {ledger.totalRows} 行
              {ledger.updatedAt === "" ? "" : ` · 更新于 ${ledger.updatedAt}`}
            </p>
            <ul className="wechat-custorg__list">
              {ledger.customers.map((customer) => (
                <CustorgCustomer key={customer.key} customer={customer} />
              ))}
            </ul>
          </>
        )
      )}
    </div>
  );
}

function CustorgCustomer({ customer }: { readonly customer: WechatCustorgLedgerEntryView }) {
  return (
    <li className="wechat-custorg__item">
      <div className="wechat-custorg__title">
        <b>{customer.name}</b>
        <span className="wechat-pill wechat-pill--muted">{customer.rowCount} 行</span>
        {customer.name !== customer.key && <code>{customer.key}</code>}
      </div>
      <table className="wechat-custorg__table">
        <thead>
          <tr><th>部门</th><th>姓名</th><th>职务</th><th>联系方式</th></tr>
        </thead>
        <tbody>
          {customer.rows.map((row, index) => (
            <tr key={`${customer.key}-${index}`}>
              <td>{row.dept || "—"}</td>
              <td>{row.name || "—"}</td>
              <td>{row.title || "—"}</td>
              <td>{row.contact || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}
