# 业界 AI 讯息（运营推广页）实施方案

- 状态：规划稿，未实施；排在客户盘面 P0-A/B 改版之后，不打断现有队列。
- 目标：只读采集公开源，为每条讯息生成「摘要 / 对现有企业客户的作用 / 行业趋势判断」，在运营推广页展示。
- 非目标：不做推送、不写任何外部系统、不抓登录墙或反爬页面、不把客户数据发给外部模型。
- 本轮约束：仅基于现有代码与公开可查的源信息出方案；**未联网验证任何 feed**，文中 URL 一律是候选。

## 1. 结论

1. **独立采集、独立产物**：新增 `sync/industry_news.py` → `.local-cache/industry-news.json`，新增 `/local/industry/*` 端点；不改 `ops-digest.json` 的 schema、不改当日运营卡和钉钉推送。
2. **UI 落在运营推广页的第二个 tab**（「运营动态」/「业界 AI 讯息」），不新增一级导航；现有四源当日卡原样保留。
3. **MVP 用模板规则生成**（确定性、无外部依赖），AI 解读作为 P1 增强，复用 `dev/ops-bridge.ts` 的 DashScope 先例；两种模式在卡面分别标注。
4. **源以官方 RSS/Atom 为主**。GitHub Trending、Hugging Face 热榜没有稳定官方 feed，放 P2，且不绕过反爬。
5. **客户关联只用本地行业标签**：从快照 `customers[].industry` 映射到固定行业分类，去重后作为提示词/展示标签；不发送客户名、CID、GAAP、跟进记录或数量。

## 2. 现状与复用点（已读代码）

| 现有能力 | 位置 | 复用方式 |
| --- | --- | --- |
| 抓取白名单、重定向逐跳校验、20s 超时、4MB 上限 | `sync/ops_digest.py`：`_validate_fetch_url`、`_WhitelistRedirectHandler`、`default_fetch` | 抽到共享 guard（推荐 P0a），或在新脚本内复制同规则并加同构测试 |
| 单源失败保留旧条目并标 stale | `sync/ops_digest.py`：`_section` | 采用同样的 `SourceStatus` 形状与降级语义 |
| id 去重、按源保留、倒序、原子写 | `sync/ops_digest.py`：`build_digest`、`atomic_write_json` | 采用同样的合并与保留策略 |
| AI 摘要一次刷新算一次、失败回退模板、产物 0600 | `dev/ops-bridge.ts`：`aiOverview`（L371-407）、`computeOverview`（L507-530） | 复用模型、超时、缓存与回退模式；新增独立 AI 缓存 |
| 源健康、当日卡、近 7 天展板、空态 | `src/components/ops/OpsView.tsx`、`src/lib/ops-model.ts` | 复用视觉与分日逻辑；不共用数据契约 |
| 刷新状态轮询 3s、GET 无副作用 | `src/components/ops/OpsProvider.tsx`、`dev/ops-bridge.ts` | 新 Provider 同构实现 |

**为什么独立产物而不是扩 `ops_digest.py`**：现有四源摘要会进入当日卡和推送预览，业界讯息不应默认混入；独立产物也便于单独失败、单独保留天数和单独排期。代价是少量重复代码，用共享 guard 即可控制。

## 3. 数据源选型

### 3.1 候选清单（全部待联网验证）

验证标准：HTTPS 200、`content-type` 为 XML/RSS/Atom、最近 3 条有日期、连续 3 天可抓、无登录/反爬；任一不满足即剔除或降级为人工精选链接。频率为估算，需实测修正。

