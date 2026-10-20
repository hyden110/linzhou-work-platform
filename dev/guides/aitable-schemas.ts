/**
 * AI 表格建表 schema 登记（TS 移植自 base/sa-workbench scripts/lib/aitable_schemas.js，
 * 结构来源唯一；business 四表字段随 donor tools/aitable_business_schema.json 内联）。
 *
 * v2 口径差异：configFile 落 .local-cache/*.json（leads 复用既有 leads.json，与
 * dev/leads/leads-config.ts 同路径）；字段级 config（formatter/options）不随建表登记——
 * 与 donor bootstrap 出参一致（只发 fieldName+type），钉钉在写入时自建选项。
 *
 * mode：
 *   name          配置只含 baseId/tableId/tableName（消费方按字段名映射：leads/relations/daily）
 *   fields        配置含 fields{key:{id,name,type}}（消费方按字段 id 取数：worklog/custfiles/daily_report）
 *   tables-fields 多表且各表含 fields 映射（dttask：conv + task）
 *   idonly        多表只登记 tables.{key}.{id,name}（business）
 */

export const BASE_NAME = "SA 工作台数据";

export interface SchemaField {
  readonly fieldName: string;
  readonly type: string;
  readonly key?: string;
}

export interface SchemaTable {
  readonly key: string | null;
  readonly tableName: string;
  readonly fields: readonly SchemaField[];
}

export type SchemaMode = "name" | "fields" | "tables-fields" | "idonly";

export interface TableSchema {
  readonly id: string;
  readonly cap: string | null;
  /** cacheDir 相对路径。 */
  readonly configFile: string;
  readonly mode: SchemaMode;
  readonly note?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly requiredNames?: readonly string[];
  readonly tables: readonly SchemaTable[];
}

function f(fieldName: string, type: string, key?: string): SchemaField {
  return key ? { fieldName, type, key } : { fieldName, type };
}

interface RawSchema extends Omit<TableSchema, "tables"> {
  readonly tableName?: string;
  readonly fields?: readonly SchemaField[];
  readonly tables?: readonly SchemaTable[];
}

const BUSINESS_TABLES: readonly SchemaTable[] = [
  {
    key: "customers", tableName: "客户主数据",
    fields: [
      f("客户名称", "text"), f("customerKey", "text"), f("ECID", "text"), f("CID", "text"),
      f("工商全称", "text"), f("GC", "text"), f("业务标签", "text"), f("行业", "text"),
      f("区域", "text"), f("客户层级", "text"), f("价值评分", "number"), f("融资轮次", "text"),
      f("员工规模", "number"), f("技术招聘", "text"), f("来源更新时间", "date"),
    ],
  },
  {
    key: "customerAliases", tableName: "客户标识映射",
    fields: [
      f("标识", "text"), f("customerKey", "text"), f("标识类型", "singleSelect"), f("标识值", "text"),
      f("客户名称", "text"), f("来源", "singleSelect"), f("有效", "checkbox"), f("来源更新时间", "date"),
    ],
  },
  {
    key: "customerMetrics", tableName: "客户经营快照_FY27",
    fields: [
      f("快照键", "text"), f("customerKey", "text"), f("客户名称", "text"), f("统计日期", "date"),
      f("上月GAAP", "number"), f("日GAAP", "number"), f("日环比", "number"), f("GC", "text"),
      f("业务标签", "text"), f("区域", "text"), f("来源", "singleSelect"), f("syncRunId", "text"),
      f("采集时间", "date"), f("记录状态", "singleSelect"),
    ],
  },
  {
    key: "ppl", tableName: "商务项目",
    fields: [
      f("项目名称", "text"), f("projectId", "text"), f("customerKey", "text"), f("客户名称", "text"),
      f("CID", "text"), f("ECID", "text"), f("项目阶段", "text"), f("阶段中文", "text"),
      f("项目金额", "currency"), f("项目类别", "text"), f("赢率", "number"), f("预计GAAP日期", "date"),
      f("商务负责人", "text"), f("客户池内", "checkbox"), f("来源更新时间", "date"),
    ],
  },
];

