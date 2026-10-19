# 钉钉待办双向同步 + 钉群未读每日总结 实施方案

- 状态：规划稿，未动代码；排在客户盘面 P0-A/B 之后实施。
- 来源：用户原话（seq 155）+ 交付负责人可行性探测结论（dws todo/chat 子命令，直接采用，未重复探测）。
- 铁律：写操作仅 `todo +create`（P1 `+complete`），逐条显式确认；禁止发送/撤回消息、清红点、标记已读、改群；总结管道零外部写。

## 1. 现状核对（已读代码，本轮仅本地只读）

| 事实 | 位置 |
| --- | --- |
| todos 只读自 `todo +get-related-tasks`，白名单在 `DWS_COMMANDS`；`run_dws` 仅放行白名单命令、追加 `--format json`、`shell=False`、180s 超时 | `sync/crm_snapshot.py` L34-41、L105-127 |
| `fetch_todos` 只投影 `taskId/title/priority/planFinishDate`，**无状态、无完成时间** | `sync/crm_snapshot.py` L248-257 |
| 快照 10 段结构、失败保留旧条目标 stale、`atomic_write_json`、umask 0o077（产物 0600） | 同文件 `_section` L479-503、`build_snapshot` L506-536、`main` L555 |
| 前端 `TodoItem {id,title,priority,dueAt}`；`normalizeSnapshot` 兼容旧快照加字段 | `src/lib/crm-types.ts` L43-48、`crm-client.ts` |
| 驾驶舱 `todoActions` 按逾期/今日/3 天内/watch 分档；「逾期待办」卡 note 写死「共 X 条未完成」，**因无状态字段，实际把拉到的全部待办当未完成** | `src/lib/crm-model.ts` L285-296、`CockpitView.tsx` L138-148、L171 |
| 钉群盘面：`dingtalkBoard` 产出群↔客户 linked/unconfirmed/unlinked + missingCustomers + mentions；未读会话只展示 id/name | `src/components/crm/DingtalkView.tsx` L64-70、L226-249 |
| 本地路由：origin 白名单 + `allowRequest` 限流；`/local/crm/refresh` GET/POST→202 轮询范式；`/local/ppl/approval` POST 是现成的「写本地 decisions」先例 | `dev/local-router.ts` L155-187、L266 |
| 桥进程范式：`execFile` `shell:false` maxBuffer 8MB 超时受控；fbi-insights 目录 0o700、产物 0600 | `dev/crm-bridge.ts` L129-133、L285 |
| PPL 审批状态机 pending→approved→creating→created/failed、approvals.json 0600，「创建执行留外部」铁律注释 | `dev/ppl-inspection-bridge.ts` L10、L190-208 |
| `qodercli` 在 `~/.qoder/bin/qodercli/qodercli-1.0.34`（另有 0.2.16）；`--help` 确认支持 `-p/--print` 非交互、`-w/--cwd`、`--tools`（可传 `""` 禁用全部内置工具）、`--allowed-mcp-server-names`、`--permission-mode`、`-o/--output-format`、`--max-output-tokens`。**启动时打印当前 `~/.qoder/settings.json` 4 个 mcpServers `authType` 配置校验错误**；本轮未跑真实 prompt，`-p` 是否被该错误阻断未验证 | 本机探测（仅 `--help`，无副作用） |
| `dws` 在 PATH（`~/.qoder/bin/dws`）；`qoder` 不在 PATH | 本机探测 |

## 2. 目标与非目标

- 目标：F1 待办「拉取增强 + 工作台创建（P1 完成同步）」；F2 钉群未读每日总结（按客户聚合工单）。
- 非目标：不指派他人待办（v1 执行人=本人）；不做消息级已读同步（钉钉无接口）；不自动清红点；站点保持未发布；不改鲲鹏/FBI 链路。

## 3. P0/P1 拆解

### F1 待办双向同步

