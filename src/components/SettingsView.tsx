import { useCallback, useEffect, useMemo, useState } from "react";
import { EyeOff, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import "../settings.css";
import { HealthPanel } from "./HealthPanel";
import { McpPanel } from "./settings/McpPanel";
import { useCrm } from "./crm/CrmProvider";
import { useOps } from "./ops/OpsProvider";
import { SOURCE_LABELS, formatDateTime } from "./crm/crm-shared";
import { StatusBadge, ViewHeading, type ViewProps } from "./shared";
import { fetchKbSources, kbErrorMessage, type KbSourceView } from "../lib/kb-client";
import {
  fetchLeadsSnapshot,
  leadsAgeHours,
  leadsErrorMessage,
  refreshLeads,
  type LeadsSnapshot,
} from "../lib/leads-client";
import {
  DEFAULT_GAAP_THRESHOLDS,
  GAAP_THRESHOLD_FIELDS,
  GAAP_THRESHOLD_META,
  formatThresholdAmount,
  formatThresholdNote,
  parseGaapThresholdsForm,
  readGaapThresholds,
  resetGaapThresholds,
  setGaapThresholds,
  subscribeGaapThresholds,
  type GaapThresholdField,
  type GaapThresholds,
} from "../lib/gaap-thresholds";
import {
  readDemoMode,
  setDemoMode,
  shouldMask,
  subscribeDemoMode,
  type DemoDocumentLike,
  type DemoFieldKind,
  type DemoStorageLike,
} from "../lib/demo-mode";
import type { OpsDigest } from "../lib/ops-types";
import type { SourceKey, SourceStatus } from "../lib/crm-types";

/**
 * 设置视图（V2）：能力清单 / 配置状态 / 数据新鲜度 / 只读刷新入口 / 演示模式。
 * 全页只读——不写任何配置、不新造写操作；配置只报「已设置 / 未配置 / 探测失败」，
 * 绝不显示值。数据一律复用既有桥与客户端（F4 体检、kb、leads、crm、ops）。
 */

/* ---------- 环境访问（无 DOM/存储环境安全降级） ---------- */

function browserStorage(): DemoStorageLike | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function browserDocument(): DemoDocumentLike | null {
  return typeof document === "undefined" ? null : document;
}

/* ---------- 能力清单：口径与派生 ---------- */

type CapabilityStatus = "available" | "pending-auth" | "blocked";

const CAPABILITY_STATUS: Readonly<Record<CapabilityStatus, { label: string; tone: "green" | "amber" | "muted" }>> = {
  available: { label: "可用", tone: "green" },
  "pending-auth": { label: "待授权", tone: "amber" },
  blocked: { label: "受阻", tone: "muted" },
};

interface CapabilityRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: CapabilityStatus;
  readonly note: string;
}

/** 各视图实际消费的快照源（读过 CockpitView/CustomersView/DingtalkView/PplFollowupView 的取数口径）。 */
const VIEW_SOURCES: Readonly<Record<string, readonly SourceKey[]>> = {
  cockpit: ["agenda", "todos", "mentions", "customers", "projects"],
  customers: ["customers", "overview", "top"],
  dingtalk: ["groups", "mentions", "unread", "customers"],
  lifecycle: ["customers", "projects", "mygroups"],
};

const SOURCE_KEY_ORDER = Object.keys(SOURCE_LABELS) as SourceKey[];

interface CapabilityContext {
  readonly crmSources: Partial<Record<SourceKey, SourceStatus>>;
  readonly crmMissing: boolean;
  readonly crmHasSnapshot: boolean;
  readonly opsDigest: OpsDigest | null;
  readonly opsMissing: boolean;
  readonly leads: LeadsSnapshot | null;
  readonly leadsFailed: boolean;
  readonly kbSources: readonly KbSourceView[] | null;
  readonly kbFailed: boolean;
}

function crmViewCapability(
  ctx: CapabilityContext,
  keys: readonly SourceKey[],
): { status: CapabilityStatus; note: string } {
  if (ctx.crmMissing) return { status: "blocked", note: "尚无客户快照：到同步中心点「手动同步」生成第一份" };
  if (!ctx.crmHasSnapshot) return { status: "blocked", note: "本地桥未启动或快照读取失败" };
  const states = keys.flatMap((key) => (ctx.crmSources[key] ? [ctx.crmSources[key] as SourceStatus] : []));
  if (states.length === 0) return { status: "blocked", note: "当前快照缺少该视图依赖的数据源" };
  if (states.some((state) => state.status === "auth_required")) {
    return { status: "pending-auth", note: "上游要求登录/授权（dws 或鲲鹏登录失效），重新登录后刷新" };
  }
  if (states.some((state) => state.status === "error")) {
    return { status: "blocked", note: "依赖的数据源读取失败，明细见同步中心" };
  }
  const partialCount = states.filter((state) => state.status === "partial").length;
  return { status: "available", note: partialCount > 0 ? `${partialCount} 个数据源部分降级（明细见同步中心）` : "" };
}

