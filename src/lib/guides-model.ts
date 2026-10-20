/**
 * 接入指引注册表（TS 移植自 base/sa-workbench assets/models/guides-model.js）。
 *
 * 指引 = 分步引导用户完成一个产品依赖的接入。步骤四类：
 *   check  只读检测（bin / dwsSession / file / cap / aitable-verify）
 *   action 写动作（terminal=展示命令人工执行；aitable-provision=一键建表写配置，必经二次确认；refresh=触发刷新组）
 *   input  手填回退（粘贴既有配置，P2 备用）
 *   done   完成态
 * fix.cmd + terminal:true → 桥离线 / 需交互时降级为「终端执行」提示。
 *
 * 纯数据 + 纯函数查找：浏览器渲染与 dev/guides 桥执行共用同一份定义，不含任何凭据值。
 */

export const GUIDES_MODEL_VERSION = "2026-10-17";

export type CheckType = "bin" | "dwsSession" | "file" | "cap" | "aitable-verify";

export interface StepCheck {
  readonly type: CheckType;
  /** check.type=bin：待探测的可执行名。 */
  readonly name?: string;
  /** check.type=file：待探测的相对路径。 */
  readonly path?: string;
  /** check.type=cap：能力 id。 */
  readonly id?: string;
  /** check.type=aitable-verify：schema id 列表。 */
  readonly schemas?: readonly string[];
}

export type ActionType = "terminal" | "aitable-provision" | "refresh";

export interface StepAction {
  readonly type: ActionType;
  /** action.type=terminal：只回显、绝不执行的命令文本。 */
  readonly cmd?: string;
  /** action.type=aitable-provision：schema id 列表。 */
  readonly schemas?: readonly string[];
  /** action.type=refresh：刷新组 id。 */
  readonly group?: string;
}

export interface StepFix {
  readonly cmd: string;
  readonly terminal: boolean;
  readonly label: string;
}

export type StepKind = "check" | "action" | "input" | "done";

export interface GuideStep {
  readonly id: string;
  readonly kind: StepKind;
  readonly t: string;
  readonly d?: string;
  readonly check?: StepCheck;
  readonly action?: StepAction;
  readonly fix?: StepFix;
  readonly needConfirm?: boolean;
  readonly confirm?: string;
}

export type GuideKind = "base" | "aitable";

export interface Guide {
  readonly id: string;
  readonly t: string;
  readonly d: string;
  readonly kind: GuideKind;
  readonly schemas?: readonly string[];
  readonly cap?: string | null;
  readonly steps: readonly GuideStep[];
}

/** 8 个 AI 表格依赖点：schema id（aitable_schemas）→ 指引文案与关联能力。 */
interface AitableDep {
  readonly schema: string;
  readonly guide: string;
  readonly cap: string | null;
  readonly t: string;
  readonly d: string;
}

const AITABLE: readonly AitableDep[] = [
  { schema: "leads", guide: "aitable-leads", cap: "leads", t: "拓新雷达 · AI 表格接入", d: "创建「拓新企业清单」表并写入 tools/aitable_leads.json" },
  { schema: "relations", guide: "aitable-relations", cap: "relations", t: "协作关系台账 · AI 表格接入", d: "创建「协作关系表」并写入 tools/aitable_relations.json" },
  { schema: "daily", guide: "aitable-daily", cap: "aitableDaily", t: "Agent&MaaS 日报 · AI 表格接入", d: "创建「Agent&MaaS日报」表并写入 tools/aitable_daily.json" },
  { schema: "worklog", guide: "aitable-worklog", cap: "worklog", t: "历史工作 · AI 表格接入", d: "创建「历史工作记录」表并写入 tools/aitable_worklog.json" },
  { schema: "custfiles", guide: "aitable-custfiles", cap: "custfiles", t: "客户文件清单 · AI 表格接入", d: "创建「客户文件清单」表并写入 tools/aitable_custfiles.json" },
  { schema: "dttask", guide: "aitable-dttask", cap: null, t: "会话/任务台账 · AI 表格接入", d: "创建「钉钉会话台账」「与我有关任务」两表并写入 tools/aitable_dttask.json" },
  { schema: "daily_report", guide: "aitable-daily-report", cap: "report", t: "日周报 · AI 表格接入", d: "创建「日报记录」表并写入 tools/daily_report.json（oa/weekly/remote 段需后续手工补全）" },
  { schema: "business", guide: "aitable-business", cap: null, t: "业务域回写 · AI 表格接入", d: "创建客户主数据等 4 表并写入 tools/aitable_business.json" },
];

