# DeepSeek Harness 观测接入开发计划

1. 建立 Harness OTLP fixture，先覆盖识别、解析、严格鉴权和独立 spool。
2. 实现 Harness 事件聚合器，覆盖消息、Tool、Skill、usage、错误和父子 Session 元数据。
3. 注册 `FrameworkAdapter` 与 OTel consumer source，输出统一 `ExecutionRecord`。
4. 实现 Agent Insight Harness 观测插件的脱敏、截断和官方 telemetry 配置。
5. 提供三文件资源与 shell setup API，补充用户与开发者指南。
6. 安装官方 `@deepseek-ai/dsh`，通过直接文件下载安装观测插件，启动 Agent Insight，执行真实 headless 任务并核对持久化结果。
7. 运行专项测试、相关回归测试、类型检查、生产构建与真实链路验收。