| 项 | 内容 |
| --- | --- |
| F1-P0 拉取增强 | `fetch_todos` 增投影：完成状态、完成时间、执行人、创建时间——**字段名以 `+get-related-tasks` 一次真实样本为准**（读操作，实现第一步核对），投影只加白名单字段，schema 保持 v1 + 可选字段，前端 `normalize` 补默认值。驾驶舱 todos 分「未完成（逾期/今日/以后）/已完成」；`todoActions` 只统计未完成；L171 卡片 note 改真实口径 |
| F1-P0 创建 | 驾驶舱「新建待办」：表单（标题/截止/优先级；执行人固定本人）→ 确认弹窗逐字段复述（对齐 PPL 字段复述闸门）→ `POST /local/dingtalk/todo` → 桥先 `--dry-run` 预演，通过后真实 `+create` → dws 自带读回 + 桥二次校验（taskId 存在、标题/截止匹配）→ 触发快照刷新。防重复：客户端 requestId + 服务端映射表（同 requestId 重放直接返回既有结果，进行中拒绝并发），审计 JSONL 0600 |
| F1-P1 完成同步 | 待办行「标记完成」→ 确认弹窗（复述标题）→ `POST /local/dingtalk/todo/complete` → `+complete`（含读回）→ 刷新。失败如实报错，不重试碰运气 |

### F2 钉群未读每日总结

| 项 | 内容 |
| --- | --- |
| F2-P0 采集 | 新脚本 `sync/dingtalk_daily.py`：`+unread-chats` ∩ 快照 `groups`（只处理群聊，单聊计数上报不摘要）→ 逐群 `chat +chat-messages --group <id> --start --end --order asc --page-limit 100 --max-items 200`。界：群数 ≤20/轮、每群 ≤200 条、时间窗 ≤72h（首次取近 24h，之后按水位）；分页不完整该群标 partial。消息最小投影（messageId/sender/text/time）落 `.local-cache/dingtalk-daily/raw/<date>/<chatId>.json` 0600。**绝不调用清红点/标记已读** |
| F2-P0 水位 | `watermarks.json` per chatId：`{lastMessageTime, lastMessageId, lastSummarizedAt}`。群 complete→推进到窗口 end；partial→推进到最后一条已读消息时间（复用 ops qianzai 游标语义，不跳过未读尾部）；空→窗口 end |
| F2-P0 摘要 | qodercli 非交互：`qodercli -p <prompt> -w <项目根> --tools "" --allowed-mcp-server-names`（禁全部工具与 MCP → 结构性零写）；严格 JSON：每群 `{summary, tickets:[{problem, firstSeenAt, lastSeenAt, status: resolved|unresolved|unconfirmed, solution|null, evidence:[messageId]}]}`。判定规则进 prompt：只有问题之后出现明确解决表述且引用到证据消息才可 `resolved`；无证据一律 `unconfirmed`；输出超预算的群做等距采样并标 `truncated`。解析失败重试 1 次（只读安全），仍失败降级规则抽取（关键词+时间序）并显式标「未生成摘要」，不造假 |
| F2-P0 聚合 | **摘要 JSON 保持 per-chat，客户聚合放前端**：复用 `dingtalkBoard` 现成 linked/unconfirmed/unlinked 三桶（linked→按客户分组、unconfirmed→待确认桶、unlinked→未匹配桶），避免 Python/TS 两套匹配漂移 |
| F2-P0 UI | DingtalkView 顶部新增「每日群消息总结」panel：日期选择（默认最近有产物日）、「立即生成」（手动，P1 才定时）、按客户分组、未解决置顶、证据行展开显示消息原文（经专用端点投影）、生成失败红条如实告警 |
| F2-P1 定时 | 每日 08:45 任务覆盖上一自然日（任务创建需用户授权，改任务后重启 App 并验证 failureCircuit）；先上手动「立即生成」 |
| F2-P1 联动 | 未解决工单一键「转待办」：预填标题（`客户-问题摘要-跟进`），走 F1 创建链路与确认弹窗 |

## 4. 数据模型与文件清单

新增（均 `.local-cache/`，0600）：

| 文件 | 内容 |
| --- | --- |
| `dingtalk-todo-writes.json` | `{requestId: {state: creating\|created\|failed, taskId, error, dryRun, createdAt}}` 幂等映射 |
| `dingtalk-todo-audit.jsonl` | append 审计：ts/action/requestId/命令模板与旗标名/title/dryRun 结果/taskId/错误码 |
| `dingtalk-daily/watermarks.json` | 群级未读水位 |
| `dingtalk-daily/raw/<date>/<chatId>.json` | 消息最小投影原文（0600，供证据展开） |
| `dingtalk-daily/summary-<date>.json` | 摘要产物 + per-group `complete/partial/truncated` 状态 |
| `dingtalk-daily/runs.json` | 生成任务状态（idle/running/succeeded/failed + error） |

