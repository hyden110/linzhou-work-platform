/**
 * 数据源注册表 · 原始数据（TS 移植自 base/sa-workbench assets/models/datasource-model.js）。
 *
 * 纯数据：本文件只登记「有哪些取数通道 / 数据源 / 刷新组 / 能力 / 环境入口 / 健康分组」，
 * 不含任何派生逻辑（派生纯函数在 datasource-model.ts），不含任何凭据值。
 * 通道口径：cookie=带 Cookie 直连原始平台 API；aitable=钉钉 AI 表格；dws=钉钉 DWS CLI（非表格）；
 *           cli=本机 CLI 自管登录态；probe=无凭据 HTTP/CDP 探针；llm=外部大模型；
 *           local=本机文件与个人配置；static=仓库内硬编码，随代码发布、无快照。
 */

export type ChannelId = "cookie" | "aitable" | "dws" | "cli" | "probe" | "llm" | "local" | "static";

export interface ChannelMgmt {
  readonly k: string;
  readonly v: string;
}

export interface Channel {
  readonly id: ChannelId;
  /** 表格里的窄标签。 */
  readonly short: string;
  /** 卡片与图例里的全称。 */
  readonly name: string;
  readonly cls: string;
  readonly ico: string;
  readonly auth: string;
  readonly desc: string;
  /** 通道管理要点（续期 / 配置位置 / 触发命令 / 护栏）。 */
  readonly mgmt: readonly ChannelMgmt[];
}

export interface RefreshGroup {
  readonly id: string;
  readonly d: string;
}

export interface Capability {
  readonly id: string;
  readonly t: string;
  readonly grp: string | null;
  /** requires 语法：数组各项 AND；token 内 | 分隔任一组，组内 + 分隔 AND。 */
  readonly requires: readonly string[];
  readonly pages: readonly string[];
}

export interface DataSource {
  readonly sys: string;
  readonly cap: string | null;
  readonly ico: string;
  readonly ch: readonly ChannelId[];
  readonly grp: string | null;
  /** 健康键（驱动「状态」列）；无对应健康键即 null。 */
  readonly hk: readonly string[] | null;
  readonly auth: string;
  readonly via: string;
  readonly api: string;
  readonly snap: string;
  readonly globals: readonly string[];
  readonly pages: readonly string[];
  readonly cmd: string;
  readonly note: string;
}

export interface EnvPlatform {
  readonly ico: string;
  readonly t: string;
  readonly auth: string;
  readonly url: string;
  readonly hkey: string | null;
  readonly bg: string;
  readonly fg: string;
  readonly d: string;
  readonly how: string;
  readonly tbd?: boolean;
}

export interface EnvLink {
  readonly t: string;
  readonly d: string;
  readonly ico: string;
  readonly url: string;
  readonly tbd?: boolean;
}

export interface EnvSection {
  readonly g: string;
  readonly env: string;
  readonly d: string;
  readonly platforms: readonly EnvPlatform[];
  readonly links: readonly EnvLink[];
}

export interface HealthGroup {
  readonly id: string;
  readonly t: string;
  readonly ico: string;
  readonly d: string;
  readonly runner: string;
  readonly registry: string;
  /** 修复指引文案（部分分组提供）。 */
  readonly fix?: string;
  readonly fixHref?: string;
}

export const DATASOURCE_MODEL_VERSION = "2026-10-18";

/* short = 表格里的窄标签；name = 卡片与图例里的全称；mgmt 驱动通道管理卡。 */
export const channels: readonly Channel[] = [
  {
    id: "cookie", short: "Cookie 直连", name: "Cookie 直连原始平台 API", cls: "blue", ico: "🔑",
    auth: "Chrome Cookie 库 / 个人中心粘贴的共享 BUC 会话（tools/fetch/sa_cookies.py 统一取，Node 侧不碰凭据）",
    desc: "带登录态直接打内网平台原始接口，取回结构化 JSON 落快照。会话失效表现为返回 HTML 拦截页，浏览器访问一次对应平台即续期。",
    mgmt: [
      { k: "续期", v: "浏览器访问对应内网平台一次即续期；或个人中心粘贴新会话" },
      { k: "命令", v: "npm run refresh -- --only cust / okr / ppl" },
      { k: "护栏", v: "Cookie 只在 Python 侧内存拼请求头，不打印、不落盘" },
    ],
  },
  {
    id: "aitable", short: "钉钉 AI 表格", name: "钉钉 AI 表格", cls: "purple", ico: "◱",
    auth: "dws CLI 自管钉钉授权（OAuth），脚本不读也不落任何 Cookie / Token",
    desc: "以钉钉多维表为业务库读写：record query 拉取、record upsert 回写。baseId / tableId / 字段映射外置在 tools/aitable_*.json。",
    mgmt: [
      { k: "配置", v: "tools/aitable_*.json（baseId / tableId / 字段映射）" },
      { k: "命令", v: "npm run worklog:pull · custfiles:pull · business:sync" },
      { k: "护栏", v: "写回须逐项人工确认；分页未完 / 记录腰斩时拒绝覆盖" },
    ],
  },
  {
    id: "dws", short: "钉钉 DWS", name: "钉钉 DWS CLI", cls: "green", ico: "💬",
    auth: "同上（dws 自管 OAuth）",
    desc: "钉钉开放能力的统一接入层：群聊与消息、日历、日志、知识库、事件长连接。只读为主，摘录仅落本机 gitignore 快照。",
    mgmt: [
      { k: "配置", v: "tools/dingtalk_watch.json（关注名单/窗口）· tools/lifecycle.json" },
      { k: "命令", v: "npm run refresh -- --only dingtalk / presales / ops" },
      { k: "护栏", v: "消息原文只在刷新进程内存，快照仅存 AI 概要与计数" },
    ],
  },
  {
    id: "cli", short: "本机 CLI", name: "本机 CLI（自管登录态）", cls: "b", ico: "🅰",
    auth: "a1 CLI 走 NCS 内网登录态，免令牌；ossutil 读本机 ~/.ossutilconfig（脚本不碰 AK）",
    desc: "不持凭据、由 CLI 自身维护登录态的本机命令行取数。",
    mgmt: [
      { k: "续期", v: "a1 自管 NCS 登录态，免令牌，无需手动续期；ossutil 随本机配置" },
      { k: "命令", v: "npm run refresh（data 组）· --only cases（案例库）" },
    ],
  },
  {
    id: "probe", short: "探针", name: "无凭据探针", cls: "amber", ico: "🛰",
    auth: "无（或网关 Basic Auth 由 credctl 托管，值不入页面）",
    desc: "只做可达性判定与本地端口发现，不取业务数据：HTTP 状态码、Chrome CDP 标签、daemon.port。",
    mgmt: [
      { k: "命令", v: "npm run refresh（data 组）" },
      { k: "口径", v: "只判可达性（redirect: manual 取状态码），不取业务数据" },
    ],
  },
  {
    id: "llm", short: "大模型", name: "外部大模型", cls: "purple", ico: "🧮",
    auth: "QoderCLI（随 Qoder 安装，复用本机登录态、免 Key）；无 QoderCLI 时退 SA_LLM_API_KEY 环境变量 / credctl 加密凭据 llm-api-key",
    desc: "把本地已取回的原文交给模型做提炼。花外部调用费的源一律显式触发，不进 refresh 自动编排。",
    mgmt: [{ k: "命令", v: "npm run okr-ai（显式点单，不进自动编排）；ops 组随 refresh 跑" }],
  },
  {
    id: "local", short: "本机文件", name: "本机文件与个人配置", cls: "", ico: "📑",
    auth: "无",
    desc: "本机目录扫描与个人配置文件：决定抓什么、怎么归类、挂载到哪。均不入仓库（模板 .example 入库）。",
    mgmt: [
      { k: "配置", v: "tools/*.json · data/review*.md（个人数据不入 git，模板 .example 入库）" },
      { k: "改动", v: "改配置即改抓取行为，改后重跑对应刷新组" },
    ],
  },
  {
    id: "static", short: "静态", name: "仓库内静态数据", cls: "tbd", ico: "⬡",
    auth: "无",
    desc: "硬编码在 assets/ 里的模型层：方法模型、健康检测项、入口目录。无快照、无刷新命令，改动即改代码。",
    mgmt: [
      { k: "改动", v: "手改 assets/*.js（模型三处共用，改一处三处生效）" },
      { k: "口径", v: "改动即改口径，随代码发布，无快照兜底" },
    ],
  },
];

