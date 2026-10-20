/**
 * Worklog model — 工作清单「采集后分类」的纯函数层（浏览器与本地桥共用同一口径）。
 * donor: base/sa-workbench assets/models/workflow-model.js（九环节 + keywords）与
 * tools/fetch/worklog_classify.js（打分/置信度/聚类）、worklog_live.js ruleStage
 * （搬语义不搬代码）。零依赖、零 I/O、零时钟：nowMs 一律显式注入。
 *
 * 口径：
 * - 环节打分：标题归一化（小写、去空白）后按 stage keywords 命中计分，
 *   关键词 ≥4 字计 4 分、否则 3 分（donor classify 同口径）；
 * - stageId 只在最高分 ≥3 时给出，否则 null（未分类，如实不猜）；
 *   置信度 ≥10 high / ≥5 medium / 其余 low（donor classify 阈值）；
 * - 聚类沿用 donor CLUSTERS 八组模式词，全不中落「其他模式」；
 * - 时间范围：days 与 from/to 二选一，1~366 天，本地时区日历日，to 含当日。
 */

/** 分类置信度（donor：high ≥10 分 / medium ≥5 分 / low 其余）。 */
export type WorklogConfidence = "high" | "medium" | "low";

export interface WorklogStage {
  readonly id: string;
  readonly no: string;
  readonly name: string;
  readonly phase: string;
  readonly keywords: readonly string[];
}

/** SA 全生命周期九环节（donor workflow-model.js stages 的 id/no/name/phase/keywords 投影）。 */
export const WORKLOG_STAGES: readonly WorklogStage[] = [
  { id: "insight", no: "01", name: "洞察与拓新", phase: "discover", keywords: ["拓新", "融资日报", "投资企业", "企业清单", "联系方式", "一级市场", "拓客", "商机crm扫描", "waic", "目标客户", "客户名单", "热点清单"] },
  { id: "account", no: "02", name: "客户建档与关系", phase: "discover", keywords: ["客户情况", "企业信息", "企查查", "企典", "我的客户", "客户画像", "客户盘面", "客户分层", "客户运营", "客户材料", "客户清单", "crm查询", "鲲鹏客户"] },
  { id: "discovery", no: "03", name: "需求澄清", phase: "shape", keywords: ["需求分析", "需求拆解", "需求澄清", "问题清单", "卡点", "评估项", "用户故事", "prd", "brd", "招标需求", "读取客户需求", "需求回顾", "调研问卷", "调查问卷"] },
  { id: "solution", no: "04", name: "方案与架构", phase: "shape", keywords: ["方案设计", "解决方案", "架构", "体系建设", "合作方向", "技术方案", "实施方案", "网络方案", "全景架构", "sop", "流程方案", "战略合作"] },
  { id: "validate", no: "05", name: "验证与测算", phase: "shape", keywords: ["测算", "压测", "测试报告", "poc", "demo", "验证", "成本", "报价", "资源需求", "配置清单", "费用", "tpm", "token", "gpu", "带宽", "规格", "台数", "性能指标", "读取图纸"] },
  { id: "opportunity", no: "06", name: "商机与决策", phase: "land", keywords: ["投标", "标书", "技术标", "高层交流", "谈参", "汇报材料", "交流材料", "报价单", "采购", "招标", "商机", "ppl", "赢率", "交流大纲", "汇报方案"] },
  { id: "delivery", no: "07", name: "交付与上线", phase: "land", keywords: ["部署", "上线", "发布", "交付", "验收", "排查", "修复", "故障", "环境", "流水线", "容器", "ecs", "podman", "nginx", "迁移", "联通", "实施"] },
  { id: "operate", no: "08", name: "运营与增购", phase: "grow", keywords: ["运营", "消费明细", "用量", "gaap", "上量", "限流", "健康", "月消费", "日报", "周报", "看板取数", "客户跟进", "待办", "催办", "监控告警"] },
  { id: "reuse", no: "09", name: "复盘与沉淀", phase: "grow", keywords: ["沉淀", "知识库", "技能", "skill", "分享", "培训", "ppt", "材料", "文章", "案例", "复盘", "总结", "归档", "模板", "工作台", "平台建设", "数字员工", "自动化", "mcp", "文档"] },
];

export const WORKLOG_STAGE_IDS: ReadonlySet<string> = new Set(WORKLOG_STAGES.map((s) => s.id));

