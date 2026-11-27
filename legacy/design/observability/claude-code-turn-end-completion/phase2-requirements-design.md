# Claude Code 轮次结束信号：需求设计

## 采集契约

复用已有的 Claude 上下文补传通道 `POST /api/ingest/claude/context`（不新增路由），新增补传类型 `turn_end`：

- 客户端 `claude_context_uploader.js` 在 `Stop` / `StopFailure` / `SessionEnd` hook 的入队任务里附带 `{kind: 'turn_end', hookEvent, capturedAt}`；`capturedAt` 取入队时间（≈hook 触发时刻），直传降级时取当前时间。
- 客户端只读 hook 负载里的 session 与事件名，不读取 transcript；`SubagentStop` 不产生该补传项。
- 服务端 `buildContextSupplementEvents` 允许 `turn_end` 无正文，只接受 `Stop` / `SessionEnd` / `StopFailure`，其余 hook 丢弃。
- 结束信号排在补传批次最前，避免被条数上限挤到后续批次。

## 聚合与落库

`aggregateClaudeOtelEvents` 收集 `turn_end` 事件，与最后一次活动时间比较：

- 活动时间排除 `turn_end` 自身与 Claude 内部 query source（标题/建议等）。
- `Stop` / `StopFailure` 优先，`SessionEnd` 仅在一轮没有 `Stop` 时兜底，避免用户几小时后关会话把结束时间推后。
- 只有信号时间不早于最后一次活动才写 `trace_completed_at`（客户端事件时间，非服务端接收时间）；否则视为新一轮仍在执行。
- `executionStatus` 显式写 `completed` / `failed`（`StopFailure`）/ `in_progress`，让列表与详情的读侧判定不依赖时间推断。
- 不产生 interaction，不影响对话、工具与 Token 统计。

`saveExecutionRecord` 对 `framework=claudecode` 且 `executionStatus=in_progress` 的记录清空 `Session.endTime`：trace 对应整个 session，上一轮 `Stop` 写过的结束时间必须在新一轮活动到来时撤回。

## 读侧

现有 `trace-lifecycle.ts`（内存与 SQL 两条路径）无需新增分支：显式 `executionStatus=failed` 与 `trace_completed_at` 已被优先消费；没有完成时间时仍按十分钟 inactivity 判 `timed_out`，作为旧客户端与真正卡死场景的兜底。

## 风险

- 客户端与服务端时钟偏差：完成时刻取客户端事件时间，与 OTel 事件同一时钟源。
- 补传失败：`turn_end` 与其他补传项一样重试，失败时保留队列；仍未上报则退回十分钟兜底。
- 幂等：重复 `Stop` 收敛到同一完成时间；`turn_end` 不改变已完成的 interaction 数据。
