# 客户盘面改版规划：GAAP 异动分析（P0-A）+ MaaS 分层 PPL 跟进（P0-B）

日期：2026-10-17 · 状态：待交付负责人评审 · 依据：用户反馈（seq 126）+ 交付负责人已核实现状 + 仓库现有代码/快照结构。
约束：本规划不新增实测、不调用外部接口；文档示例一律使用虚构夹具，不写入真实客户名与业务数值；不 push。

## 1. 目标与范围

- P0-A：客户盘面新增「GAAP 异动分析」——逐客户昨日环比/绝对变动检测、阈值可配、暴增/暴跌双态、异常卡列，点击进客户抽屉看明细；FBI 归因仅保留既有入口占位。
- P0-B：以「MaaS / 非 MaaS + 逐客户 PPL 跟进」视图**替代**现有「客户全生命周期」视图（LifecycleView.tsx 现按项目阶段分四栏，口径不符，重做而非微调）。
- 非目标：FBI DataMate 组件级归因（需授权，后续）；新建 PPL、写外部系统；MaaS 字段的后台补拉在本期仅出方案与占位，不真调鲲鹏。

## 2. P0-A GAAP 异动分析

### 2.1 数据与口径（全部来自现有快照）

- 输入：`CustomerItem.lastMonthGaap / yesterdayGaap / yesterdayGaapRate`（现有）。
- **需补投影**：`crm_snapshot.py#_project_customer`（L309-326）增加 `extGaapDDiff → yesterdayGaapDiff`（同一 customers 响应已含该字段，仅扩展投影，不新增外部调用）；`crm-types.ts CustomerItem` 增加可选字段。
- 旧快照兼容（无 diff 字段时）：`diff = yesterdayGaap × rate ÷ (1 + rate)`（rate > -1 时），并在 UI 标注「推算值」。

### 2.2 判定规则（集中在 crm-model.ts，纯函数可测）

- 三档阈值（可配默认）：T1 绝对 ±5 万（提示）、T2 绝对 ±30 万（关注）、T3 环比 ±50%（严重）；命中多档取最高档；暴增/暴跌由变动符号决定。
- 噪声防护：`yesterdayGaapRate` 或 `yesterdayGaap` 为空、rate=0、上月基数低于门槛（默认 30 万，可配）时不上报绝对档；低基数命中环比时标「低基数」。
- 输出：`GaapAlert { customer, direction: up|down, tier: T1|T2|T3, rate, diff, basis, lowBase }`，按档位、|rate| 降序。
- 三分态：暴增 / 暴跌 / 无异常；数据 stale/缺失单列为数据状态，不参与判定。

### 2.3 UI（CustomersView.tsx）

- 位置：指标卡之后、TOP 榜之前新增「GAAP 异动分析」面板。
- 异常卡：客户名 / 变动幅度（rate + diff）/ 上月基数 / 触发档位与方向（↑/↓ + 文案，不只靠颜色）；点击复用现有 `setOpenCid` 打开 `CustomerDrawer`。
- 归因占位：抽屉内已有 `InsightPanel`（FBI 消耗异动解读，走 `/local/fbi/insight`），本期不改链路；其未验证状态如实展示，不伪造结论。
- 诚实态：`SourceBanner keys=["customers"]` 已有 stale 提示；面板内再标「数据时效：快照 generatedAt」；无 rate → 「无环比数据」；无异常 → 「未发现达到阈值的异动」；无快照 → 等待同步。

## 3. P0-B PPL 跟进视图（替代生命周期视图）

### 3.1 视图结构

- 新建 `src/components/crm/PplFollowupView.tsx`；`App.tsx` 的 `lifecycle` 路由指向新组件，`viewTitles` 与 `Sidebar.tsx` 文案改为「PPL 跟进」；评审后删除旧 `LifecycleView.tsx`。保留 `customerLifecycle()`（CustomersView/CustomerDrawer 仍用）。
- 布局：MaaS / 非 MaaS / 未分类三条泳道（桌面三栏，移动端 tab 切换）；顶部按阶段筛选（stageName）+ 客户搜索；每客户卡片聚合其 PPL。
- 客户卡：客户名 / 等级 / 上月 GAAP / MaaS 徽标（三态）/ PPL 数；下挂 PPL 卡：项目名 / 阶段 / 赢率 / 预估收入(price) / 预计合同日 / GAAP 起算日 / 最近进展。
- 「最近进展」现状缺数据：用 `customer.lastNoteAt` 显示「最近跟进」；进展文本标「需补拉项目跟进字段」，不占位编造。
- 底部「未匹配客户项目」区：cid/customerName 匹配不上的项目显式列出（不能静默丢弃）；无在途 PPL 的客户显示空态。

