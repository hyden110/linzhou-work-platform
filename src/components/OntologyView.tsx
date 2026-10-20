/**
 * OntologyView (F8) — 本体管理：实体列表 / 链接列表 / SVG 派生图 / 动作面板 + 审计尾。
 *
 * 口径：
 * - 数据全部来自本地桥（ontology-client）；策展层真身是操作日志，图是派生物；
 * - SVG 图用 layoutOntologyGraph 的 type 分列网格（无力导、无随机）；
 * - 破坏性动作（archive/merge/split）必须手输目标 uid 确认后才可提交；
 * - 幂等键由客户端铸造，提交重试同键不重复落账；deduped 命中如实展示；
 * - 空态诚实：无任何实体时给「创建第一个实体」引导，不放假数据。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchOntologyGraph,
  fetchOntologyState,
  makeOntologyActionKey,
  ontologyErrorMessage,
  submitOntologyAction,
  type OntologyStateSnapshot,
} from "../lib/ontology-client";
import { layoutOntologyGraph } from "../lib/ontology-model";
import { DESTRUCTIVE_ONTOLOGY_ACTIONS, ONTOLOGY_ACTIONS } from "../lib/ontology-types";
import type { GraphNode, OntologyGraphView } from "../lib/ontology-types";
import { ViewHeading } from "./shared";
import "../ontology.css";

/* ---------------- 动作表单声明（字段随动作而变） ---------------- */

type FieldKind = "text" | "uid" | "type" | "linkType" | "basis" | "absorbed" | "json";

interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly placeholder?: string;
}

const ACTION_FORMS: Record<string, { readonly label: string; readonly fields: readonly FieldSpec[] }> = {
  "entity.create": { label: "创建实体", fields: [{ name: "type", label: "类型", kind: "type" }, { name: "name", label: "名称", kind: "text", placeholder: "甲科技（合成）" }, { name: "props", label: "属性（k=v，逗号分隔）", kind: "text", placeholder: "ecid=E1, cid=C2" }] },
  "entity.rename": { label: "重命名", fields: [{ name: "uid", label: "目标实体", kind: "uid" }, { name: "name", label: "新名称（旧名进别名）", kind: "text" }] },
  "entity.setProp": { label: "改属性", fields: [{ name: "uid", label: "目标实体", kind: "uid" }, { name: "props", label: "属性（k=v，逗号分隔）", kind: "text", placeholder: "ecid=E9" }] },
  "entity.retag": { label: "改类型", fields: [{ name: "uid", label: "目标实体", kind: "uid" }, { name: "type", label: "新类型", kind: "type" }] },
  "entity.archive": { label: "归档（破坏性）", fields: [{ name: "uid", label: "目标实体", kind: "uid" }] },
  "entity.merge": { label: "合并（破坏性）", fields: [{ name: "uid", label: "存方实体", kind: "uid" }, { name: "fromUid", label: "被并实体", kind: "uid" }] },
  "entity.split": { label: "拆分（破坏性）", fields: [{ name: "uid", label: "存方实体", kind: "uid" }, { name: "absorbedKeys", label: "拆回的吸收键", kind: "absorbed" }] },
  "link.assert": { label: "断言链接", fields: [{ name: "fromUid", label: "起点", kind: "uid" }, { name: "toUid", label: "终点", kind: "uid" }, { name: "type", label: "链接类型", kind: "linkType" }, { name: "basis", label: "可信度（缺省 confirmed）", kind: "basis" }] },
  "link.retract": { label: "撤销链接", fields: [{ name: "fromUid", label: "起点", kind: "uid" }, { name: "toUid", label: "终点", kind: "uid" }, { name: "type", label: "链接类型", kind: "linkType" }] },
  "schema.addType": { label: "注册对象类型", fields: [{ name: "id", label: "id（小写字母开头 ≤32 位）", kind: "text", placeholder: "vendor" }, { name: "label", label: "显示名", kind: "text", placeholder: "供应商" }] },
  "schema.addLink": { label: "注册链接类型", fields: [{ name: "id", label: "id", kind: "text", placeholder: "supplies" }, { name: "label", label: "显示名", kind: "text", placeholder: "供货" }, { name: "from", label: "起点类型", kind: "type" }, { name: "to", label: "终点类型", kind: "type" }] },
  "schema.addConstraint": { label: "追加约束", fields: [{ name: "rule", label: "规则 JSON", kind: "json", placeholder: '{"id":"vendor-name","when":{"type":"vendor"},"require":["name"]}' }] },
};