代码新增：`sync/dingtalk_daily.py`、`sync/test_dingtalk_daily.py`、`dev/dingtalk-bridge.ts`、`dev/dingtalk-bridge_test.ts`、`src/lib/dingtalk-types.ts`、`src/lib/dingtalk-client.ts`、`src/components/crm/DailySummaryPanel.tsx`、`TodoComposeDialog.tsx`。

代码修改：`sync/crm_snapshot.py`（fetch_todos 投影）、`src/lib/crm-types.ts`（TodoItem 增可选字段）、`src/lib/crm-model.ts`（todoActions 过滤未完成）、`src/components/crm/CockpitView.tsx`（表单入口 + 已完成区 + 口径修正）、`src/components/crm/DingtalkView.tsx`（总结面板）、`dev/local-router.ts`（新路由）。

## 5. 接口/路由定义（沿用 `{ok, data|error}` 封套、origin 白名单、限流）

| 路由 | 方法 | 语义 |
| --- | --- | --- |
| `/local/dingtalk/todo` | POST | 创建待办。body `{requestId, title, dueAt(ISO8601), priority(10\|20\|30\|40), executor:"self"}`；202 受理/200 幂等重放；错误码 `invalid_request/busy/dws_missing/todo_write_failed/todo_verify_failed` |
| `/local/dingtalk/todo/complete` | POST（P1） | `{requestId, taskId}` → `+complete` + 读回 |
| `/local/dingtalk/todo/writes` | GET | 本机写入记录（审计投影，便于 UI 展示最近创建） |
| `/local/dingtalk/summary` | POST | 202 启动当日生成（running 单例）；GET `?date=` 读产物，无产物 404 `summary_not_found` |
| `/local/dingtalk/summary/status` | GET | RefreshStatus 形态，前端 3s 轮询 |
| `/local/dingtalk/daily-messages` | GET | `?date=&chatId=` 证据原文投影（只回 messageId/sender/text/time） |

写入执行器 `runDwsWrite`（仅 dingtalk-bridge 内）：命令前缀白名单 `("todo","+create")`/`("todo","+complete")`，旗标逐一校验（title 1–200 字 trim、due ISO8601 且可解析、priority 枚举、executor 常量），`shell:false`、timeout 120s、先 `--dry-run` 后执行，两次调用都进审计。

## 6. 安全闸门

1. 写白名单：全桥仅 `+create`（P1 `+complete`）；`+send/+recall/+update/+mute/+clear` 等任何其余子命令一律 `command_not_allowed`。
2. 用户确认：确认弹窗逐字段复述 + requestId 绑定该次确认；无确认不下发。
3. 幂等与并发：requestId 映射表 + creating 锁；dws `+create` non-idempotent，靠本地映射防重。
4. 读回验证：dws 自带读回 + 桥校验 taskId/标题/截止，不一致判 `todo_verify_failed` 并如实上报（待办可能已创建，UI 提示去钉钉核对，不自动重试）。
5. 总结管道零写：qodercli 调用固定 `--tools ""` 且不传 `--allowed-mcp-server-names`；静态断言测试（见 §7）。
6. 隐私：真实客户名/消息内容不入代码与 fixture（合成数据「示例客户群A/B」）；raw 缓存与审计 0600；浏览器响应无绝对路径/凭证；`dws` 裸 `execFile` 不接管道不经过 shell。isolated 源每轮（含异常路径）递归收紧其配置目录为目录 0700/文件 0600，失败以 `isolated_log_chmod_failed` 记入产物 `warnings`，不阻断摘要；default 源使用 `~/.qoder`，qodercli 自写日志可能为 0644 且含 prompt，桥不递归修改用户全局目录。
7. 产物权限：目录 0o700、文件 0600（沿 crm/ops 范式 + umask）。

## 7. 测试计划（含失败分支）

