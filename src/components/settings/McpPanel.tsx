import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  History,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Network,
  PlugZap,
  Plus,
  Save,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  checkMcpConnectors,
  confirmMcpConnector,
  createMcpKey,
  dryMcpConnector,
  fetchMcpConnectors,
  fetchMcpKeys,
  fetchMcpService,
  mcpErrorMessage,
  McpClientError,
  revokeMcpKey,
  toggleMcpService,
} from "../../lib/mcp-client";
import {
  auditActionLabel,
  checkStatusMeta,
  connectorHeadline,
  connectorOpLabel,
  keyStatusOf,
  MCP_SCOPE_OPTIONS,
  prettyJsonOrNull,
  serviceHeadline,
  transportLabel,
  type McpConfirmSnapshot,
  type McpConnectorItem,
  type McpConnectorOpName,
  type McpConnectorsSnapshot,
  type McpDrySnapshot,
  type McpKeyCreatedSnapshot,
  type McpKeysSnapshot,
  type McpScopeName,
  type McpServiceSnapshot,
  type McpCheckSnapshot,
  type McpTone,
} from "../../lib/mcp-model";
import "../../mcp.css";

/**
 * MCP 服务面板 — 只读工具封装 + API KEY 管理 + 连接器发现/体检/dry→confirm 写。
 * 红线（与 dev/mcp 桥契约一致）：
 * - key 明文只在创建应答出现一次：密码框展示 + 一键复制 + 「我已保存」立即从 DOM 清除；
 *   页面任何位置只出现 sha256 前 8 位掩码，绝无全 hash；
 * - 服务默认关；开关必须先勾选知情确认（confirm 严格布尔 true）；
 * - 连接器写一律 dry→confirm 两步：弹窗展示目标文件 + 掩码 diff + 逐条勾选，
 *   confirm 严格带一次性 token；体检/写入的桥侧单飞锁冲突（mcp_busy）如实提示；
 * - 无轮询：只在挂载与用户动作后刷新。
 */

type BusyKind = "" | "load" | "toggle" | "create" | "revoke" | "check" | "dry" | "confirm";

function ToneBadge({ tone, children }: { tone: McpTone; children: React.ReactNode }) {
  return <span className="mcp-badge" data-tone={tone}>{children}</span>;
}

