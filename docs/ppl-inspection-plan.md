# PPL 每日巡检 + 推荐 + 确认后创建 · 实现规划

日期：2026-10-16 · 更新：2026-10-17 · 状态：MVP-1 已实现（待交付负责人评审入库）· 依据：交付负责人已核实材料（skill 契约）+ 仓库现有文件（crm_snapshot.py、crm-snapshot.json、dev/local-router.ts、dev/ops-bridge.ts）+ 用户 2026-10-17 拍板（日报源=钉钉日报、界面进工作台、创建触发尽量自动化）。

> **已定项（2026-10-17 用户拍板）**
> 1. 日报源：**钉钉日报**，`dws report outbox list`（白名单只读，见 §4）；
> 2. 摘要整理进工作台做 PPL 推荐（本文件 §7 面板，已落地驾驶舱）；
> 3. 创建 skill 触发尽量自动化：MVP-1 为「面板同意 → agent 会话执行」，自动化定时触发列入 MVP-2（§8）；
> 4. 界面进工作台（驾驶舱「PPL 巡检」面板，已落地）；
> 5. 席位看板 2000986 ACL 复查（2026-10-17）：**仍无权限**（「数据权限不足，无法执行本次查询： 无报表： 2000986,的权限」），申请入口已提交审批中，坐席卡暂不动。

术语：
- PPL：销售运营工作台中的项目记录；本方案以快照 `projects`（153 条，2026-10-15 口径）作为「我的 PPL 清单」（映射一致性见 §12-3）。
- 创建执行器：`kunpeng-ppl-create` skill（位于 Waker agent 工作区 `.qoder-plugin/skills/kunpeng-ppl-create`，只读引用、不改动）。

## 1. 目标与非目标

目标（三段链路）：
1. 每日 09:15 巡检：**只读**比对「我的 PPL 清单」与「日报」→ 找出未创建的 PPL → 生成推荐条目（含建议字段）。
2. 工作台「PPL 巡检」面板：提醒 + 推荐 + 逐项「同意/放弃」。
3. 逐项同意后：由 agent 会话调用 kunpeng-ppl-create skill 真实创建；结果（含 BPID）回写工作台。

非目标（本期不做）：
- 定时任务/分析引擎中的任何外部写（创建、发消息）；
- 自动批量创建、创建失败自动重试；
- 改造 kunpeng-ppl-create skill 本身；
- 先接不稳定的日报自动源（MVP 仅接用户指定源）。

## 2. 铁律边界（不可突破）

- B1 巡检只读：09:15 任务仅使用快照 + 日报文件做分析，仅写本项目产物 `.local-cache/ppl-inspection/`；任务 prompt 沿用现有五禁（禁发送 / 禁写外部系统 / 仅写本项目产物 / 禁落盘凭证 / 遇墙即停）。
- B2 真实创建=双闸门：闸门一=工作台逐项「同意」（写本地 `approvals.json`，仅授权）；闸门二=agent 执行 skill 时按 skill 自带边界「提交前复述全部字段值获用户确认，未确认不点确定」。两闸门缺一不可。
- B3 逐条执行、禁批量；每条创建尝试写审计条目（时间/字段/结果/BPID/失败原因）。
- B4 凭证与登录态由各 skill/CLI 自持本机；仓库代码不读取、不打印、不落盘。

## 3. 架构与数据链路

```
08:30 同步任务（现有）──→ .local-cache/crm-snapshot.json（projects 153 / customers 35）
09:15 PPL 巡检任务（新增，只读）＝ sync/ppl_daily_report.py（已实现）
  ├─ 校验快照新鲜度（generatedAt；stale → 标注「基于 X 日快照」）
  ├─ 读日报源（§4 已定：dws report outbox list 钉钉日报，白名单只读）
  ├─ 抽取候选条目 → 与 projects 判重（§5）→ 生成推荐
  └─ 写 .local-cache/ppl-inspection/<YYYY-MM-DD>.json + latest.json（0600）
工作台（React+Vite；仅 /local/* 本机桥，不进入部署 Function；已实现）
  ├─ 「PPL 巡检」面板（驾驶舱）读 latest.json（推荐列表 + 三分态徽标）
  ├─ 逐项 同意/放弃 → POST /local/ppl/approval → approvals.json（0600）
  ├─ 面板「立即/重新巡检」→ POST /local/ppl/refresh（后台跑巡检脚本）
  └─ 创建结果回写展示（状态 + BPID；回写动作由 agent 会话完成）
Agent 会话（用户触发）
  └─ 读 approvals.json 的 approved 项 → kunpeng-ppl-create skill 逐条创建
     → 回写 creating / created(+BPID) / failed(+原因)
```

- 状态机（每条推荐）：`pending → approved | discarded → creating → created（+BPID）/ failed（+原因）`。
- 时区：Asia/Shanghai；日期以同步快照与本地日历为准。

## 4. 日报来源（已定：钉钉日报 dws report outbox list）

**用户已拍板（2026-10-17）**：日报源 = 钉钉日报，用 dws 检索本人发出的日报。

