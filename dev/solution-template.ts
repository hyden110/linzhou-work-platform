import type { SolutionDraft, SolutionFlow, SolutionLayer, SolutionMapping, SolutionProduct, SolutionRisk } from "../src/lib/assistant-contract.ts";

/**
 * Deterministic Alibaba Cloud reference architecture used when the local Qoder CLI
 * cannot generate a plan. Every product name is a real Alibaba Cloud offering; the
 * draft is labelled `engine: "template"` by the caller so the UI never presents it
 * as model output.
 */

export interface SolutionInput {
  readonly customer: string;
  readonly industry: string;
  readonly goal: string;
  readonly constraints: string;
}

type Theme = "rnd" | "rag" | "data" | "private" | "multimodal" | "iot";

const THEME_PATTERNS: ReadonlyArray<readonly [Theme, RegExp]> = [
  ["rnd", /研发|编码|代码|工程效能|devops|ide|测试|交付/i],
  ["rag", /问答|客服|助手|知识|检索|rag|文档/i],
  ["data", /数据中台|大数据|数仓|湖仓|指标|报表|分析|治理/i],
  ["private", /不出域|私有化|专有云|本地化|信创|合规|等保/i],
  ["multimodal", /视频|图像|语音|多模态|解析|ocr/i],
  ["iot", /物联网|iot|设备|边缘|制造|工厂/i],
];

const product = (name: string, role: string): SolutionProduct => ({ name, role });

function detectThemes(input: SolutionInput): Set<Theme> {
  const haystack = `${input.industry} ${input.goal} ${input.constraints}`;
  return new Set(THEME_PATTERNS.flatMap(([theme, pattern]) => (pattern.test(haystack) ? [theme] : [])));
}

function accessLayer(): SolutionLayer {
  return {
    name: "接入与体验层",
    purpose: "统一南北向入口，就近加速并阻断常见应用层攻击。",
    products: [
      product("阿里云 CDN", "静态资源与前端产物就近分发，降低首屏时延"),
      product("Web 应用防火墙 WAF 3.0", "拦截 SQL 注入、XSS 与爬虫，提供 Bot 管理"),
      product("API 网关", "统一 API 发布、鉴权、限流与灰度，隔离存量系统"),
      product("应用型负载均衡 ALB", "七层流量分发与健康检查，承载业务入口"),
    ],
  };
}

function applicationLayer(themes: Set<Theme>): SolutionLayer {
  const products = [
    product("容器服务 Kubernetes 版 ACK", "业务与智能体运行时的统一编排底座，支持弹性与灰度发布"),
    product("函数计算 FC", "事件驱动执行轻量任务与 Webhook，按调用付费"),
    product("Serverless 应用引擎 SAE", "免运维部署存量微服务，快速承接迁移应用"),
  ];
  if (themes.has("rag")) {
    products.push(product("百炼智能体应用", "编排检索增强问答与工具调用，输出带引用的回答"));
  }
  if (themes.has("rnd")) {
    products.push(product("Qoder", "AI 研发中枢：Quest 自主完成跨文件开发任务，Repo Wiki 沉淀代码库语义"));
    products.push(product("云效 Flow", "CI/CD 流水线，自动构建、测试与部署"));
  }
  if (themes.has("iot")) {
    products.push(product("物联网平台", "设备接入、物模型与规则流转，桥接边缘与云上"));
  }
  return {
    name: "应用与智能体层",
    purpose: "承载业务应用与智能体编排，是能力落地与交付的主战场。",
    products: products.slice(0, 6),
  };
}

function modelLayer(themes: Set<Theme>): SolutionLayer {
  const products = [
    product("阿里云百炼", "模型服务与知识库（RAG）平台，统一管理提示词、评测与应用发布"),
    product("通义千问 Qwen 系列", "文本、多模态与推理模型，按场景分层调用以平衡效果与成本"),
    product("人工智能平台 PAI", "模型微调、评测与私有化部署，满足定制与数据不出域诉求"),
  ];
  if (themes.has("rag") || themes.has("data")) {
    products.push(product("向量检索服务 DashVector", "存储与检索知识向量，支撑语义召回"));
  }
  if (themes.has("multimodal")) {
    products.push(product("智能媒体服务 IMS", "音视频转码、理解与内容生产流水线"));
  }
  return {
    name: "模型与知识层",
    purpose: "提供模型推理、知识向量化与检索增强能力，只消费脱敏后的受控内容。",
    products: products.slice(0, 6),
  };
}

