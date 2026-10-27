# DeepSeek Harness 观测接入需求分析

## 背景

DeepSeek Harness 已提供官方 Session Telemetry seam，可将 append-only Session Event 通过 OTLP/HTTP Logs 导出。Agent Insight 当前 Logs 入口只区分 CodeAgent 与其他事件，其他事件进入 Claude 解析和 spool；该链路读取 `event.name`，无法保留 Harness 使用的 `event.type`、`event.seq` 与父子 Session 语义。

## 目标

- Harness 继续在用户环境独立执行，Agent Insight 只负责观测、诊断和评测。
- 使用 Harness 官方 `FULL` Session Telemetry，不侵入模型循环。
- 保留用户消息、模型响应、Tool、Skill、Token 和父子 Session 信息。
- 上传前递归脱敏敏感字段，并截断超大字符串。
- 服务端严格使用 Agent Insight API Key 归属数据，按 `session.id + event.seq` 幂等聚合。
- 在 macOS 上安装与 Harness `master` 对齐的 CLI 和观测插件，完成真实任务验证。

## 非目标

- 不由 Agent Insight 控制 Harness 的模型、Tool 或 Skill 编排。
- 不在一期实现本地持久 outbox 或“至少一次”传输保证。
- 不修改 Prisma schema；继续落到统一 `ExecutionRecord`。
- 不把 Harness 的匿名 `resource.user.id` 当作平台用户身份。

## 数据策略

- 保留观测与评测所需正文。
- 对 authorization、cookie、password、API key、token、secret、credential 等字段递归脱敏。
- 对字符串中的 Bearer、常见 API Key 和环境变量凭据形态脱敏。
- 单字段超限时保留前缀、原长度和 SHA-256 摘要；不静默丢弃整个事件。

## 验收

1. 官方 Harness OTLP Logs 能被独立识别，不进入 Claude spool。
2. 缺失或无效 API Key 的 Harness 请求返回 401 且不落盘。
3. 重复 `(session.id, event.seq)` 不产生重复 interaction。
4. `user/message`、`assistant/message`、`tool/call`、`tool/result`、usage 能还原成 Trace。
5. `tool/call name=skill` 能成为平台 Skill 调用。
6. 子 Session 能通过 `session.parent_id` 和 `subagent/descriptor` 保留父子身份。
7. Mac 上真实 Harness 任务可在 Agent Insight 中持久化为 `framework=deepseek-harness` 的 Execution。
