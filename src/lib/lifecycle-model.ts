import { buildActionFeed, normalizeTriage, type TriageMap } from "./action-feed.ts";
import type { MaasStatus, PplFollowupBoard, PplFollowupCustomer } from "./crm-model.ts";
import type { CustomerItem, ProjectItem } from "./crm-types";
import type { PplInspectionBundle, PplRecommendation } from "./ppl-client";

// ---------------------------------------------------------------------------
// PPL 生命周期 A→D 四阶段 + 客户触达时间轴（纯函数模型层）。
//
// 阶段映射口径 = 供体 base/sa-workbench assets/models/workflow-model.js 的
// pplStageMap（移植语义不抄代码）：以鲲鹏 stageName 为键精确匹配；开始上量与
// 资源上量共用 projectStage code 6，供体明确禁止按 code / 赢率推断——未知阶段名
// 一律「未归类」，不猜。「签约完成」是 V2 快照实际观察到的阶段名（crm-model 的
// STAGE_BY_NAME 亦按「签约」归 C），供体表未收录，单独标 basis=v2。
// 所有导出均为纯函数：畸形输入降级为空结果，绝不抛错。
// ---------------------------------------------------------------------------

export type LifecyclePhase = "A" | "B" | "C" | "D";
export type PhaseKey = LifecyclePhase | "unclassified";

export interface PhaseMeta {
  readonly id: PhaseKey;
  readonly name: string;
  readonly hint: string;
}

export const LIFECYCLE_PHASES: readonly PhaseMeta[] = [
  { id: "A", name: "识别机会", hint: "潜在商机：从信号到值得经营的客户" },
  { id: "B", name: "塑造方案", hint: "技术方案：从问题到可验证的共同方案" },
  { id: "C", name: "赢单交付", hint: "商机确认 / 商务谈判 / 商务方案 / 合同签署 / 签约完成 / 项目赢单 / 履约完成：从承诺到可验收的业务结果" },
  { id: "D", name: "持续经营", hint: "收入确认 / 开始上量 / 资源上量：从一次交付到复购与组织资产" },
  { id: "unclassified", name: "未归类", hint: "阶段名不在映射表内；不按 projectStage code 或赢率猜，待补映射口径" },
];

export const PHASE_KEYS: readonly PhaseKey[] = ["A", "B", "C", "D", "unclassified"];

export interface PhaseMapping {
  readonly stageName: string;
  readonly phase: LifecyclePhase;
  readonly rank: number;
  readonly basis: "donor" | "v2";
}

/**
 * PPL 阶段名 → 生命周期阶段。rank = 漏斗进展序（供体口径，1 最早期）；
 * 「签约完成」（basis=v2）按语义插在 合同签署(6) 与 项目赢单(7) 之间取 6.5，
 * 不重排供体原有序号。
 */
export const PPL_PHASE_TABLE: readonly PhaseMapping[] = [
  { stageName: "潜在商机", phase: "A", rank: 1, basis: "donor" },
  { stageName: "商机确认", phase: "C", rank: 2, basis: "donor" },
  { stageName: "技术方案", phase: "B", rank: 3, basis: "donor" },
  { stageName: "商务谈判", phase: "C", rank: 4, basis: "donor" },
  { stageName: "商务方案", phase: "C", rank: 5, basis: "donor" },
  { stageName: "合同签署", phase: "C", rank: 6, basis: "donor" },
  { stageName: "签约完成", phase: "C", rank: 6.5, basis: "v2" },
  { stageName: "项目赢单", phase: "C", rank: 7, basis: "donor" },
  { stageName: "履约完成", phase: "C", rank: 8, basis: "donor" },
  { stageName: "收入确认", phase: "D", rank: 9, basis: "donor" },
  { stageName: "开始上量", phase: "D", rank: 10, basis: "donor" },
  { stageName: "资源上量", phase: "D", rank: 11, basis: "donor" },
];

const PHASE_BY_STAGE_NAME: ReadonlyMap<string, PhaseMapping> = new Map(
  PPL_PHASE_TABLE.map((row) => [row.stageName, row]),
);

/** 只按 stageName 精确匹配（首尾空白容忍）；code / 赢率一律不参与推断（供体禁令）。 */
export function pplPhaseOf(project: Pick<ProjectItem, "stageName">): PhaseKey {
  const name = typeof project?.stageName === "string" ? project.stageName.trim() : "";
  return PHASE_BY_STAGE_NAME.get(name)?.phase ?? "unclassified";
}