/* 刷新组注册表：npm run refresh -- --only <id> 的各组。 */
export const groups: readonly RefreshGroup[] = [
  { id: "data", d: "系统探针（Chrome / a1 / 服务可达）＋ 登录态快照＋ 快照继承" },
  { id: "cust", d: "客户池 GAAP 盘面 ＋ ECID 画像（每户 5 请求）" },
  { id: "custfiles", d: "钉钉 AI 表格 · 客户文件清单（带腰斩护栏）" },
  { id: "leads", d: "钉钉 AI 表格 · 拓新企业清单（lead-radar 写入，只读拉取）" },
  { id: "relations", d: "钉钉 AI 表格 · 协作关系表（合作人台账，只读拉取）" },
  { id: "ppl", d: "鲲鹏商务项目管线（销售管线四阶段）" },
  { id: "okr", d: "CRD OKR 原值 ＋ 述职材料挂载" },
  { id: "presales", d: "Obsidian / 钉钉 Wiki / QoderWake 端点探活" },
  { id: "ops", d: "钉群消息 → AI 运营概要（花 LLM 调用费）" },
  { id: "dingtalk", d: "钉钉会话 / 日历 / 日志 / 待办提取" },
  { id: "wechat", d: "本机微信加密库 → 变化库重解密 ＋ 群台账 / @我待办 / 与我有关（tools/wxkey/sync.js，全程本地）" },
  { id: "worklog", d: "历史工作分类（AI 表格优先，MD 回退）" },
  { id: "cases", d: "解决方案案例库 · Code 平台 ＋ OSS 发布的 HTML-PPT（按源 last-good）" },
  { id: "campaign", d: "战役口径人工层（tools/campaign.json）＋ FBI 指标卡实时抓取（CDP 9222，失败静默）" },
  { id: "aitable", d: "钉钉 AI 表格「Agent&MaaS日报」（驾驶舱首屏，按数据日期分区，T+1 更新）" },
  { id: "crs", d: "CRS MaaS 资源报备（百炼 SFM 报备单台账；宿主侧产出 inbox，本站只归一）" },
  { id: "ontology", d: "个人本体构建（钉钉快照 + 微信 wxdump 产物归一；产物供关系星图与本体 MCP）" },
];

/* 能力注册表：「未配置即隐藏」的唯一判定依据。 */
export const caps: readonly Capability[] = [
  { id: "okr", t: "OKR（CRD）", grp: "okr", requires: ["bin:python3", "session:buc"], pages: ["okr"] },
  { id: "okrAi", t: "OKR AI 建议", grp: null, requires: ["cap:okr", "bin:qodercli|cred:llm-api-key"], pages: [] },
  { id: "cust", t: "客户池与画像", grp: "cust", requires: ["bin:python3", "module:kunpeng_ecid", "session:buc", "config:devata.*", "file:tools/cust_map.json"], pages: ["customers"] },
  { id: "campaign", t: "战役 / 述职口径", grp: "campaign", requires: ["session:buc|file:tools/campaign.json"], pages: [] },
  { id: "ppl", t: "商务项目 PPL", grp: "ppl", requires: ["cap:cust", "config:lifecycle.ppl.viewId"], pages: [] },
  { id: "leads", t: "拓新雷达", grp: "leads", requires: ["bin:dws", "session:dws", "file:tools/aitable_leads.json"], pages: ["leads"] },
  { id: "relations", t: "协作关系台账", grp: "relations", requires: ["bin:dws", "session:dws", "file:tools/aitable_relations.json"], pages: [] },
  { id: "dingtalk", t: "钉钉办公", grp: "dingtalk", requires: ["bin:dws", "session:dws", "file:tools/dingtalk_watch.json"], pages: ["dingtalk"] },
  { id: "wechat", t: "微信办公（本机解密）", grp: "wechat", requires: ["file:data/wechat.json#groups"], pages: ["wechat"] },
  { id: "aitableDaily", t: "Agent&MaaS 日报（钉钉 AI 表格）", grp: "aitable", requires: ["bin:dws", "session:dws", "file:tools/aitable_daily.json"], pages: [] },
  { id: "crs", t: "MaaS 资源报备（CRS）", grp: "crs", requires: ["file:tools/inbox/crs_reports.json#rows"], pages: [] },
  { id: "ops", t: "钉群 AI 运营概要", grp: "ops", requires: ["bin:dws", "session:dws", "config:lifecycle.ops.groups", "bin:qodercli|cred:llm-api-key"], pages: [] },
  { id: "presales", t: "售前知识（Obsidian / 钉钉 Wiki）", grp: "presales", requires: ["file:~/Library/Application Support/obsidian/obsidian.json#vaults|config:lifecycle.obsidian.vault|bin:dws+session:dws"], pages: [] },
  { id: "worklog", t: "历史工作", grp: "worklog", requires: ["bin:dws+file:tools/aitable_worklog.json|file:tools/inbox/worklog.md"], pages: [] },
  { id: "custfiles", t: "客户文件清单", grp: "custfiles", requires: ["cap:cust", "bin:dws", "session:dws", "file:tools/aitable_custfiles.json"], pages: [] },
  { id: "cases", t: "解决方案案例库", grp: "cases", requires: ["file:tools/cases.json", "bin:a1+file:tools/cases.json#code.repos|bin:ossutil+file:tools/cases.json#oss.bucket"], pages: ["cases"] },
  { id: "aone", t: "Aone 仓库", grp: "data", requires: ["bin:a1"], pages: [] },
  { id: "probes", t: "自定义服务探活", grp: "data", requires: ["config:probes"], pages: [] },
  { id: "wake", t: "数字员工（QoderWake）", grp: "data", requires: ["file:~/.qoderwake/run/daemon.port|config:lifecycle.wake.endpoints"], pages: ["agents"] },
  { id: "agentloop", t: "AgentLoop 观测", grp: null, requires: ["file:~/.loongsuite-pilot/config.json|config:agentloop.views", "cred:agentloop-sls", "bridge"], pages: ["agentloop"] },
  { id: "kb", t: "知识库检索", grp: null, requires: ["config:kb.sources", "bridge"], pages: ["kb"] },
  { id: "report", t: "日周报管理", grp: null, requires: ["file:tools/daily_report.json#baseId", "bridge"], pages: ["report"] },
  { id: "ontology", t: "个人本体（钉钉+微信）", grp: "ontology", requires: ["cap:dingtalk|config:ontology.wechatDir"], pages: [] },
];

