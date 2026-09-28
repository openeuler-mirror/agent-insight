# 跨 Session 协作 Trace

跨 Session 协作层把分散的 Session 关系作为独立覆盖层保存。它与 Execution 原生父子树并存：关系可以先于 Trace 到达，端点关联随新 Execution 重算，但任何结果都不会写回 `parentExecutionId` 或 `rootExecutionId`。

## 模块

| 模块 | 职责 |
|-|-|
| `src/lib/collaboration/*` | 严格 HTTP 契约、API Key、限流、自动会话匹配、兼容显式绑定、原始调用定位与安全日志 |
| `src/lib/ingest/collaboration/contracts.ts` | 外部事件严格校验、规范正文、稳定摘要与 Goal Plus 确定性 ID |
| `persist.ts` | Collaboration/Event 幂等保存、正文冲突和端点状态写入 |
| `resolve.ts` | 用户范围内按 Session 身份精确关联 Execution，并计算调用位置候选 |
| `query.ts` | 协作列表、节点和事件 read model，以及历史 Goal Plus 语义投影成员查询 |
| `src/lib/collaboration/projection.ts` / `display-tree.ts` | reported 协作的列表折叠、只读成员组合与步骤/并列树展示 |
| `src/lib/ingest/collaboration/trace-projection.ts` | Goal Plus 专用只读 TASK / 子 Agent 展示流 |
| `providers/goal-plus.ts` | 历史 Goal Plus 语义数据的内部投影；不是新版 collector 的主路径 |
| `CollaborationExplorer.tsx` | 独立协作图、节点/连线详情和原 Trace 入口 |

## API

`POST /api/ingest/collaborations/events` 只接受有效 `x-witty-api-key`，请求最多 64 KiB，并拒绝重复 JSON key、未知字段和内部保留 ID。外部请求不能提供 `sourceType`，因此保存为 `reported`。相同 collaboration/event ID 与相同规范正文返回 duplicate；正文不同返回 409 `EVENT_CONFLICT`。端点首次出现即成为节点，即使原 Trace 尚未到达也可浏览关系。

`POST /api/ingest/collaborations/sessions` 建立逻辑 `sessionId` 到 `Session.taskId` 的显式绑定，并可声明事件时钟可信度。绑定正文不可覆盖，Trace 可以晚到；同一规范正文重复上传幂等成功，不同正文返回冲突。普通 reported 接入不要求预绑定；已有绑定以及 Goal Plus collector 的 main/worker 绑定继续有效。

读取接口为 `GET /api/observe/collaborations` 和 `GET /api/observe/collaborations/:collaborationId`，均按当前用户隔离。详情返回分页 `events`、`nodes`、只读 `automaticEvents`、`resolutionComplete` 和 `nextOffset`，任务状态保持 unknown。`GET /api/observe/collaborations/native?traceTaskId=...` 从已有 Trace 构建原生调用图，不要求上报事件，也不写入关系。`POST /api/observe/collaborations/relink` 保留显式端点重算入口。

## 端点与步骤解析

端点优先读取同一用户、同一 collaboration 下的显式 binding；无 binding 时，按 `Session.taskId` / `Execution.taskId` / `Execution.agentSessionId` 精确匹配。多个候选对应不同 taskId 时保留身份歧义，不按名称或时间猜测。Trace 可以晚到；新增 binding 和 Execution 触发端点重算，图刷新重新读取身份与正文。

`fromLocator` 只搜索当前源 Trace 的原始工具记录。唯一工具名或 Shell 命令匹配为 candidate；明确 task/spawn_agent/subagent 调用中的目标会话编号可确认位置。多个事件只有在数量相等、时间无缺失或并列、事件时钟可信且调用时间来自执行端等条件均满足时才返回 time_ordered。未知事件时钟不参与时间推定，交互时间不代替工具开始时间；类型/FIFO 和 description 不作为调用证据。

自动边只来自成功原始调用中的唯一明确目标。仅当上报关系与原始调用位置、目标均唯一对应时才合并 `reported` / `trace` 来源。循环、自联系、重复联系、多父级和回传消息保留为图中的事件，不强制解释为新的子 Agent。

历史 `goal-plus-semantic` 关系可以保留持久化端点解析的关联与步骤状态；该回退限定于 semantic 来源，不能用历史 linked 状态覆盖普通 reported 当前身份歧义，也不构造不存在的原 Trace 正文。

## 普通 reported Trace 合并

`CollaborationProjection` 使用图查询中精确解析的 taskId，无须 sessions 预绑定。成员完整可读时，Trace 列表只保留一个合并入口；详情通过 `_collaboration` 标识来源，`buildCollaborationTraceTree` 先建各 Session 的原树，再组合展示：

- 有 `fromLocator` 且唯一定位的关系挂到对应调用步骤，保留 candidate / confirmed / time_ordered 的证据标识。
- 没有定位或不能确定唯一调用父级的成员在“协作 Trace”下并列展示。展示顺序使用 observedAt，缺失时使用接收时间，不证明实际执行不存在并发。
- 循环、回传和多父级联系完整保留在协作图；详情只取可构成树的唯一调用关系，其余成员并列，不构造循环的 Trace 树。

原始 Session/Execution 和评估口径不变。成员缺失、无权限、空正文、重复 Execution、已有原生子记录、Langfuse 专用树或容量不足时，普通关系的相关组件保留原始列表。跨协作的父级冲突也不强制合并。

## Goal Plus reported 路径

新版 Goal Plus 适配使用公开的 binding/event API：