// ---------------------------------------------------------------------------
// 阶段导航计数与盘面筛选
// ---------------------------------------------------------------------------

export interface PhaseTally {
  readonly projects: number;
  readonly customers: number;
}

export interface PhaseNavCounts {
  readonly phases: Readonly<Record<PhaseKey, PhaseTally>>;
  readonly totalProjects: number;
  readonly unmatchedProjects: number;
  readonly customersWithoutPpl: number;
}

const FOLLOWUP_LANES: readonly MaasStatus[] = ["maas", "non_maas", "unconfirmed"];

function laneRows(board: PplFollowupBoard, lane: MaasStatus): readonly PplFollowupCustomer[] {
  const rows = board?.lanes?.[lane];
  return Array.isArray(rows) ? rows : [];
}

function boardProjects(board: PplFollowupBoard): readonly ProjectItem[] {
  return Array.isArray(board?.unmatched) ? board.unmatched : [];
}

/**
 * 各阶段项目数 / 客户数（客户在同一阶段只计一次，跨阶段各计一次）；
 * 未匹配项目计入项目数但不计客户；无任何 PPL 的客户单独上报、绝不落阶段。
 * 项目数跨阶段守恒：各阶段项目数之和 = totalProjects（泳道内 + 未匹配）。
 */
export function phaseNavCounts(board: PplFollowupBoard): PhaseNavCounts {
  const tally: Record<PhaseKey, PhaseTally> = {
    A: { projects: 0, customers: 0 },
    B: { projects: 0, customers: 0 },
    C: { projects: 0, customers: 0 },
    D: { projects: 0, customers: 0 },
    unclassified: { projects: 0, customers: 0 },
  };
  const bump = (phase: PhaseKey, field: "projects" | "customers"): void => {
    tally[phase] = { ...tally[phase], [field]: tally[phase][field] + 1 };
  };

  let totalProjects = 0;
  let unmatchedProjects = 0;
  let customersWithoutPpl = 0;

  for (const lane of FOLLOWUP_LANES) {
    for (const row of laneRows(board, lane)) {
      const seen = new Set<PhaseKey>();
      for (const project of Array.isArray(row?.projects) ? row.projects : []) {
        totalProjects += 1;
        const phase = pplPhaseOf(project);
        bump(phase, "projects");
        seen.add(phase);
      }
      for (const phase of seen) bump(phase, "customers");
      if (seen.size === 0) customersWithoutPpl += 1;
    }
  }
  for (const project of boardProjects(board)) {
    totalProjects += 1;
    unmatchedProjects += 1;
    bump(pplPhaseOf(project), "projects");
  }

  return { phases: tally, totalProjects, unmatchedProjects, customersWithoutPpl };
}

/**
 * 阶段筛选（null = 全部，返回原看板引用）：无命中项目的客户隐藏，未匹配项目同口径过滤；
 * 计数不可变重算（可见项目数 = 泳道内 + 未匹配）。
 */
