# 跨 Session 协作 Trace

跨 Session 协作层把分散的 Session 关系作为独立覆盖层保存。它与 Execution 原生父子树并存：关系可以先于 Trace 到达，端点关联随新 Execution 重算，但任何结果都不会写回 `parentExecutionId` 或 `rootExecutionId`。

## 模块

| 模块 | 职责 |
|-|-|
| `src/lib/collaboration/*` | API Key、限流、显式 Session 绑定、原始调用定位与安全日志 |
| `src/lib/ingest/collaboration/contracts.ts` | 外部事件严格校验、规范正文与稳定摘要 |
| `persist.ts` | Collaboration/Event 幂等保存、正文冲突和端点状态写入 |
| `resolve.ts` | 用户范围内按 session ID 精确关联 Execution，并计算调用位置候选 |
| `query.ts` | 协作列表、节点和事件 read model |
| `projection.ts` / `trace-projection.ts` | 将 reported worker 合成为只读 TASK / 子 Agent 展示流 |
| `providers/goal-plus.ts` | 历史 Goal Plus 语义数据的内部投影；不是新版 collector 的主路径 |

## 写入 API

`POST /api/ingest/collaborations/sessions` 建立逻辑 `sessionId` 到 `Session.taskId` 的显式绑定，并声明事件时钟可信度。绑定正文不可覆盖，Trace 可以晚到；同一规范正文重复上传幂等成功，不同正文返回冲突。

`POST /api/ingest/collaborations/events` 只接受有效 `x-witty-api-key`，请求最多 64 KiB，并拒绝重复 JSON key、未知字段和内部保留 ID。外部请求不能提供 `sourceType`，因此保存为 `reported`。相同 collaboration/event ID 与相同规范正文返回 duplicate；正文不同返回 409 `EVENT_CONFLICT`。

读取接口为 `GET /api/observe/collaborations` 和 `GET /api/observe/collaborations/:collaborationId`，均按当前用户隔离。详情读取会重新解析 reported 端点；`POST /api/observe/collaborations/relink` 可显式触发同一过程。

## 端点解析

端点优先读取同一用户、同一 collaboration 下的显式 binding，把事件逻辑 `sessionId` 转换为 `traceSessionId`，再与 `Execution.taskId` / `Execution.agentSessionId` 精确匹配；无 binding 时才直接使用事件 session ID。关系可以先上传，状态保持 pending。新增 binding 会重算命中该逻辑 session 的事件，目标 Trace 到达时也会通过反查 binding 重算对应事件。

`fromLocator` 中的工具名或 Shell 命令片段只是调用位置候选：唯一命中为 candidate；多事件只有在数量相等、时间无缺失或并列、且调用时间来源可信时才返回 time_ordered。无 locator 且已有 Execution 直接父子关系时可返回 confirmed。不得只根据时间接近度选择父级。

## Goal Plus reported 路径

重构后的 Goal Plus 适配完全使用公开的 binding/event API，不要求服务端增加 Goal Plus 专用关系接口：

1. Pi collector 在实际 `/goal-plus` start task 获得结构化 Goal ID 时立即异步上报 `main → <nativeSessionId>__taskN` 绑定，并在 settle/shutdown 重试；
2. Goal Plus collector 为每个 Pi worker 上报 `worker:<stable-id> → goal-plus:<sourceId>:<agentSessionId>` 绑定；
3. Goal Plus collector 上报同一 `collaborationId` 下的 `main → worker` 事件；
4. reported 解析器在两端 Trace 可用后建立 endpoint resolution；
5. 通用 Trace 投影把已解析 worker 合并到主 Trace 响应。

两侧使用 `initialPiSessionId` 和 `goalPlusId` 计算同一个 `collaborationId`。主 binding 的 `traceSessionId` 必须是 Pi collector 已实际创建的分段 taskId，worker binding 则使用 Goal Plus canonical worker taskId。逻辑 ID 和事件 ID必须由源数据稳定生成，不能包含扫描时间或接收时间。

这条 reported 路径优先于历史 `GoalPlusExecutionLink` 语义投影。同一主 Trace 已存在 resolved reported 关系时，不再叠加内部 Goal Plus 投影，避免 worker 重复。旧 semantic projection 只服务已有历史记录，不属于当前 collector 的兼容目标。

## Trace 只读投影

通用 Trace 详情读取 `/api/observe/session` 时，`composeCollaborationTrace` 在响应中追加带 `trace_synthetic`、`trace_relation` 元数据的虚拟 TASK，以及 worker 原生交互的展示副本，从而渲染：

```text
main Agent
  └─ TASK（Goal Plus 编排）
       └─ worker Agent
            ├─ LLM
            └─ Tool / Skill / MCP
```

虚拟 TASK 追加在主 Trace 原生交互之后。关系能证明编排成员身份，但不一定能证明 worker 位于哪一次原生工具调用；`anchorState != confirmed` 时前端必须显示未确认定位，不能伪造调用层级。

`full`、`structure`、`interactions` 和按索引读取单条 interaction 使用同一确定性投影。合并后的交互保留 `_collaboration` 源 Session/索引信息；`_payloadVersion` 仍根据原正文计算，前端拒绝刷新前发起或版本不匹配的异步加载结果。

投影只存在于 API 响应，不修改原生 Session/Execution、评估口径或完整度。Goal Plus reported 关系按 worker 独立判断：主端和当前 worker 唯一解析且两侧均有非空 Session 正文时即可合并；另一个 worker pending 不阻塞当前 worker。主端歧义、当前 worker 缺失、跨用户或被拒绝的关系仍不合并。非 Goal Plus collaboration 继续按整个连通组件保证可合并性。

单次详情最多投影 50 个 worker、20000 条 worker 交互；超过上限时 `collaborationProjection.truncated=true`。子 Agent 节点保留 worker 的 `taskId`，因此仍可打开独立 worker Trace。

## 列表折叠

Trace 列表显式请求协作 worker 折叠。默认“仅主 Agent”范围排除两类子 Trace：已经成功投影的通用协作子节点，以及 Goal Plus `main → worker:*` 事件中已有 worker binding 的已声明子节点。“仅子 Agent”将这些 worker 与原生 `isSubagent=true` Execution 合并查询；“主 Agent + 子 Agent”保留全部记录。

过滤必须发生在数据库分页和聚合之前，使 page size、total 与统计一致。Goal Plus 的已声明 worker 即使主 binding、主 Trace 或正文仍 pending，也不回退成默认主记录；详情按 worker 在当前两端完整可解析时立即合并，不等待同组其他 worker 或主任务结束。非 Goal Plus 关系继续要求成功投影后才隐藏，超过投影安全限制或查询失败时 fail open。该行为只影响明确启用折叠的 Trace 查询，不改写 `Execution.isSubagent`。

## 持久化对象与一致性

- `Collaboration`：用户与来源范围；
- `CollaborationEvent`：不可变关系正文与接收审计；
- `CollaborationSessionBinding`：逻辑 Session 到 Trace Session 的不可覆盖绑定及事件时钟声明；
- `CollaborationEndpointResolution`：可重算的 from/to Execution 引用、证据与步骤候选。

持久化按认证用户隔离。关系重算失败不得回滚已经入库的 Trace，Trace 上传失败也不得删除已持久化的关系。collector 本地 outbox 以相同规范正文和稳定 logical key保证重试幂等：2xx 记 delivered，网络/429/5xx 重试，确定性 4xx 进入 rejected。

Goal Plus 关系只保存角色、run/candidate/agent session 标识与可审计 locator，不保存 worker 输出、评分或结果摘要；worker 正文继续由 OTLP Trace ingest 负责。
