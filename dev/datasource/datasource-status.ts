/**
 * 每源状态派生（纯函数）：从既有桥产物（crm 快照 / ops 摘要 / ppl 巡检 / leads 快照 /
 * kb 源 / 钉钉写通道 / 健康快照 / 本体图）推导注册表 51 个源的当前状态。
 *
 * 诚实红线：产物缺失一律 missing（附「缺什么、去哪补」），v2 尚未接入检测通道的源
 * 一律 unknown，绝不伪造 ok；状态判定只用计数/布尔/时间戳，凭据值物理不可达。
 */

import type { DataSource } from "../../src/lib/datasource-model.ts";
import type { DataSourceState, DataSourceStatus } from "./datasource-types.ts";

/* ---------- 产物解析（全部防御式，坏形状 = 缺失） ---------- */

interface SourceStatusLike {
  readonly status: string;
  readonly stale: boolean;
  readonly fetchedAt: string | null;
}

export interface CrmArtifact {
  readonly generatedAt: string | null;
  readonly sources: Readonly<Record<string, SourceStatusLike>>;
}

export interface OpsArtifact {
  readonly generatedAt: string | null;
  readonly sources: Readonly<Record<string, SourceStatusLike>>;
}

export interface LeadsArtifact {
  readonly configured: boolean;
  readonly hasData: boolean;
  readonly fetchedAt: string;
  readonly total: number;
}

export interface KbSourceLike {
  readonly id: string;
  readonly type: string;
  readonly ok: boolean;
}

export interface HealthRowLike {
  readonly name: string;
  readonly state: string;
  readonly detail?: string;
}

export interface HealthArtifact {
  readonly fetchedAt: string;
  readonly bridges: readonly HealthRowLike[];
  readonly cli: readonly HealthRowLike[];
  readonly caps: readonly HealthRowLike[];
}

export interface OntologyArtifact {
  readonly opsCount: number;
  readonly uidsCount: number;
}

export interface ArtifactBundle {
  readonly crm: CrmArtifact | undefined;
  readonly ops: OpsArtifact | undefined;
  readonly ppl: boolean;
  readonly leads: LeadsArtifact | undefined;
  readonly kb: readonly KbSourceLike[] | undefined;
  readonly dingtalkWrites: readonly unknown[] | undefined;
  readonly health: HealthArtifact | undefined;
  readonly ontology: OntologyArtifact | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseSourceStatuses(raw: unknown): Record<string, SourceStatusLike> {
  if (!isRecord(raw)) return {};
  const out: Record<string, SourceStatusLike> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.status !== "string") continue;
    out[key] = {
      status: value.status,
      stale: value.stale === true,
      fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : null,
    };
  }
  return out;
}

export function parseCrm(raw: unknown): CrmArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    sources: parseSourceStatuses(raw.sources),
  };
}

export function parseOps(raw: unknown): OpsArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    sources: parseSourceStatuses(raw.sources),
  };
}

export function parseLeads(raw: unknown): LeadsArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    configured: raw.configured === true,
    hasData: raw.hasData === true,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : 0,
  };
}

export function parseKb(raw: unknown): readonly KbSourceLike[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: KbSourceLike[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    out.push({ id: item.id, type: typeof item.type === "string" ? item.type : "", ok: item.ok === true });
  }
  return out;
}

export function parseHealth(raw: unknown): HealthArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  const rows = (value: unknown): readonly HealthRowLike[] =>
    Array.isArray(value)
      ? value.filter(isRecord).map((row) => ({
        name: typeof row.name === "string" ? row.name : "",
        state: typeof row.state === "string" ? row.state : "",
        detail: typeof row.detail === "string" ? row.detail : undefined,
      }))
      : [];
  return {
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    bridges: rows(raw.bridges),
    cli: rows(raw.cli),
    caps: rows(raw.caps),
  };
}

export function parseOntology(raw: unknown): OntologyArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    opsCount: typeof raw.opsCount === "number" ? raw.opsCount : 0,
    uidsCount: typeof raw.uidsCount === "number" ? raw.uidsCount : 0,
  };
}

/* ---------- 证据绑定 ---------- */