export function filterFollowupByPhase(board: PplFollowupBoard, phase: PhaseKey | null): PplFollowupBoard {
  if (phase === null) return board;
  const keep = (project: ProjectItem) => pplPhaseOf(project) === phase;
  const lanes: Record<MaasStatus, PplFollowupCustomer[]> = { maas: [], non_maas: [], unconfirmed: [] };
  for (const lane of FOLLOWUP_LANES) {
    lanes[lane] = laneRows(board, lane)
      .map((row) => ({ ...row, projects: (Array.isArray(row?.projects) ? row.projects : []).filter(keep) }))
      .filter((row) => row.projects.length > 0);
  }
  const unmatched = boardProjects(board).filter(keep);
  const visibleProjects = FOLLOWUP_LANES.reduce(
    (sum, lane) => sum + lanes[lane].reduce((count, row) => count + row.projects.length, 0),
    0,
  ) + unmatched.length;
  return {
    lanes,
    unmatched,
    counts: {
      customers: FOLLOWUP_LANES.reduce((sum, lane) => sum + lanes[lane].length, 0),
      maas: lanes.maas.length,
      nonMaas: lanes.non_maas.length,
      unconfirmed: lanes.unconfirmed.length,
      projects: visibleProjects,
      unmatched: unmatched.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 客户触达时间轴：本机可得八源合并（followup/relate/project/contract/gaap/
// inspection/approval/triage），按时间倒序；无法解析的时间计入 skipped，
// 绝不臆造日期。
// ---------------------------------------------------------------------------

export type TouchSource = "followup" | "relate" | "project" | "contract" | "gaap" | "inspection" | "approval" | "triage";

export interface TouchEvent {
  readonly key: string;
  readonly at: number;
  readonly dayOnly: boolean;
  readonly source: TouchSource;
  readonly title: string;
  readonly detail: string | null;
  readonly planned: boolean;
}

export const TOUCH_SOURCE_LABEL: Readonly<Record<TouchSource, string>> = {
  followup: "跟进",
  relate: "关联",
  project: "项目",
  contract: "预计签约",
  gaap: "GAAP",
  inspection: "巡检",
  approval: "授权",
  triage: "处理",
};

export interface TimelineInput {
  readonly customer: CustomerItem;
  /** 该客户名下的项目（调用方按归属过滤；模型不按 state 二次过滤）。 */
  readonly projects: readonly ProjectItem[];
  readonly inspection?: PplInspectionBundle | null;
  readonly triage?: TriageMap;
  readonly now: number;
}

export interface CustomerTimeline {
  readonly events: readonly TouchEvent[];
  readonly skipped: number;
}

/** 严格时间解析：YYYY-MM-DD[ T]HH:mm[:ss[.f…]][Z|±HH[:mm]]。带时区按绝对时刻，否则按本地时间；月/日/时/分越界或日期回卷一律 null。 */
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function parseTimelineTime(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const match = TIME_RE.exec(text);
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = match;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  if (zone) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  const check = new Date(ms);
  return check.getFullYear() === Number(y) && check.getMonth() === Number(mo) - 1 && check.getDate() === Number(d)
    ? ms
    : null;
}

function isPresentText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 巡检推荐归属：cid 命中优先；推荐无 cid 时按客户名兜底（同名以快照客户名为准）。 */
function recommendationMatches(rec: PplRecommendation, customer: CustomerItem): boolean {
  if (typeof rec.cid === "string" && rec.cid !== "") return rec.cid === customer.cid;
  return rec.customerName === customer.name;
}

function projectLabel(project: ProjectItem): string {
  return typeof project.name === "string" && project.name.trim() !== "" ? project.name.trim() : "未命名项目";
}

function stageLabel(project: ProjectItem): string {
  return typeof project.stageName === "string" && project.stageName.trim() !== "" ? project.stageName.trim() : "阶段未知";
}

/**
 * 合并客户触达时间轴（时间倒序）：
 * - followup = 客户最近跟进（lastNoteAt，无时区串按本地时间）；
 * - relate = 客户关联记录（relatedAt 以「/」分隔的多段时间）；
 * - project / contract / gaap = 逐项目 创建 / 预计签约 / 预计 GAAP 起算（ISO 按绝对时刻）；
 * - inspection / approval = 本机 PPL 巡检推荐与决策（仅 state=ok 巡检；cid 命中 + 客户名兜底；
 *   approve 只写本机授权，不等于已创建鲲鹏项目）；
 * - triage = 本机行动队列的已处理/已忽略记录（与队列同一套键）。
 * planned = 事件时刻晚于 now（未来计划）；dayOnly = 日粒度字段（预计签约 / GAAP 起算）。
 * 存在但解析失败的时间计入 skipped（缺席字段不计）；畸形输入降级为空。
 */
export function customerTimeline(input: TimelineInput): CustomerTimeline {
  if (!input || typeof input !== "object") return { events: [], skipped: 0 };
  const customer = input.customer;
  if (!customer || typeof customer !== "object") return { events: [], skipped: 0 };
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const now = Number.isFinite(input.now) && input.now > 0 ? input.now : Date.now();
  const events: TouchEvent[] = [];
  let skipped = 0;
  const add = (event: Omit<TouchEvent, "planned">): void => {
    events.push({ ...event, planned: event.at > now });
  };

  // —— 客户字段：跟进 / 关联 ——
  const noteAt = parseTimelineTime(customer.lastNoteAt);
  if (noteAt === null) {
    if (isPresentText(customer.lastNoteAt)) skipped += 1;
  } else {
    add({ key: "followup:lastNoteAt", at: noteAt, dayOnly: false, source: "followup", title: "最近跟进记录", detail: null });
  }
  const relateParts = typeof customer.relatedAt === "string" && customer.relatedAt.trim() !== ""
    ? customer.relatedAt.split("/")
    : [];
  relateParts.forEach((part, index) => {
    const at = parseTimelineTime(part);
    if (at === null) {
      if (isPresentText(part)) skipped += 1;
      return;
    }
    add({ key: `relate:${index}`, at, dayOnly: false, source: "relate", title: "客户关联", detail: null });
  });

  // —— 逐项目：创建 / 预计签约 / 预计 GAAP 起算 ——
  projects.forEach((project, index) => {
    if (!project || typeof project !== "object") return;
    const id = typeof project.id === "string" && project.id !== "" ? project.id : `#${index}`;
    const summary = `${projectLabel(project)} · ${stageLabel(project)}`;
    const created = parseTimelineTime(project.createdAt);
    if (created === null) {
      if (isPresentText(project.createdAt)) skipped += 1;
    } else {
      add({ key: `project:${id}`, at: created, dayOnly: false, source: "project", title: "项目创建", detail: summary });
    }
    const contract = parseTimelineTime(project.expectedContractDate);
    if (contract === null) {
      if (isPresentText(project.expectedContractDate)) skipped += 1;
    } else {
      add({ key: `contract:${id}`, at: contract, dayOnly: true, source: "contract", title: "预计签约", detail: summary });
    }
    const gaap = parseTimelineTime(project.expectedGaapStartDate);
    if (gaap === null) {
      if (isPresentText(project.expectedGaapStartDate)) skipped += 1;
    } else {
      add({ key: `gaap:${id}`, at: gaap, dayOnly: true, source: "gaap", title: "预计 GAAP 起算", detail: summary });
    }
  });

  // —— 本机 PPL 巡检：推荐（触达）+ 决策（仅授权，未创建） ——
  const bundle = input.inspection;
  if (bundle && typeof bundle === "object" && bundle.inspection && typeof bundle.inspection === "object") {
    const inspection = bundle.inspection;
    // 失败 / 非 ok 巡检的推荐不作触达（与 pplInspectionStatus 同口径），其决策一并不并入。
    if (inspection.state === "ok") {
      const recs = (Array.isArray(inspection.recommendations) ? inspection.recommendations : [])
        .filter((rec) => rec && typeof rec === "object" && typeof rec.id === "string" && typeof rec.customerName === "string");
      const generatedAt = parseTimelineTime(inspection.generatedAt);
      if (isPresentText(inspection.generatedAt) && generatedAt === null) skipped += 1;
      if (generatedAt !== null) {
        for (const rec of recs) {
          if (!recommendationMatches(rec, customer)) continue;
          const amount = typeof rec.amountYuan === "number" ? `${rec.amountYuan.toLocaleString("zh-CN")} 元` : null;
          add({
            key: `inspection:${rec.id}`,
            at: generatedAt,
            dayOnly: false,
            source: "inspection",
            title: `PPL 巡检推荐：${rec.opportunityType}`,
            detail: [rec.suggestedProjectName, amount].filter(Boolean).join(" · ") || null,
          });
        }
      }
      const byId = new Map(recs.map((rec) => [rec.id, rec]));
      for (const decision of Array.isArray(bundle.decisions) ? bundle.decisions : []) {
        if (!decision || typeof decision !== "object") continue;
        if (typeof decision.recommendationId !== "string") continue;
        if (decision.action !== "approve" && decision.action !== "discard") continue;
        const rec = byId.get(decision.recommendationId);
        if (!rec || !recommendationMatches(rec, customer)) continue;
        const at = parseTimelineTime(decision.decidedAt);
        if (at === null) {
          if (isPresentText(decision.decidedAt)) skipped += 1;
          continue;
        }
        add({
          key: `approval:${decision.id}`,
          at,
          dayOnly: false,
          source: "approval",
          title: decision.action === "approve" ? "同意推荐 · 仅授权，未创建鲲鹏项目" : "忽略推荐（本机）",
          detail: rec.suggestedProjectName,
        });
      }
    }
  }

  // —— 本机行动队列 triage：与队列同一套键（重建该客户的 PPL 队列项后按键命中） ——
  const triage = normalizeTriage(input.triage);
  if (Object.keys(triage).length > 0) {
    const feed = buildActionFeed(
      { todos: [], agenda: [], mentions: [], customers: [customer], projects },
      { now, triage, showHandled: true },
    );
    for (const item of feed.items) {
      if (item.kind !== "ppl") continue;
      const entry = triage[item.key];
      if (!entry) continue;
      const at = parseTimelineTime(entry.at);
      if (at === null) {
        skipped += 1;
        continue;
      }
      add({
        key: `triage:${item.key}`,
        at,
        dayOnly: false,
        source: "triage",
        title: `${entry.s === "done" ? "已处理" : "已忽略"}：${item.detail}`,
        detail: item.title,
      });
    }
  }

  events.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  return { events, skipped };
}