| 分组 | 候选源 | 候选入口 | 格式 | 预计频率 | 合规/稳定性 | 阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 云厂商 | AWS Machine Learning Blog | `https://aws.amazon.com/blogs/machine-learning/feed/` | RSS | 日更～周更 | 官方 syndication feed，稳定 | P0 |
| 云厂商 | Azure Blog | `https://azure.microsoft.com/en-us/blog/feed/` | RSS | 2–5 条/周 | 官方 feed；需按 AI 关键词过滤 | P0 |
| 云厂商 | Google Cloud Blog | `https://cloudblog.withgoogle.com/rss/` | RSS | 日更 | 官方 feed；需过滤 AI 相关 | P0 |
| 云厂商 | 阿里云 AI 产品动态 | 百炼/PAI 的官方「更新日志/公告」目录页（`help.aliyun.com`，具体路径待验证） | HTML | 周更 | 无稳定 RSS 证据；沿用现有公告目录解析模式 | P1；MVP 先以现有千问办公公告覆盖，缺口感如实标注 |
| 模型/平台 | OpenAI News | `https://openai.com/news/rss.xml` | RSS | 1–3 条/周 | 官方 feed；页面为 JS 渲染，只取 feed | P0 |
| 模型/平台 | Microsoft AI Blog | `https://blogs.microsoft.com/ai/feed/` | RSS | 1–2 条/周 | 官方 feed | P0 |
| 模型/平台 | Meta AI Blog | `https://ai.meta.com/blog/rss/` | RSS | 1–2 条/周 | 官方 feed；入口可能调整，需验证 | P0 |
| 模型/平台（可选） | Anthropic News / Google DeepMind Blog | 官方 blog RSS（路径待验证） | RSS/Atom | 1–3 条/周 | 官方源；非用户点名，P1 再评估 | P1 |
| Skill/Agent | Anthropic Skills 仓库发布 | `https://github.com/anthropics/skills/releases.atom` | Atom | 低频 | GitHub 官方 Atom；只读、无 token | P0 |
| Skill/Agent | MCP Servers 仓库发布 | `https://github.com/modelcontextprotocol/servers/releases.atom` | Atom | 低频 | 同上 | P0 |
| Skill/Agent | GitHub Trending | `https://github.com/trending` | HTML | 日更 | **无官方 RSS/API**；HTML 结构与反爬会变；第三方镜像不可信 | P2 |
| Skill/Agent | Hugging Face Trending | `https://huggingface.co/api/models?sort=trending&limit=20`（候选） | JSON API | 日更 | 无面向产品的稳定 SLA；需验证条款与限流 | P2 |
| Skill/Agent | 官方 Skill 市场 | 暂无已确认的公开 feed | — | — | 不臆造入口；P2 调研 | P2 |

Skill 口径说明：P0 的「热门 Skill」只用**精选仓库的官方发布 Atom**，表达的是「这些 Agent/Skill 生态有更新」，不是全网热度排名；卡面文案不得写成「热榜第一」。真正的热榜等 P2 找到合规稳定源再上。

### 3.2 白名单与抓取约束

- 新增 `industry` 源域名白名单：`aws.amazon.com`、`azure.microsoft.com`、`cloudblog.withgoogle.com`、`openai.com`、`blogs.microsoft.com`、`ai.meta.com`、`github.com`、`huggingface.co`（后两者 P2）、`help.aliyun.com`。
- 宽域名必须加**路径前缀白名单**：`github.com` 只允许 `/<org>/<repo>/releases.atom`；`huggingface.co` 只允许 `/api/models`。重定向每一跳同时校验 host 与 path。
- 只发 GET；不接受用户输入 URL；不抓取条目里的外链（外链只用于展示）。
- 每 feed 20s 超时、2MB 上限；串行抓取，feed 间隔 1s；每日最多 2 次；P1 加 `ETag`/`Last-Modified` 条件请求。
- 编码：优先按 `content-type` / XML 声明识别；MVP 只支持 UTF-8，遇其他编码标记 `unsupported_encoding`，不乱猜。
- 仅存标题、来源、日期、≤280 字摘录、链接；不存全文、不存图片。

## 4. 采集与信息结构

### 4.1 产物 schema（`industry-news.json`，0600）