/** 明文 key 一次性展示：password 输入框（可揭示）+ 复制 + 「我已保存」清除。 */
function OneTimeKey({ created, onDone }: { created: McpKeyCreatedSnapshot; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(created.key).then(() => setCopied(true)).catch(() => setCopied(false));
  };
  return (
    <div className="mcp-onetime" role="alert">
      <div className="mcp-onetime__head">
        <KeyRound size={14} />
        <strong>key 已创建：明文只显示这一次</strong>
      </div>
      <p className="mcp-note">{created.note || "请立即复制保存；关闭后页面任何地方都不会再出现明文，遗失只能吊销重发。"}</p>
      <div className="mcp-onetime__row">
        <input
          type={shown ? "text" : "password"}
          readOnly
          value={created.key}
          aria-label="一次性明文 key"
          onFocus={(event) => event.target.select()}
        />
        <button className="text-button" onClick={() => setShown(!shown)} aria-label={shown ? "隐藏明文" : "揭示明文"}>
          {shown ? <EyeOff size={13} /> : <Eye size={13} />}{shown ? "隐藏" : "揭示"}
        </button>
        <button className="text-button" onClick={copy}>
          <Copy size={13} />{copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="mcp-onetime__meta">
        <span>掩码 <code>{created.record.hashPrefix}</code> · scope {created.record.scopes.join("/") || "—"}</span>
        <button className="primary-button" onClick={onDone}>
          <CheckCircle2 size={13} />我已保存，清除明文
        </button>
      </div>
    </div>
  );
}

/** dry→confirm 弹窗：目标文件 + 掩码 diff + 逐条勾选后才允许真实写入。 */
function dryChecks(dry: McpDrySnapshot): readonly string[] {
  return [
    `这是配置写操作：目标文件 ${dry.target.shown}（来源 ${dry.role} · 键路径 ${dry.target.dot}）。写入前自动备份 .bak（0600），写入失败原文不动，回读校验失败自动从备份回滚。`,
    `本次操作为「${connectorOpLabel(dry.op)}：${dry.name}」（${dry.existed ? "目标已存在" : "新增项"}）。下方 diff 为掩码摘要：凭据值一律 ***，真值只落配置文件本身、绝不回显。`,
    `一次性 token 于 ${dry.expiresAt || "—"} 过期：confirm 提交后不可重放，取消或过期需重新 dry-run。`,
  ];
}

function DryDialog({
  dry,
  busy,
  onConfirm,
  onCancel,
}: {
  dry: McpDrySnapshot;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const items = dryChecks(dry);
  const [checks, setChecks] = useState<readonly boolean[]>(() => items.map(() => false));
  const allChecked = checks.every(Boolean);
  return (
    <div className="mcp-dialog-overlay" onClick={onCancel}>
      <div className="mcp-dialog" role="dialog" aria-modal="true" aria-label="连接器写入确认" onClick={(event) => event.stopPropagation()}>
        <div className="mcp-dialog__head">
          <Save size={15} />
          <strong>确认写入连接器配置（{connectorOpLabel(dry.op)}：{dry.name}）</strong>
          <button className="text-button" onClick={onCancel} aria-label="关闭" disabled={busy}><X size={14} /></button>
        </div>
        <dl className="mcp-summary">
          <div><dt>目标文件</dt><dd><code>{dry.target.shown}</code>（{dry.target.dot}）</dd></div>
          <div><dt>来源</dt><dd>{dry.role}</dd></div>
          <div><dt>token 有效期</dt><dd>{dry.expiresAt || "—"}</dd></div>
        </dl>
        <div className="mcp-diff">
          <div>
            <span className="mcp-diff__label">变更前（掩码）</span>
            <pre>{prettyJsonOrNull(dry.diff.before) ?? "（无：新增项）"}</pre>
          </div>
          <div>
            <span className="mcp-diff__label">变更后（掩码）</span>
            <pre>{prettyJsonOrNull(dry.diff.after) ?? "（无：移除项）"}</pre>
          </div>
        </div>
        <ul className="mcp-checks">
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
        <div className="mcp-dialog__actions">
          <button className="primary-button" onClick={onConfirm} disabled={busy || !allChecked}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <ListChecks size={13} />}
            {allChecked ? "确认写入（备份 + 原子写）" : "逐条勾选后才可确认"}
          </button>
          <button className="text-button" onClick={onCancel} disabled={busy}>取消（不写入）</button>
        </div>
      </div>
    </div>
  );
}

/** 新增连接器表单：只拼白名单字段；env/headers JSON 解析失败如实报错、不发请求。 */
function AddConnectorForm({
  connectors,
  busy,
  onDry,
}: {
  connectors: McpConnectorsSnapshot | null;
  busy: boolean;
  onDry: (input: { op: McpConnectorOpName; role: string; name: string; def?: Record<string, unknown> }, parseError?: string) => void;
}) {
  const writable = (connectors?.sources ?? []).filter((s) => s.writable);
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const effectiveRole = role || writable[0]?.role || "";

  const submit = () => {
    const def: Record<string, unknown> = {};
    if (command.trim()) def.command = command.trim();
    const argList = args.split(/\s+/).filter(Boolean);
    if (argList.length) def.args = argList;
    if (url.trim()) def.url = url.trim();
    if (envText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(envText);
      } catch {
        onDry({ op: "set", role: effectiveRole, name: name.trim() }, "env/headers 必须是合法 JSON 对象（例：{\"SYNTH_TOKEN\":\"…\"}）——本次未发任何请求。");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        onDry({ op: "set", role: effectiveRole, name: name.trim() }, "env/headers 必须是 JSON 对象（键值都是字符串）——本次未发任何请求。");
        return;
      }
      def.env = parsed as Record<string, unknown>;
    }
    onDry({ op: "set", role: effectiveRole, name: name.trim(), def });
  };

  if (!writable.length) {
    return <p className="mcp-note mcp-note--dim">当前没有可写来源：宿主配置默认只读（需桥侧显式 hostWrite 才开放）。</p>;
  }
  return (
    <div className="mcp-add">
      <div className="mcp-add__row">
        <label className="mcp-field">
          <span>来源</span>
          <select value={effectiveRole} onChange={(event) => setRole(event.target.value)}>
            {writable.map((s) => <option key={s.role} value={s.role}>{s.label}（{s.shown}）</option>)}
          </select>
        </label>
        <label className="mcp-field">
          <span>连接器名</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="1–80 字符，不含引号" />
        </label>
      </div>
      <div className="mcp-add__row">
        <label className="mcp-field">
          <span>command（stdio）</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="~/bin/node 或绝对路径" />
        </label>
        <label className="mcp-field">
          <span>args（空格分隔）</span>
          <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="server.js --port 0" />
        </label>
      </div>
      <div className="mcp-add__row">
        <label className="mcp-field">
          <span>url（HTTP/SSE）</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…（与 command 二选一）" />
        </label>
        <label className="mcp-field">
          <span>env（JSON，可空）</span>
          <input value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder='{"SYNTH_TOKEN":"…"}' />
        </label>
      </div>
      <button className="primary-button" onClick={submit} disabled={busy || !name.trim() || (!command.trim() && !url.trim())}>
        {busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}dry-run 预检（不写入）
      </button>
    </div>
  );
}

