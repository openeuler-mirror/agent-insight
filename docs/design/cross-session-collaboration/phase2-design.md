# 跨 Session 调用关系：需求设计

## 独立存储与接口

Collaboration 保存用户、协作编号；CollaborationEvent 保存不可变规范正文、hash、首次接收时间，用户+协作+事件唯一。CollaborationSessionBinding 保存用户+协作+sessionId 到 traceSessionId（现有 Session.taskId）的明确映射。第三张表用于补齐原方案未落地的身份映射，不扫描裸 sessionId 猜测。

POST /api/ingest/collaborations/events 沿用原方案事件字段及 64 KiB 限制。POST /api/ingest/collaborations/sessions 接受 collaborationId、sessionId、traceSessionId，允许 Trace 晚到；同映射幂等，不允许改绑。可选 eventClock=source_session|synchronized|unknown（默认 unknown），由接入者声明该发起 Session 的事件时钟来自同一执行端或已同步。没有可信时钟依据禁止时间推定。绑定本身不会证明调用位置。

GET /api/observe/collaborations/:collaborationId?offset=0&limit=100 返回分页事件、端点节点、定位结果和 total。组内解析最多读取 2000 条事件、200 个绑定 Session，每条原 Trace 最多 8 MiB/20000 交互/20000 调用；单次查询累计正文最多 32 MiB、调用最多 100000 条；超出时返回 pending/容量原因，不在残缺组上排序。无 UI detailPath，只返回可用的 detailApiPath。

三个接口均要求 x-witty-api-key，归属取有效凭据的 username。所有 Trace 读取重新验证 Session 与 Execution 用户。未绑定的节点 unresolved；绑定不可覆盖，未知/无权 Trace 不提供内容。保存成功后解析失败返回 pending，不影响保存结果。

## 定位

只读取绑定 Session 的本层原始 tool_calls/parts。固定 Shell 工具映射；工具名精确匹配，命令字面包含。明确工具结果中的 session_id/sessionId/subagent_session_id/subagentSessionId 等于目标绑定的 traceSessionId，且是 task/spawn_agent/subagent 工具，才作为直接证据。类型队列推测、description 不参与确认；不改旧 buildAgentCallTree。

时间来源仅接受 OpenCode 原始 tool part state.time.start 或 timing.source=execution 的显式工具时间，不借用交互时间。重复定位组按原配置分组；数量相等、时间可用且不并列、时钟声明可信、无失败/一对多已知证据、明确关联不冲突、无跨组重叠时才排序。每次查询重算；事件不变。单候选可被迟到数据变为多候选。

当前后端返回上报关系及其明确 Trace 证据；旧 Trace 自动关系仍由原路径负责，不增加关系图界面或自动协作列表。数据库支持 SQLite 及 pg 接口；数据库变更只新增表。


## 运行日志与自动升级

复用公共 logger 的 collaboration scope，记录请求 ID、操作、HTTP 结果、定位状态、错误代码及原因；响应头回传请求 ID。日志不含采集凭据、传递正文或命令。两个既有启动脚本将 stdout/stderr 写入仓库根 server.log；db_push 和 generate 在启动前执行，新模型沿用该自动升级链路，不关闭破坏性变更保护。SQLite 回归验证旧库升级和重复启动同步；OpenGauss 定义同步但需实库验收。

## 现有 Trace 读取投影

`projection.ts` 读取已认证用户的绑定和事件，列表在数据库分页和计数前过滤已合并子 Session；指定 taskId 的原始入口及“全部 / 子 Agent”筛选保留原记录访问。详情的 structure/full/interactions 返回包含原 Session 标识、源索引、正文版本的交互，懒加载使用源 Session 与索引；刷新版本变化时丢弃旧正文。

`display-tree.ts` 分别构建各 Session 原有树，再组合。提供 fromLocator 的唯一候选挂在对应工具下并标“候选步骤”；confirmed/time_ordered 保留原证据状态。定位失败保留父 Agent 下的子节点和原因。不提供 fromLocator 时使用“协作 Trace”容器，将各 Agent 并列展示，按 observedAt（缺失则接收时间）顺序排列，不构造虚假工具调用。

相同子 Trace 正文只展示一次。循环、多父级冲突、缺失/无权限/空正文、重复 Execution、已有原生子记录或 Langfuse 专用树保留该连通组的原始列表。投影最多扫描 200 个协作组、2000 条关系、200 个 Session、32 MiB 正文，超过限制保留原列表并记录 warning。已有原生子树路径不改写；本轮无数据库模型变化。