| 候选来源 | 结论 |
|---|---|
| 钉钉「日志/日报」 | **已核实并接入**：`dws report outbox list`，支持 `--start/--end`（ISO-8601 ±hh:mm，单次窗口 ≤20 天）、`--cursor`、`--size`（1-20）、`--format=json`；不传 `--template-name` 查全部。实测默认窗口无新日报、显式窗口可返回历史日报 |
| 钉钉文档/听记 | 未接（owned-docs 枚举仍 `blocked-capability`） |
| 本机文件 | 不再需要（日报源已定） |
| 其他（粘贴/其他系统） | 不再需要 |

接入约束（`sync/ppl_daily_report.py`）：命令白名单只允许 `report outbox list` + 上述 5 个 flag（值全校验），超时 120s；解析只取「日志内容/日期/标题」三个中文键，内容截断 6000 字、单次最多 60 份；dws 不存在/退出非 0/登录态失效 → 巡检产物标 `failed`（原因 `dws_missing`/`dws_exit_N`/`dws_auth`），诚实不编造。

## 5. 判重与匹配口径（建议，保守优先）

1. 归一化：去空格/全半角/【】「」/FY 前缀/日期串。
2. 三层比对：
   - a) 项目名归一化后与 `projects[].name` 精确/子串比对 → **「已存在」**（不推荐创建）；
   - b) 同 CID（或归一化同名客户）下主体关键词（产品/场景词）重合 → **「疑似已存在」**（展示但默认不推荐，需人工判断）；
   - c) 无命中 → **「未创建」**（推荐创建）。
3. 每条输出附匹配证据（命中的既有项目名/ID），不做黑箱。
4. 匹配键优先级：CID > 客户名（归一化）> 项目名；阈值与停用词集中配置。

## 6. 推荐字段与来源

| 字段（★=skill 必填） | 来源 | 缺失时动作 |
|---|---|---|
| ★ 工作文档链接 | 用户提供（建议固定模板链接；待拍板） | 阻塞创建，提示用户 |
| ★ 客户名称（建议附 CID） | 日报抽取；CID 由 customers(35) 精确/模糊匹配 | CID 缺 → 仅客户名 + 人工确认；客户名缺 → 人工补充 |
| ★ 项目名称（FY27-Q3-客户-项目） | 模板生成：`FY27-Q3-{客户}-{日报主题词}` | 允许用户修改 |
| ★ 预估年化收入 | 日报中金额原文（若有） | **绝不猜测**；用户填写后解锁创建 |
| 机会点类型（固定下拉） | 关键词→6 项映射表（智算-GPU/敏态/SFOA/七大件/大数据/其他）；产品名如 qoder 无匹配 → 就近替换并显式提示 | 无映射 → 「其他」+ 提示 |
| 变更说明（≤140 字） | 日报关键句摘录 | 可空 |

## 7. 工作台 UI 设计（已落地驾驶舱）

- 落点：驾驶舱（`src/components/crm/CockpitView.tsx`）已挂「PPL 巡检」面板（`PplInspectionPanel`）；信息量大再升为独立视图。
- 卡片内容（已实现）：巡检时间 + 快照新鲜度 + 日报份数 + 推荐计数；每条 = 客户名/CID / 建议项目名（FY27-Q3 模板）/ 机会点类型 / 金额 / 三分态徽标 + 匹配证据（命中既有项目名）。
- 交互（已实现）：同意（弹层复读全部字段 + 「同意 = 授权创建。提交前 agent 会逐字段复述确认，未确认不会点确定」）→ approved；放弃 → discarded；金额缺失条目同意按钮禁用且后端 422 双重拦截；已处理条目折叠区展示；面板脚注固定「同意仅写入本地授权记录（approvals.json），不会创建 PPL」。
- 面板支持「立即巡检/重新巡检」（POST /local/ppl/refresh，后台跑只读巡检脚本，202 返回）。
- 已创建显示 BPID；failed 显示原因 + 「重新发起」（重走双闸门）——回写入口在 agent 会话侧，MVP-1 未含。
- 控制台提醒：①任务结果通知（Qoder App 任务机制，复用现有先例）；②钉钉卡片=后续可选扩展，复用 ops 的「预览 → 真发开关」模式（`ops-push-preview.json`：`mode/cardText/receiverConfigured`，默认关、永不自动发送）。
- 空态/异常态（已实现）：无产物 → 「还没有巡检产物」+ 立即巡检按钮；快照过期 → 显式标注口径日期。

## 8. 分期