### 3.2 模型（crm-model.ts + crm-types.ts）

- `pplFollowupBoard(snapshot, classification)`：按客户聚合全部 projects（快照以 `--state normal` 拉取），返回三条泳道 + unmatched + 计数；阶段筛选后客户与项目计数守恒。
- `classifyMaas(customer, projects, overrides)`：三态 `maas | non_maas | unconfirmed`。

### 3.3 MaaS 判定来源（缺字段，三层方案）

1. **首选·需补拉鲲鹏字段**：开发期用现有只读工具核对 `kunpeng_project_search_fields`（约 115 字段）是否有 MaaS/机会点分类字段；存在则 `crm_snapshot.py` 同次 projects 拉取增投影并回填（标注「需补拉鲲鹏字段」）。**本期不执行该探测**。
2. **过渡·关键词初筛**：仅对项目名/客户名做关键词匹配，关键词表由用户确认（如 MaaS、大模型、模型服务、百炼、推理等仅为占位示例，不视为业务口径）；命中标「疑似 MaaS」。
3. **人工覆盖**：本地配置 `maas-overrides.json`（CID → maas/non_maas），优先级最高、可审计。
4. **禁用**：`cate`（混合云/公有云/国际）与 MaaS 维度无关，**禁止映射**；无法判定一律「未分类」，不静默归入非 MaaS。PPL 表单机会点类型六项无 MaaS 专项，新建项目不会自带该标记——作为后续与表单侧对齐的事项。

## 4. 涉及文件

- 数据：`sync/crm_snapshot.py`（+yesterdayGaapDiff 投影）、`src/lib/crm-types.ts`。
- 模型/测试：`src/lib/crm-model.ts`、`src/lib/crm-model.test.ts`（新增两个 board + 阈值用例）。
- UI：`src/components/crm/CustomersView.tsx`、新增 `PplFollowupView.tsx`、`src/App.tsx`、`src/components/Sidebar.tsx`；复用 `CustomerDrawer.tsx`、`crm-shared.tsx`。
- 复用不改：`CrmProvider.tsx`、`crm-client.ts`、`/local/*` 路由。

## 5. 分期与依赖

- **MVP-1（本批串行）**：①补 yesterdayGaapDiff 投影（Python 投影 + 类型）；②crm-model 两个 board + 阈值；③异常面板；④PPL 跟进视图 + MaaS 三态（关键词占位 + 人工覆盖）；⑤测试与回归。不含 FBI 归因、不含后台补拉。
- **MVP-2（后续）**：鲲鹏 MaaS 字段核对与补拉（需一次真实刷新）；按真实分布标定阈值；FBI 归因（需授权）。
- **并行约束**：PPL 巡检返工（进行中）与本批共用 `crm-model.ts`/`crm-types.ts`，两批须按文件串行合并（先到先合，后到 rebase）；UI 文件不同可并行。旧 `lifecycleBoard()` 在新视图上线后清理（先确认无其他引用）。

## 6. 验证与验收（可判定）

1. **阈值单测**（虚构数值）：rate 边界 49.9/50.0/50.1%、diff 边界 4.99/5/30 万；正负方向；多档取最高；null/0/缺失不上报；低基数标记；排序稳定。
2. **异常不漏不误报**：给定夹具快照，断言异常集合与预期**完全相等**（不是包含）；无 rate 客户不出现；stale 快照仍计算但显示时效提示。
3. **PPL 视图**：夹具中每个项目恰好出现一次（MaaS + 非MaaS + 未分类 + 未匹配 = 全量）；阶段筛选前后总数守恒；三态客户计数之和=客户总数；无 PPL 客户可见；未匹配项目可见。
4. **回归**：现有 test:web / test:function / test:dev 全绿；`npx tsc --noEmit` 通过；视觉检查 1440×1000 与 390×844 无横向溢出。

## 7. 风险与待确认

- **MaaS 字段不可得**（项目字段元数据无此项）→ 降级为关键词 + 人工覆盖 + 未分类徽标；需用户提供判定口径（关键词表/客户名单）。
- **cid/客户名匹配缺口** → 未匹配区显式展示，不丢项目。
- **阈值误报**（小基数）→ 基数门槛 + 低基数标签 + MVP-2 按真实分布标定。
- **进展数据缺失** → 仅显示最近跟进时间并标注缺字段。
- **并行冲突** → crm-model/crm-types 串行合并。
- **待用户拍板**：①三档阈值默认值与「取最高档」逻辑；②MaaS 关键词表或客户名单；③是否接受「未分类」三态（而非强行二分）；④旧生命周期视图直接下线还是保留入口一个迭代。