function dataLayer(themes: Set<Theme>): SolutionLayer {
  const products = [
    product("对象存储 OSS", "原始资料与非结构化数据的低成本统一存储"),
    product("云数据库 RDS / PolarDB", "承载业务交易数据，提供高可用与读写分离"),
  ];
  if (themes.has("data")) {
    products.push(product("大数据计算服务 MaxCompute", "离线数仓与大规模批处理计算"));
    products.push(product("实时计算 Flink 版", "流式接入与实时指标计算"));
    products.push(product("实时数仓 Hologres", "面向分析与智能问数的高并发在线服务"));
    products.push(product("大数据开发治理平台 DataWorks", "统一数据集成、开发、调度与质量治理"));
  } else {
    products.push(product("文件存储 NAS", "共享文件与模型权重的低时延访问"));
  }
  return {
    name: "数据与存储层",
    purpose: "分层存放交易、分析与非结构化数据，并对上游提供统一服务化出口。",
    products: products.slice(0, 6),
  };
}

function platformLayer(): SolutionLayer {
  return {
    name: "基础设施与可观测层",
    purpose: "提供网络、算力与全链路观测，保障方案可运维、可度量。",
    products: [
      product("专有网络 VPC", "隔离的私有网络环境，配合安全组与私网连接控制访问面"),
      product("云服务器 ECS / GPU 云服务器", "通用算力与推理训练算力底座，支持弹性伸缩"),
      product("日志服务 SLS", "统一采集应用与审计日志，支持检索、告警与留存策略"),
      product("应用实时监控服务 ARMS", "调用链追踪与性能诊断，定位智能体调用瓶颈"),
    ],
  };
}

function securityLayer(themes: Set<Theme>): SolutionLayer {
  const products = [
    product("访问控制 RAM", "最小权限的身份与策略管理，支持多账号与角色分离"),
    product("密钥管理服务 KMS", "密钥托管与数据加密，凭据不落业务代码"),
    product("云安全中心", "主机与容器的威胁检测、基线核查与漏洞管理"),
    product("数据安全中心 DSC", "敏感数据识别、分级分类与异常访问审计"),
  ];
  if (themes.has("rag") || themes.has("multimodal")) {
    products.push(product("AI 安全护栏", "对模型输入输出做内容安全与提示注入防护"));
  }
  return {
    name: "安全与合规层",
    purpose: "贯穿全栈的身份、密钥、数据与内容安全控制，支撑等保与行业合规。",
    products: products.slice(0, 6),
  };
}

function requestFlow(): SolutionFlow {
  return {
    name: "在线请求主链路",
    steps: [
      "终端用户经 CDN 就近接入",
      "WAF 3.0 与 API 网关完成清洗、鉴权与限流",
      "ACK / 函数计算承载业务与智能体运行时",
      "百炼智能体检索 DashVector 与知识库证据",
      "Qwen 模型生成带引用的回答",
      "SLS 记录请求与引用留痕，ARMS 追踪耗时",
    ],
  };
}

function knowledgeFlow(): SolutionFlow {
  return {
    name: "知识入库与隐私边界",
    steps: [
      "原始资料保留在本机受控目录",
      "本地同步器解析并切块，生成摘要与受控引用",
      "仅元数据、摘要、引用片段与向量出域",
      "百炼知识库完成向量化与索引",
      "检索按阈值召回，证据不足即拒答",
    ],
  };
}

function themedFlows(themes: Set<Theme>): SolutionFlow[] {
  const flows: SolutionFlow[] = [];
  if (themes.has("rnd")) {
    flows.push({
      name: "研发提效闭环",
      steps: [
        "需求进入云效 Projex",
        "Qoder Quest 生成跨文件代码变更与单测",
        "云效 Codeup 评审与门禁",
        "云效 Flow 构建并部署到 ACK",
        "ARMS 与 SLS 验证线上表现",
      ],
    });
  }
  if (themes.has("data")) {
    flows.push({
      name: "数据加工链路",
      steps: [
        "DataWorks 集成业务库与日志",
        "MaxCompute 完成离线数仓分层",
        "Flink 版计算实时指标",
        "Hologres 对外提供分析服务",
        "百炼基于指标做智能问数",
      ],
    });
  }
  return flows;
}