const DWS_STEP: GuideStep = {
  id: "dws", kind: "check", t: "钉钉 DWS 登录态",
  d: "dws CLI 已安装且钉钉授权在有效期内",
  check: { type: "dwsSession" },
  fix: { cmd: "dws auth login", terminal: true, label: "终端执行 dws auth login" },
};

function aitableGuide(a: AitableDep): Guide {
  const steps: GuideStep[] = [
    DWS_STEP,
    {
      id: "provision", kind: "action", t: "一键建表并写入配置",
      d: "在钉钉侧创建（或复用同名）「SA 工作台数据」多维表与所需数据表，读回字段后自动写入本地配置",
      action: { type: "aitable-provision", schemas: [a.schema] },
      needConfirm: true,
      confirm: "将在你的钉钉创建/复用「SA 工作台数据」多维表及数据表，并把 baseId / tableId / 字段映射写入 " + a.d.replace(/^.*写入 /, "") + "。继续？",
    },
    { id: "verify", kind: "check", t: "校验表结构", d: "读回远端表，确认必需字段齐备", check: { type: "aitable-verify", schemas: [a.schema] } },
  ];
  if (a.cap) steps.push({ id: "cap", kind: "check", t: "能力就绪复查", d: "能力注册表重新判定", check: { type: "cap", id: a.cap } });
  steps.push({ id: "done", kind: "done", t: "接入完成", d: "对应插件已可开启；数据首拉见各页刷新入口" });
  return { id: a.guide, t: a.t, d: a.d, kind: "aitable", schemas: [a.schema], cap: a.cap, steps };
}

export const guides: readonly Guide[] = [
  {
    id: "dws", t: "钉钉 DWS 接入", d: "钉钉数据源的总前置：CLI 在位 + 授权有效", kind: "base",
    steps: [
      { id: "bin", kind: "check", t: "检测 dws CLI", d: "默认解析 ~/.qoder/bin/dws，可在系统设置覆盖", check: { type: "bin", name: "dws" }, fix: { cmd: "", terminal: true, label: "dws 随 Qoder 安装（~/.qoder/bin/dws）" } },
      { id: "auth", kind: "action", t: "钉钉授权登录", d: "需在本机终端交互完成（浏览器扫码）", action: { type: "terminal", cmd: "dws auth login" } },
      { id: "verify", kind: "check", t: "验证登录态", check: { type: "dwsSession" }, fix: DWS_STEP.fix },
      { id: "done", kind: "done", t: "接入完成", d: "钉钉类能力（dingtalk / presales / ops 等）可继续接入" },
    ],
  },
  {
    id: "aitable-all", t: "AI 表格一键接入（全部）", d: "一次建好 8 个依赖点所需的全部数据表", kind: "aitable",
    schemas: AITABLE.map((a) => a.schema), cap: null,
    steps: [
      DWS_STEP,
      {
        id: "provision", kind: "action", t: "一键建表（12 张表）并写入全部配置",
        d: "在钉钉侧创建（或复用同名）「SA 工作台数据」多维表，批量建好全部数据表并写回 8 个 tools 配置",
        action: { type: "aitable-provision", schemas: AITABLE.map((a) => a.schema) },
        needConfirm: true,
        confirm: "将在你的钉钉创建/复用「SA 工作台数据」多维表并批量建 12 张数据表，写回 8 个 tools/aitable_*.json 配置。继续？",
      },
      { id: "verify", kind: "check", t: "逐表校验", d: "8 个配置逐一读回校验", check: { type: "aitable-verify", schemas: AITABLE.map((a) => a.schema) } },
      { id: "done", kind: "done", t: "全部接入完成", d: "插件中心可开启 AI 表格类页面" },
    ],
  },
  ...AITABLE.map(aitableGuide),
];

export function guideOf(id: string): Guide | undefined {
  return guides.find((g) => g.id === id);
}

export function stepOf(guide: Guide, stepId: string): GuideStep | undefined {
  return guide.steps.find((s) => s.id === stepId);
}

/** 全部 aitable-provision 涉及的 schema id（去重保序）。 */
export function provisionSchemas(): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of guides) {
    for (const s of g.steps) {
      if (s.action?.type === "aitable-provision") {
        for (const sc of s.action.schemas ?? []) {
          if (!seen.has(sc)) {
            seen.add(sc);
            out.push(sc);
          }
        }
      }
    }
  }
  return out;
}