1. Pi collector 在实际 `/goal-plus` start task 获得结构化 Goal ID 时立即异步上报 `main → <nativeSessionId>__taskN` 绑定，并在 settle/shutdown 重试。
2. Goal Plus collector 为 Pi worker 上报 `worker:<stable-id> → goal-plus:<sourceId>:<agentSessionId>` 绑定。
3. Goal Plus collector 在同一 collaboration 下上报 `main → worker` 事件。
4. 端点解析器在两端 Trace 可用后建立关联，读取投影逐 worker 合并已就绪成员。

两侧使用 `initialPiSessionId` 和 `goalPlusId` 计算同一个 `gp.<hash>` collaborationId。主 binding 必须引用 Pi collector 实际创建的分段 taskId，worker binding 使用 canonical worker taskId；逻辑 ID 和事件 ID由源数据稳定生成，不能包含扫描或接收时间。

Goal Plus reported 关系按 worker 独立判断：主端与当前 worker 唯一解析且两侧有非空 Session 正文时即可合并；另一个 worker pending 不阻塞当前 worker，也不要求主任务结束。主端歧义、当前 worker 缺失、跨用户或被拒绝的关系不生成详情 links。单个 worker 在加载期间暂不可读时跳过该成员，不中断其他就绪 worker。

## Goal Plus 专用投影与正文读取

历史 Goal Plus 语义数据继续通过 `GoalPlusExecutionLink` 选择当前 run 的明确成员，并由 `composeCollaborationTrace` 追加带 `trace_synthetic`、`trace_relation` 元数据的只读 TASK / 子 Agent 展示流。当前活跃主 Session、唯一 main link、worker 的 source/goal/run/candidate/session 身份和 owner 仍是成员边界；历史 run、歧义端点或普通 Pi 任务不借用该投影。详见 [Goal Plus 观测契约](12-goal-plus-observability.md)。

虚拟 TASK 追加在主 Trace 原生交互之后，标注“Goal Plus 编排”。关系可证明成员身份，不一定证明具体启动位置；`anchorState != confirmed` 时必须显示未确认定位。专用投影单次最多 50 个 worker、20000 条 worker 交互，超限或关联正文暂不可读时 `collaborationProjection.truncated=true`。子 Agent 保留 worker taskId，可继续打开独立详情。reported 关系投影优先；没有可用 reported 合并结果时才回退历史 semantic 专用投影。同一响应不叠加两套成员副本，避免重复显示。

`full`、`structure`、`interactions` 和单条 interaction 读取使用一致投影。普通合并交互保留 `_collaboration` 源 Session/索引/版本，所有 Session 响应保留 `_payloadVersion`；前端拒绝刷新前发起或版本不匹配的异步加载结果。`source=raw` 绕过展示投影，读取仍验证当前用户。

## 列表折叠与 pending

Trace 列表显式请求协作 worker 折叠。默认“仅主 Agent”范围排除已经成功投影的普通协作成员，以及 Goal Plus `main → worker:*` 事件中已有 worker binding 的已声明子节点。“仅子 Agent”将这些 worker 与原生 `isSubagent=true` Execution 合并查询；“主 Agent + 子 Agent”保留全部记录。

Goal Plus 投影计划把列表隐藏与详情合并分开：`hiddenChildren` 包含已声明 worker 与已合并子节点；其中尚未合并的已声明 worker 进入 `pendingChildren`；`links` 只包含当前可读的主从关系。main binding、主 Trace 或 worker 正文仍 pending 时，已声明 worker 不回退成默认主记录，详情也不会凭空生成正文。

过滤发生在数据库分页和聚合之前，保证 page size、total 与统计一致；不改写 `Execution.isSubagent`。普通 reported 只有成功投影才隐藏，查询失败保留原列表。已识别 Goal Plus 声明后发生解析查询失败时保留该隐藏集合；全局投影安全限制触发时回退原列表。全局上限为 200 个协作组、2000 条关系、200 个 Session、32 MiB 正文。

## 独立协作图

`/observe/collaborations` 和 `/observe/collaborations/:id` 展示分页上报事件与明确原始调用导出的自动关系。节点可查看原 Trace，连线可查看上报内容、定位依据和步骤原文；循环、自联系和重复联系不被树展示丢弃。

Trace 列表的“协作图”打开上报协作列表；Trace 详情的“调用关系图”打开无需上报事件的原生调用图。图读取和 Trace 合并共用身份解析，完整 HTTP 契约见 [04-api-and-contracts.md](04-api-and-contracts.md)，操作示例见 [查看 Trace](../user-guide/observability/view-traces.md)。

## 持久化对象与一致性

- `Collaboration`：用户与来源范围。
- `CollaborationEvent`：不可变关系正文与接收审计。
- `CollaborationSessionBinding`：逻辑 Session 到 Trace Session 的不可覆盖绑定及事件时钟声明。
- `CollaborationEndpointResolution`：可重算的 from/to Execution 引用、证据与步骤候选。

本轮复用已有表。关系重算失败不得回滚已经入库的 Trace，Trace 上传失败也不得删除已持久化关系。collector 本地 outbox 以相同规范正文和稳定 logical key 重试：2xx 记 delivered，网络/429/5xx 重试，确定性 4xx 进入 rejected。

Goal Plus 关系只保存角色、run/candidate/agent session 标识与可审计 locator，不保存 worker 输出、评分或结果摘要；worker 正文继续由 OTLP Trace ingest 负责。日志使用 collaboration scope 和请求 ID，不记录凭据、事件正文或 Shell 命令。