function isDestructive(action: string): boolean {
  return (DESTRUCTIVE_ONTOLOGY_ACTIONS as readonly string[]).includes(action);
}

/** "k=v, k2=v2" → {k:"v", k2:"v2"}（数字/布尔自动收窄，其余留字符串）。 */
function parsePropsText(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(/[,，]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (raw === "true" || raw === "false") out[key] = raw === "true";
    else if (raw !== "" && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

function timeOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString("zh-CN", { hour12: false });
}

/* ---------------- 动作面板 ---------------- */

function ActionPanel({
  state,
  graph,
  preselect,
  onDone,
}: {
  state: OntologyStateSnapshot;
  graph: OntologyGraphView;
  preselect: string;
  onDone: (message: string) => void;
}) {
  const [action, setAction] = useState<string>(preselect);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const keyRef = useRef<string>(makeOntologyActionKey());

  useEffect(() => {
    setAction(preselect);
    setValues({});
    setConfirmText("");
    setFormError("");
  }, [preselect]);

  const form = ACTION_FORMS[action];
  const nodes = graph.nodes;
  const destructive = isDestructive(action);
  const targetUid = values.uid ?? "";
  const confirmOk = !destructive || confirmText.trim() === targetUid;

  /* split 的候选吸收键：来自日志里存方匹配的 merge 富化记录。 */
  const absorbedOptions = useMemo(() => {
    if (action !== "entity.split" || !targetUid) return [];
    const keys = new Set<string>();
    for (const op of state.ops) {
      if (op.op === "entity.merge" && op.uid === targetUid && Array.isArray(op.absorbedKeys)) {
        for (const key of op.absorbedKeys as unknown[]) {
          if (typeof key === "string" && key) keys.add(key);
        }
      }
    }
    return [...keys];
  }, [action, targetUid, state.ops]);

  const setValue = (name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFormError("");
  };

  const toggleAbsorbed = (key: string): void => {
    const current = (values.absorbedKeys ?? "").split("\n").filter((k) => k && k !== key);
    const next = (values.absorbedKeys ?? "").split("\n").includes(key) ? current : [...current, key];
    setValue("absorbedKeys", next.join("\n"));
  };

  function buildPayload(): Record<string, unknown> | null {
    switch (action) {
      case "entity.create": {
        const name = (values.name ?? "").trim();
        if (!values.type || !name) { setFormError("类型与名称必填。"); return null; }
        return { type: values.type, props: { name, ...parsePropsText(values.props ?? "") } };
      }
      case "entity.rename":
        if (!targetUid || !(values.name ?? "").trim()) { setFormError("目标实体与新名称必填。"); return null; }
        return { uid: targetUid, name: values.name.trim() };
      case "entity.setProp":
        if (!targetUid) { setFormError("目标实体必填。"); return null; }
        return { uid: targetUid, props: parsePropsText(values.props ?? "") };
      case "entity.retag":
        if (!targetUid || !values.type) { setFormError("目标实体与新类型必填。"); return null; }
        return { uid: targetUid, type: values.type };
      case "entity.archive":
        if (!targetUid) { setFormError("目标实体必填。"); return null; }
        return { uid: targetUid };
      case "entity.merge":
        if (!targetUid || !values.fromUid) { setFormError("存方与被并实体必填。"); return null; }
        if (targetUid === values.fromUid) { setFormError("存方与被并实体不可相同。"); return null; }
        return { uid: targetUid, fromUid: values.fromUid };
      case "entity.split": {
        const keys = (values.absorbedKeys ?? "").split("\n").filter((k) => k.trim());
        if (!targetUid || !keys.length) { setFormError("存方实体与至少一个吸收键必填。"); return null; }
        return { uid: targetUid, absorbedKeys: keys };
      }
      case "link.assert": {
        if (!values.fromUid || !values.toUid || !values.type) { setFormError("起点、终点与链接类型必填。"); return null; }
        if (values.fromUid === values.toUid) { setFormError("链接不可自环。"); return null; }
        const payload: Record<string, unknown> = { fromUid: values.fromUid, toUid: values.toUid, type: values.type };
        if (values.basis) payload.basis = values.basis;
        return payload;
      }
      case "link.retract":
        if (!values.fromUid || !values.toUid || !values.type) { setFormError("起点、终点与链接类型必填。"); return null; }
        return { fromUid: values.fromUid, toUid: values.toUid, type: values.type };
      case "schema.addType":
        if (!(values.id ?? "").trim() || !(values.label ?? "").trim()) { setFormError("id 与显示名必填。"); return null; }
        return { id: values.id.trim(), type: { label: values.label.trim() } };
      case "schema.addLink":
        if (!(values.id ?? "").trim() || !values.from || !values.to) { setFormError("id 与起终点类型必填。"); return null; }
        return { id: values.id.trim(), link: { label: (values.label ?? "").trim() || values.id.trim(), from: values.from, to: values.to } };
      case "schema.addConstraint": {
        try {
          const rule = JSON.parse(values.rule ?? "") as unknown;
          if (!rule || typeof rule !== "object") throw new Error("rule 须为对象");
          return { rule };
        } catch {
          setFormError("规则必须是合法 JSON 对象。");
          return null;
        }
      }
      default:
        setFormError("未知动作。");
        return null;
    }
  }

  async function submit(): Promise<void> {
    const payload = buildPayload();
    if (!payload) return;
    if (destructive && !confirmOk) { setFormError("破坏性动作需要输入目标 uid 确认。"); return; }
    setBusy(true);
    setFormError("");
    try {
      const outcome = await submitOntologyAction({
        action,
        payload,
        key: keyRef.current,
        confirm: destructive ? targetUid : undefined,
      });
      keyRef.current = makeOntologyActionKey();
      setValues({});
      setConfirmText("");
      onDone(outcome.deduped
        ? `幂等键命中：该动作此前已落账（${timeOf(outcome.at)}），未重复执行。`
        : `已落账：${form?.label ?? action} · ${timeOf(outcome.at)} · uid ${outcome.uid ?? "-"}`);
    } catch (error) {
      setFormError(ontologyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const renderField = (field: FieldSpec) => {
    const value = values[field.name] ?? "";
    if (field.kind === "uid") {
      return (
        <select value={value} onChange={(e) => setValue(field.name, e.target.value)}>
          <option value="">选择实体…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.uid}>{n.name || n.id}（{n.type} · {n.uid}）</option>
          ))}
        </select>
      );
    }
    if (field.kind === "type" || field.kind === "linkType") {
      const entries = field.kind === "type"
        ? Object.entries(state.schema.objectTypes)
        : Object.entries(state.schema.linkTypes);
      return (
        <select value={value} onChange={(e) => setValue(field.name, e.target.value)}>
          <option value="">选择类型…</option>
          {entries.map(([id, def]) => (
            <option key={id} value={id}>{id} · {def.label}</option>
          ))}
        </select>
      );
    }
    if (field.kind === "basis") {
      return (
        <select value={value} onChange={(e) => setValue(field.name, e.target.value)}>
          <option value="">（缺省 confirmed）</option>
          {Object.entries(state.schema.basis).map(([id, def]) => (
            <option key={id} value={id}>{id} · {def.label}</option>
          ))}
        </select>
      );
    }
    if (field.kind === "absorbed") {
      return absorbedOptions.length ? (
        <div className="onto-checks">
          {absorbedOptions.map((key) => (
            <label key={key} className="onto-checks__item">
              <input type="checkbox" checked={(values.absorbedKeys ?? "").split("\n").includes(key)} onChange={() => toggleAbsorbed(key)} />
              <code>{key}</code>
            </label>
          ))}
        </div>
      ) : (
        <p className="onto-form__hint">该实体没有可拆回的合并记录（absorbedKeys 来自日志里的 merge 富化）。</p>
      );
    }
    if (field.kind === "json") {
      return <textarea rows={3} value={value} placeholder={field.placeholder} onChange={(e) => setValue(field.name, e.target.value)} />;
    }
    return <input type="text" value={value} placeholder={field.placeholder} onChange={(e) => setValue(field.name, e.target.value)} />;
  };

  return (
    <section className="panel onto-panel" aria-label="本体动作">
      <div className="panel__header">
        <h2>动作面板</h2>
        <span className="onto-panel__key" title="本次表单的幂等键（提交成功后轮换）">key <code>{keyRef.current.slice(0, 13)}…</code></span>
      </div>
      <div className="onto-form">
        <label className="onto-form__row">
          <span>动作</span>
          <select value={action} onChange={(e) => { setAction(e.target.value); setValues({}); setConfirmText(""); setFormError(""); }}>
            {ONTOLOGY_ACTIONS.map((name) => (
              <option key={name} value={name}>{name} · {ACTION_FORMS[name]?.label ?? ""}</option>
            ))}
          </select>
        </label>
        {form?.fields.map((field) => (
          <label className="onto-form__row" key={field.name}>
            <span>{field.label}</span>
            {renderField(field)}
          </label>
        ))}
        {destructive && (
          <label className="onto-form__row onto-form__row--danger">
            <span>确认目标 uid（{targetUid || "先选择实体"}）</span>
            <input
              type="text"
              value={confirmText}
              placeholder="破坏性动作：手动输入目标 uid"
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </label>
        )}
        {formError && <p className="onto-form__error" role="alert">{formError}</p>}
        <button type="button" className="onto-form__submit" disabled={busy || (destructive && !confirmOk)} onClick={() => void submit()}>
          {busy ? "提交中…" : `提交 ${action}`}
        </button>
      </div>
    </section>
  );
}

/* ---------------- SVG 派生图（type 分列网格，无力导） ---------------- */

function GraphCanvas({ graph }: { graph: OntologyGraphView }) {
  const layout = useMemo(() => layoutOntologyGraph(graph.nodes), [graph]);
  const positions = useMemo(() => new Map(layout.positions.map((p) => [p.id, p])), [layout]);
  const nameOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.name || n.id])), [graph.nodes]);

  const center = (id: string): { x: number; y: number } | null => {
    const p = positions.get(id);
    return p ? { x: p.x + layout.nodeWidth / 2, y: p.y + layout.nodeHeight / 2 } : null;
  };

  return (
    <section className="panel onto-graph" aria-label="本体派生图">
      <div className="panel__header">
        <h2>派生图</h2>
        <span className="onto-graph__meta">
          {graph.nodes.length} 实体 · {graph.links.length} 链接 · 由操作日志派生（{timeOf(graph.generatedAt)}）
        </span>
      </div>
      <div className="onto-graph__scroll">
        <svg width={layout.width} height={layout.height} role="img" aria-label="本体图（类型分列网格）">
          {layout.columns.map((column) => (
            <g key={column.type}>
              <text className="onto-graph__col" x={column.x} y={24}>{column.type}（{column.count}）</text>
              <line x1={column.x - 8} x2={column.x - 8} y1={32} y2={layout.height - 12} className="onto-graph__rule" />
            </g>
          ))}
          {graph.links.map((link, index) => {
            const from = center(link.from);
            const to = center(link.to);
            if (!from || !to) return null;
            return (
              <g key={`${link.type}-${link.from}-${link.to}-${index}`}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`onto-graph__link onto-graph__link--${link.basis}`} />
                <title>{`${nameOf.get(link.from) ?? link.from} -${link.type}（${link.basis}）→ ${nameOf.get(link.to) ?? link.to}`}</title>
              </g>
            );
          })}
          {layout.positions.map((p) => {
            const node = graph.nodes.find((n) => n.id === p.id) as GraphNode | undefined;
            if (!node) return null;
            return (
              <g key={p.id} className="onto-graph__node">
                <rect x={p.x} y={p.y} width={layout.nodeWidth} height={layout.nodeHeight} rx={8} />
                <text x={p.x + 10} y={p.y + 18} className="onto-graph__name">
                  {(node.name || node.id).slice(0, 12)}
                </text>
                <text x={p.x + 10} y={p.y + 34} className="onto-graph__sub">
                  {node.type}{node.curated ? " · 已策展" : ""}
                </text>
                <title>{`${node.name || node.id}（${node.type} · ${node.uid}）`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

/* ---------------- 主视图 ---------------- */

export function OntologyView() {
  const [state, setState] = useState<OntologyStateSnapshot | null>(null);
  const [graph, setGraph] = useState<OntologyGraphView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [preselect, setPreselect] = useState("entity.create");

  const reload = useCallback(async () => {
    try {
      const [nextState, nextGraph] = await Promise.all([fetchOntologyState(), fetchOntologyGraph()]);
      setState(nextState);
      setGraph(nextGraph);
      setLoadError("");
    } catch (error) {
      setLoadError(ontologyErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleDone = (message: string): void => {
    setNotice(message);
    void reload();
  };

  const typeLabel = (type: string): string => state?.schema.objectTypes[type]?.label ?? type;
  const linkLabel = (type: string): string => state?.schema.linkTypes[type]?.label ?? type;
  const nodeName = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id;

  const empty = Boolean(state && graph && graph.nodes.length === 0 && state.opsCount === 0);

  return (
    <div className="onto-view">
      <ViewHeading
        eyebrow="ONTOLOGY · F8"
        title="本体管理"
        description="知识本体 CRUD + 派生图 + 审计：策展层真身是操作日志，图与列表都是从日志 replay 出来的派生物。"
        aside={
          <div className="onto-view__badges">
            <span className="status-badge">{state ? `${state.opsCount} 条操作` : "…"}</span>
            <span className="status-badge">{graph ? `${graph.nodes.length} 实体 / ${graph.links.length} 链接` : "…"}</span>
            {state && state.conflicts.length > 0 && <span className="status-badge status-badge--amber">{state.conflicts.length} 个 replay 冲突</span>}
            {state && state.violations.length > 0 && <span className="status-badge status-badge--amber">{state.violations.length} 个约束违例</span>}
          </div>
        }
      />

      {loadError && (
        <div className="onto-banner onto-banner--error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="text-button" onClick={() => { setLoading(true); void reload(); }}>重试</button>
        </div>
      )}
      {notice && (
        <div className="onto-banner onto-banner--ok" role="status">
          <p>{notice}</p>
          <button type="button" className="text-button" onClick={() => setNotice("")}>知道了</button>
        </div>
      )}
      {loading && !state && <p className="onto-loading">正在读取本体策展层…</p>}

      {empty && (
        <div className="empty-state onto-empty">
          <h2>本体还是空的</h2>
          <p>操作日志（edits.json）里还没有任何动作。从创建第一个实体开始，图和审计都会随之生长。</p>
          <button
            type="button"
            className="onto-empty__cta"
            onClick={() => { setPreselect("entity.create"); setNotice(""); }}
          >
            创建第一个实体
          </button>
        </div>
      )}

      {state && graph && !empty && (
        <div className="onto-grid">
          <section className="panel onto-list" aria-label="实体列表">
            <div className="panel__header"><h2>实体（{graph.nodes.length}）</h2></div>
            <table className="onto-table">
              <thead>
                <tr><th>名称</th><th>类型</th><th>标签</th><th>属性摘要</th><th>uid</th></tr>
              </thead>
              <tbody>
                {graph.nodes.map((node) => (
                  <tr key={node.id}>
                    <td>
                      {node.name || node.id}
                      {node.curated && <span className="onto-tag onto-tag--mint">已策展</span>}
                      {node.aliases.length > 0 && <span className="onto-tag">别名 {node.aliases.length}</span>}
                    </td>
                    <td>{typeLabel(node.type)}</td>
                    <td>{node.tags.length ? node.tags.join(" / ") : "—"}</td>
                    <td className="onto-props">
                      {Object.entries(node.props).slice(0, 3).map(([k, v]) => `${k}=${String(v)}`).join(" · ") || "—"}
                    </td>
                    <td><code>{node.uid}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel onto-list" aria-label="链接列表">
            <div className="panel__header"><h2>链接（{graph.links.length}）</h2></div>
            <table className="onto-table">
              <thead>
                <tr><th>类型</th><th>起点 → 终点</th><th>可信度</th><th>来源</th></tr>
              </thead>
              <tbody>
                {graph.links.map((link, index) => (
                  <tr key={`${link.type}-${link.from}-${link.to}-${index}`}>
                    <td>{linkLabel(link.type)}</td>
                    <td>{nodeName(link.from)} → {nodeName(link.to)}</td>
                    <td>{state.schema.basis[link.basis]?.label ?? link.basis}</td>
                    <td>{link.source}</td>
                  </tr>
                ))}
                {graph.links.length === 0 && <tr><td colSpan={4} className="onto-table__empty">还没有链接：用「断言链接」动作登记第一条关系。</td></tr>}
              </tbody>
            </table>
          </section>

          <GraphCanvas graph={graph} />
          <ActionPanel state={state} graph={graph} preselect={preselect} onDone={handleDone} />

          {(state.conflicts.length > 0 || state.violations.length > 0) && (
            <section className="panel onto-list onto-issues" aria-label="冲突与违例">
              <div className="panel__header"><h2>冲突与违例（只报告，不自动修改）</h2></div>
              <ul>
                {state.conflicts.map((conflict, index) => (
                  <li key={`c-${index}`} className="onto-issues__item">
                    <code>{conflict.op}</code> {conflict.note}{conflict.uid ? `（uid ${conflict.uid}）` : ""}
                  </li>
                ))}
                {state.violations.map((violation, index) => (
                  <li key={`v-${index}`} className="onto-issues__item">
                    <code>{violation.rule}</code> [{violation.scope}] {violation.note}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel onto-list onto-audit" aria-label="审计尾">
            <div className="panel__header">
              <h2>审计尾（最近 {state.audit.length} 行）</h2>
              <button type="button" className="text-button" onClick={() => { setLoading(true); void reload(); }}>刷新</button>
            </div>
            <table className="onto-table">
              <thead>
                <tr><th>时间</th><th>动作</th><th>结果</th><th>幂等键</th></tr>
              </thead>
              <tbody>
                {state.audit.map((line, index) => (
                  <tr key={`${line.at}-${line.action}-${index}`}>
                    <td>{timeOf(line.at)}</td>
                    <td><code>{line.action}</code></td>
                    <td>{line.ok ? <span className="onto-tag onto-tag--mint">成功</span> : <span className="onto-tag onto-tag--danger">拒绝</span>}</td>
                    <td className="onto-props">{line.key ?? "—"}</td>
                  </tr>
                ))}
                {state.audit.length === 0 && <tr><td colSpan={4} className="onto-table__empty">还没有审计记录：每次执行动作都会追加一行。</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

export default OntologyView;