function leadsViewCapability(ctx: CapabilityContext): { status: CapabilityStatus; note: string } {
  if (ctx.leadsFailed) return { status: "blocked", note: "本地桥未启动或读取失败" };
  if (!ctx.leads) return { status: "blocked", note: "尚未读取到拓新雷达快照" };
  if (!ctx.leads.configured) {
    return { status: "blocked", note: "未配置 .local-cache/leads.json（参考 config/leads.json.example）" };
  }
  if (!ctx.leads.hasData) return { status: "blocked", note: "已配置但尚无数据：到拓新雷达点「刷新快照」首次拉取" };
  return { status: "available", note: "" };
}

function opsViewCapability(ctx: CapabilityContext): { status: CapabilityStatus; note: string } {
  if (ctx.opsMissing) return { status: "blocked", note: "尚无运营摘要：到运营推广视图点「刷新」生成" };
  if (!ctx.opsDigest) return { status: "blocked", note: "本地桥未启动或读取失败" };
  const states = Object.values(ctx.opsDigest.sources);
  if (states.some((state) => state.status === "auth_required")) {
    return { status: "pending-auth", note: "运营数据源要求登录/授权" };
  }
  if (states.some((state) => state.status === "error")) {
    return { status: "blocked", note: "运营数据源读取失败，明细见运营推广视图" };
  }
  return { status: "available", note: "" };
}

function kbCapability(ctx: CapabilityContext): { status: CapabilityStatus; note: string } {
  if (ctx.kbFailed) return { status: "blocked", note: "本地桥未启动或读取失败" };
  if (!ctx.kbSources) return { status: "blocked", note: "尚未读取到知识源状态" };
  if (ctx.kbSources.length === 0) return { status: "blocked", note: "未配置 .local-cache/kb.json 或无启用源" };
  const okCount = ctx.kbSources.filter((source) => source.ok).length;
  if (okCount === 0) return { status: "blocked", note: "启用源均不可检索（明细见 AI 问答 · 外部知识库）" };
  return { status: "available", note: `启用 ${ctx.kbSources.length} 源，其中 ${okCount} 源可检索` };
}

function viewCapability(ctx: CapabilityContext, id: string): { status: CapabilityStatus; note: string } {
  const keys = VIEW_SOURCES[id];
  if (keys) return crmViewCapability(ctx, keys);
  if (id === "leads") return leadsViewCapability(ctx);
  if (id === "ops") return opsViewCapability(ctx);
  return { status: "available", note: "" };
}

function buildViewCapabilities(ctx: CapabilityContext): readonly CapabilityRow[] {
  const rows: ReadonlyArray<Omit<CapabilityRow, "status" | "note">> = [
    { id: "cockpit", name: "驾驶舱", description: "今日待办 / 会议 / @我 + 客户与项目 + 行动队列" },
    { id: "customers", name: "客户盘面", description: "客户池、GAAP 异动与 TOP 榜（鲲鹏 ecid 只读）" },
    { id: "dingtalk", name: "钉群盘面", description: "钉钉群 / 未读 / @我 与客户覆盖核对（dws 只读）" },
    { id: "feishu", name: "飞书台账", description: "飞书群与单聊 / @我消息 / 我的待办（lark-cli 只读投影，消息预览 ≤60 字、open_id 掩码）" },
    { id: "lifecycle", name: "PPL 跟进", description: "在途项目按客户分组、巡检与分层视图（只读）" },
    { id: "okr", name: "OKR 目标", description: "CRD 目标树 / 进展编辑 / dry-run 后逐项确认回写" },
    { id: "leads", name: "拓新雷达", description: "dws aitable 只读拉取的拓新线索分桶" },
    { id: "report", name: "日周报", description: "当日草稿编辑与两步回写 / 提交 outbox / 双周报 / worklog 采集分类" },
    { id: "inbox", name: "消息中心", description: "本机收件箱（测试生产者 + 已读位）" },
    { id: "overview", name: "总览", description: "本地索引概览与入口（纯本地元数据）" },
    { id: "ask", name: "AI 问答", description: "本地受控证据问答 + 外部知识库检索" },
    { id: "map", name: "知识地图", description: "方案 / 客户 / 活动 / 主题四维找资料" },
    { id: "assistant", name: "方案助手", description: "证据组合生成方案建议 + 已发布案例面板" },
    { id: "documents", name: "全部资料", description: "本地元数据索引浏览与筛选" },
    { id: "yunqi", name: "云栖大会", description: "本机整理稿解析的六层趋势与论坛" },
    { id: "sync", name: "同步中心", description: "数据源健康、手动同步与环境体检" },
    { id: "ops", name: "运营推广", description: "运营摘要 / 推广卡片 / 微信登记（摘要只读）" },
    { id: "agents", name: "数字员工", description: "QoderWake daemon / AgentLoop 观测与凭据管理 / SLS 出票（凭据掩码）" },
    { id: "ontology", name: "本体管理", description: "知识本体策展操作日志 + 派生图 + 审计（本地读写）" },
    { id: "profile", name: "个人中心", description: "BUC 会话管理与判活（cookie 仅掩码展示，0600 存储）" },
    { id: "datasources", name: "数据源管理", description: "数据源注册表 / 分组刷新 / env 与接入向导（写操作两步确认）" },
    { id: "settings", name: "设置", description: "能力清单、配置状态、数据新鲜度与演示模式（本页）" },
  ];
  const notes: Readonly<Record<string, string>> = {
    report: "回写走 save-dry→save-confirm、提交走 submit-dry→submit-confirm 两步链路；5 分钟冷却内不重发；worklog 仅只读采集",
    okr: "回写走 dry-run → 逐项确认两步链路；未配置 CRD 会话时如实引导，不伪造目标数据",
    inbox: "回复需本机 dws CLI；建议生成需本机 qoder CLI，缺失时如实提示 engine_missing",
    ask: "未配置百炼密钥时自动降级为关键词检索（实际配置见下方体检）",
    agents: "凭据 0600 掩码管理（只报已设置/未设置）；出票走 ticket-dry→ticket-confirm 单次消费 token，审计掩码留痕",
    profile: "判活需先粘贴 BUC 会话；未设置时视图如实引导，chrome 自动提取未接入",
    datasources: "刷新仅 supported 分组；建表与续期均需确认闸门，密钥类配置只报「已设置/未设置」",
    feishu: "lark-cli 发现顺序 FEISHU_CLI_PATH → ~/.qoderwork/bin → ~/.qwenworkcn/bin → PATH；CLI 缺失或 user 身份未授权时如实给 cli_missing / auth_required 指引（含 loginCommand），绝不伪造数据；桥纯只读，绝不代跑登录或发信写命令；缓存 300s + 单飞，单区失败只影响该区",
    settings: "MCP 服务默认关；只读工具面需先建 sak_ key（明文仅创建时出现一次，落盘只有 sha256）；连接器体检只走注入握手，写入需 dry→confirm 且宿主配置默认只读",
  };
  return rows.map((row) => {
    const derived = viewCapability(ctx, row.id);
    return { ...row, status: derived.status, note: derived.note || notes[row.id] || "" };
  });
}

