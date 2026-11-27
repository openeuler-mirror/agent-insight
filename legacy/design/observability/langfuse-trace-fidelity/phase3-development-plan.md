# Phase 3：Langfuse Trace 完整展示开发计划

1. 定义 `LangfuseTraceNode` 与 Langfuse 专用投影/建树函数。
2. 让 Langfuse adapter 同时返回现有 interactions 和完整节点快照。
3. 为 SQLite Prisma schema 与 OpenGauss Session 表增加可空字段。
4. 在 `saveExecutionRecord` 中限定 Langfuse framework 写入该字段。
5. 扩展 Session API，并在 Trace 页面/抽屉中把 Langfuse observation 投影进原有 Agent Trace 界面，同时保留历史回退。
6. 使用 `tmp/f7` fixture 验证 19/19 节点、关键内容、工具输出和时间。
7. 运行非 Langfuse adapter、通用 Agent Trace 和完整项目测试，确认隔离性。
8. 同步用户指南与开发者指南。
