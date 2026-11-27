# Claude Code 轮次结束信号：开发计划

1. 扩展补传契约：`context-supplement.ts` 增加 `turn_end` 类型与 hook 白名单（无正文）。
2. 客户端：`scripts/claude_context_uploader.js` 增加 `turnEndItem`，在 `Stop`/`StopFailure`/`SessionEnd` 任务里排到批次最前；`SubagentStop` 不上报。
3. 聚合：`aggregator.ts` 收集结束信号，按最后一次活动时间判定完成/失败/执行中，写 `trace_completed_at` 与 `executionStatus`。
4. 落库：`data-service.ts` 对 `claudecode` 的 `in_progress` 记录清空 `Session.endTime`，支持多轮会话重新进入执行中。
5. 单测：Stop 落库、重复 Stop、SubagentStop、StopFailure、多轮失效、SessionEnd 兜底、十分钟 inactivity 兜底，以及客户端与补传端点的字段映射。
6. 文档：更新 `docs/zh/how-to/observability/view-traces.md`、`docs/zh/reference/platform/api-and-contracts.md`、`docs/zh/explanation/platform/data-control-flow.md`。
7. 验证：专项测试 + 类型检查；未做浏览器 golden path 时在 PR 里显式说明。
