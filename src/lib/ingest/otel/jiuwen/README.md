# Jiuwen OTLP 接入开发说明

JiuwenSwarm 产品接入使用 `scripts/jiuwen_extension/`：安装指导分发该扩展，在
AgentServer 的 Worker 中初始化 agent-core OTLP/HTTP exporter，并按能力启用新版单 Agent 追踪。
手动安装与配置见 [扩展说明](../../../../../scripts/jiuwen_extension/README.md)，升级与验证范围见
[客户端兼容性](../../../../../docs/zh/reference/observability/client-compatibility.md#jiuwenswarm)。

## 接入与验收

1. 使用已运行的平台，从安装指导获取当前账号的 JiuwenSwarm 安装命令。
2. 在 JiuwenSwarm 运行环境安装扩展，配置可达的 `/api/ingest/otel/v1/traces` 和 API Key。
3. 重启 AgentServer，运行真实对话及一次工具调用。
4. 在 `/trace` 核对用户输入、系统提示、最终回答、模型调用、工具参数与结果、Token 和结束状态。

Docker Desktop 内连接宿主本地 3000 服务可使用
`http://host.docker.internal:3000/api/ingest/otel/v1/traces`。不要在容器中把 `localhost:3000`
当作宿主地址。新版 SDK 的 exporter 初始化与单 Agent tracing demand 是两个步骤，扩展会完成
两者；无需另行修改 `agent_observability.enabled`。已有 provider 的配置遵循 SDK 的首次初始化规则。

## 服务端契约

- `contract.ts` 识别新版结构化 GenAI 消息、工具和 Token 字段，保留旧字段兼容。
- `aggregate.ts` 将完整 Span 集转换为 ExecutionRecord。旧版 team / task-fan-out 使用原路径；
  新版按明确父 Span 或 tool-call ID 关联工具，按 execution subject / session 保留子 Agent 身份。
- 入库复用 `data-service.ts` 的通用子 Agent 派生机制，写入独立 Execution / Session 与直接父级、
  根执行关联；子 Trace 使用标准详情页和父子跳转，不使用框架专用弹窗。
- 新版 inference 只计一次，独立 reasoning / context event Span 不重复计数。JSON 工具输出先按
  JSON 解析，旧 Python repr 才使用兼容解包逻辑。
- `spool.ts` 每批先持久化、按 traceId 分桶。旧版多 Trace 及明确 team 标记按 session 拼接；
  新版普通单 Agent 的 task-iteration 不再被误判为团队。
- `coalesce.ts` 节流重聚合；已结束的 team root 或带 `openjiuwen.trace.complete=true` 的新版
  root 绕过节流，及时保存结束状态。开始时间取源 Span，避免使用晚于执行结束的入库时刻。
  根失败事实保留为 `jiuwen-run-error`。

`examples/` 与 `design/observability/jiuwenswarm-tracing/` 保留早期 SDK 的实验脚本及设计证据；
其中手动调用 `init_observability` 的示例不代替当前产品扩展接入方式。