function buildGlobalCapabilities(ctx: CapabilityContext): readonly CapabilityRow[] {
  const kb = kbCapability(ctx);
  const writePending: readonly CapabilityRow[] = [
    { id: "write-report", name: "日报回写（草稿保存 / 提交）", description: "保存日报草稿、提交日报到 CRM / AI 表", status: "available", note: "已接通：白名单字段 save-dry→save-confirm 两步回写（recordId 冲突 409 不覆盖）；提交走 submit-dry→submit-confirm + outbox 去重 + 5 分钟冷却，成败均回读校验并留 writes.jsonl 掩码审计" },
    { id: "write-reply", name: "消息中心真实回复", description: "从收件箱直接回复钉钉群消息", status: "available", note: "已接通：建议生成走本机 qoder CLI（缺失时如实 engine_missing，不回落云端）；发送走 dws chat message send，且弹窗 confirm 必须严格等于候选 id 才执行，每次真实尝试留 sends.jsonl 审计" },
    { id: "write-agentloop", name: "AgentLoop 凭据与出票", description: "管理 AgentLoop 凭据、连接测试与工单出票", status: "available", note: "已接通：凭据 0600 存储且只报掩码/已设置；连接测试只读 listLogstores；出票 ticket-dry→ticket-confirm（confirm 严格 === 一次性 token，单次消费），cn-shanghai HMAC-SHA1 签名，成败均落掩码审计" },
    { id: "write-okr", name: "OKR 进展回写（CRD）", description: "把本地进展编辑回写到 CRD OKR", status: "available", note: "已接通：先 dry-run 出差异，再按 keys 逐项确认回写；冲突需显式 acceptConflicts，未配置 BUC 会话时如实引导不伪造数据" },
    { id: "write-provision", name: "数据源建表 / 凭据续期", description: "接入向导里的 aitable 建表与体检里的凭据续期", status: "available", note: "已接通：needConfirm 步必须 body.confirm === true（严格布尔）；terminal 步只回显命令文本，绝不代跑子进程" },
    { id: "write-mcp", name: "MCP 服务开关 / API KEY / 连接器登记", description: "开启只读工具面、签发与吊销 sak_ key、连接器体检与写入", status: "available", note: "已接通：服务默认关，toggle 需 body.confirm 严格 === true；key 明文只在创建响应出现一次（磁盘与视图只有 sha256 + 前缀），吊销需 confirm 严格 === keyId；连接器体检走注入 spawn/fetch 且单飞（并发 409 busy），写入 dry→confirm 单次消费 token 并留 .bak 备份 + 掩码审计；宿主配置来源默认只读" },
    { id: "write-dingtalk", name: "钉钉真实发送（运营卡片推送）", description: "运营推广卡片真实推送到钉钉群", status: "pending-auth", note: "OPS_DINGTALK_PUSH_ENABLED 默认关：需在本机显式开启后走两步确认推送" },
    { id: "write-aitable", name: "AI 表回写（拓新雷达）", description: "把线索跟进状态回写到 aitable", status: "pending-auth", note: "dws aitable 仅只读拉取，无回写端点" },
  ];
  const readCaps: readonly CapabilityRow[] = [
    { id: "kb-search", name: "外部知识检索（本地桥 kb）", description: "阿里云 / 钉钉文档多源检索", status: kb.status, note: kb.note },
    { id: "ai-qa", name: "AI 问答与摘要（百炼密钥）", description: "证据问答 / 语义检索 / 外部摘要", status: "available", note: "未配置 DASHSCOPE_API_KEY 时自动降级为关键词检索（实际配置见下方体检）" },
    { id: "health", name: "环境与健康体检", description: "桥产物 / CLI 在位 / 配置开关的只读体检", status: "available", note: "" },
    { id: "demo-mode", name: "演示模式（本页开关）", description: "客户名 / 金额 / 账号类字段模糊遮挡", status: "available", note: "默认关；状态存本机 localStorage，刷新后保持" },
  ];
  return [...writePending, ...readCaps];
}