- `sync/test_dingtalk_daily.py`（合成 fixture）：unread∩群交集（单聊剔除并计数）；群数/条数/时间窗三重截断→partial；水位推进（complete/partial/空/首次 24h）；raw 落盘权限位断言；prompt 组装含哨兵检查（不含 fixture 外真实名）；LLM 输出非法 JSON→重试 1 次→规则抽取降级且标「未生成摘要」；`resolved` 必须有 evidence messageId，否则判 `unconfirmed`。
- `dev/dingtalk-bridge_test.ts`（fake runner）：create 路由参数校验（空标题/超长/优先级非法/due 非 ISO→`invalid_request`）；调用序列必须 dry-run→create，dry-run 失败绝不执行；同 requestId 重放不再调用 runner；读回不一致→`todo_verify_failed`；dws 缺失/超时/非零→错误码映射；complete 路由同构；summary 404/202/running 单例；daily-messages 只投影允许字段。
- 静态断言：grep 级测试——dingtalk_daily.py 与 qodercli 调用构造中不得出现 `+create/+complete/+send/+recall/+update` 等写子命令字符串、必须含 `--tools` 空参；dingtalk-bridge 中写白名单之外子命令零出现。
- 回归：`crm-bridge_test.ts`、`local-router_test.ts`、`test_crm_snapshot.py` 全绿（fetch_todos 改动后旧快照向后兼容）。
- 手工/浏览器：1440×1000 与 390×844 无横向溢出；确认弹窗键盘可达；创建成功后列表刷新可见；断网/登出态错误如实。

## 8. 验收标准

1. 快照 todos 带状态；驾驶舱逾期计数只算未完成，已完成区可见，口径与卡面文案一致。
2. 创建链路全通：表单→复述确认→dry-run→创建→读回→刷新可见；同一 requestId 双击只产生一条；审计可查。
3. 摘要产物为严格 JSON；工单按客户三桶聚合；无证据不得判「已解决」；失败/降级显式告警并标「未生成摘要」。
4. 全程零清红点/标记已读调用（静态+运行断言）；现有只读链路行为不变。
5. 缓存 0600；浏览器响应无绝对路径、无凭证；站点未发布。

## 9. 依赖与风险

- **qodercli 可用性**：`--help` 已验证，但当前 settings.json 有 4 个 mcpServers `authType` 校验错误，`-p` 是否被阻断未验证；缓解：`--config-dir` 指向干净配置根（实现时先跑一次最小 prompt 验证）。CLI 不可用时降级规则抽取。
- **数据出域**：群消息文本经 qodercli 上行模型服务完成摘要——属既有「方案助手」同路径，但内容含客户沟通记录，需用户对出域范围确认（待确认 3）。
- **dws 登录态**：登出时读/写全失败，按 kunpeng 登录失效模式如实报错，不静默。
- **字段语义**：`+create` 的 priority 数值映射、`+get-related-tasks` 状态字段名需样本核对，禁止凭猜测硬编码。
- **体量**：超大群超输入预算→采样+`truncated` 标注；群数/条数上限实现后按实测校准。
- **排期冲突**：`crm_snapshot.py`/`CockpitView.tsx`/`DingtalkView.tsx` 与客户盘面 P0-A/B 有交集，F1/F2 排在其后合入；`dingtalk_daily.py`、`dingtalk-bridge.ts` 为纯新增无冲突。

## 10. 待确认项

1. **截止/优先级默认值**：建议截止=当天 18:00（表单可改）、优先级默认 20；请确认数值与默认语义。
2. **未读水位口径**：红点会话∩群 + 本地水位文件；首次近 24h、窗口上限 72h、每群 200 条、每轮 20 群；partial 只推进到已读尾。是否认可？
3. **总结时间与范围**：定时 08:45 覆盖上一自然日 vs 纯水位制（不漏但跨天）；建议「水位制 + 08:45 定时触发」。另：群消息经 qodercli 出域到模型服务，需用户确认。
4. **摘要执行体**：已确认本机 qodercli 1.0.34 支持 `-p`/`--tools ""`，作为唯一摘要通道（不走 DashScope）；若配置错误阻断，用 `--config-dir` 规避——是否符合「与方案助手同路径」的预期？
5. **v1 是否含完成同步**：当前按 lead 分层 v1 只做创建、完成同步 P1；请确认。
6. **本人 userId 获取**：`+create --executors` 必填。候选：a) 环境变量一次性配置（`.env`，不入库不入文档）；b) 从 `+get-related-tasks` 样本的执行人字段提取；c) dws 是否有 whoami 类只读命令待查。倾向 b+a 兜底。
7. **单聊处理**：未读中的单聊 v1 不摘要，仅在面板计数展示；确认。