/* 取数通道总表（51 条）。grp = 刷新组；hk = 健康键，驱动「状态」列。 */
export const sources: readonly DataSource[] = [
  /* ---- cookie：内网平台原始 API ---- */
  {
    sys: "鲲鹏 CRM · devata「我的客户」", cap: "cust", ico: "🧭", ch: ["cookie"], grp: "cust", hk: ["devata"],
    auth: "共享 BUC 会话（aliyun-inc.com）", via: "tools/fetch/ecid_fetch.py",
    api: "GET olap.devata.aliyun-inc.com/poolGroup/records · viewId=186 / poolId=8 / groupId=64（pageSize 20，被拦截时回落 6）",
    snap: "tools/inbox/pool_records.json → data/cust_profiles.js", globals: ["__CUST_POOL__", "__CUST_FETCHED_AT__"],
    pages: ["index", "customers", "lifecycle", "dingtalk"], cmd: "npm run refresh -- --only cust",
    note: "客户池 GAAP 盘面唯一源。返回 HTML 即会话失效，浏览器访问 devata 一次即恢复。",
  },
  {
    sys: "鲲鹏 ECID 画像 ＋ 企典", cap: "cust", ico: "🏛", ch: ["cookie"], grp: "cust", hk: ["kunpeng"],
    auth: "同上（与鲲鹏共用一份 Cookie 库）", via: "tools/fetch/profiles_fetch.py（kunpeng_ecid.KunpengEcidClient）",
    api: "GET amp.devata…/api/ecid/queryEcidInfoByEcid.json · queryDataAccountInfoByEcidPageResult.json · GET xobject.devata…/objectdata/getDetail.json · POST olap.devata…/statistics/data/preview（chartId 109747 融资 / 109755 招聘趋势 / 行为 ranking）· GET query.aliyun-inc.com/rest/customer.ecid_layer_rules",
    snap: "tools/inbox/profiles.json → data/cust_profiles.js", globals: ["__CUST_PROFILES__", "__CUST_OWNER__"],
    pages: ["index", "customers", "lifecycle", "okr", "dingtalk"], cmd: "npm run refresh -- --only cust",
    note: "每户 5 个只读请求：工商实体 / 价值与招聘标量字段 / 云研兴趣 TOP / 融资 / 数据账号数。抓取名单由 tools/cust_map.json 决定。",
  },
  {
    sys: "鲲鹏商务项目（PPL）", cap: "ppl", ico: "🎯", ch: ["cookie"], grp: "ppl", hk: ["opportunity"],
    auth: "同上；opportunity 子域需单独续期", via: "tools/fetch/ppl_fetch.py",
    api: "KunpengEcidClient.project_search → opportunity.devata.aliyun-inc.com（viewId / states / max 取 tools/lifecycle.json）",
    snap: "tools/inbox/ppl_records.json → data/ppl.js", globals: ["__PPL__"],
    pages: ["index", "lifecycle", "health"], cmd: "npm run refresh -- --only ppl",
    note: "阶段名经 assets/models/workflow-model.js 的 pplStageMap 归位四阶段；未在映射表内的阶段名会 console.warn 并落 unclassified。",
  },
  {
    sys: "CRD 目标管理（读）", cap: "okr", ico: "🚩", ch: ["cookie"], grp: "okr", hk: ["crd"],
    auth: "BUC SSO（login.alibaba-inc.com · APP aliyun-od-portal）", via: "tools/fetch/fetch_okr.py",
    api: "crd.aliyun-inc.com：/sso/login/user/info · /api/v3/allPeriods · /api/v3/objective/fullview · /api/v3/progress/objective/list · /api/v3/jobReview/*",
    snap: "data/okr.json + data/okr.js", globals: ["__OKR__"],
    pages: ["index", "okr", "profile"], cmd: "npm run refresh -- --only okr",
    note: "OKR 原值唯一权威源。周期按 periodType=FY 且 name 含当期财年定位（阿里财年 4 月起算，SA_OKR_PERIOD 可覆盖），不硬编码 ID；成功后把执行人头像/部门/职位/邮箱补全进当前用户 profile。",
  },
  {
    sys: "CRD 目标管理（写回）", cap: "okr", ico: "🚩", ch: ["cookie"], grp: null, hk: ["crd"],
    auth: "同上", via: "tools/sync/okr_write.py ← scripts/okr_sync.js ← 本地桥 POST /sync-dry · /sync-confirm",
    api: "PUT objective/user/update（先 dry-run 读 CRD 当前值做冲突检测，逐项人工确认后才落笔）",
    snap: "无（直接回写 CRD）", globals: [],
    pages: ["okr"], cmd: "npm run okr-sync",
    note: "全站唯一对外部系统的写通道之一。红线：不自动跳过任何一步确认。",
  },
  {
    sys: "BUC 身份解析与会话校验", cap: null, ico: "🪪", ch: ["cookie"], grp: null, hk: ["crd"],
    auth: "共享 BUC 会话（chrome / manual / auto 三模式，个人中心可切）", via: "tools/fetch/whoami.py ← 本地桥 POST /auth/login · /profile/test",
    api: "crd.aliyun-inc.com/sso/login/user/info（解析 window.USER_INFO，只取白名单字段）",
    snap: "~/.sa-workbench/users/<工号>/profile.json（0600）", globals: [],
    pages: ["profile", "health"], cmd: "页面内触发（个人中心登录 / 校验）",
    note: "内网平台共用一份会话：CRD 身份接口通过即视为全部平台有效，不逐平台探测。头像另取 work.alibaba-inc.com/photo/<工号>.220x220.jpg。",
  },
  {
    sys: "登录态健康快照（Cookie 层）", cap: null, ico: "🛡", ch: ["cookie", "probe"], grp: "data", hk: ["kunpeng", "devata", "crd"],
    auth: "只读 Cookie 计数 + 带 Cookie 逐平台判活", via: "tools/fetch/gen_sysstatus.py",
    api: "Cookie 库可用性（条数 / 域名数）· config/platforms.json 逐平台判活（api＝body 判 NOT_LOGIN / JSON；redirect＝不跟随重定向看是否跳 SSO；devata-records＝records API JSON=有效 / HTML=失效）· config probes",
    snap: "data/sysstatus.js + data/sysstatus.json", globals: ["__SYS_STATUS__"],
    pages: ["health", "index", "workflow", "lifecycle", "dingtalk", "settings", "profile", "env"], cmd: "npm run refresh（data 组内串行）",
    note: "只记状态 / 计数 / 时间戳，不落任何凭据值。Cookie 只在 Python 侧内存拼请求头，Node 与页面都不碰。",
  },
  {
    sys: "三类健康快照（CLI / MCP / Cookie）", cap: null, ico: "🩺", ch: ["cli", "probe", "cookie"], grp: "data", hk: ["a1", "aliyun", "ossutil", "dws", "dashscope"],
    auth: "CLI 自管登录态（不读凭据）· MCP 连接器配置（url query 与 env 值一律掩码）· Cookie 层复用 gen_sysstatus 产物",
    via: "scripts/lib/health.js（CLI + 汇总）＋ scripts/lib/mcp.js（连接器发现 / 握手 / 接入）",
    api: "a1 auth whoami · aliyun sts GetCallerIdentity · ossutil ls · dws auth status · DashScope /models（有 Key 才检）· MCP initialize + tools/list",
    snap: "data/health.js + data/health.json", globals: ["__SA_HEALTH__"],
    pages: ["health"], cmd: "npm run refresh（data 组）· 页面「重新检测」经本地桥 POST /health/check",
    note: "未装 / 未配置的 CLI 整项隐藏；MCP 只注册在非生效配置文件的服务器标「未加载」。快照不入 git。",
  },

  /* ---- aitable：钉钉 AI 表格 ---- */
  {
    sys: "钉钉 AI 表格「历史工作」", cap: "worklog", ico: "◱", ch: ["aitable"], grp: "worklog", hk: ["dws"],
    auth: "dws 自管钉钉授权", via: "tools/sync/aitable_worklog_sync.js",
    api: "dws aitable table get --base-id --table-ids · record query --all --page-limit 0 --field-ids · record upsert --records-file（配置 tools/aitable_worklog.json）",
    snap: "data/worklog.js + worklog.json + worklog-status.js", globals: ["__WORKLOG__", "__WORKLOG_STATUS__"],
    pages: ["index", "workflow", "lifecycle"], cmd: "npm run worklog:pull（或 refresh --only worklog）",
    note: "双向：pull 拉取分类结果，push/seed 把本地分类回写。未配置 baseId/tableId 时 refresh 自动回退 tools/inbox/worklog.md。",
  },
  {
    sys: "钉钉 AI 表格「客户文件清单」", cap: "custfiles", ico: "📑", ch: ["aitable"], grp: "custfiles", hk: ["dws"],
    auth: "同上", via: "tools/sync/aitable_custfiles_sync.js",
    api: "dws aitable table get · record query --all（配置 tools/aitable_custfiles.json；keepTypes 只取「文档」「笔记」）",
    snap: "data/cust_files.js + cust_files.json + cust_files_status.js", globals: ["__CUST_FILES__", "__CUST_FILES_STATUS__"],
    pages: ["lifecycle"], cmd: "npm run custfiles:pull（或 refresh --only custfiles）",
    note: "客户归属靠 dirAliases / subAliases 映射到客户池简称，按第一个子目录聚合。安全护栏：分页未结束、记录为空或较上次腰斩时拒绝覆盖。",
  },
  {
    sys: "钉钉 AI 表格「拓新企业清单」", cap: "leads", ico: "🎯", ch: ["aitable"], grp: "leads", hk: ["dws"],
    auth: "同上", via: "tools/sync/aitable_leads_sync.js",
    api: "dws aitable table get · record query --all（配置 tools/aitable_leads.json；字段按名称映射，必需字段缺失即判 schema 漂移）",
    snap: "data/leads.js + leads.json + leads-status.js", globals: ["__LEADS__", "__LEADS_STATUS__"],
    pages: ["leads", "lifecycle"], cmd: "npm run leads:pull（或 refresh --only leads）",
    note: "线索由 lead-radar（外部信源 → LLM 抽取 → 鲲鹏 Name 判定）写入，本通道只读。电话 / 邮箱 / 法定代表人不入快照。雷达采集花 LLM 调用费，显式触发、不进 refresh 编排。",
  },
  {
    sys: "钉钉 AI 表格「协作关系表」", cap: "relations", ico: "🤝", ch: ["aitable"], grp: "relations", hk: ["dws"],
    auth: "同上", via: "tools/sync/aitable_relations_sync.js",
    api: "dws aitable table get · record query --all（配置 tools/aitable_relations.json；字段按名称映射，必需字段缺失即判 schema 漂移）",
    snap: "data/relations.js + relations.json + relations-status.js", globals: ["__RELATIONS__", "__RELATIONS_STATUS__"],
    pages: ["dingtalk"], cmd: "npm run relations:pull（或 refresh --only relations）",
    note: "合作人台账（PDSA/SA/BTE/PD/PDM/TAM/TL 与客户、合作伙伴），源文档《山东区域上下游团队支持》。只读拉取，无联系字段；驱动钉钉办公「关系全景」的协作人层。",
  },
  {
    sys: "钉钉 AI 表格「业务域」（反向写入）", cap: null, ico: "◱", ch: ["aitable"], grp: null, hk: ["dws"],
    auth: "同上", via: "tools/sync/aitable_business_sync.js",
    api: "dws aitable table get · record query · record upsert（配置 tools/aitable_business.json + aitable_business_schema.json）",
    snap: "data/business-status.js（仅同步状态，业务数据不落本地）", globals: ["__BUSINESS_SYNC_STATUS__"],
    pages: ["customers", "lifecycle"], cmd: "npm run business:sync",
    note: "方向相反：把本地鲲鹏 / devata / PPL 快照推回钉钉表格，供跨端消费。自由文本一律过 redact() 脱敏。",
  },
  {
    sys: "钉钉 AI 表格「Agent&MaaS日报」", cap: "aitableDaily", ico: "📊", ch: ["aitable"], grp: "aitable", hk: ["dws"],
    auth: "dws 自管钉钉授权", via: "tools/fetch/aitable_daily_fetch.js",
    api: "dws aitable field get（按字段名解析）· record query --all（配置 tools/aitable_daily.json）；行结构＝数据类别（核心指标/客户变化TOP10/模型变化TOP10/Agent产品变化/新上量与放量/场景归因/双战役客户/结论与建议/席位与收入结构）× 板块（汇总/MaaS/Agent），完整属性存「数据JSON」",
    snap: "data/aitable_daily.js", globals: ["__AITABLE_DAILY__"],
    pages: ["index"], cmd: "npm run refresh -- --only aitable",
    note: "按「数据日期」取最新分区（T+1，上游每日更新）；核心指标历史收录为 trend（默认 ≤30 天）。金额万元、席位个；与战役 / BI 口径不可相加。分区缺核心指标或记录腰斩即保留旧快照标 degraded。快照不入 git。",
  },
  {
    sys: "钉钉 AI 表格「日报跟踪记录」", cap: "report", ico: "📝", ch: ["aitable"], grp: null, hk: ["dws"],
    auth: "dws 自管钉钉授权", via: "scripts/lib/report/index.js（本地桥 /report/* 路由）",
    api: "dws aitable record query --filters（「日报日期」= 北京今日）· record update --records-file（当日草稿修改）· report outbox list（已提交状态）· drive list --workspace --folder + doc read --node（「双周报」文件夹目录 / 正文预览，只读）；配置 tools/daily_report.json",
    snap: "无快照（仅在线）", globals: [],
    pages: ["report"], cmd: "npm run bridge → report.html",
    note: "19:00 初稿 / 23:15 提交 / 周五 17:00 双周报为 ECS QoderWake 定时任务；页面只改当日草稿字段（白名单）并经 SSH run-now 提前触发，发送链路复用远端任务（工作日判定 / outbox 去重 / 模板 / 收件人）；双周报历史只读，node 必须命中目录清单。",
  },

  /* ---- dws：钉钉开放能力（非表格） ---- */
  {
    sys: "钉钉会话与群台账", cap: "dingtalk", ico: "💬", ch: ["dws"], grp: "dingtalk", hk: ["dws"],
    auth: "dws 自管 OAuth", via: "tools/fetch/fetch_dingtalk.js",
    api: "dws chat group list-all · list-top-conversations · search · message list-all --start --end（活跃+短窗口共用扫描） · message list-mentions --start --end · calendar event list · todo task list · report outbox list",
    snap: "data/dingtalk.json + data/dingtalk.js", globals: ["__DINGTALK__"],
    pages: ["index", "dingtalk", "lifecycle"], cmd: "npm run refresh -- --only dingtalk",
    note: "打标依据 tools/dingtalk_watch.json（BTE 名单 / 窗口天数 / 关键词）。首个会话源失败即非 0 退出并保留旧快照；后续源失败写 degraded + sourceFailures。",
  },
  {
    sys: "钉钉日历日程", cap: "dingtalk", ico: "💬", ch: ["dws"], grp: "dingtalk", hk: ["dws"],
    auth: "同上", via: "tools/fetch/fetch_dingtalk.js",
    api: "dws calendar event list --start --end --limit 100 --format json",
    snap: "data/dingtalk.js（calendarEvents）", globals: ["__DINGTALK__"],
    pages: ["index", "lifecycle"], cmd: "npm run refresh -- --only dingtalk",
    note: "触达时间轴六源之一；未来日程标「未开始」。",
  },
  {
    sys: "钉钉日志（日报 / 周报）", cap: "dingtalk", ico: "📨", ch: ["dws"], grp: "dingtalk", hk: ["dws"],
    auth: "同上", via: "tools/fetch/fetch_dingtalk.js",
    api: "dws report outbox list --cursor --size 20 --start --end（服务端单次上限 20 天，翻页上限 2 页）",
    snap: "data/dingtalk.js（reportEvents）", globals: ["__DINGTALK__"],
    pages: ["lifecycle"], cmd: "npm run refresh -- --only dingtalk",
    note: "只保留客户相关条目，摘录 ≤120 字，落本机 gitignore 快照。",
  },
  {
    sys: "钉钉聊天待办提取", cap: "dingtalk", ico: "💬", ch: ["dws"], grp: "dingtalk", hk: ["dws"],
    auth: "同上（不再额外请求）", via: "tools/fetch/fetch_dingtalk.js（本地启发式规则）",
    api: "复用已取回的会话消息，本地规则识别待办工作项",
    snap: "data/dingtalk.js（todos）", globals: ["__DINGTALK__"],
    pages: ["index", "dingtalk"], cmd: "npm run refresh -- --only dingtalk",
    note: "与下一行「事件长连接」是两套待办：这套是快照内的历史提取，那套是实时候选。",
  },
  {
    sys: "钉钉事件长连接 → 实时待办候选", cap: "dingtalk", ico: "🔔", ch: ["dws"], grp: null, hk: ["dws"],
    auth: "同上", via: "tools/fetch/dingtalk_realtime_todo.js process | watch",
    api: "消费 data/dingtalk-events/*（事件类型 user_im_message_receive_group_all / user_im_message_receive_at），fs.watch 增量处理",
    snap: "data/dingtalk-todos.js + data/dingtalk-realtime.state.json", globals: ["__DINGTALK_TODOS__"],
    pages: ["dingtalk"], cmd: "npm run dingtalk:todo:watch",
    note: "唯一近实时源。事件文件由 dws event 长连接落地，本脚本只做归类与优先级打分，不自己连钉钉。",
  },
  {
    sys: "钉钉知识库（Wiki）", cap: "presales", ico: "📚", ch: ["dws"], grp: "presales", hk: ["dws"],
    auth: "同上", via: "scripts/lib/lifecycle/presales.js",
    api: "dws wiki +space-list --page-all · +node-list --workspace <id> --page-all（配置 tools/lifecycle.json dingWiki.spaces / max）",
    snap: "data/presales.js（dingWiki）", globals: ["__PRESALES__"],
    pages: ["lifecycle"], cmd: "npm run refresh -- --only presales",
    note: "按客户短名匹配节点标题，作为 B 阶段「客户知识关联」与 D 阶段触达证据。",
  },
  {
    sys: "钉群消息 → AI 运营概要", cap: "ops", ico: "🤖", ch: ["dws", "llm"], grp: "ops", hk: ["dws"],
    auth: "dws OAuth ＋ QoderCLI（兜底 SA_LLM_API_KEY / credctl llm-api-key）", via: "scripts/lib/lifecycle/ops.js",
    api: "dws chat +chat-messages --group --start --page-all --max-items → scripts/lib/ai.js（QoderCLI 优先，兜底 POST {baseUrl}/chat/completions · qwen-plus · response_format json_object）",
    snap: "data/ops.js", globals: ["__OPS__"],
    pages: ["lifecycle"], cmd: "npm run refresh -- --only ops",
    note: "隐私边界：消息只在刷新进程内存中流转，快照仅存概要 / 机会 / 风险 / 待办与计数，不存原文。监控群配 tools/lifecycle.json ops.groups。",
  },
  {
    sys: "钉群台账手工导入（降级补录）", cap: "dingtalk", ico: "📑", ch: ["local"], grp: null, hk: null,
    auth: "无", via: "tools/fetch/import_dingtalk_snapshot.js",
    api: "只读显式 JSON 文件：--groups-file / --activity-file / [--details-file]，不调 dws、不起 shell",
    snap: "data/dingtalk.js", globals: ["__DINGTALK__"],
    pages: ["dingtalk"], cmd: "npm run refresh:dingtalk:import",
    note: "dws 不可用时的两阶段补录通道，复用 fetch_dingtalk.js 的打标与完整性判定函数。",
  },

  /* ---- cli / probe ---- */
  {
    sys: "Aone / 云效 Code 代码库", cap: "aone", ico: "🅰", ch: ["cli"], grp: "data", hk: ["a1"],
    auth: "a1 CLI · NCS 内网登录态（免令牌）", via: "scripts/refresh.js getAoneRepos()",
    api: "a1 repo list -f json --per-page 20 --order-by last_activity_at",
    snap: "data/data.js（aoneRepos）", globals: ["__SA_DATA__"],
    pages: ["datasource"], cmd: "npm run refresh（data 组）",
    note: "同时充当 a1 通道的探活：能列出库即视为 a1 正常。⌘K 命令面板的「Aone 仓库」跳转也读这份。",
  },
  {
    sys: "案例库 · Code 平台（Aone Pages）", cap: "cases", ico: "🅰", ch: ["cli", "probe"], grp: "cases", hk: ["a1", "cases"],
    auth: "a1 CLI · NCS 内网登录态（免令牌）", via: "tools/fetch/cases_fetch.js fetchCode()",
    api: "a1 pages view · a1 repo file list --type RECURSIVE · a1 repo file view --start-line 1 --end-line 60（仓库白名单 tools/cases.json code.repos）＋ Pages 入口 GET 探活",
    snap: "data/cases.js + cases.json（+ cases.state.json 标题缓存 / last-good）", globals: ["__CASES__"],
    pages: ["cases", "customers", "health", "datasource"], cmd: "npm run refresh -- --only cases",
    note: "site 模式整仓一案例，collection 模式发布根一级目录一案例；有 public/ 用 public。Pages 站点不可达时回落仓库链接。更新时间取仓库最近活跃（updatedBasis=repo）。",
  },
  {
    sys: "案例库 · OSS 发布桶", cap: "cases", ico: "☁", ch: ["cli"], grp: "cases", hk: ["cases"],
    auth: "ossutil 自管 ~/.ossutilconfig（脚本不读 AK）", via: "tools/fetch/cases_fetch.js fetchOss()",
    api: "ossutil ls oss://<bucket> -r · cat --head 8192 · api get-object-acl（桶 / 对外域名 / 排除目录见 tools/cases.json oss）",
    snap: "data/cases.js + cases.json", globals: ["__CASES__"],
    pages: ["cases", "customers", "health", "datasource"], cmd: "npm run refresh -- --only cases",
    note: "对外渠道：链接走自定义域名；仅公共读对象额外给 OSS 原生兜底地址（alt）。标题按 etag 缓存，未变化不重读。Codeup 为 P2（需云效个人令牌，当前 unconfigured）。",
  },
  {
    sys: "Chrome 标签页", cap: null, ico: "🌐", ch: ["probe"], grp: "data", hk: ["chrome"],
    auth: "无（本机调试端口）", via: "scripts/refresh.js getChromeTabs()",
    api: "GET http://127.0.0.1:9222/json（超时 1.5s，只取 type=page）",
    snap: "data/data.js（chromeTabs）", globals: ["__SA_DATA__"],
    pages: ["datasource"], cmd: "npm run refresh（data 组）",
    note: "未开调试端口时降级为 degraded，并沿用上一轮快照缓存。",
  },
  {
    sys: "服务可达性探针（config probes）", cap: "probes", ico: "🛰", ch: ["probe"], grp: "data", hk: ["waker", "harness", "newapi", "insight", "quantdinger", "crd"],
    auth: "无凭据（redirect: manual，只取状态码）", via: "scripts/refresh.js probeHttp() + probeOne()",
    api: "config.json probes 数组（k / url / ms / okCodes / fix，k 不可与内置健康键同名）＋ 内置 crd 探针（https://crd.aliyun-inc.com/）",
    snap: "data/data.js（syshealth[k]，附 name/fix 元数据）", globals: ["__SA_DATA__"],
    pages: ["health", "index"], cmd: "npm run refresh（data 组）",
    note: "任何 HTTP 响应（含 401/30x）视为可达；配置 okCodes 时不符即降级。health 页检测行由快照 name/fix 动态渲染，未配置即无行。与登录态快照相互独立、独立降级。",
  },
  {
    sys: "QoderWake daemon（本地）", cap: "wake", ico: "🤖", ch: ["probe"], grp: "data", hk: ["qoderwake"],
    auth: "无（本机 daemon）", via: "scripts/refresh.js probeWakeDaemon()",
    api: "读 ~/.qoderwake/run/daemon.port（回退 19820）→ GET http://127.0.0.1:<port>/api/health",
    snap: "data/data.js（daemons.qoderwake）", globals: ["__SA_DATA__"],
    pages: ["agents", "health"], cmd: "npm run refresh（data 组）",
    note: "file:// 下浏览器直连 127.0.0.1 会被 CORS null origin 拦，所以状态必须由刷新进程旁路探测。",
  },
  {
    sys: "QoderWake 端点探活（本地 / ECS / MacMini）", cap: "wake", ico: "🛰", ch: ["probe"], grp: "presales", hk: ["waker", "qoderwake"],
    auth: "网关 Basic Auth（credctl 托管，值不入页面）", via: "scripts/lib/lifecycle/presales.js probeEndpoint()",
    api: "tools/lifecycle.json wake.endpoints：local 取 daemon.port（url:\"auto\"）· ecs / macmini 由 lifecycle.json 配置（可选 cred 字段引用 credctl 条目，探测时带 Basic Auth）",
    snap: "data/presales.js（endpoints）", globals: ["__PRESALES__"],
    pages: ["agents"], cmd: "npm run refresh -- --only presales",
    note: "数字员工页三端 Tab 的可用性依据；桥在线时整页经桥 http 同站打开，内嵌 Console 会话 Cookie（SameSite=Lax）才可持久。",
  },
  {
    sys: "本地触发桥（动作通道，非数据源）", cap: null, ico: "🔌", ch: ["probe"], grp: null, hk: null,
    auth: "仅本机回环 ＋ 必带 X-SA-Bridge:1 头（强制 CORS 预检）", via: "scripts/bridge.js",
    api: "127.0.0.1:8765-8769 · GET /health /auth/status /profile /config /users /chrome/profiles · POST /refresh /refresh-okr /okr-ai /sync-dry /sync-confirm /auth/login /auth/logout /profile/test · PUT /profile/source|session|prefs /config · DELETE /profile/session /users/:id",
    snap: "无（只触发动作，产物由各脚本落盘）", globals: [],
    pages: ["profile", "settings", "okr", "health"], cmd: "npm run bridge",
    note: "白名单动作 + 互斥锁（占用中返回 423）+ 错误消息脱敏。桥离线时页面自动降级为终端命令提示，纯静态行为不受影响。",
  },

  /* ---- llm ---- */
  {
    sys: "OKR AI 辅助建议", cap: "okrAi", ico: "🧮", ch: ["llm"], grp: null, hk: null,
    auth: "QoderCLI（随 Qoder 安装，免 Key）；兜底 SA_LLM_API_KEY 环境变量 / credctl llm-api-key", via: "scripts/okr_ai.js",
    api: "scripts/lib/ai.js（QoderCLI 优先，兜底 POST dashscope compatible-mode /chat/completions）；输入 data/okr.json ＋ 可选 data/okr_edits.json",
    snap: "data/okr_suggest.js + okr_suggest.json", globals: ["__OKR_SUGGEST__"],
    pages: ["okr"], cmd: "npm run okr-ai",
    note: "刻意不进 refresh 自动编排——花外部 LLM 调用必须显式点单。建议引用的 id / field 全部白名单校验，非法项直接丢弃，防模型编造目标。",
  },

  /* ---- local：本机文件与个人配置 ---- */
  {
    sys: "Obsidian 本地知识库", cap: "presales", ico: "📚", ch: ["local"], grp: "presales", hk: null,
    auth: "无", via: "scripts/lib/lifecycle/presales.js scanObsidian()",
    api: "读 ~/Library/Application Support/obsidian/obsidian.json 定位 vault → 扫描 tools/lifecycle.json obsidian.dirs（上限 max 200）",
    snap: "data/presales.js（obsidian）", globals: ["__PRESALES__"],
    pages: ["lifecycle"], cmd: "npm run refresh -- --only presales",
    note: "只取标题与路径元数据，不读正文。",
  },
  {
    sys: "述职材料与挂载映射", cap: "okr", ico: "🚩", ch: ["local"], grp: "okr", hk: null,
    auth: "无", via: "tools/fetch/fetch_okr.py（挂载阶段）",
    api: "data/review.md · data/review-scope.md（env SA_REVIEW_MD / SA_REVIEW_SCOPE_MD 可覆盖）＋ tools/okr_mount.json（mount / secOwner）",
    snap: "并入 data/okr.json 的 review / mount 字段", globals: ["__OKR__"],
    pages: ["okr"], cmd: "npm run refresh -- --only okr",
    note: "CRD 的 progress 与 jobReview 均为空，S1 进展证据全靠这层挂载。文件缺失时自动降级为纯 CRD OKR 骨架。",
  },
  {
    sys: "客户短名映射", cap: "cust", ico: "🧭", ch: ["local"], grp: "cust", hk: null,
    auth: "无", via: "tools/fetch/profiles_fetch.py",
    api: "tools/cust_map.json：[{short 简称, name 客户池实体全名}]（个人数据不入仓库，模板 .example）",
    snap: "决定画像抓取名单", globals: [],
    pages: ["customers"], cmd: "npm run refresh -- --only cust",
    note: "简称即 __CUST_PROFILES__ 的键，全站客户 chip 与深链 #/cust/<简称> 都依赖它。",
  },
  {
    sys: "钉钉关注配置", cap: "dingtalk", ico: "💬", ch: ["local"], grp: "dingtalk", hk: null,
    auth: "无", via: "tools/fetch/fetch_dingtalk.js",
    api: "tools/dingtalk_watch.json：BTE 名单 / 窗口天数 / 关键词 / 日志回看天数",
    snap: "影响 __DINGTALK__ 的打标范围与窗口", globals: [],
    pages: ["dingtalk"], cmd: "npm run refresh -- --only dingtalk",
    note: "改这里就能改「哪些群算客户相关」，不必动代码。",
  },
  {
    sys: "生命周期编排配置", cap: null, ico: "⚙", ch: ["local"], grp: null, hk: null,
    auth: "无", via: "scripts/lib/lifecycle/presales.js · scripts/lib/lifecycle/ops.js · tools/fetch/ppl_fetch.py",
    api: "tools/lifecycle.json：ppl.viewId/states/max · wake.endpoints · obsidian · dingWiki · ops.groups/days/maxMsgs/llm",
    snap: "影响 ppl / presales / ops 三组", globals: [],
    pages: ["lifecycle", "agents"], cmd: "改后重跑对应组",
    note: "一个文件管住三个刷新组的外部依赖，模板 lifecycle.json.example 入库。",
  },
  {
    sys: "历史工作 Markdown（回退源）", cap: "worklog", ico: "📑", ch: ["local"], grp: "worklog", hk: null,
    auth: "无", via: "tools/fetch/worklog_classify.js",
    api: "tools/inbox/worklog.md → 关键词与类目权重打分归入九环节（模型 assets/models/workflow-model.js）",
    snap: "data/worklog.js + worklog.json", globals: ["__WORKLOG__"],
    pages: ["workflow", "lifecycle"], cmd: "npm run worklog",
    note: "仅在 tools/aitable_worklog.json 未配置 baseId/tableId 时由 refresh 自动回退到这条。",
  },
  {
    sys: "本地工作 LIVE 采集（实时层）", cap: null, ico: "⚡", ch: ["local"], grp: null, hk: null,
    auth: "无（只读本机 sqlite/索引；AI 分类走 scripts/lib/ai.js QoderCLI 优先）", via: "tools/fetch/worklog_live.js（桥内 scripts/lib/live/workloglive.js 托管常驻）",
    api: "自动扫描 Application Support 下 Qoder*/QwenWork* 实例（vscdb localHistory / agents.db chats）+ ~/.codex/session_index.jsonl；tools/fetch/worklog_live.json 的 watchDirs 白名单目录 fs.watch 归并人工文件变更",
    snap: "data/worklog-live.js + worklog-live.json + worklog-live-status.json", globals: ["__WORKLOG_LIVE__"],
    pages: ["workflow"], cmd: "node tools/fetch/worklog_live.js（--watch 常驻；桥启动即托管，SA_WORKLOG_LIVE=off 关停）",
    note: "实时待复核层：sourceKey 与 worklog_collect 同形，对账标注「已入账」；权威台账仍是 AI 表格链路，本层不上推不改写。进行中会话沉默 10min 后才入清单；首跑仅收近 3 天，更早历史标 baseline。",
  },
  {
    sys: "Chrome Profile 枚举", cap: null, ico: "🌐", ch: ["local"], grp: null, hk: null,
    auth: "无", via: "本地桥 GET /chrome/profiles",
    api: "枚举本机 Chrome User Data 目录下的 profile 子目录",
    snap: "无（实时返回）", globals: [],
    pages: ["profile", "settings"], cmd: "页面内触发",
    note: "决定 Cookie 来源模式 chrome 抓哪个 profile。",
  },
  {
    sys: "加密凭据库", cap: null, ico: "🔐", ch: ["local"], grp: null, hk: null,
    auth: "AES-256-GCM ＋ scrypt 派生密钥，文件 0600", via: "tools/credctl.js",
    api: "~/.sa-workbench/credentials.enc + ~/.sa-workbench/.credkey（刻意放在站点目录之外）",
    snap: "无（值不入页面、不入快照、不入 git）", globals: [],
    pages: ["health"], cmd: "node tools/credctl.js list | set | get | rm | verify",
    note: "AI 通道优先走 QoderCLI（免 Key）；llm-api-key 为兜底通道（也供 dashscope 健康检测），网关 Basic Auth 也从这里取。页面只展示托管状态与用途。",
  },
  {
    sys: "运行期配置", cap: null, ico: "⚙", ch: ["local"], grp: null, hk: null,
    auth: "无", via: "scripts/lib/config.js",
    api: "优先级 env > ~/.sa-workbench/config.json > 默认值：bin 路径 / CDP / 刷新组开关 / 各组超时",
    snap: "无", globals: [],
    pages: ["settings"], cmd: "本地桥 GET|PUT /config",
    note: "保存按白名单合并并保留未知键（该目录可能与其他工具共用）。",
  },

  /* ---- local：本机人工配置层 ---- */
  {
    sys: "战役口径人工层", cap: "campaign", ico: "📊", ch: ["local"], grp: "campaign", hk: null,
    auth: "无", via: "tools/campaign.json（人工维护）→ scripts/lib/campaign.js（live 附 FBI 指标卡，经本机 Chrome CDP 9222，失败静默）",
    api: "meta 的 maasW / agentW / 排名 / 占比 / MC / 分层 / 合作动态 / 拓新名单；live 附最新 日GAAP / 调用量（有无随 CDP）",
    snap: "data/campaign.js", globals: ["__CAMPAIGN__"],
    pages: ["customers", "lifecycle"], cmd: "npm run refresh -- --only campaign",
    note: "口径红线：战役口径（FBI 1842553，山东区域 44 户）/ 述职池口径 / BI detail-166 全产品口径三套不可相加。引用处必须标「按占比推算」。未配置 tools/campaign.json 时相关泳道与分层不渲染；配置与快照均不入 git。",
  },
  {
    sys: "CRS MaaS 资源报备（百炼 SFM 报备单）", cap: "crs", ico: "📝", ch: ["local"], grp: "crs", hk: null,
    auth: "Qoder 宿主托管 OAuth（crs_demand_mcp）；本机自持 token 被 CRS 拒 [403/1008]，故刷新进程不直连",
    via: "宿主侧调 crs-sfm-demand-my-tracked → node tools/fetch/crs_report_fetch.js --ingest <MCP 返回文件> 白名单裁剪写 tools/inbox/crs_reports.json → 同脚本归一",
    api: "报备单：demandPlanId / deliveryPlanId / bpid / cid / uid / 客户 / 模型 / 资源类型 / 地域 / RPM·TPM·并发·队列申请值 / 日 Token 估算 / 报备原因 / 期望上量 / 审批与交付状态。口径＝本人作为 SA / BTE 跟进的客户所提报备单",
    snap: "data/crs_reports.js", globals: ["__CRS_REPORTS__"],
    pages: ["lifecycle"], cmd: "npm run refresh -- --only crs（inbox 产出口径见 tools/prompts/qoderwake_crs_sync_prompt.txt）",
    note: "只读——不保存、不提交、不撤回、不取消任何报备单，写操作只在 CRS 前端由人执行。sfm 一单一模型，多子单只记 itemCount 不猜。inbox 过期（crs.staleDays，默认 3 天）或行数腰斩标 degraded 但保留数据可见。inbox 与快照均不入 git。",
  },
  {
    sys: "战略方向（会议提炼）", cap: null, ico: "◎", ch: ["local"], grp: null, hk: null,
    auth: "无", via: "人工维护 data/strategy.js（内部会议纪要的个人提炼，模板见 data/strategy.js.example）",
    api: "headline / paths / stats / pillars[]（tag·t·d·color）/ shifts[]（from→to）/ plans[] / actions[]（t·href·go）/ readMore / source",
    snap: "data/strategy.js", globals: ["__STRATEGY__"],
    pages: ["strategy"], cmd: "手改 data/strategy.js，本站不刷新",
    note: "独立页 strategy.html；无 headline 且无 pillars 或 status=unconfigured 时页面显示未配置空态。内容来自内部会议，不入 git、勿截屏外传。",
  },

  /* ---- ontology：个人本体构建 ---- */
  {
    sys: "个人本体构建", cap: "ontology", ico: "◎", ch: ["local", "dws"], grp: "ontology", hk: ["dws"],
    auth: "微信源无凭据（只读 wxdump 产物目录）；钉钉源复用 dingtalk 组快照", via: "scripts/lib/ontology/index.js build",
    api: "data/dingtalk.json + data/relations.json + entity_alias.js + ontology.wechatDir 产物 → normalize → assets/models/ontology-model.js build（前后端共用语义层）",
    snap: "data/ontology.js（摘要 __ONTOLOGY__）+ data/ontology_graph.json（全量图，本体 MCP 专用）", globals: ["__ONTOLOGY__"],
    pages: ["dingtalk"], cmd: "npm run refresh -- --only ontology",
    note: "微信源经 wxprecheck 门禁（端侧登录 + graph_data.json 数据完备 + 新鲜度），未过即跳过并记 sourceStatus.wechat，不阻塞钉钉源。",
  },

  /* ---- static：仓库内硬编码 ---- */
  {
    sys: "生命周期方法模型", cap: null, ico: "⬡", ch: ["static"], grp: null, hk: null,
    auth: "无", via: "assets/models/workflow-model.js",
    api: "四阶段九环节 / 标准输出 / SOP / 工具 / 指标 / 关键词 ＋ pplStageMap（PPL 阶段名 → 阶段归属）",
    snap: "无快照", globals: [],
    pages: ["workflow", "lifecycle"], cmd: "手改代码",
    note: "页面与 tools/fetch/worklog_classify.js、tools/sync/aitable_worklog_sync.js 共用同一份，改一处三处生效。",
  },
  {
    sys: "客户盘面分层与重点关注", cap: "campaign", ico: "◈", ch: ["local"], grp: "campaign", hk: null,
    auth: "无", via: "tools/campaign.json segDefs / focus",
    api: "KA / M / A / + 四组客户名单（keys 顺序即渲染顺序）与重点项文案（含金额）",
    snap: "data/campaign.js", globals: ["__CAMPAIGN__"],
    pages: ["customers"], cmd: "编辑 tools/campaign.json 后重跑 --only campaign",
    note: "金额是人工维护的述职口径文案，不随客户池快照变化——与同页 KPI（走 __CUST_POOL__）不是同一来源。",
  },
  {
    sys: "健康检测项与凭据托管清单", cap: null, ico: "🛡", ch: ["static"], grp: null, hk: null,
    auth: "无", via: "assets/models/datasource-model.js CLI_CHECKS / MCP_SOURCES / HEALTH_GROUPS ＋ config/platforms.json（Cookie 平台与判活规格）＋ config.json syshost（凭据托管卡）",
    api: "三类分组口径 / CLI 检测规格（命令 · 判活字段 · 修复指引）/ MCP 来源与生效宿主 / Cookie 平台清单",
    snap: "无快照", globals: [],
    pages: ["health", "env", "datasource"], cmd: "手改代码（平台清单改 config/platforms.json）",
    note: "检测项的「状态」来自 data/health.js 快照，「有哪些项、怎么判、坏了怎么修」来自这里。三类之外不再新增检测项。",
  },
  {
    sys: "环境入口目录", cap: null, ico: "🌍", ch: ["static"], grp: null, hk: null,
    auth: "无", via: "assets/components/core.js PUBLIC_ENTRIES ＋ config.entries（data/_site.js）＋ assets/models/datasource-model.js envSections",
    api: "公共目录硬编码（⌘K 入口四组 ＋ env.html 环境五组）；个人入口分组走 config.entries 随站点快照注入，未配置不渲染",
    snap: "data/_site.js", globals: ["__SA_SITE__"],
    pages: ["env"], cmd: "系统设置或 migrate_personal 配置 entries 后 npm run refresh 物化",
    note: "⌘K 命令面板的「入口」分组也读 ENTRIES（公共 + 个人合并）。",
  },
  {
    sys: "无本地直连源的快照继承", cap: "wake", ico: "📚", ch: ["static"], grp: "data", hk: null,
    auth: "无", via: "scripts/refresh.js inheritStatic()",
    api: "QMind 知识库 / Codeup 仓库 / QoderWake 花名册：无本地直连，从上一轮 data/data.json 原样继承（status=snapshot）",
    snap: "data/data.js（knowledge / repos / agents）", globals: ["__SA_DATA__"],
    pages: ["agents"], cmd: "npm run refresh（data 组）",
    note: "这三项永远是「快照」状态、不会自己更新。首次运行时从旧根 data.json 迁移；Aone 仓库跳转由 ⌘K 命令面板消费。",
  },
];

