# 跨 Session 协作 Trace

跨 Session 协作层将分散的 Session 关系作为独立覆盖层保存。它与 Execution 原生父子树并存：关系可以先于 Trace 到达，端点关联随新 Execution 重算，但任何结果都不会写回 `parentExecutionId` 或 `rootExecutionId`。

## 模块

| 模块 | 职责 |
|-|-|
| `src/lib/collaboration/*` | 严格 HTTP 契约、API Key、限流、显式 Session 绑定、原始调用步骤定位与安全日志 |
| `src/lib/ingest/collaboration/contracts.ts` | 外部事件严格校验、稳定正文、SHA-256 与 Goal Plus 确定性 ID |
| `persist.ts` | Collaboration/Event 幂等保存、正文冲突、端点状态写入 |
| `resolve.ts` | user 范围内按 session ID 精确关联 Execution，并计算发起位置候选 |
| `query.ts` | 协作列表、节点和事件 read model |
| `providers/goal-plus.ts` | Goal Plus 语义成员关系的内部投影 |

## API

`POST /api/ingest/collaborations/events` 只接受有效 `x-witty-api-key`，请求最多 64 KiB，并拒绝重复 JSON key、未知字段与内部保留的 `collab_gp_` ID。外部请求不能提供 sourceType，因此永远保存为 `reported`。相同 collaboration/event ID 与相同规范化正文返回 200 duplicate；正文不同返回 409 `EVENT_CONFLICT`。

`POST /api/ingest/collaborations/sessions` 建立逻辑 sessionId 到现有 `Session.taskId` 的显式绑定，并声明事件时钟可信度。绑定不可覆盖，Trace 可以晚到；该路径用于远程原始调用证据定位，与端点自动重算并存。

读取接口为 `GET /api/observe/collaborations` 和 `GET /api/observe/collaborations/:collaborationId`，均按当前用户隔离。详情读取会重新解析 reported 端点；`POST /api/observe/collaborations/relink` 可显式触发同一过程。

## 解析可信度

端点只按 `Execution.taskId` 或 `Execution.agentSessionId` 精确匹配。fromLocator 的工具名或 Shell 命令片段只是候选：唯一命中为 candidate；多事件只有在数量相等、时间无缺失/并列、调用时间来源可信时才返回 time_ordered。无 locator 且已有 Execution 直接父子关系时可返回 confirmed。

Goal Plus 走更严格的内部路径：只消费 `GoalPlusExecutionLink`，逻辑主节点只有一个 linked 候选时才关联具体 Execution；多个候选为 ambiguous，不使用工具名或时间兜底。

## 数据模型

- `Collaboration`：用户与来源范围。
- `CollaborationEvent`：不可变关系正文与接收审计。
- `CollaborationSessionBinding`：显式逻辑 Session 到 Trace Session 的不可覆盖绑定及事件时钟声明。
- `CollaborationEndpointResolution`：可重算的 from/to Execution 引用、证据和步骤候选。

事件内容复用 Goal Plus secret/path 脱敏。Goal Plus projector 不保存 worker 输出、评分或结果摘要；投影和重算错误必须与原生 Trace、语义 snapshot 入库隔离。