/* ---------- 数据新鲜度：口径与派生 ---------- */

type FreshnessStatus = "ok" | "partial" | "stale" | "missing" | "unknown";

const FRESHNESS_STATUS: Readonly<Record<FreshnessStatus, { label: string; tone: "green" | "amber" | "muted" }>> = {
  ok: { label: "正常", tone: "green" },
  partial: { label: "部分", tone: "amber" },
  stale: { label: "过期", tone: "amber" },
  missing: { label: "未同步", tone: "muted" },
  unknown: { label: "探测失败", tone: "amber" },
};

interface FreshnessRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly fetchedAt: string | null;
  readonly status: FreshnessStatus;
  readonly refreshKind: "crm" | "ops" | "leads" | null;
  readonly note: string;
}

function sourceFreshness(state: SourceStatus | undefined): FreshnessStatus {
  if (!state) return "missing";
  if (state.status === "ok") return state.stale ? "stale" : "ok";
  if (state.status === "missing") return "missing";
  return "partial";
}

function aggregateFreshness(states: readonly FreshnessStatus[]): FreshnessStatus {
  if (states.length === 0) return "missing";
  if (states.every((status) => status === "ok")) return "ok";
  if (states.some((status) => status === "unknown")) return "unknown";
  if (states.every((status) => status === "missing")) return "missing";
  if (states.some((status) => status === "partial")) return "partial";
  return "stale";
}

function leadsFreshness(leads: LeadsSnapshot | null): FreshnessStatus {
  if (!leads || !leads.configured || !leads.hasData) return "missing";
  const ageHours = leadsAgeHours(leads.fetchedAt, Date.now());
  return ageHours !== null && ageHours > 24 ? "stale" : "ok";
}

function kbFreshness(kbSources: readonly KbSourceView[] | null, kbFailed: boolean): FreshnessStatus {
  if (kbFailed || !kbSources) return "unknown";
  if (kbSources.length === 0) return "missing";
  return kbSources.some((source) => source.ok) ? "ok" : "partial";
}

interface FreshnessArgs {
  readonly indexGeneratedAt: string;
  readonly crmGeneratedAt: string | null;
  readonly crmSources: Partial<Record<SourceKey, SourceStatus>>;
  readonly crmMissing: boolean;
  readonly crmHasSnapshot: boolean;
  readonly opsDigest: OpsDigest | null;
  readonly opsMissing: boolean;
  readonly leads: LeadsSnapshot | null;
  readonly kbSources: readonly KbSourceView[] | null;
  readonly kbFailed: boolean;
}

function crmFreshnessStatus(args: FreshnessArgs): FreshnessStatus {
  if (args.crmMissing) return "missing";
  if (!args.crmHasSnapshot) return "unknown";
  const states = SOURCE_KEY_ORDER.flatMap((key) => {
    const state = args.crmSources[key];
    return state ? [sourceFreshness(state)] : [];
  });
  return aggregateFreshness(states);
}

function opsFreshnessStatus(args: FreshnessArgs): FreshnessStatus {
  if (args.opsMissing) return "missing";
  if (!args.opsDigest) return "unknown";
  const states = Object.values(args.opsDigest.sources).map((state) => sourceFreshness(state));
  return aggregateFreshness(states);
}

function buildFreshnessRows(args: FreshnessArgs): readonly FreshnessRow[] {
  return [
    {
      id: "index",
      label: "本地知识索引",
      detail: "总览 / 问答 / 地图 / 方案助手 / 资料 / 云栖的元数据底座",
      fetchedAt: args.indexGeneratedAt,
      status: "ok",
      refreshKind: null,
      note: "由构建期同步脚本盘点生成（npm run build 时更新），无在线刷新入口",
    },
    {
      id: "crm",
      label: "CRM 快照（钉钉 dws + 鲲鹏 ecid）",
      detail: "驾驶舱 / 客户盘面 / 钉群盘面 / PPL 跟进的数据源",
      fetchedAt: args.crmGeneratedAt,
      status: crmFreshnessStatus(args),
      refreshKind: "crm",
      note: "已有只读刷新入口：本机触发 dws + 鲲鹏只读拉取（POST /local/crm/refresh）",
    },
    {
      id: "ops",
      label: "运营摘要",
      detail: "运营推广视图的摘要与条目来源",
      fetchedAt: args.opsDigest?.generatedAt ?? null,
      status: opsFreshnessStatus(args),
      refreshKind: "ops",
      note: "已有只读刷新入口（POST /local/ops/refresh）",
    },
    {
      id: "leads",
      label: "拓新雷达快照",
      detail: "dws aitable 只读拉取的线索快照（超 24 小时视为过期）",
      fetchedAt: args.leads?.fetchedAt ?? null,
      status: leadsFreshness(args.leads),
      refreshKind: "leads",
      note: "已有只读刷新入口（POST /local/leads/refresh；已配置机器最坏可等待数分钟）",
    },
    {
      id: "kb",
      label: "外部知识库（本地桥 kb）",
      detail: "打开本页时实时探测的启用源状态",
      fetchedAt: null,
      status: kbFreshness(args.kbSources, args.kbFailed),
      refreshKind: null,
      note: "来源配置在 .local-cache/kb.json，修改后重启 dev:function 生效；无在线刷新入口",
    },
  ];
}