/* 环境入口目录：按环境归属分五组。platforms = 平台级详卡；links = 轻量入口链接。 */
export const envSections: readonly EnvSection[] = [
  {
    g: "内网 · 数据与研发平台", env: "内网", d: "公司内网 · Cookie / SSO / NCS 登录态",
    platforms: [
      { ico: "🧭", t: "鲲鹏 CRM / devata", auth: "Chrome Cookie（kunpeng_ecid 通道）", url: "https://devata.aliyun-inc.com/", hkey: "devata", bg: "var(--blue-soft)", fg: "var(--blue)", d: "客户 / 机会点 / 消费 / 客户池 GAAP 与画像取数主源", how: "健康页 Cookie 类逐平台判活（records API 返回 JSON＝有效 / HTML＝失效）；失效时浏览器访问一次即续期" },
      { ico: "🏛", t: "企典 co-dict", auth: "Chrome Cookie（与鲲鹏同库）", url: "https://co-dict.alibaba-inc.com/", hkey: "codict", bg: "var(--purple-soft)", fg: "var(--purple)", d: "工商 / 组织架构 / 股权穿透 / 融资与招聘", how: "健康页 Cookie 类逐平台判活（带 Cookie GET 不跟随重定向，跳 SSO＝失效）" },
      { ico: "🎯", t: "CRD 目标管理", auth: "SSO（login.alibaba-inc.com · APP aliyun-od-portal）", url: "https://crd.aliyun-inc.com/okr/my/owner", hkey: "crd", bg: "var(--brand-soft)", fg: "var(--brand-ink)", d: "OKR / 述职的唯一权威源，「OKR 目标」页的 O/KR 原值取自此", how: "refresh 对首页做无凭据 HTTP 探活；取数走 tools/fetch/fetch_okr.py（Cookie 直连）" },
      { ico: "🔀", t: "Aone / 云效 Code", auth: "NCS 登录态（a1 CLI 免令牌）", url: "https://code.alibaba-inc.com", hkey: "a1", bg: "var(--brand-soft)", fg: "var(--brand-ink)", d: "代码库 / 工作项 / Pages / AoneCI", how: "a1 repo list 探活（refresh 编排同源）" },
      { ico: "◱", t: "DataMate", auth: "NCS 登录态", url: "https://datamate.alibaba-inc.com/chat.htm", hkey: null, bg: "var(--blue-soft)", fg: "var(--blue)", d: "客户运营数据底座（消费明细 / 机会点 / 非结构化数据结构化）", how: "入口已确认；探活待接" },
      { ico: "📚", t: "QMind", auth: "NCS 登录态（MCP 插件）", url: "#", tbd: true, hkey: null, bg: "var(--purple-soft)", fg: "var(--purple)", d: "多源知识库 Notebook / 检索", how: "list_notebooks 自检；无本地直连，走快照继承" },
    ],
    links: [],
  },
  {
    g: "公网 · 协作与模型平台", env: "公网", d: "公网账号登录 · 无内网依赖",
    platforms: [
      { ico: "💬", t: "钉钉（DWS）", auth: "钉钉账号（DWS CLI 注入认证）", url: "https://alidocs.dingtalk.com", hkey: "dws", bg: "var(--blue-soft)", fg: "var(--blue)", d: "AI 表格 / 知识库 / 群聊 / 日历 / 日志 / 待办 / 审批", how: "dws-runtime-check 自检" },
      { ico: "📊", t: "百炼控制台", auth: "阿里云账号（个人 / 企业）", url: "https://bailian.console.aliyun.com", hkey: null, bg: "var(--amber-soft)", fg: "var(--amber)", d: "模型 / credits / 限流 / 用量与 SLA", how: "登录入口见「多账号 · 快速登录」组" },
    ],
    links: [],
  },
  {
    g: "ECS · 自部署服务", env: "ECS", d: "公网 ECS 自部署（实例 / 安全组 / 快照）· 个人服务入口经 config.entries",
    platforms: [],
    links: [{ t: "ECS 控制台", d: "实例 / 安全组 / 快照", ico: "☁", url: "https://ecs.console.aliyun.com" }],
  },
  {
    g: "本地 · 服务与通道", env: "本地", d: "本机回环 · 免认证 / 本地信任",
    platforms: [
      { ico: "🤖", t: "QoderWake daemon（本地）", auth: "本机 daemon · 无需认证", url: "http://127.0.0.1:19820", hkey: "qoderwake", bg: "var(--green-soft)", fg: "var(--green)", d: "本地数字员工宿主 · Console / Wakers / Knowledge / Conversations", how: "refresh 读 daemon.port 探测 /api/health；Console 经 agents.html 内嵌" },
    ],
    links: [
      { t: "个人本体工作台", d: "本站 · file:// 双击直开（零后端）", ico: "🏠", url: "#" },
      { t: "Chrome 调试通道", d: "CDP 9222 · 标签实时", ico: "🌐", url: "http://127.0.0.1:9222/json" },
      { t: "本地触发桥", d: "scripts/bridge.js · 127.0.0.1:8765-8769", ico: "🔌", url: "#" },
    ],
  },
  {
    g: "多账号 · 快速登录", env: "多账号", d: "个人 / 企业 / 内部账号切换",
    platforms: [
      { ico: "🪪", t: "全息平台", auth: "内部账号（POC 登录入口）", url: "https://quanxi-account.aliyun-inc.com/#/MyAccountManage?status=true", hkey: null, bg: "var(--amber-soft)", fg: "var(--amber)", d: "内部阿里云账号 POC 的账号管理与快速登录", how: "直接登录入口，无独立探活" },
    ],
    links: [
      { t: "阿里云个人账号", d: "实名个人账号登录", ico: "👤", url: "https://account.aliyun.com" },
      { t: "RAM 多账号切换", d: "企业 / 角色 / 子账号切换", ico: "🔑", url: "https://ram.console.aliyun.com" },
      { t: "NCS 内网 SSO", d: "内网统一登录态 · 随首访自动建立", ico: "🛡", url: "#", tbd: true },
      { t: "钉钉登录", d: "钉钉账号", ico: "💬", url: "https://login.dingtalk.com" },
    ],
  },
];