export type EvidenceBinding =
  | { readonly kind: "static" }
  | { readonly kind: "crm" }
  | { readonly kind: "crm-inferred"; readonly evidence: string }
  | { readonly kind: "ops" }
  | { readonly kind: "health-bridge"; readonly key: string }
  | { readonly kind: "health-cli"; readonly key: string }
  | { readonly kind: "health-cap"; readonly key: string }
  | { readonly kind: "health-snapshot" }
  | { readonly kind: "leads" }
  | { readonly kind: "kb"; readonly type: string }
  | { readonly kind: "ontology" }
  | { readonly kind: "none"; readonly state: "missing" | "unknown"; readonly evidence: string };

const AITABLE_UNBOUND = "v2 尚无该表接入配置（.local-cache），可经接入向导一键建表接入";

/** 逐源绑定表：sys 精确匹配优先，其后按刷新组、通道兜底。 */
const SYS_BINDINGS: Readonly<Record<string, EvidenceBinding>> = {
  "CRD 目标管理（读）": { kind: "none", state: "missing", evidence: "v2 无 OKR 快照产物（donor data/okr.json 未接）" },
  "CRD 目标管理（写回）": { kind: "none", state: "missing", evidence: "v2 无 CRD 写回通道产物" },
  "BUC 身份解析与会话校验": { kind: "crm-inferred", evidence: "由 crm 快照可用性推断（v2 未接 Cookie 层直检）" },
  "登录态健康快照（Cookie 层）": { kind: "crm-inferred", evidence: "由 crm 快照可用性推断（v2 未接 sysstatus Cookie 判活）" },
  "三类健康快照（CLI / MCP / Cookie）": { kind: "health-snapshot" },
  "钉钉 AI 表格「历史工作」": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉 AI 表格「客户文件清单」": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉 AI 表格「拓新企业清单」": { kind: "leads" },
  "钉钉 AI 表格「协作关系表」": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉 AI 表格「业务域」（反向写入）": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉 AI 表格「Agent&MaaS日报」": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉 AI 表格「日报跟踪记录」": { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  "钉钉知识库（Wiki）": { kind: "kb", type: "dingtalk" },
  "Obsidian 本地知识库": { kind: "kb", type: "obsidian" },
  "Aone / 云效 Code 代码库": { kind: "health-cli", key: "a1" },
  "案例库 · Code 平台（Aone Pages）": { kind: "health-bridge", key: "cases" },
  "案例库 · OSS 发布桶": { kind: "health-bridge", key: "cases" },
  "Chrome 标签页": { kind: "none", state: "missing", evidence: "v2 无 Chrome 标签采集通道（donor data/data.js 未接）" },
  "服务可达性探针（config probes）": { kind: "none", state: "missing", evidence: "v2 未接服务可达性探针（waker/harness/newapi 等）" },
  "QoderWake daemon（本地）": { kind: "none", state: "missing", evidence: "v2 无 QoderWake daemon 探测产物" },
  "QoderWake 端点探活（本地 / ECS / MacMini）": { kind: "none", state: "missing", evidence: "v2 无 QoderWake 端点探活产物" },
  "本地触发桥（动作通道，非数据源）": { kind: "none", state: "unknown", evidence: "动作通道，无数据状态可判定" },
  "OKR AI 辅助建议": { kind: "health-cap", key: "DASHSCOPE_API_KEY" },
  "述职材料与挂载映射": { kind: "none", state: "missing", evidence: "v2 无 okr 产物（review/mount 未接）" },
  "客户短名映射": { kind: "none", state: "unknown", evidence: "本机映射配置，v2 未接检测通道" },
  "钉钉关注配置": { kind: "none", state: "unknown", evidence: "本机配置项，v2 未接检测通道" },
  "生命周期编排配置": { kind: "none", state: "unknown", evidence: "本机配置项，v2 未接检测通道" },
  "历史工作 Markdown（回退源）": { kind: "none", state: "missing", evidence: "v2 无 worklog 产物" },
  "本地工作 LIVE 采集（实时层）": { kind: "none", state: "missing", evidence: "v2 无 worklog-live 产物" },
  "Chrome Profile 枚举": { kind: "none", state: "unknown", evidence: "实时枚举项，v2 未接检测通道" },
  "加密凭据库": { kind: "none", state: "unknown", evidence: "凭据库不回显状态（值与存在性均不出桥）" },
  "运行期配置": { kind: "none", state: "unknown", evidence: "运行期配置，v2 未接检测通道" },
  "战役口径人工层": { kind: "none", state: "missing", evidence: "v2 无 campaign 产物" },
  "客户盘面分层与重点关注": { kind: "none", state: "missing", evidence: "v2 无 campaign 产物" },
  "CRS MaaS 资源报备（百炼 SFM 报备单）": { kind: "none", state: "missing", evidence: "v2 无 CRS 报备台账产物（inbox 归一未接）" },
  "战略方向（会议提炼）": { kind: "none", state: "missing", evidence: "v2 无 strategy 产物" },
  "个人本体构建": { kind: "ontology" },
};