const RAW_SCHEMAS: readonly RawSchema[] = [
  {
    id: "leads", cap: "leads", configFile: "leads.json",
    tableName: "拓新企业清单", mode: "name",
    fields: [
      f("企业名称", "text"), f("综合分", "number"), f("优先级", "singleSelect"), f("Name判定", "singleSelect"),
      f("CRM状态", "text"), f("CRM客户名", "text"), f("CID", "text"), f("ECID", "text"), f("法律实体", "text"),
      f("赛道", "text"), f("一句话", "text"), f("省份", "text"), f("城市", "text"), f("注册地址", "text"),
      f("注册资本", "text"), f("成立日期", "text"), f("法定代表人", "text"), f("创始人", "text"),
      f("电话", "text"), f("邮箱", "text"), f("官网", "text"), f("最新融资额", "text"), f("融资阶段", "text"),
      f("领投方", "text"), f("最新信号时间", "date"), f("雷达更新时间", "date"), f("最新资讯", "url"),
      f("信号类型", "text"), f("提及次数(14天)", "number"), f("关联UID数", "number"), f("数据来源", "text"),
      f("MaaS匹配", "text"), f("MaaS产品", "text"), f("MaaS分析", "text"), f("Agent席位潜力", "text"),
      f("Agent分析", "text"), f("Qoder匹配", "text"), f("千问办公匹配", "text"), f("合作要点", "text"),
      f("竞争风险", "text"), f("阿里关联", "text"), f("跟进团队", "text"), f("跟进人", "text"),
      f("建联方式建议", "text"), f("企典状态", "text"), f("序号", "number"),
    ],
    requiredNames: ["企业名称", "Name判定", "CRM状态", "综合分", "省份", "城市", "赛道", "一句话", "最新信号时间", "CID"],
    extra: { priorityProvinces: ["北京", "山东", "河南", "山西", "河北"], radarCmd: "" },
  },
  {
    id: "relations", cap: "relations", configFile: "aitable-relations.json",
    tableName: "协作关系表", mode: "name",
    fields: [
      f("姓名", "text"), f("花名", "text"), f("角色", "multipleSelect"), f("内外部", "singleSelect"),
      f("负责领域/产品", "text"), f("是否线下对接过", "singleSelect"), f("备注", "text"),
    ],
    requiredNames: ["姓名", "角色", "内外部"],
  },
  {
    id: "daily", cap: "aitableDaily", configFile: "aitable-daily.json",
    tableName: "Agent&MaaS日报", mode: "name",
    fields: [
      f("数据类别", "singleSelect"), f("板块", "singleSelect"), f("序号", "number"),
      f("数据日期", "date"), f("对象名称", "text"), f("数据JSON", "text"),
    ],
    requiredNames: ["数据类别", "板块", "序号", "数据日期", "对象名称", "数据JSON"],
    extra: { href: "", trendDays: 30, maxDrivers: 3 },
  },
  {
    id: "worklog", cap: "worklog", configFile: "aitable-worklog.json",
    tableName: "历史工作记录", mode: "fields",
    fields: [
      f("工作标题", "text", "title"), f("工作日期", "date", "date"), f("客户", "text", "customer"),
      f("原始分类", "singleSelect", "category"), f("主题", "text", "topic"), f("生命周期环节", "singleSelect", "stage"),
      f("环节来源", "singleSelect", "stageSource"), f("分类置信度", "singleSelect", "confidence"),
      f("重复模式", "singleSelect", "pattern"), f("来源渠道", "singleSelect", "source"),
      f("源记录键", "text", "sourceKey"), f("记录状态", "singleSelect", "status"),
      f("交付物", "url", "deliverable"), f("备注", "text", "note"),
    ],
  },
  {
    id: "custfiles", cap: "custfiles", configFile: "aitable-custfiles.json",
    tableName: "客户文件清单", mode: "fields",
    fields: [
      f("客户/子目录", "text", "subPath"), f("文件名", "text", "name"), f("类型", "text", "type"),
      f("修改时间", "text", "mtime"), f("创建时间", "text", "ctime"), f("概要", "text", "summary"),
    ],
    extra: { schemaVersion: 1, keepTypes: ["文档", "笔记"], dirAliases: {}, subAliases: {}, maxFilesPerGroup: 12 },
  },
  {
    id: "dttask", cap: null, configFile: "aitable-dttask.json",
    mode: "tables-fields",
    tables: [
      {
        key: "conv", tableName: "钉钉会话台账",
        fields: [
          f("会话", "text", "name"), f("发布日", "date", "day"), f("会话键", "text", "convKey"),
          f("类型", "singleSelect", "kind"), f("关联客户", "text", "customers"), f("客户状态", "singleSelect", "custState"),
          f("BTE联系人", "text", "bte"), f("消息数", "number", "msgCount"), f("未回复", "checkbox", "unreplied"),
          f("未回复条数", "number", "unrepliedCount"), f("等待起始", "date", "since"), f("最后发言人", "text", "lastSender"),
          f("@我数", "number", "atMe"), f("仅@我", "checkbox", "partial"), f("最近消息时间", "date", "lastMsgAt"),
        ],
      },
      {
        key: "task", tableName: "与我有关任务",
        fields: [
          f("任务标题", "text", "title"), f("发布日", "date", "day"), f("任务键", "text", "taskKey"),
          f("规则标题", "text", "rawTitle"), f("摘要", "text", "summary"), f("类别", "singleSelect", "category"),
          f("优先级", "singleSelect", "priority"), f("规则分", "number", "score"), f("判定线索", "text", "reasons"),
          f("@我", "checkbox", "atMe"), f("截止提示", "text", "dueHint"), f("涉及模型", "text", "models"),
          f("发送人", "text", "sender"), f("消息时间", "date", "at"), f("会话", "text", "conv"),
        ],
      },
    ],
  },
  {
    id: "daily_report", cap: "report", configFile: "report.json",
    tableName: "日报记录", mode: "fields",
    fields: [
      f("日报主题", "text", "topic"), f("所属部门", "singleSelect", "dept"), f("工作状态", "singleSelect", "workStatus"),
      f("日报日期", "date", "date"), f("关键阶段目标跟进", "text", "followup"), f("新方案/新商机拓展", "text", "opportunity"),
      f("重大问题/风险", "text", "risk"), f("其他（思考/竞对等）", "text", "other"),
    ],
    note: "oa.templateName 与 weekly/remote 段需在 report.json 里另行手工维护（指引只建表与字段）",
  },
  {
    id: "business", cap: null, configFile: "aitable-business.json",
    mode: "idonly", tables: BUSINESS_TABLES,
  },
];

/** 展开为统一视图：所有 mode 都带 tables:[{key, tableName, fields}]。 */
function expand(raw: RawSchema): TableSchema {
  const { tableName: _t, fields: _f, tables, ...rest } = raw;
  if (tables) return { ...rest, tables };
  return { ...rest, tables: [{ key: null, tableName: raw.tableName ?? "", fields: raw.fields ?? [] }] };
}

const SCHEMAS: readonly TableSchema[] = RAW_SCHEMAS.map(expand);

export function listSchemas(): readonly TableSchema[] {
  return SCHEMAS;
}

export function schemaOf(id: string): TableSchema | undefined {
  return SCHEMAS.find((s) => s.id === id);
}
