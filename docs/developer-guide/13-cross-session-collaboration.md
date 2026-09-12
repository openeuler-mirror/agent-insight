# 跨 Session 协作 Trace

跨 Session 协作层将分散的 Session 关系作为独立覆盖层保存。它与 Execution 原生父子树并存：关系可以先于 Trace 到达，端点关联随新 Execution 重算，但任何结果都不会写回 `parentExecutionId` 或 `rootExecutionId`。

## 模块

| 模块 | 职责 |
|-|-|
| `src/lib/collaboration/*` | 严格 HTTP 契约、API Key、限流、显式 Session 绑定、原始调用步骤定位与安全日志 |
| `src/lib/ingest/collaboration/contracts.ts` | 外部事件严格校验、稳定正文、SHA-256 与 Goal Plus 确定性 ID |
| `persist.ts` | Collaboration/Event 幂等保存、正文冲突、端点状态写入 |
| `resolve.ts` | user 范围内按 session ID 精确关联 Execution，并计算发起位置候选 |
| `query.ts` | 协作列表、节点、事件 read model 与 Goal Plus Trace 投影成员查询 |
| `trace-projection.ts` | 将已关联的独立 worker Session 合成为只读 TASK / 子 Agent 展示流 |
| `providers/goal-plus.ts` | Goal Plus 语义成员关系的内部投影 |

## API

`POST /api/ingest/collaborations/events` 只接受有效 `x-witty-api-key`，请求最多 64 KiB，并拒绝重复 JSON key、未知字段与内部保留的 `collab_gp_` ID。外部请求不能提供 sourceType，因此永远保存为 `reported`。相同 collaboration/event ID 与相同规范化正文返回 200 duplicate；正文不同返回 409 `EVENT_CONFLICT`。

`POST /api/ingest/collaborations/sessions` 建立逻辑 sessionId 到现有 `Session.taskId` 的显式绑定，并声明事件时钟可信度。绑定不可覆盖，Trace 可以晚到；该路径用于远程原始调用证据定位，与端点自动重算并存。

读取接口为 `GET /api/observe/collaborations` 和 `GET /api/observe/collaborations/:collaborationId`，均按当前用户隔离。详情读取会重新解析 reported 端点；`POST /api/observe/collaborations/relink` 可显式触发同一过程。

## 解析可信度

端点只按 `Execution.taskId` 或 `Execution.agentSessionId` 精确匹配。fromLocator 的工具名或 Shell 命令片段只是候选：唯一命中为 candidate；多事件只有在数量相等、时间无缺失/并列、调用时间来源可信时才返回 time_ordered。无 locator 且已有 Execution 直接父子关系时可返回 confirmed。

Goal Plus 走更严格的内部路径：只消费 `GoalPlusExecutionLink`，逻辑主节点只有一个 linked 候选时才关联具体 Execution；多个候选为 ambiguous，不使用工具名或时间兜底。

## Goal Plus Trace 只读投影

通用 Trace 详情读取 `/api/observe/session` 时，会调用 `findGoalPlusTraceProjectionMembers`，直接从 `GoalPlusExecutionLink` 选择唯一 linked 的主 Execution，并读取同一 Goal 下唯一 linked 的 worker Session。详情投影不依赖 `CollaborationEvent` 是否已物化；关系事件仍用于独立协作查询和审计。随后 `composeCollaborationTrace` 在响应内追加一个带 `trace_synthetic`、`trace_relation` 元数据的虚拟 TASK，以及 worker 原生交互的展示副本，现有 Agent Tree 因此可以渲染 `TASK → AGENT → LLM/TOOL` 层级。`full`、`structure`、`interactions` 和按索引读取单条 interaction 使用同一套确定性投影，避免懒加载时结构索引与正文错位。

该投影只存在于 API 响应，不写回 Session、Execution 或 Collaboration 表，不修改 `parentExecutionId` / `rootExecutionId`，也不影响原生 Trace 的查询、评估和完整度。虚拟 TASK 追加在主 Trace 原生交互之后，因为 Goal Plus 语义只能证明编排成员关系，不能证明它位于某一次原生工具调用；前端必须显示“Goal Plus 编排”来源，并在 `anchorState != confirmed` 时明确未推断具体启动位置。主端歧义、任一端 pending/superseded、worker Session 缺失或跨用户时不合并。

单次详情最多投影 50 个 worker、20000 条 worker 交互；超过上限或关联成员暂时不可读时，响应中的 `collaborationProjection.truncated` 为 `true`。子 Agent 节点保留 worker 的 `taskId`，因此已有 Trace 跳转仍可打开其独立执行详情。

Trace 列表显式传 `collapseGoalPlusWorkers=1`。默认“仅主 Agent”范围用同一 `GoalPlusExecutionLink` 关系排除已挂入唯一主 Trace 的 worker；“仅子 Agent”把这些 worker 与原生 `isSubagent=true` Execution 合并查询；“主 Agent + 子 Agent”保留全部记录。过滤发生在数据库分页和聚合之前，因此页大小、total 与列表统计保持一致。该逻辑只改变 `/trace` 展示查询，不改写 `Execution.isSubagent`，其他调用 `/api/observe/data` 的页面未显式传参时保持旧口径。

## 数据模型

- `Collaboration`：用户与来源范围。
- `CollaborationEvent`：不可变关系正文与接收审计。
- `CollaborationSessionBinding`：显式逻辑 Session 到 Trace Session 的不可覆盖绑定及事件时钟声明。
- `CollaborationEndpointResolution`：可重算的 from/to Execution 引用、证据和步骤候选。

事件内容复用 Goal Plus secret/path 脱敏。Goal Plus projector 不保存 worker 输出、评分或结果摘要；投影和重算错误必须与原生 Trace、语义 snapshot 入库隔离。