const GROUP_BINDINGS: Readonly<Record<string, EvidenceBinding>> = {
  cust: { kind: "crm" },
  ppl: { kind: "health-bridge", key: "ppl-inspection" },
  ops: { kind: "ops" },
  dingtalk: { kind: "health-bridge", key: "dingtalk" },
  leads: { kind: "leads" },
  cases: { kind: "health-bridge", key: "cases" },
  okr: { kind: "none", state: "missing", evidence: "v2 无 okr 组产物" },
  wechat: { kind: "none", state: "unknown", evidence: "微信层 v2 未接检测通道" },
  worklog: { kind: "none", state: "missing", evidence: "v2 无 worklog 组产物" },
  relations: { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  custfiles: { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  aitable: { kind: "none", state: "missing", evidence: AITABLE_UNBOUND },
  presales: { kind: "none", state: "unknown", evidence: "presales 聚合层 v2 未接检测通道" },
  campaign: { kind: "none", state: "missing", evidence: "v2 无 campaign 产物" },
  crs: { kind: "none", state: "missing", evidence: "v2 无 CRS 台账产物" },
  ontology: { kind: "ontology" },
  data: { kind: "none", state: "unknown", evidence: "综合组，见逐源判定" },
};

export function bindingFor(source: DataSource): EvidenceBinding {
  const bySys = SYS_BINDINGS[source.sys];
  if (bySys) return bySys;
  if (source.grp !== null && GROUP_BINDINGS[source.grp]) return GROUP_BINDINGS[source.grp];
  if (source.ch.includes("static")) return { kind: "static" };
  return { kind: "none", state: "unknown", evidence: "v2 未接该源检测通道" };
}

/* ---------- 状态判定 ---------- */

/** 汇总一组 {status, stale}：error/auth_required 优先，其后 stale，最后 ok。 */
function aggregateSources(sources: Readonly<Record<string, SourceStatusLike>>): { state: DataSourceState; detail: string } {
  const entries = Object.values(sources);
  if (entries.length === 0) return { state: "missing", detail: "产物内无逐源状态" };
  const bad = entries.filter((s) => s.status === "error" || s.status === "auth_required");
  if (bad.length > 0) return { state: "error", detail: `${bad.length}/${entries.length} 个源异常（${bad[0]?.status ?? "error"}）` };
  const stale = entries.filter((s) => s.stale);
  if (stale.length > 0) return { state: "stale", detail: `${stale.length}/${entries.length} 个源过期` };
  const okCount = entries.filter((s) => s.status === "ok").length;
  const partial = entries.length - okCount;
  return { state: "ok", detail: partial > 0 ? `${okCount} 个源就绪、${partial} 个部分` : `${okCount} 个源就绪` };
}

function healthRowState(state: string): DataSourceState {
  if (state === "ok") return "ok";
  if (state === "error") return "error";
  if (state === "unconfigured" || state === "missing") return "missing";
  return "unknown";
}

export function deriveStatus(source: DataSource, artifacts: ArtifactBundle): DataSourceStatus {
  const binding = bindingFor(source);
  switch (binding.kind) {
    case "static":
      return { state: "static", evidence: "仓库内静态登记，随代码发布，无运行期状态", fetchedAt: null };
    case "none":
      return { state: binding.state, evidence: binding.evidence, fetchedAt: null };
    case "crm": {
      if (!artifacts.crm) return { state: "missing", evidence: "无 crm 快照产物（同步中心手动同步生成）", fetchedAt: null };
      const agg = aggregateSources(artifacts.crm.sources);
      return { state: agg.state, evidence: `crm 快照 · ${agg.detail}`, fetchedAt: artifacts.crm.generatedAt };
    }
    case "crm-inferred": {
      if (!artifacts.crm) return { state: "missing", evidence: `无 crm 快照产物可推断 · ${binding.evidence}`, fetchedAt: null };
      return { state: "ok", evidence: binding.evidence, fetchedAt: artifacts.crm.generatedAt };
    }
    case "ops": {
      if (!artifacts.ops) return { state: "missing", evidence: "无 ops 摘要产物（ops 刷新生成）", fetchedAt: null };
      const agg = aggregateSources(artifacts.ops.sources);
      return { state: agg.state, evidence: `ops 摘要 · ${agg.detail}`, fetchedAt: artifacts.ops.generatedAt };
    }
    case "health-bridge": {
      if (!artifacts.health) return { state: "missing", evidence: "无健康快照（体检面板运行体检或现场重检生成）", fetchedAt: null };
      const row = artifacts.health.bridges.find((r) => r.name === binding.key);
      if (!row) return { state: "unknown", evidence: `健康快照缺 ${binding.key} 行`, fetchedAt: artifacts.health.fetchedAt };
      return { state: healthRowState(row.state), evidence: `健康快照 ${binding.key} · ${row.detail ?? row.state}`, fetchedAt: artifacts.health.fetchedAt };
    }
    case "health-cli": {
      if (!artifacts.health) return { state: "missing", evidence: "无健康快照（体检面板运行体检或现场重检生成）", fetchedAt: null };
      const row = artifacts.health.cli.find((r) => r.name === binding.key);
      if (!row) return { state: "unknown", evidence: `健康快照缺 cli.${binding.key} 行`, fetchedAt: artifacts.health.fetchedAt };
      return { state: healthRowState(row.state), evidence: `健康快照 cli.${binding.key} · ${row.state}`, fetchedAt: artifacts.health.fetchedAt };
    }
    case "health-cap": {
      if (!artifacts.health) return { state: "missing", evidence: "无健康快照（体检面板运行体检或现场重检生成）", fetchedAt: null };
      const row = artifacts.health.caps.find((r) => r.name === binding.key);
      if (!row) return { state: "unknown", evidence: `健康快照缺 ${binding.key} 行`, fetchedAt: artifacts.health.fetchedAt };
      return { state: healthRowState(row.state), evidence: `${binding.key} ${row.state === "ok" ? "已设置（值不入快照）" : "未设置"}`, fetchedAt: artifacts.health.fetchedAt };
    }
    case "health-snapshot": {
      if (!artifacts.health) return { state: "missing", evidence: "无健康快照产物（.local-cache/health.json，现场重检生成）", fetchedAt: null };
      return {
        state: "ok",
        evidence: `健康快照就绪 · 桥 ${artifacts.health.bridges.length} / CLI ${artifacts.health.cli.length} / 配置 ${artifacts.health.caps.length}`,
        fetchedAt: artifacts.health.fetchedAt,
      };
    }
    case "leads": {
      const leads = artifacts.leads;
      if (!leads) return { state: "missing", evidence: "leads 快照不可读", fetchedAt: null };
      if (!leads.configured) return { state: "missing", evidence: "未配置 .local-cache/leads.json（可经接入向导建表）", fetchedAt: null };
      if (!leads.hasData) return { state: "missing", evidence: "快照无数据（先刷新 leads 组）", fetchedAt: leads.fetchedAt || null };
      return { state: "ok", evidence: `leads 快照 ${leads.total} 行`, fetchedAt: leads.fetchedAt || null };
    }
    case "kb": {
      if (!artifacts.kb) return { state: "missing", evidence: "知识库源清单不可读", fetchedAt: null };
      const hits = artifacts.kb.filter((s) => s.type === binding.type);
      if (hits.length === 0) return { state: "missing", evidence: `知识库未启用 ${binding.type} 源（.local-cache/kb.json）`, fetchedAt: null };
      const broken = hits.filter((s) => !s.ok);
      if (broken.length > 0) return { state: "error", evidence: `${binding.type} 源 ${broken.length}/${hits.length} 个异常`, fetchedAt: null };
      return { state: "ok", evidence: `${binding.type} 源 ${hits.length} 个就绪`, fetchedAt: null };
    }
    case "ontology": {
      if (!artifacts.ontology) return { state: "missing", evidence: "无本体图产物（.local-cache/ontology/graph.json）", fetchedAt: null };
      const { opsCount, uidsCount } = artifacts.ontology;
      if (opsCount === 0 && uidsCount === 0) return { state: "missing", evidence: "本体图为空（尚无策展操作）", fetchedAt: null };
      return { state: "ok", evidence: `本体图就绪 · 操作 ${opsCount} / 节点 ${uidsCount}`, fetchedAt: null };
    }
  }
}
