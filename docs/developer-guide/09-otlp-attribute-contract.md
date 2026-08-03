# OTLP 属性契约 (FR-011)

> 本文档定义 OpenClaw 及其他 OTLP/HTTP 客户端向 Agent Insight 上报 trace/log 时必须遵守的属性契约。服务端依据此契约解析、归一化并存储为 `Execution` / `Session` 记录。

## 传输层

| 项目 | 值 | 说明 |
|------|-----|------|
| 协议 | OTLP/HTTP (JSON 或 Protobuf) | gRPC 不支持 |
| 端点 | `POST /api/ingest/otel/v1/traces` | Traces |
| | `POST /api/ingest/otel/v1/logs` | Logs (仅 JSON) |
| | `POST /api/ingest/otel/v1/metrics` | Metrics（vLLM 指标；CodeAgent 来源丢弃） |
| 认证 | `x-witty-api-key` Header | 用于关联 Workspace |
| Content-Type | `application/json` 或 `application/x-protobuf` | |

## 资源属性 (Resource)

客户端在 `resource.attributes` 中设置以下字段：

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `service.name` | string | 是 | 固定为 `"openclaw"`；服务端据此区分 OpenClaw 与 Claude Code 上报 |
| `service.version` | string | 否 | OpenClaw 版本号 |
| `telemetry.sdk.name` | string | 否 | SDK 标识，如 `"opentelemetry"` |
| `telemetry.sdk.language` | string | 否 | 如 `"nodejs"`、`"python"` |
| `telemetry.sdk.version` | string | 否 | SDK 版本 |

## Span 属性契约

### 根 Span (Agent Execution)

代表一次完整的 Agent 执行（对应内部 `Session` + `Execution` 根记录）。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.agent.name` | string | 是 | Agent 名称，如 `"plan"`、`"build"` |
| `witty.agent.id` | string | 是 | Agent 唯一标识，如 `"opencode-plan"` |
| `witty.session.id` | string | 是 | 一次对话/任务的 session ID |
| `witty.trace.id` | string | 是 | Trace ID (与 OTLP `trace_id` 一致) |
| `witty.user.id` | string | 否 | 用户标识 |
| `gen_ai.system` | string | 推荐 | 如 `"opencode"`、`"custom"` |
| `gen_ai.request.model` | string | 推荐 | 本次执行使用的模型，如 `"gpt-4"` |

Span 名称约定：`"agent {agent_name}"`，如 `"agent plan"`。

### Skill 调用 Span

代表一次 Skill 的触发与执行。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.skill.name` | string | 是 | Skill 名称 |
| `witty.skill.version` | string | 否 | Skill 版本标识 |
| `witty.skill.trigger_type` | string | 推荐 | 触发方式：`"auto"`、`"user_request"`、`"sub_agent"` |

Span 名称约定：`"skill {skill_name}"`。

### 工具调用 Span

代表一次外部工具/函数调用。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.tool.name` | string | 是 | 工具名称 |
| `witty.tool.input` | string | 推荐 | 工具调用输入（截断至 4096 字符） |
| `witty.tool.result` | string | 否 | 工具调用输出摘要 |
| `witty.tool.error` | boolean | 否 | 是否发生错误 |

Span 名称约定：`"tool {tool_name}"`。

### LLM 请求 Span

代表一次 LLM 模型推理调用。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `gen_ai.system` | string | 是 | 模型平台，如 `"openai"`、`"anthropic"` |
| `gen_ai.request.model` | string | 是 | 模型名称 |
| `gen_ai.response.model` | string | 否 | 实际响应模型（可能与请求不同） |
| `gen_ai.usage.prompt_tokens` | int | 推荐 | 输入 Token 数 |
| `gen_ai.usage.completion_tokens` | int | 推荐 | 输出 Token 数 |
| `gen_ai.usage.total_tokens` | int | 推荐 | 总 Token 数 |

Span 名称约定：`"llm {model_name}"`。

### 子 Agent Span

代表主 Agent 委派给子 Agent 的执行。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.agent.name` | string | 是 | 子 Agent 名称 |
| `witty.agent.id` | string | 是 | 子 Agent 唯一标识 |
| `witty.parent_span_id` | string | 是 | 父 Span ID (通过 OTLP parentSpanId 表达) |

Span 名称约定：`"sub_agent {agent_name}"`。

## Log 属性契约