- **MVP-1（分析引擎 + 面板）——已实现（2026-10-17，待评审入库）**：`sync/ppl_daily_report.py` 采集+分析引擎（dws 白名单只读 + 三分态判重 + 金额阻塞）；`dev/ppl-inspection-bridge.ts` 本机桥（latest.json 只读 + approvals.json 决策 + 后台巡检）；`/local/ppl/inspection|refresh|approval` 三路由；`src/lib/ppl-client.ts` + 驾驶舱 `PplInspectionPanel`；测试见 §10。agent 手动执行创建 + BPID 回写待功能入库后由 agent 会话首跑。
- **MVP-2（定时化 + 创建触发自动化）**：Qoder App 新增 09:15 任务（只读 prompt + 五禁）。机制注意：改任务后需重启 App 重载；`prevent_sleep=1`；防 failureCircuit 熔断（已知根因=休眠唤醒后 DNS 未就绪）。用户已拍板「创建 skill 触发尽量自动化」→ 本期随巡检自动化推进。
- **后续**：钉钉卡片提醒（真发开关）、多日巡检差异对比、匹配算法升级（含集团简称→子公司映射，当前按保守原则不映射，见 §5）。

## 9. 风险与依赖

| 风险 | 缓解 |
|---|---|
| BUC 登录态失效（创建中断） | 创建前检查；遇墙即停 + 提示用户重登；不自动重试 |
| CID 匹配失败 | 降级仅客户名；标记「待补 CID」 |
| 日报格式不稳定 | 单一可控源（dws outbox）；解析失败条目不猜，列「需人工补充」 |
| 金额缺失 | 阻塞该条创建（blocked + 前后端双重拦截），直至用户补齐 |
| 快照 stale | 巡检结果显式标注口径日期，不静默 |
| 双闸门被绕过（误创建） | 静态断言 + 流程测试 + 审计日志（§10） |
| 153 条 projects 与 PPL 口径不一致 | 开发首验项：抽样 1-2 条与工作台页面核对（只读） |
| 集团简称（海信/青啤等）匹配不到快照子公司实体 | 保守不映射：宁可漏报不可误报，漏掉的候选可人工在日报侧补全客户全名 |

## 10. 验证方案（已执行，2026-10-17）

1. **分析准确性**：`tests/test_ppl_daily_report.py`（17 例）——三分态（exists/suspected/new）各至少 1 例 + 证据含项目名；同客户不同主题降级疑似；金额缺失 blocked 绝不猜；万元/元抽取；快照 stale 标注；真实端到端 1 次（8 份日报 → 2 条推荐，均为疑似已建 + 金额缺失阻塞）。
2. **零误创建**：(a) 静态断言（Python + TS 链路 4 文件）：源码不含创建 skill / devata / 浏览器自动化关键词，命中数=0；(b) 流程测试：同意只写 approvals.json，blocked 条目 422 拒绝，巡检脚本仅 `report outbox list` 白名单；(c) 审计=approvals.json（时间/条目/动作）。
3. **确认流闭环**：`dev/ppl-inspection-bridge_test.ts`（6 例）——decide 状态机（approve/discard/already_decided/not_found/invalid_request/blocked）、approvals.json 0600、projectState 投影、refresh 只跑巡检脚本；路由集成 404/201/400/409/422/405/202；真实网关实测（422 blocked、404、400、201 discard、409 重复、GET 回读决策一致）。
4. **回归**：Python 176 例 / test:dev 72 / test:web 41（含 ppl-client 5）/ test:function 36 全绿；`npx tsc --noEmit` 通过；Playwright 实测驾驶舱面板渲染（1 待处理/2 条、同意按钮禁用+阻塞提示、已处理折叠区、零控制台错误）。

## 11. 涉及文件（实际落地）

- 新增：`sync/ppl_daily_report.py`；`tests/test_ppl_daily_report.py`；`dev/ppl-inspection-bridge.ts` + `_test.ts`；`src/lib/ppl-client.ts` + `ppl-client.test.ts`；`src/components/crm/PplInspectionPanel.tsx`。
- 修改：`dev/local-router.ts`（+/local/ppl/inspection|refresh|approval）；`src/components/crm/CockpitView.tsx`（挂载面板）；`src/crm.css`（ppl-* 样式）。
- 复用：`crm-snapshot.json`、本机 dev 桥模式、`atomic_write_json`。
- 产物目录：`.local-cache/ppl-inspection/`（`<YYYY-MM-DD>.json` / `latest.json` / `approvals.json`，均 0600）。
- 只读引用：`kunpeng-ppl-create` skill（**不改动**，代码零引用）。

## 12. 待用户拍板（剩余项）

1. ~~日报载体与路径~~ **已定（2026-10-17）**：钉钉日报 `dws report outbox list`，已接入。
2. 工作文档链接（skill 必填）取用方式：固定模板 vs 每次指定——**仍待拍板**（当前金额缺失条目已阻塞，此字段在 agent 创建前补充确认）。
3. 153 条 projects 是否即 PPL 全集（开发首验 + 用户确认）——仍待首验。
4. 登录态策略：巡检分析用快照即可（无需浏览器）；创建仅依赖 skill 自持的 BUC 登录态——建议与鲲鹏 Chrome 通道解耦、失效人工重登。
5. 机会点类型映射表初版确认（含 qoder 等无匹配产品名的就近替换规则）——初版已实现（qoder/千问办公/百炼/qwen/模型/agent/aios → 智算-通义），待用户确认。
6. 钉钉卡片提醒是否列入本期（默认否）。