/* 健康检测分组（CLI / MCP / Cookie / Agent 应用 / 本地技能）——只登记「检测什么、怎么判、坏了怎么修」。 */
export const healthGroups: readonly HealthGroup[] = [
  {
    id: "cli", t: "CLI 登录态", ico: "⌨️",
    d: "本机命令行自管登录态：不持凭据，由 CLI 自身维护。已接入项检测登录态；市场候选自动扫描（未装即隐藏，发现未接入默认关闭、默认隐藏）。",
    runner: "scripts/lib/health.js", registry: "assets/models/datasource-model.js CLI_CHECKS ＋ CLI_MARKET",
  },
  {
    id: "mcp", t: "MCP 连接器", ico: "🔌",
    d: "按 Qoder 连接器口径呈现：传输方式 / 生效来源 / 工具数 / 握手结果。检测与接入经本地桥后端服务。",
    runner: "scripts/lib/mcp.js", registry: "assets/models/datasource-model.js MCP_SOURCES",
  },
  {
    id: "cookie", t: "本地 Cookie 直连", ico: "🔑",
    d: "一份共享 BUC 会话覆盖全部内网平台：只校验身份一次，逐平台判活。会话失效表现为跳 SSO 或返回 HTML 拦截页，浏览器访问对应平台一次即续期。",
    runner: "tools/fetch/gen_sysstatus.py", registry: "config/platforms.json",
    fix: "浏览器打开该平台续期入口一次，再重跑 npm run refresh", fixHref: "profile.html#cookies",
  },
  {
    id: "agents", t: "Agent 应用", ico: "🤖",
    d: "自动扫描本机编码 / 协同智能体（QoderCLI、QoderWake、Claude Code、Codex、OpenCode、OpenClaw、WorkBuddy 等）：发现未接入默认关闭、默认隐藏，显式开启后纳入清单。",
    runner: "scripts/lib/scan.js", registry: "assets/models/datasource-model.js AGENT_APPS",
  },
  {
    id: "skills", t: "本地技能", ico: "🧩",
    d: "自动扫描本机 Agent 技能（Skill）：来源 / 是否生效 / 状态 / 能否被工作台的 AI 调用复用。只读目录与 SKILL.md 的 frontmatter，不启用不停用、不执行技能内任何脚本。",
    runner: "scripts/lib/skills.js", registry: "assets/models/datasource-model.js SKILL_SOURCES",
  },
];