/* ---------- 配置状态：存在性行（只报 set/unset，绝不显示值） ---------- */

interface ConfigRow {
  readonly label: string;
  readonly value: string;
  readonly tone: "green" | "muted" | "amber";
  readonly note: string;
}

function buildConfigRows(ctx: CapabilityContext): readonly ConfigRow[] {
  const leadsConfig: ConfigRow = ctx.leadsFailed
    ? { label: ".local-cache/leads.json（拓新雷达配置）", value: "探测失败", tone: "amber", note: "本地桥未启动或读取失败" }
    : ctx.leads?.configured
      ? { label: ".local-cache/leads.json（拓新雷达配置）", value: "已配置", tone: "green", note: "五键齐备（baseId / tableId / viewId / tableName / priorityProvinces）；值不显示" }
      : { label: ".local-cache/leads.json（拓新雷达配置）", value: "未配置", tone: "muted", note: "参考 config/leads.json.example 补齐五键" };
  const kbConfig: ConfigRow = ctx.kbFailed
    ? { label: ".local-cache/kb.json（外部知识源配置）", value: "探测失败", tone: "amber", note: "本地桥未启动或读取失败" }
    : ctx.kbSources && ctx.kbSources.length > 0
      ? { label: ".local-cache/kb.json（外部知识源配置）", value: `已配置（启用 ${ctx.kbSources.length} 源）`, tone: "green", note: "源名与可用性见上方数据新鲜度；值不显示" }
      : { label: ".local-cache/kb.json（外部知识源配置）", value: "未配置", tone: "muted", note: "无启用源时外部知识检索不可用" };
  return [
    {
      label: ".env.local（可选，env 注入）",
      value: "由体检「可选能力」行如实显示（set/unset）",
      tone: "muted",
      note: "dev:function 以 --env-file-if-exists=.env.local 启动；本页与体检均只报设置与否，绝不显示值",
    },
    leadsConfig,
    kbConfig,
    {
      label: ".local-cache/cases.json（已发布案例配置）",
      value: "由体检「数据桥」行如实显示",
      tone: "muted",
      note: "未配置时案例桥报 unconfigured（不扇出渠道 CLI）；参考 config/cases.json.example",
    },
    {
      label: "config/*.json（仓库内）",
      value: "仅 *.json.example 示例入库",
      tone: "muted",
      note: "真实配置位在 .local-cache/（gitignored）；存在性以上方各行与体检为准",
    },
  ];
}

/* ---------- 演示模式区块 ---------- */

const DEMO_EXAMPLES: ReadonlyArray<{ kind: DemoFieldKind; caption: string; value: string }> = [
  { kind: "customer", caption: "客户名", value: "示例客户甲科技有限公司" },
  { kind: "amount", caption: "金额", value: "1,234.56 万" },
  { kind: "uid", caption: "账号 / UID", value: "cid-000123" },
  { kind: "plain", caption: "普通文本（不遮挡）", value: "2026-10-20 · 方案评审" },
];

function maskClass(kind: DemoFieldKind, enabled: boolean): string {
  return shouldMask(kind, enabled) ? "demo-mask" : "";
}