export function McpPanel() {
  const [service, setService] = useState<McpServiceSnapshot | null>(null);
  const [keys, setKeys] = useState<McpKeysSnapshot | null>(null);
  const [connectors, setConnectors] = useState<McpConnectorsSnapshot | null>(null);
  const [checkView, setCheckView] = useState<McpCheckSnapshot | null>(null);
  const [created, setCreated] = useState<McpKeyCreatedSnapshot | null>(null);
  const [dry, setDry] = useState<McpDrySnapshot | null>(null);
  const [confirmed, setConfirmed] = useState<McpConfirmSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<BusyKind>("");
  /* 服务开关知情确认（confirm 严格布尔 true 的前置闸门）。 */
  const [toggleAck, setToggleAck] = useState(false);
  /* key 创建表单。 */
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<readonly McpScopeName[]>([]);
  const [keyNote, setKeyNote] = useState("");
  /* 吊销武装态：id → 二次点击才真发。 */
  const [armedRevoke, setArmedRevoke] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    const [svc, ks, conn] = await Promise.all([fetchMcpService(), fetchMcpKeys(), fetchMcpConnectors()]);
    setService(svc);
    setKeys(ks);
    setConnectors(conn);
  }, []);

  useEffect(() => {
    setBusy("load");
    loadAll().catch(setError).finally(() => setBusy(""));
  }, [loadAll]);

  const run = (kind: BusyKind, action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    action().catch(setError).finally(() => setBusy(""));
  };

  const onToggle = () => {
    if (!service || !toggleAck) return;
    const op = service.enabled ? "disable" : "enable";
    run("toggle", async () => {
      await toggleMcpService({ op, confirm: true });
      setToggleAck(false);
      setService(await fetchMcpService());
    });
  };

  const onCreateKey = () => run("create", async () => {
    const out = await createMcpKey({
      name: keyName.trim(),
      ...(keyScopes.length ? { scope: keyScopes } : {}),
      ...(keyNote.trim() ? { note: keyNote.trim() } : {}),
    });
    setCreated(out);
    setKeyName("");
    setKeyScopes([]);
    setKeyNote("");
    setKeys(await fetchMcpKeys());
    setService(await fetchMcpService());
  });

  const onRevoke = (id: number) => run("revoke", async () => {
    await revokeMcpKey({ keyId: id, confirm: String(id) });
    setArmedRevoke(null);
    setKeys(await fetchMcpKeys());
    setService(await fetchMcpService());
  });

  const onCheck = (name?: string) => run("check", async () => {
    setCheckView(await checkMcpConnectors(name ? { name } : {}));
    setService(await fetchMcpService());
  });

  const onDry = (input: { op: McpConnectorOpName; role: string; name: string; def?: Record<string, unknown> }, parseError?: string) => {
    if (parseError) {
      setError(new McpClientError("mcp_invalid_request", parseError));
      return;
    }
    run("dry", async () => {
      setConfirmed(null);
      setDry(await dryMcpConnector(input));
    });
  };

  const onConfirmWrite = () => {
    if (!dry) return;
    run("confirm", async () => {
      setConfirmed(await confirmMcpConnector({ confirm: dry.token }));
      setDry(null);
      setConnectors(await fetchMcpConnectors());
      setService(await fetchMcpService());
    });
  };

  /** 行内写操作的可写来源：优先该连接器已注册的、且 writable 的来源。 */
  const writableRoleFor = (conn: McpConnectorItem): string | null => {
    const sources = connectors?.sources ?? [];
    const hit = sources.find((s) => s.writable && conn.sources.includes(s.role));
    return hit?.role ?? null;
  };

  const statusOf = (name: string) => checkView?.results.find((r) => r.name === name) ?? null;

  return (
    <section className="panel mcp-panel" aria-label="MCP 服务与连接器">
      <div className="panel__header">
        <div>
          <span className="eyebrow">MCP / SERVICE &amp; CONNECTORS</span>
          <h2>MCP 服务与连接器</h2>
        </div>
        <button className="text-button" onClick={() => run("load", loadAll)} disabled={busy !== ""}>
          <LoaderCircle size={14} className={busy !== "" ? "spin" : undefined} />刷新
        </button>
      </div>

      {error !== null && (
        <div className="answer-warning"><AlertCircle size={15} /> {mcpErrorMessage(error)}</div>
      )}

      {/* ---- 服务状态 + 开关（默认关；confirm 严格布尔 true） ---- */}
      <div className="mcp-service">
        <div className="mcp-service__head">
          <Settings size={15} />
          <ToneBadge tone={service?.enabled ? "mint" : "dim"}>{service?.enabled ? "已开启" : "已关闭（默认）"}</ToneBadge>
          {service && <span className="mcp-note mcp-note--inline">{serviceHeadline(service)}</span>}
          <span className="mcp-note mcp-note--dim mcp-note--inline">JSON-RPC 入口未挂端口（本批只读封装）</span>
        </div>
        {service && service.toolNames.length > 0 && (
          <div className="mcp-chips">
            {service.toolNames.map((name) => <code key={name} className="mcp-chip">{name}</code>)}
          </div>
        )}
        <div className="mcp-service__toggle">
          <label className="mcp-check">
            <input type="checkbox" checked={toggleAck} onChange={(event) => setToggleAck(event.target.checked)} disabled={busy !== ""} />
            <span>
              我确认要{service?.enabled ? "关闭" : "开启"}本机 MCP 服务
              {service?.enabled ? "（关闭后 JSON-RPC 入口拒绝所有调用）" : "（开启后仅暴露只读工具，调用必须携带 API KEY）"}。
            </span>
          </label>
          <button className="primary-button" onClick={onToggle} disabled={!service || !toggleAck || busy !== ""}>
            {busy === "toggle" ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
            {service?.enabled ? "关闭服务" : "开启服务"}
          </button>
        </div>
      </div>

      {/* ---- API KEY：创建 + 掩码列表 + 一次性明文 ---- */}
      <div className="mcp-keys">
        <div className="mcp-section__head">
          <KeyRound size={14} />
          <strong>API KEY（只落 sha256，明文仅创建时出现一次）</strong>
          {keys && <span className="mcp-note mcp-note--dim mcp-note--inline">有效 {keys.active} · 已吊销 {keys.revoked}</span>}
        </div>
        {created && <OneTimeKey created={created} onDone={() => setCreated(null)} />}
        <div className="mcp-keys__form">
          <label className="mcp-field">
            <span>名称</span>
            <input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="1–60 字符（审计追溯用）" maxLength={60} />
          </label>
          <div className="mcp-keys__scopes">
            {MCP_SCOPE_OPTIONS.map((opt) => (
              <label key={opt.value} className="mcp-check mcp-check--inline" title={opt.hint}>
                <input
                  type="checkbox"
                  checked={keyScopes.includes(opt.value)}
                  onChange={(event) => setKeyScopes(event.target.checked
                    ? [...keyScopes, opt.value]
                    : keyScopes.filter((s) => s !== opt.value))}
                />
                <span>{opt.label}</span>
              </label>
            ))}
            <span className="mcp-note mcp-note--dim mcp-note--inline">不勾 = 全量白名单</span>
          </div>
          <label className="mcp-field">
            <span>备注（可空）</span>
            <input value={keyNote} onChange={(event) => setKeyNote(event.target.value)} maxLength={200} placeholder="用途说明" />
          </label>
          <button className="primary-button" onClick={onCreateKey} disabled={busy !== "" || !keyName.trim()}>
            {busy === "create" ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}创建 key
          </button>
        </div>
        <ul className="mcp-keylist">
          {(keys?.keys ?? []).map((key) => (
            <li key={key.id} data-status={keyStatusOf(key)}>
              <code className="mcp-keylist__hash">{key.hashPrefix}</code>
              <strong>{key.name || `key-${String(key.id)}`}</strong>
              <ToneBadge tone={keyStatusOf(key) === "active" ? "mint" : "dim"}>
                {keyStatusOf(key) === "active" ? "有效" : "已吊销"}
              </ToneBadge>
              <span className="mcp-note mcp-note--dim">scope {key.scopes.join("/") || "—"}</span>
              <span className="mcp-note mcp-note--dim">创建 {key.createdAt || "—"}</span>
              {key.lastUsedAt && <span className="mcp-note mcp-note--dim">最近使用 {key.lastUsedAt}</span>}
              {keyStatusOf(key) === "active" && (armedRevoke !== key.id ? (
                <button className="text-button mcp-danger-text" onClick={() => setArmedRevoke(key.id)} disabled={busy !== ""}>
                  <Trash2 size={13} />吊销
                </button>
              ) : (
                <button className="text-button mcp-danger-text" onClick={() => onRevoke(key.id)} disabled={busy !== ""}>
                  {busy === "revoke" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}确认吊销 #{String(key.id)}
                </button>
              ))}
            </li>
          ))}
          {(keys?.keys ?? []).length === 0 && <li className="mcp-note mcp-note--dim">尚无 key：创建后才能调用只读工具面。</li>}
        </ul>
      </div>

      {/* ---- 连接器：来源 + 清单 + 体检 + 写 ---- */}
      <div className="mcp-connectors">
        <div className="mcp-section__head">
          <Network size={14} />
          <strong>连接器（发现只读 · 写必须 dry→confirm）</strong>
          {connectors && (
            <span className="mcp-note mcp-note--dim mcp-note--inline">
              共 {connectors.summary.total} · 生效 {connectors.summary.effective} · 未加载 {connectors.summary.notLoaded} · 禁用 {connectors.summary.disabled} · 损坏 {connectors.summary.broken}
            </span>
          )}
          <button className="text-button mcp-section__action" onClick={() => onCheck()} disabled={busy !== ""}>
            {busy === "check" ? <LoaderCircle className="spin" size={13} /> : <PlugZap size={13} />}全部体检（只读握手）
          </button>
        </div>
        {connectors && connectors.sources.length > 0 && (
          <ul className="mcp-srcs">
            {connectors.sources.map((src) => (
              <li key={src.role} data-ok={src.exists ? "yes" : "no"}>
                <strong>{src.label}</strong>
                <code>{src.shown}</code>
                <ToneBadge tone={src.effective ? "mint" : "dim"}>{src.effective ? "生效来源" : "未加载"}</ToneBadge>
                <ToneBadge tone={src.writable ? "mint" : "dim"}>{src.writable ? "可写" : "只读"}</ToneBadge>
                <span className="mcp-note mcp-note--dim">{src.count} 项</span>
                {src.error && <span className="mcp-note mcp-src__error">{src.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {confirmed && (
          <div className="mcp-outcome">
            <CheckCircle2 size={14} />
            <span>{confirmed.note || "写入完成"} · 备份 <code>{confirmed.backup}</code>（可用于手工恢复）</span>
          </div>
        )}
        <ul className="mcp-connlist">
          {(connectors?.servers ?? []).map((conn) => {
            const st = statusOf(conn.name);
            const meta = st ? checkStatusMeta(st.status) : null;
            const role = writableRoleFor(conn);
            return (
              <li key={conn.name}>
                <div className="mcp-connlist__main">
                  <strong>{conn.name}</strong>
                  <span className="mcp-note mcp-note--dim">{transportLabel(conn.transport)}</span>
                  {!conn.effective && <ToneBadge tone="amber">未被宿主加载</ToneBadge>}
                  {conn.disabled && <ToneBadge tone="dim">已禁用</ToneBadge>}
                  {conn.transport === "stdio" && conn.exists === false && <ToneBadge tone="danger">命令缺失</ToneBadge>}
                  {meta && <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>}
                  {st?.toolCount !== undefined && <span className="mcp-note mcp-note--dim">{st.toolCount} 工具 · {String(st.ms ?? 0)}ms</span>}
                </div>
                <div className="mcp-connlist__line"><code>{connectorHeadline(conn)}</code></div>
                {st && <div className="mcp-note mcp-note--dim">{st.note}</div>}
                <div className="mcp-connlist__actions">
                  <button className="text-button" onClick={() => onCheck(conn.name)} disabled={busy !== ""}>
                    <PlugZap size={13} />体检
                  </button>
                  {role ? (
                    <>
                      <button
                        className="text-button"
                        onClick={() => onDry({ op: conn.disabled ? "enable" : "disable", role, name: conn.name })}
                        disabled={busy !== ""}
                      >
                        {busy === "dry" ? <LoaderCircle className="spin" size={13} /> : <Settings size={13} />}
                        {conn.disabled ? "启用" : "禁用"}
                      </button>
                      <button className="text-button mcp-danger-text" onClick={() => onDry({ op: "remove", role, name: conn.name })} disabled={busy !== ""}>
                        <Trash2 size={13} />移除
                      </button>
                    </>
                  ) : (
                    <span className="mcp-note mcp-note--dim">来源只读，不可写</span>
                  )}
                </div>
              </li>
            );
          })}
          {(connectors?.servers ?? []).length === 0 && <li className="mcp-note mcp-note--dim">未发现任何连接器登记。</li>}
        </ul>
        <details className="mcp-addwrap">
          <summary><Plus size={13} /> 登记新连接器（dry-run 预检 → 确认写入）</summary>
          <AddConnectorForm connectors={connectors} busy={busy === "dry"} onDry={onDry} />
        </details>
      </div>

      {/* ---- 审计尾（append-only，无 key 材料） ---- */}
      <details className="mcp-audit">
        <summary><History size={13} /> 服务审计尾（{service?.auditTail.length ?? 0} 行，最新在前，append-only 0600）</summary>
        {(service?.auditTail ?? []).length === 0 ? (
          <p className="mcp-note mcp-note--dim">尚无审计记录。</p>
        ) : (
          <ul className="mcp-audit__rows">
            {(service?.auditTail ?? []).map((row, index) => (
              <li key={`${row.at}-${String(index)}`} data-ok={row.ok ? "yes" : "no"}>
                <span className="mcp-audit__at">{row.at}</span>
                <span className="mcp-badge" data-tone={row.ok ? "mint" : "danger"}>{auditActionLabel(row.action)}</span>
                {row.target && <code>{row.target}</code>}
                {row.note && <span className="mcp-note mcp-note--dim">{row.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </details>

      {dry && <DryDialog dry={dry} busy={busy === "confirm"} onConfirm={onConfirmWrite} onCancel={() => setDry(null)} />}
    </section>
  );
}
