# OTLP 属性契约 (FR-011)

> 本文档定义 OpenClaw 及其他 OTLP/HTTP 客户端向 Agent Insight 上报 trace/log 时必须遵守的属性契约。服务端依据此契约解析、归一化并存储为 `Execution` / `Session` 记录。

## 传输层

| 项目 | 值 | 说明 |
|------|-----|------|
| 协议 | OTLP/HTTP (JSON 或 Protobuf) | gRPC 不支持 |
| 端点 | `POST /api/ingest/otel/v1/traces` | Traces |
| | `POST /api/ingest/otel/v1/logs` | Logs (仅 JSON) |
| | `POST /api/ingest/otel/v1/metrics` | Metrics (桩) |
| 认证 | `x-witty-api-key` Header | 用于关联 Workspace |
| Content-Type | `application/json` 或 `application/x-protobuf` | |

> **RAS 旁路（非 OTLP）**：环内 Agent RAS 事件走 `POST /api/ingest/ras-events`（flat JSON：`taskId` / `type` / **必填** `deliveryId`；同鉴权头、与 OTel `Execution.taskId` 对齐），**禁止**写入 OTLP traces/logs spool。属性约定见下文「RAS 旁路属性」；可靠性观测页以当前用户的普通根 `Execution` 为主表左连接这些事件，详情将异常和动作结果合并进 Agent 时间线。环内分层与旁路边界见 [`../agent-ras/designs/modules/ras-runtime.md`](../agent-ras/designs/modules/ras-runtime.md)；本文件为 Insight ingest **契约真源**。

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

## RAS 旁路属性

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 与 OTLP / Execution 的 session 对齐 |
| `type` | string | 是 | `anomaly` / `actions` / `action_result` / `skill_*` |
| `deliveryId` | string | 是 | 一次逻辑投递的 UUID；重试复用，独立事件必须不同 |
| `anomalyKind` | string | 否 | 如 `repeat_tool_call`、`llm_thinking_dead_loop` |
| `severity` | string | 否 | `low` / `medium` / `high` / `critical` |
| `summary` | string | 否 | 人可读摘要 |
| `actionTypes` | string | 否 | 逗号分隔动作类型 |
| `framework` / `platform` | string | 否 | 平台，如 `opencode` |
| `payload` | object | 否 | 原始事件体，落库为 `payloadJson` |

落库模型：`RasAnomalyEvent`。实现：`src/lib/ingest/ras/*`、`src/app/api/ingest/ras-events`；推送方：同进程 `agent_ras/ras_runtime/insight_push.py`（fail-open）。同一 `taskId + deliveryId` 幂等更新；相同内容的两次真实异常使用不同 `deliveryId`，不会被错误合并。`payload.actions[]` 保留动作类型及完整 `message`；`payload.trace_anchor` 使用 `message_id + part_id + channel` 定位**检测点**，或使用 `call_id + channel=tool_call` 定位工具调用。`action_result` 携带同一检测锚点、实际投递内容，以及 `payload.delivery_anchor`（`message_id` 必填才可把投递交互重分类为 RAS；`channel` 为 `ras_notice` 或 `ras_steering`）。**不做**正文匹配兜底。

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.2 | 2026-07-31 | RAS 契约收紧：仅 flat+必填 deliveryId；移除 witty.* / rasEventId / 深路径 rewrite / 正文兜底 |
| 1.1 | 2026-07-27 | 补充 RAS 旁路 ingest（非 OTLP）与 `witty.ras.*` |
| 1.0 | 2026-07-14 | 初版，定义 OTLP 属性契约 (FR-011) |