Log 记录用于补充 trace 中无法表达的执行细节。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.log.category` | string | 推荐 | 分类：`"user_prompt"`、`"tool_detail"`、`"system"`、`"error"` |
| `witty.log.level` | string | 推荐 | 严重级别：`"info"`、`"warn"`、`"error"` |
| `witty.session.id` | string | 推荐 | 关联 Session ID |
| `witty.trace.id` | string | 推荐 | 关联 Trace ID |

## 与内部模型的映射

### Span → Execution 树

```
OTLP Span                          Agent Insight 内部模型
────────────────────────────────────────────────────
Root Span (agent)                  → Execution (rootExecutionId = NULL)
├─ LLM Span                        → SessionInteraction (type: llm)
├─ Tool Span                       → SessionInteraction (type: tool_call)
├─ Skill Span                      → SessionInteraction (type: skill_invocation)
│   └─ Sub-agent Span              → Execution (parentExecutionId = root)
│       ├─ LLM Span                → SessionInteraction
│       └─ Tool Span               → SessionInteraction
```

### 身份识别

服务端通过以下优先级识别客户端身份：
1. `x-witty-api-key` Header → 查找 `ApiKey` 记录 → 关联 Workspace
2. `resource.attributes["service.name"]` → `"openclaw"` 或 `"claude-code"` 决定解析器
3. `witty.agent.name` → 创建/匹配 Agent 记录

## CodeAgent 兼容契约

CodeAgent 使用自己的 LogRecord 协议而非上述通用 span 属性。服务端用 resource attribute `service.name=CodeAgentOC` 识别该来源，并执行 signal 级分流：

| Signal | 服务端行为 |
|------|------|
| Logs | 仅支持 OTLP/HTTP JSON；写入 `otel_data/codeagent`，按 `session.id` 聚合 |
| Traces | JSON/Protobuf 解码后返回 `accepted + ignored`，不写 trace spool |
| Metrics | JSON/Protobuf 解码后返回 `accepted + ignored`，不创建 InfraSource/InfraMetricSample |

Logs 中的 `api_request` / `api_response`、`tool_request` / `tool_response`、`agent.start` / `agent.finish` 是 CodeAgent Execution 的权威输入。工具事件通过 `tool_call_id` 与 `inference_id` 关联；`execution.agent_run_id` 与 `execution.parent_agent_run_id` 表达父子运行关系；root 与 child 的 Agent 名称优先读取 `agent_name`，其次读取 `execution.agent_id`，仅在两者都缺失时使用框架兜底名；没有独立 `user_prompt` 事件时，接收端从 root 首个 `api_request.request_text` 提取用户消息并补成 `role=user` interaction；`skill_name` 及 Skill 参数表达技能调用。接收端将 `Skill` 规范化为 `skill`，将 `Agent` / `Task` 规范化为 `task`，再复用统一 Execution 树与 Skill 归属逻辑。

setup wrapper 只设置 `CODEAGENT3_ENABLE_TELEMETRY=1`、OTLP base endpoint、JSON protocol 和认证 header，不写 `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none`；CodeAgent 当前会覆盖这类关闭变量。

## LlamaIndex 兼容契约

LlamaIndex 客户端复用官方 `llama-index-observability-otel==0.6.4` 创建 OTel span，并由 Agent Insight Handler 子类补充以下属性。客户端使用独立 `TracerProvider`，不会替换应用已有的全局 Provider；`SimpleSpanProcessor` 调用的自定义 exporter 只做 `ReadableSpan → SpanRecord → put_nowait`，不会在 span 结束线程中执行磁盘或网络 I/O。

| 属性 | 类型 | 说明 |
|------|------|------|
| `agent.insight.framework` | string | 固定为 `llamaindex` |
| `agent.insight.span.kind` | string | `agent`、`workflow`、`workflow_step`、`tool`、`llm`、`retriever`、`synthesizer`、`chain` 或 `span` |
| `session.id` | string | 业务上下文提供的 sessionId；缺省为 OTel traceId |
| `agent.instance.id` | string | 多 Agent/Workflow Context 中稳定的 Agent 实例标识 |
| `gen_ai.request.model` | string | LLM 模型名称 |
| `gen_ai.provider.name` | string | 模型提供方 |
| `gen_ai.usage.input_tokens` | int | 输入 Token |
| `gen_ai.usage.output_tokens` | int | 输出 Token |
| `gen_ai.usage.total_tokens` | int | 总 Token |

Tool 使用 `tool.name`、`tool.arguments`、`tool.output`；Retriever 使用 `retrieval.query`、`retrieval.nodes`；Workflow step 使用 `workflow.step.name`、`workflow.step.input_event`。正文属性由客户端按配置截断，并用 `<key>.truncated` 与 `<key>.original_chars` 标记。

`session.id` 的优先级为显式 `trace_context(session_id=...)`、父 Span 继承、OTel traceId。独立 Retriever/LLM 保留真实根 Span，不生成 synthetic Agent root。服务端 LlamaIndex Adapter 负责包装 LLM Span 去重、错误摘要、Agent 所有者和子 Agent 关系归一化；共享 renderer 不读取 LlamaIndex 私有属性，也不按框架名分支。

## 环境变量 (OpenClaw 侧)

以下环境变量控制 OpenClaw 的 OTel 导出行为：

| 变量 | 说明 | 建议值 |
|------|------|--------|
| `CLAW_ENABLE_TELEMETRY` | 启用 OTel 上报 | `1` |
| `OTEL_LOGS_EXPORTER` | Logs 导出器 | `otlp` |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Logs 传输协议 | `http/json` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Logs 端点 URL | `http://<host>:3000/api/ingest/otel/v1/logs` |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Traces 传输协议 | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces 端点 URL | `http://<host>:3000/api/ingest/otel/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | 公共 Headers | `x-witty-api-key=<your-api-key>` |
| `OTEL_SERVICE_NAME` | OTel service.name | `openclaw` |

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-07-14 | 初版，定义 OTLP 属性契约 (FR-011) |