function mappingRows(input: SolutionInput, themes: Set<Theme>): SolutionMapping[] {
  const rows: SolutionMapping[] = [
    { need: "统一入口与防护", product: "API 网关 + WAF 3.0 + ALB", reason: "存量系统无需改造即可被安全地暴露给新应用与智能体" },
    { need: "弹性运行底座", product: "容器服务 ACK + 函数计算 FC", reason: "长驻服务与事件型任务分池部署，按负载弹性伸缩控制成本" },
    { need: "模型与知识能力", product: "阿里云百炼 + 通义千问 Qwen", reason: "以托管方式获得模型服务、知识库与应用编排，避免自建推理集群" },
    { need: "全链路可观测", product: "日志服务 SLS + ARMS", reason: "智能体调用链路必须可追踪、可回放，才能定位效果与耗时问题" },
    { need: "身份与数据安全", product: "RAM + KMS + 数据安全中心 DSC", reason: "最小权限与密钥托管是等保与客户安全评审的硬要求" },
  ];
  if (themes.has("private")) {
    rows.push({
      need: input.constraints.includes("不出域") ? "数据不出域" : "私有化与合规",
      product: "人工智能平台 PAI + 专有网络 VPC",
      reason: "模型微调与推理可部署在客户自有网络内，原始数据不出域",
    });
  }
  if (themes.has("rnd")) {
    rows.push({ need: "研发提效", product: "Qoder + 云效", reason: "从需求到部署形成可度量的 AI 研发闭环，沉淀企业代码知识" });
  }
  if (themes.has("data")) {
    rows.push({ need: "数据中台与分析", product: "MaxCompute + DataWorks + Hologres", reason: "离线与实时一体，向上提供统一指标与智能问数服务" });
  }
  if (themes.has("rag")) {
    rows.push({ need: "可核验问答", product: "百炼知识库 + DashVector", reason: "回答必须绑定受控引用，证据不足时明确拒答而非编造" });
  }
  if (themes.has("multimodal")) {
    rows.push({ need: "多模态处理", product: "智能媒体服务 IMS + Qwen 多模态模型", reason: "覆盖音视频与图像内容的解析、理解与生产" });
  }
  return rows.slice(0, 12);
}

function riskRows(themes: Set<Theme>): SolutionRisk[] {
  const risks: SolutionRisk[] = [
    { risk: "模型输出不可核验，存在幻觉", mitigation: "强制绑定受控引用，设置召回阈值，证据不足时明确拒答并提示补充资料" },
    { risk: "原始资料与凭据出域", mitigation: "原始文件与凭据留本机，仅上传摘要、受控引用、元数据与向量；网络侧用 VPC + KMS 收敛访问面" },
    { risk: "存量系统集成周期长", mitigation: "先经 API 网关做适配层灰度接入，按业务域分批迁移，保留回滚开关" },
    { risk: "云上成本不可预期", mitigation: "小模型前置分流、按量付费叠加资源包，用 SLS 与费用中心建立用量看板" },
    { risk: "效果无法量化验收", mitigation: "上线前建立评测集与基线指标，每次知识或模型变更后回归对比" },
  ];
  if (themes.has("private")) {
    risks.push({ risk: "合规与信创要求未对齐", mitigation: "与客户安全团队确认等保级别与部署形态，优先选择可私有化部署的 PAI 与专有云方案" });
  }
  return risks.slice(0, 6);
}

function nextStepRows(input: SolutionInput, themes: Set<Theme>): string[] {
  const steps = [
    `与 ${input.customer} 确认业务目标的成功指标与验收口径`,
    "梳理可用资料与数据源，明确哪些内容允许进入知识库",
    "以 1 个场景做端到端最小闭环（接入 → 检索 → 生成 → 留痕）",
    "建立评测集与基线，量化召回率、引用正确率与响应时延",
    "输出安全与合规说明，完成客户安全评审",
  ];
  if (themes.has("rnd")) steps.splice(2, 0, "选定 1–2 个代码仓库接入 Qoder，度量需求交付周期变化");
  return steps.slice(0, 8);
}

function title(input: SolutionInput): string {
  const goal = input.goal.trim().replace(/\s+/g, " ");
  const focus = Array.from(goal).slice(0, 26).join("");
  const scope = input.industry.trim() ? `${input.industry.trim()} · ` : "";
  return `${input.customer}｜${scope}${focus} 阿里云架构方案`;
}

export function templateSolutionDraft(input: SolutionInput): SolutionDraft {
  const themes = detectThemes(input);
  return {
    title: title(input),
    summary: [
      `这是本机 Qoder CLI 未能生成方案时使用的阿里云参考架构模板，按「${input.industry.trim() || "通用"}」行业与目标「${input.goal.trim()}」做了主题适配。`,
      "架构自接入、应用与智能体、模型与知识、数据与存储、基础设施与可观测到安全合规共六层，产品均为真实阿里云产品；",
      "原始资料与凭据保留在本机，仅摘要、受控引用、元数据与向量进入云上知识底座。请结合客户实际情况复核后再对外使用。",
    ].join(""),
    layers: [
      accessLayer(),
      applicationLayer(themes),
      modelLayer(themes),
      dataLayer(themes),
      platformLayer(),
      securityLayer(themes),
    ],
    flows: [requestFlow(), knowledgeFlow(), ...themedFlows(themes)].slice(0, 4),
    mapping: mappingRows(input, themes),
    risks: riskRows(themes),
    nextSteps: nextStepRows(input, themes),
  };
}