/** 工作模式聚类（donor worklog_classify.js CLUSTERS）。 */
export const WORKLOG_CLUSTERS: readonly { readonly name: string; readonly words: readonly string[] }[] = [
  { name: "材料制作与优化", words: ["ppt", "材料", "汇报", "大纲", "页面", "html", "导出", "文案", "文章"] },
  { name: "调研与选型", words: ["调研", "选型", "对比", "分析", "评估", "搜索", "查询"] },
  { name: "测算与报价", words: ["测算", "报价", "成本", "tpm", "token", "gpu", "带宽", "规格"] },
  { name: "部署与排障", words: ["部署", "排查", "修复", "上线", "发布", "环境", "流水线", "容器"] },
  { name: "数据采集与报表", words: ["取数", "提取", "清单", "报表", "看板", "数据", "excel"] },
  { name: "智能体与自动化", words: ["数字员工", "自动化", "qoderwake", "mcp", "agent", "定时任务"] },
  { name: "知识与技能", words: ["知识库", "skill", "技能", "沉淀", "培训", "教程", "模板"] },
  { name: "客户经营与跟进", words: ["客户", "crm", "跟进", "商机", "运营", "消费", "gaap"] },
];
export const WORKLOG_CLUSTER_FALLBACK = "其他模式";

/** 范围上限（天）与缺省窗口（donor LIVE 只看近几天，工作台默认给一周）。 */
export const WORKLOG_MAX_RANGE_DAYS = 366;
export const WORKLOG_DEFAULT_DAYS = 7;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 归一化（donor normalize）：小写 + 去全部空白。 */
export function normalizeWorklogText(value: string): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}

/** 本地时区 YYYY-MM-DD（donor collect.localDate 同口径）。 */
export function worklogLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 标题 → 环节（纯函数）：关键词命中计分（≥4 字 4 分、否则 3 分），最高分 ≥3 才给
 * stageId（并列时按 WORKLOG_STAGES 顺序取先者，稳定），否则 null 如实未分类。
 */
export function classifyWorklogTitle(title: string): { stageId: string | null; confidence: WorklogConfidence; score: number } {
  const text = normalizeWorklogText(title);
  let bestId: string | null = null;
  let bestScore = 0;
  for (const stage of WORKLOG_STAGES) {
    let score = 0;
    for (const keyword of stage.keywords) {
      const nk = normalizeWorklogText(keyword);
      if (nk && text.includes(nk)) score += nk.length >= 4 ? 4 : 3;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = stage.id;
    }
  }
  const confidence: WorklogConfidence = bestScore >= 10 ? "high" : bestScore >= 5 ? "medium" : "low";
  return { stageId: bestScore >= 3 ? bestId : null, confidence, score: bestScore };
}

/** 标题 → 工作模式聚类（donor cluster）：命中词最多的组，全不中落「其他模式」。 */
export function clusterOfWorklogTitle(title: string): string {
  const text = normalizeWorklogText(title);
  let bestName = WORKLOG_CLUSTER_FALLBACK;
  let bestScore = 0;
  for (const cluster of WORKLOG_CLUSTERS) {
    const score = cluster.words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestName = cluster.name;
    }
  }
  return bestName;
}

/** 计数聚合（donor countBy）：空键落「未标记」。 */
export function countWorklogBy<T>(list: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list) {
    const k = key(item) || "未标记";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** 计数对象 → 降序 top N（donor topEntries）。 */
export function topWorklogEntries(obj: Readonly<Record<string, number>>, max: number): { name: string; count: number }[] {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, count]) => ({ name, count }));
}

export interface WorklogSessionInput {
  readonly sourceKey: string;
  readonly instance: string;
  readonly ts: number;
  readonly title: string;
}

export interface WorklogClassifiedEntry {
  readonly sourceKey: string;
  readonly instance: string;
  readonly date: string;
  readonly ts: number;
  readonly title: string;
  readonly stageId: string | null;
  readonly confidence: WorklogConfidence;
  readonly cluster: string;
}

/** 采集会话 → 分类条目（纯映射，不排序不截断、不改动输入）。 */
export function classifyWorklogEntries(items: readonly WorklogSessionInput[]): WorklogClassifiedEntry[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const { stageId, confidence } = classifyWorklogTitle(item.title);
    return {
      sourceKey: item.sourceKey,
      instance: item.instance,
      date: worklogLocalDate(item.ts),
      ts: item.ts,
      title: item.title,
      stageId,
      confidence,
      cluster: clusterOfWorklogTitle(item.title),
    };
  });
}

export interface WorklogSummaryCore {
  readonly total: number;
  readonly byDay: readonly { readonly date: string; readonly count: number }[];
  readonly byStage: readonly { readonly id: string; readonly name: string; readonly count: number; readonly highConfidence: number }[];
  readonly byCluster: readonly { readonly name: string; readonly count: number }[];
  readonly unclassified: number;
}