```text
{
  schemaVersion: 1,
  generatedAt,
  readOnly: true,
  sources: { [sourceKey]: { status, error, fetchedAt, lastSuccessAt, count, complete, stale } },
  items: IndustryItem[]
}
```

`IndustryItem`：

| 字段 | 说明 |
| --- | --- |
| `id` | `industry:<sourceKey>:<feed guid 或 url 的 sha1>`，稳定去重 |
| `sourceKey` / `sourceType` / `source` | `aws`/`azure`/`gcp`/`aliyun`/`openai`/`microsoft`/`meta`/`skills`；类型 `cloud`/`vendor`/`skill`；展示名 |
| `title` / `url` | 标题与外链；`url` 必须是 https |
| `publishedAt` | 统一为 UTC ISO；缺失则为 `null`，进「无日期」桶，不猜 |
| `summary` / `summaryKind` | 摘录 ≤200 字；`excerpt`（原文）或 `ai` |
| `impact.text` / `impact.industries` / `impact.kind` | 「对客户的作用」≤120 字；行业标签来自本地白名单；`template`/`ai` |
| `trend.level` / `trend.reason` / `trend.kind` | `high`/`medium`/`low`/`unknown`；一句理由；`template`/`ai` |
| `fetchedAt` | 首次/最近抓取时间，用于保留与排序兜底 |

保留：每源最多 60 条、最多 30 天；按 `publishedAt` 倒序，无日期条目单列。跨源按规范化 URL 去重；标题相似度去重放 P2。

### 4.2 行业标签

- 新增本地 `sync/industry-taxonomy.json`：把鲲鹏 `industry` 的原始值映射到固定分类（互联网/软件、制造、金融、能源/电力、交通/物流、零售/消费、医疗/生命科学、教育、政务/公共事业、其他）。
- 只把**去重后的分类名**用于展示与 AI 提示词；不使用数量、客户名、CID、GAAP、备注。
- 映射缺失时落「其他」，卡面不伪造具体行业。行业分布只影响标签和排序，不生成「某客户」句式。

## 5. 生成策略

### 5.1 模板层（MVP，始终可用）

- 规则文件 `sync/industry-rules.json`，关键词 → 影响方向 + 行业标签 + 趋势初判。示例（泛化，不对应真实客户）：
  - `agent|智能体|MCP|skill|工具调用` → 评估 Agent/工具链接入现有流程；行业：互联网/软件、制造、金融。
  - `price|pricing|降价|计费` → 关注推理成本与报价空间；行业：全部。
  - `GPU|推理|inference|算力` → 关注算力成本与交付周期；行业：互联网/软件、制造。
  - `security|compliance|安全|合规` → 关注数据与合规边界；行业：金融、政务/公共事业。
  - `multimodal|video|voice|多模态|语音` → 关注内容、客服、营销场景；行业：零售/消费、互联网/软件。
- 摘要：优先用 feed 的 `description/summary`，去 HTML、压缩空白、截断 ≤200 字；没有摘要就返回 `null`，卡面写「来源未提供摘要，点击查看原文」，不生成空话。
- 趋势分级口径（三档 + 一个诚实兜底）：

| 级别 | 判定标准 | 理由要求 |
| --- | --- | --- |
| 高 | 平台级能力、价格结构或协议标准发生变化，官方源确认，可能影响 ≥3 个行业 | 指出变化点与影响面 |
| 中 | 单一产品线的重要功能/区域/价格更新，或生态工具链变化，影响 1–2 个行业 | 指出具体产品线与范围 |
| 低 | 常规版本、教程、案例、活动、区域性小更新 | 一句话说明为何有限 |
| 待评估 | 信息不足、日期/来源不可靠、规则未命中 | 写明「依据不足」，不强行定级 |

- 「趋势」是编辑判断，不是预测；卡面固定注明「趋势判断为机器规则初判，仅供参考」。
- 只有官方源（A/B 级）才允许判「高」；营销稿、活动稿最高「中」。

### 5.2 AI 增强层（P1，复用现有先例）