function DemoModeSection({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <section className="panel settings-panel" aria-label="演示模式">
      <div className="panel__header">
        <div><span className="eyebrow">DEMO MODE / 08</span><h2>演示模式</h2></div>
        <button
          type="button"
          className={`demo-toggle ${enabled ? "is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          aria-label="演示模式开关"
          onClick={onToggle}
        >
          <span className="demo-toggle__knob" aria-hidden="true" />
          <span className="demo-toggle__label">{enabled ? "演示中" : "已关闭"}</span>
        </button>
      </div>
      <div className="settings-panel__body">
        <p className="settings-note">
          默认关闭；开启后客户名、金额、账号/UID 类字段以 CSS 模糊遮挡，状态存本机 localStorage、刷新后保持。
          结构说明与日期时间保持清晰可讲解；开关本身不受遮挡影响，可随时退出。
        </p>
        <div className="demo-example" data-enabled={enabled ? "yes" : "no"}>
          <span className="demo-example__caption">遮挡效果示例（合成数据，非真实客户）</span>
          <div className="demo-example__row">
            {DEMO_EXAMPLES.map((example) => (
              <span className="demo-example__cell" key={example.kind}>
                <small>{example.caption}</small>
                <b className={maskClass(example.kind, enabled)}>{example.value}</b>
              </span>
            ))}
          </div>
        </div>
        <p className="settings-note settings-note--dim">
          <ShieldCheck size={13} /> 遮挡是 CSS 模糊，真值仍在页面 DOM 中：演示时请勿交出屏幕控制权或远程协助。
          覆盖范围＝本页示例 + 已挂钩的数据区（客户盘面表格客户名与 GAAP 列、拓新雷达企业名等尽力钩子）；
          未挂钩的视图（如钉群盘面会话、消息明细）仍可能透出真实信息，演示前请自行核对。
        </p>
      </div>
    </section>
  );
}

/** 顶栏演示模式徽标（App 挂载，常驻可退出；仅在开启时渲染）。 */
export function DemoModeBadge() {
  const [enabled, setEnabled] = useState(() => readDemoMode(browserStorage()));
  useEffect(() => subscribeDemoMode(setEnabled), []);
  if (!enabled) return null;
  const exit = () => setDemoMode(browserStorage(), browserDocument(), false);
  return (
    <button
      type="button"
      className="demo-mode-badge"
      onClick={exit}
      title="演示模式开启中：客户名 / 金额 / 账号类字段已模糊；点击退出"
    >
      <EyeOff size={14} />
      <span>演示模式</span>
    </button>
  );
}

/* ---------- GAAP 异动阈值区块（#10074 R1） ---------- */

function thresholdDefaultText(field: GaapThresholdField): string {
  const value = DEFAULT_GAAP_THRESHOLDS[field];
  return field === "rateSevere" ? `${value}%` : formatThresholdAmount(value);
}

function GaapThresholdSection() {
  const [thresholds, setThresholds] = useState(() => readGaapThresholds(browserStorage()));
  const [form, setForm] = useState<Record<GaapThresholdField, string>>(() => ({
    absoluteNotice: String(thresholds.absoluteNotice),
    absoluteWatch: String(thresholds.absoluteWatch),
    rateSevere: String(thresholds.rateSevere),
    lowBaseGaap: String(thresholds.lowBaseGaap),
  }));

  useEffect(() => subscribeGaapThresholds(setThresholds), []);

  const result = parseGaapThresholdsForm(form);
  const dirty = GAAP_THRESHOLD_FIELDS.some((field) => form[field] !== String(thresholds[field]));

  const save = useCallback(() => {
    if (!result.ok || !result.thresholds) return;
    if (setGaapThresholds(browserStorage(), result.thresholds)) {
      setForm({
        absoluteNotice: String(result.thresholds.absoluteNotice),
        absoluteWatch: String(result.thresholds.absoluteWatch),
        rateSevere: String(result.thresholds.rateSevere),
        lowBaseGaap: String(result.thresholds.lowBaseGaap),
      });
    }
  }, [result]);

  const reset = useCallback(() => {
    resetGaapThresholds(browserStorage());
    setForm({
      absoluteNotice: String(DEFAULT_GAAP_THRESHOLDS.absoluteNotice),
      absoluteWatch: String(DEFAULT_GAAP_THRESHOLDS.absoluteWatch),
      rateSevere: String(DEFAULT_GAAP_THRESHOLDS.rateSevere),
      lowBaseGaap: String(DEFAULT_GAAP_THRESHOLDS.lowBaseGaap),
    });
  }, []);

  return (
    <section className="panel settings-panel" aria-label="GAAP 异动阈值">
      <div className="panel__header">
        <div><span className="eyebrow">GAAP THRESHOLDS / 08</span><h2>GAAP 异动阈值</h2></div>
        <span className="settings-panel__hint">仅影响异动判定，不改变数据源与口径</span>
      </div>
      <div className="settings-panel__body">
        <p className="settings-note">
          四项判定参数保存后立即生效并持久化到本机（localStorage），客户盘面的异动集合与口径文案随配置同步变化；
          非法输入会被阻止并给出字段级错误，原有效配置不被破坏。
        </p>
        <div className="settings-threshold-grid">
          {GAAP_THRESHOLD_FIELDS.map((field) => {
            const meta = GAAP_THRESHOLD_META[field];
            return (
              <label key={field} className="settings-threshold-field">
                <span>{meta.label}</span>
                <span className="settings-threshold-field__input">
                  <input
                    type="number"
                    value={form[field]}
                    onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                    aria-label={`${meta.label}（${meta.unit}）`}
                    aria-invalid={Boolean(result.errors[field])}
                  />
                  <small>{meta.unit}</small>
                </span>
                <small className="settings-threshold-field__hint">{meta.hint}；默认 {thresholdDefaultText(field)}</small>
                {result.errors[field] && (
                  <small className="settings-threshold-field__error" role="alert">{result.errors[field]}</small>
                )}
              </label>
            );
          })}
        </div>
        <div className="settings-threshold-actions">
          <button type="button" className="primary-button" onClick={save} disabled={!result.ok || !dirty}>
            保存
          </button>
          <button type="button" className="text-button" onClick={reset}>恢复默认</button>
          <span className="settings-threshold-actions__current">当前生效：{formatThresholdNote(thresholds)}</span>
        </div>
      </div>
    </section>
  );
}

/* ---------- 能力清单区块 ---------- */

function CapabilityRowView({ row }: { row: CapabilityRow }) {
  const status = CAPABILITY_STATUS[row.status];
  return (
    <div className="settings-cap-row" data-status={row.status}>
      <strong>{row.name}</strong>
      <span className="settings-cap-row__desc">{row.description}</span>
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      {row.note && <small className="settings-cap-row__note">{row.note}</small>}
    </div>
  );
}

function CapabilitySection({ viewRows, globalRows }: { viewRows: readonly CapabilityRow[]; globalRows: readonly CapabilityRow[] }) {
  return (
    <section className="panel settings-panel" aria-label="能力清单">
      <div className="panel__header">
        <div><span className="eyebrow">CAPABILITY INVENTORY / 08</span><h2>能力清单</h2></div>
        <span className="settings-panel__hint">可用 / 待授权 / 受阻 · 口径如实</span>
      </div>
      <div className="settings-panel__body">
        <div className="settings-cap-group">
          <h3>视图能力（{viewRows.length} 个视图）</h3>
          {viewRows.map((row) => <CapabilityRowView key={row.id} row={row} />)}
        </div>
        <div className="settings-cap-group">
          <h3>全局能力</h3>
          {globalRows.map((row) => <CapabilityRowView key={row.id} row={row} />)}
        </div>
        <p className="settings-note settings-note--dim">
          「待授权」＝默认关闭的写能力或上游要求登录/授权，本台未开通；「受阻」＝配置缺失或数据源读取失败。
          口径不做粉饰：未开通的能力如实标注，不静默隐藏。
        </p>
      </div>
    </section>
  );
}

/* ---------- 数据新鲜度区块（含只读刷新入口） ---------- */

interface RefreshEntry {
  readonly running: boolean;
  readonly run: () => void;
  readonly error: string;
}

function RefreshAction({ running, onRun }: { running: boolean; onRun: () => void }) {
  return (
    <button type="button" className="text-button settings-fresh__run" onClick={onRun} disabled={running}>
      {running ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
      {running ? "刷新中…" : "只读刷新"}
    </button>
  );
}

function FreshnessSection({ rows, crmSources, kbSources, refresh }: {
  rows: readonly FreshnessRow[];
  crmSources: Partial<Record<SourceKey, SourceStatus>>;
  kbSources: readonly KbSourceView[] | null;
  refresh: Readonly<Record<"crm" | "ops" | "leads", RefreshEntry>>;
}) {
  const hasCrmSources = SOURCE_KEY_ORDER.some((key) => crmSources[key]);
  return (
    <section className="panel settings-panel" aria-label="数据新鲜度">
      <div className="panel__header">
        <div><span className="eyebrow">DATA FRESHNESS / 08</span><h2>数据新鲜度</h2></div>
        <span className="settings-panel__hint">各源最近刷新时间 + 状态</span>
      </div>
      <div className="settings-panel__body">
        {rows.map((row) => {
          const badge = FRESHNESS_STATUS[row.status];
          const entry = row.refreshKind ? refresh[row.refreshKind] : null;
          return (
            <div className="settings-fresh-row" key={row.id}>
              <div className="settings-fresh-row__main">
                <strong>{row.label}</strong>
                <span>{row.detail}</span>
              </div>
              <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              <time>{formatDateTime(row.fetchedAt)}</time>
              {entry
                ? <RefreshAction running={entry.running} onRun={entry.run} />
                : <small className="settings-fresh__note">{row.note}</small>}
              {entry && entry.error && <small className="settings-fresh__error">{entry.error}</small>}
              {entry && <small className="settings-fresh__note">{row.note}</small>}
            </div>
          );
        })}
        {hasCrmSources && (
          <div className="settings-fresh-sources" aria-label="CRM 快照源级明细">
            {SOURCE_KEY_ORDER.map((key) => {
              const state = crmSources[key];
              const badge = FRESHNESS_STATUS[sourceFreshness(state)];
              return (
                <div className="settings-fresh-source" key={key}>
                  <span>{SOURCE_LABELS[key]}</span>
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                  <time>{formatDateTime(state?.fetchedAt ?? state?.lastSuccessAt ?? null)}</time>
                </div>
              );
            })}
          </div>
        )}
        {kbSources && kbSources.length > 0 && (
          <div className="settings-kb-chips" aria-label="知识库源状态">
            {kbSources.map((source) => (
              <span className="settings-kb-chip" data-ok={source.ok ? "yes" : "no"} key={source.id}>
                {source.label}{source.ok ? "" : " · 不可用"}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- 配置状态区块（复用 F4 体检面板） ---------- */

function ConfigSection({ rows }: { rows: readonly ConfigRow[] }) {
  return (
    <section className="panel settings-panel" aria-label="配置状态">
      <div className="panel__header">
        <div><span className="eyebrow">CONFIG STATUS / 08</span><h2>配置状态</h2></div>
        <span className="settings-panel__hint">只报已设置 / 未配置，绝不显示值</span>
      </div>
      <div className="settings-panel__body">
        <div className="settings-config-grid">
          {rows.map((row) => (
            <div className="settings-config-row" key={row.label}>
              <strong>{row.label}</strong>
              <StatusBadge tone={row.tone}>{row.value}</StatusBadge>
              <small>{row.note}</small>
            </div>
          ))}
        </div>
        <p className="settings-note settings-note--dim">
          <ShieldCheck size={13} /> 环境变量与数据桥的完整探测在下方「环境与健康」面板（F4 只读体检，手动触发）：
          env 只报 set/unset、桥行如实反映各配置文件的存在性，值在任何情况下都不进页面。
        </p>
      </div>
    </section>
  );
}

/* ---------- 子状态 hook ---------- */

function useLeadsSnapshotState(): {
  leads: LeadsSnapshot | null;
  leadsError: string;
  leadsRefreshing: boolean;
  refreshLeadsNow: () => void;
} {
  const [leads, setLeads] = useState<LeadsSnapshot | null>(null);
  const [leadsError, setLeadsError] = useState("");
  const [leadsRefreshing, setLeadsRefreshing] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchLeadsSnapshot()
      .then((snapshot) => {
        if (!mounted) return;
        setLeads(snapshot);
        setLeadsError("");
      })
      .catch((error: unknown) => {
        if (mounted) setLeadsError(leadsErrorMessage(error));
      });
    return () => { mounted = false; };
  }, []);

  const refreshLeadsNow = useCallback(() => {
    if (leadsRefreshing) return;
    setLeadsRefreshing(true);
    refreshLeads()
      .then((result) => {
        setLeads(result.snapshot);
        setLeadsError("");
      })
      .catch((error: unknown) => setLeadsError(leadsErrorMessage(error)))
      .finally(() => setLeadsRefreshing(false));
  }, [leadsRefreshing]);

  return { leads, leadsError, leadsRefreshing, refreshLeadsNow };
}

function useKbSourcesState(): { kbSources: KbSourceView[] | null; kbError: string } {
  const [kbSources, setKbSources] = useState<KbSourceView[] | null>(null);
  const [kbError, setKbError] = useState("");
  useEffect(() => {
    let mounted = true;
    fetchKbSources()
      .then((sources) => {
        if (!mounted) return;
        setKbSources(sources);
        setKbError("");
      })
      .catch((error: unknown) => {
        if (mounted) setKbError(kbErrorMessage(error));
      });
    return () => { mounted = false; };
  }, []);
  return { kbSources, kbError };
}

/* ---------- 主视图 ---------- */

export function SettingsView({ index }: ViewProps) {
  const crm = useCrm();
  const ops = useOps();
  const { leads, leadsError, leadsRefreshing, refreshLeadsNow } = useLeadsSnapshotState();
  const { kbSources, kbError } = useKbSourcesState();
  const [demoEnabled, setDemoEnabled] = useState(() => readDemoMode(browserStorage()));

  useEffect(() => subscribeDemoMode(setDemoEnabled), []);

  const toggleDemoMode = useCallback(() => {
    setDemoMode(browserStorage(), browserDocument(), !demoEnabled);
  }, [demoEnabled]);

  const context = useMemo<CapabilityContext>(() => ({
    crmSources: crm.snapshot?.sources ?? {},
    crmMissing: crm.missing,
    crmHasSnapshot: crm.snapshot !== null,
    opsDigest: ops.digest,
    opsMissing: ops.missing,
    leads,
    leadsFailed: Boolean(leadsError),
    kbSources,
    kbFailed: Boolean(kbError),
  }), [crm.missing, crm.snapshot, kbError, kbSources, leads, leadsError, ops.digest, ops.missing]);

  const viewRows = useMemo(() => buildViewCapabilities(context), [context]);
  const globalRows = useMemo(() => buildGlobalCapabilities(context), [context]);
  const configRows = useMemo(() => buildConfigRows(context), [context]);
  const freshnessRows = useMemo(() => buildFreshnessRows({
    indexGeneratedAt: index.generatedAt,
    crmGeneratedAt: crm.snapshot?.generatedAt ?? null,
    crmSources: crm.snapshot?.sources ?? {},
    crmMissing: crm.missing,
    crmHasSnapshot: crm.snapshot !== null,
    opsDigest: ops.digest,
    opsMissing: ops.missing,
    leads,
    kbSources,
    kbFailed: Boolean(kbError),
  }), [crm.missing, crm.snapshot, index.generatedAt, kbError, kbSources, leads, ops.digest, ops.missing]);

  const refresh: Readonly<Record<"crm" | "ops" | "leads", RefreshEntry>> = {
    crm: { running: crm.refresh?.state === "running", run: crm.refreshNow, error: crm.error },
    ops: { running: ops.refresh?.state === "running", run: ops.refreshNow, error: ops.error },
    leads: { running: leadsRefreshing, run: refreshLeadsNow, error: leadsError },
  };

  return (
    <div className="view-stack">
      <ViewHeading
        eyebrow="WORKBENCH SETTINGS / 08"
        title="设置"
        description="能力清单、配置状态与数据新鲜度一览；演示模式开关在本页。除页尾 MCP 服务面板（key 签发/吊销、服务开关、连接器写入）外，本页其余部分只读；MCP 写操作全部走确认闸门并留掩码审计。"
        aside={<StatusBadge tone="blue">只读为主 · MCP 写操作两步确认</StatusBadge>}
      />
      <DemoModeSection enabled={demoEnabled} onToggle={toggleDemoMode} />
      <GaapThresholdSection />
      <CapabilitySection viewRows={viewRows} globalRows={globalRows} />
      <FreshnessSection
        rows={freshnessRows}
        crmSources={crm.snapshot?.sources ?? {}}
        kbSources={kbSources}
        refresh={refresh}
      />
      <ConfigSection rows={configRows} />
      <HealthPanel />
      <McpPanel />
    </div>
  );
}