/** 按日（升序）/按环节（九环节零填充，形状稳定）/按聚类聚合 + 未分类计数。 */
export function summarizeWorklog(entries: readonly WorklogClassifiedEntry[]): WorklogSummaryCore {
  const list = Array.isArray(entries) ? entries : [];
  const dayCounts = countWorklogBy(list, (x) => x.date);
  const byDay = Object.entries(dayCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
  const byStage = WORKLOG_STAGES.map((stage) => {
    const rows = list.filter((x) => x.stageId === stage.id);
    return { id: stage.id, name: stage.name, count: rows.length, highConfidence: rows.filter((x) => x.confidence === "high").length };
  });
  const byCluster = topWorklogEntries(countWorklogBy(list, (x) => x.cluster), WORKLOG_CLUSTERS.length);
  return { total: list.length, byDay, byStage, byCluster, unclassified: list.filter((x) => x.stageId === null).length };
}

export interface WorklogRange {
  readonly from: string;
  readonly to: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export type WorklogRangeResult =
  | { readonly ok: true; readonly range: WorklogRange; readonly days: number }
  | { readonly ok: false; readonly reason: string };

const invalid = (reason: string): WorklogRangeResult => ({ ok: false, reason });

/** 解析本地日历日（严格 YYYY-MM-DD + 真实日期回验；失败返回 null）。 */
function parseLocalDate(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function rangeOfDates(fromDate: Date, toDate: Date): WorklogRangeResult {
  const fromMidnight = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const toMidnight = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  const fromMs = fromMidnight.getTime();
  const toMs = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59, 999).getTime();
  const days = Math.round((toMidnight.getTime() - fromMs) / DAY_MS) + 1;
  return {
    ok: true,
    days,
    range: { from: worklogLocalDate(fromMs), to: worklogLocalDate(toMs), fromMs, toMs },
  };
}

/**
 * 时间范围解析（桥侧 400 校验与前端构参共用同一口径）：
 * - days=1~366（与 from/to 互斥）；缺省最近 WORKLOG_DEFAULT_DAYS 天；
 * - from/to 必须成对、严格 YYYY-MM-DD、真实日历日、from ≤ to、跨度 ≤366 天；
 * - to 含当日（本地 23:59:59.999）。失败给可直接展示的中文 reason。
 */
export function resolveWorklogRange(params: URLSearchParams, nowMs: number): WorklogRangeResult {
  const daysRaw = params.get("days");
  const fromRaw = params.get("from");
  const toRaw = params.get("to");

  if (daysRaw !== null && (fromRaw !== null || toRaw !== null)) {
    return invalid("days 与 from/to 不能混用：请二选一。");
  }

  if (daysRaw === null && fromRaw === null && toRaw === null) {
    const to = new Date(nowMs);
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (WORKLOG_DEFAULT_DAYS - 1));
    return rangeOfDates(from, to);
  }

  if (daysRaw !== null) {
    if (!/^\d{1,3}$/.test(daysRaw)) return invalid(`days 必须是 1~${WORKLOG_MAX_RANGE_DAYS} 的整数。`);
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > WORKLOG_MAX_RANGE_DAYS) {
      return invalid(`days 必须是 1~${WORKLOG_MAX_RANGE_DAYS} 的整数。`);
    }
    const to = new Date(nowMs);
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days - 1));
    return rangeOfDates(from, to);
  }

  if (fromRaw === null || toRaw === null) return invalid("from 与 to 必须同时提供。");
  if (!DATE_PATTERN.test(fromRaw) || !DATE_PATTERN.test(toRaw)) {
    return invalid("from/to 必须是 YYYY-MM-DD 格式的日期。");
  }
  const fromDate = parseLocalDate(fromRaw);
  if (!fromDate) return invalid(`from=${fromRaw} 不是有效日历日期。`);
  const toDate = parseLocalDate(toRaw);
  if (!toDate) return invalid(`to=${toRaw} 不是有效日历日期。`);
  if (fromDate.getTime() > toDate.getTime()) return invalid("from 不能晚于 to。");
  const spanDays = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
  if (spanDays > WORKLOG_MAX_RANGE_DAYS) {
    return invalid(`跨度超过 ${WORKLOG_MAX_RANGE_DAYS} 天：请缩小时间范围（当前 ${spanDays} 天）。`);
  }
  return rangeOfDates(fromDate, toDate);
}