- 复用 `dev/ops-bridge.ts` 的 DashScope compatible-mode、`qwen-flash` 默认模型、20–30s 超时、失败回退模板、产物 0600 的模式。
- 每次刷新只跑 **1 次批量调用**：取最新、尚未缓存的 ≤20 条；输入仅 `title + source + publishedAt + ≤280 字摘录 + 允许的行业标签`；输出严格 JSON 数组 `{id, summary, impact, industries, trend, reason}`。
- 逐条校验：id 必须命中本批、字段长度受限、行业必须在白名单、趋势必须是四值之一；任一条不合格只回退该条的模板结果。
- 缓存 `.local-cache/industry-ai.json`，key = `id + promptVersion + model`；30 天清理；同一 digest 重复 GET 不重复调用。
- 提示词硬约束：不得编造输入之外的事实；不得输出客户名、CID、金额、数量；不确定就输出「待评估」。
- 卡面标注：AI 模式「AI 生成，仅供参考」；模板模式「规则解读」；AI 失败时「AI 解读失败，已回退规则解读」。
- 无 `DASHSCOPE_API_KEY` 时直接走模板，不报错、不阻塞页面。

### 5.3 隐私红线

- 发送给模型的 payload 使用**字段允许列表序列化**，不是从客户对象里删字段。
- 单测用哨兵值（虚构客户名/CID/金额）构造快照，断言序列化后的请求体不含这些值，也不含任何 `customers` 字段。
- 不把本地路径、环境变量、凭证、digest 原文发给模型；日志只记录条数与状态。

## 6. UI 落点

- 运营推广页顶部加分段 tab：默认「运营动态」（现有四源内容不动），新增「业界 AI 讯息」。
- 新 tab 结构：
  1. 标题说明：「公开源只读采集 · 摘要与趋势判断仅供参考」+ 独立刷新按钮（复用 3s 轮询）。
  2. 数据源健康：每个源显示状态、条数、最近成功时间；失败/过期用现有 `StatusBadge` 语义。
  3. 筛选：时间（今日/近 7 天/近 30 天）、来源分组（云厂商/模型平台/Skill）、趋势（高/中/低/待评估）、行业。
  4. 分日列表卡片：来源徽章、日期、标题外链、摘要、对客户的作用 + 行业 chips、趋势徽章 + 理由；AI/规则标注。
  5. 空态/异常态（见第 7 节）。
- 不新增一级导航、不放进客户盘面、不与四源当日卡混排；P2 若用户明确要求，再把「今日高影响」作为可选卡片接入当日卡/推送（默认关闭）。
- 响应式沿用现有验收：1440×1000 与 390×844 无横向溢出，外链 `rel="noopener noreferrer"`，键盘可操作，控制台无报错。

## 7. 边界与诚实态

- 只读：不发送、不评论、不写入任何外部系统；v1 不接钉钉推送。
- 不绕过登录、付费墙、robots 或反爬；不抓第三方镜像；不把 GitHub/HF 热榜伪装成官方数据。
- 单源失败：保留旧条目并标 `stale`，显示 `lastSuccessAt`；无旧数据则显示「暂无可用数据」，不以示例填充。
- 空态：「近 N 天没有符合条件的讯息」+ 最近成功时间；筛选过窄时提示清空筛选，不误报「无数据」。
- 摘要缺失：显示「来源未提供摘要」；日期缺失：归入「无日期」并注明原因。
- AI 失败/无 key：回退模板并明示；趋势不确定：显示「待评估」。
- 与既有运营链路隔离：`ops-digest.json`、当日卡、推送预览、四源健康均不改；业界刷新失败不影响运营动态。
- 排期：`industry_news.py` 先手动刷新；P1 再并入现有 13:30 运营任务（或新增固定任务），改任务后需重启 App 并验证 failureCircuit，不在本轮实施。

## 8. 分期（MVP 范围）

| 阶段 | 内容 | 交付/验收 |
| --- | --- | --- |
| P0a（可选，0.5 天） | 抽共享抓取 guard（白名单、重定向、超时、大小、`SourceError`），现有 ops 测试全绿 | 现有四源行为不变 |
| P0b MVP（1.5–2 天） | 6 个官方 feed（AWS ML、Azure、GCP、OpenAI、Microsoft AI、Meta AI）+ 2 个 Skill releases Atom；模板摘要/影响/趋势；独立产物与端点；运营推广页新 tab、筛选、健康、空/过期态；单测 | 真实刷新一次后条目不重复；每卡三要素齐全；失败演练正确降级 |
| P1（1–2 天） | AI 批量解读 + 缓存 + 隐私测试；阿里云官方更新源；Anthropic/DeepMind 评估；定时刷新与 30 天保留；条件请求 | AI 失败全量回退；payload 无客户字段；源连续 3 天稳定 |
| P2 | GitHub Trending / HF 热榜合规评估；可选进入当日卡/推送（显式开关）；人工纠错/反馈 | 单独评审，不默认开启 |

依赖：排在客户盘面 P0-A/B 之后；与 PPL 巡检返工无文件冲突（新增文件为主）。若 P0a 抽 guard 影响现有同步，则改为在 industry 脚本内复制并加同构测试，P1 再合并，避免打断当前开发。

## 9. 验证方案

### 9.1 自动化

- `sync/test_industry_news.py`：
  - RSS/Atom fixture：标题、链接、RFC 822/ISO 日期、HTML 去标签、实体反转义、缺失日期。
  - 异常：非 200、超时、超大响应、非 XML、编码不支持、重定向到非白名单 host/path。
  - 去重：同一 guid/URL 重复刷新只留一条；每源保留与 30 天裁剪。
  - 模板：命中关键词、未命中 → 待评估、行业映射缺失 → 其他；营销稿不得判高。
  - 隐私：哨兵客户名/CID/金额不出现在 AI 请求体；无 key 不调用；AI 超时/非法 JSON → 模板。
- `dev/industry-bridge_test.ts`：GET 缺产物返回 `digest_unavailable` 且无写；刷新状态流转；脚本非零 → `failed`；响应不含绝对路径/凭证。
- `src/lib/industry-model.test.ts`：分日、筛选、排序、空/过期、趋势与来源标签映射。
- 现有 ops 测试回归：`test_ops_digest.py`、`ops-bridge_test.ts` 全绿。

### 9.2 手工/浏览器

- 首次刷新、二次刷新：无重复、时间倒序、每源计数正确。
- 断网或单源 404：旧条目保留并标 stale，其他源正常；无旧数据时空态正确。
- 无 AI key / AI 超时：模板卡与提示正确。
- 1440×1000、390×844：无横向滚动；tab、筛选、外链可用；控制台无报错。
- 回归：运营动态四源、当日卡、推送预览内容与行为不变；业界刷新不触发任何推送。

### 9.3 源的准入验收

连续 3 天、每天 2 次抓取：成功 ≥5/6、条目日期可解析、无重复、无编码错误，才保留为正式源；否则降级为「人工精选链接」或移除，并在数据源健康中如实显示。

## 10. 待确认

1. AI 解读放 MVP 还是 P1：建议 P1（模板先上线，隐私与幻觉风险更低）。
2. 业界讯息是否允许进入当日卡/钉钉推送：建议 v1 明确不接，P2 加显式开关。
3. 阿里云 AI 产品动态的具体官方入口（无稳定 RSS 时的 HTML 目录）需在下轮联网验证时确认。
4. 定时刷新时间：沿用 13:30，还是新增 09:30；建议 P1 随现有任务一起评估。
5. GitHub Trending / Hugging Face 热榜是否值得引入：需先做条款、限流、稳定性评估，默认不做。
6. 行业分类映射需在实现前读取本机快照的 `industry` 实际取值再定稿；本方案不虚构取值与分布。
