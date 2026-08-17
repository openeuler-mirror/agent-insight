# OTLP 属性契约 (FR-011)

> 本文档定义 OpenClaw 及其他 OTLP/HTTP 客户端向 Agent Insight 上报 trace/log 时必须遵守的属性契约。服务端依据此契约解析、归一化并存储为 `Execution` / `Session` 记录。

## 传输层

| 项目 | 值 | 说明 |
|------|-----|------|
| 协议 | OTLP/HTTP (JSON 或 Protobuf) | gRPC 不支持 |
| 端点 | `POST /api/ingest/otel/v1/traces` | Traces |
| | `POST /api/ingest/otel/v1/logs` | Logs（仅 JSON） |
| | `POST /api/ingest/otel/v1/metrics` | Metrics（vLLM 指标；CodeAgent 来源丢弃） |
| 认证 | `x-witty-api-key` Header | 用于关联 Workspace |
| Content-Type | Traces: `application/json` 或 `application/x-protobuf`；Logs: `application/json` | |

OpenClaw 应直接访问自己的模型供应商；Agent Insight 只接收遥测。历史 URL `POST /api/proxy/v1/chat/completions` 仅返回 410，不是 OTLP 链路，也不会代转模型请求。

> **RAS 旁路（非 OTLP）**：环内 Agent RAS 事件走 `POST /api/ingest/ras-events`（flat JSON：`taskId` / `type` / **必填** `deliveryId`；同鉴权头、与 OTel `Execution.taskId` 对齐），**禁止**写入 OTLP traces/logs spool。属性约定见下文「RAS 旁路属性」；可靠性观测页以当前用户的普通根 `Execution` 为主表左连接这些事件，详情将异常和动作结果合并进 Agent 时间线。环内分层与旁路边界见 [`../agent-ras/designs/modules/ras-runtime.md`](../agent-ras/designs/modules/ras-runtime.md)；本文件为 Insight ingest **契约真源**。

> **OpenCode 客户端身份与公网出口 IP 快照**：非 OTLP `POST /api/ingest/upload` 使用 `client_id`、`host.reported_ip`、`host.hostname`。正式 `~/.agent-insight/client/config.json` 同时提供 `clientId` 与 `deviceCredential`；uploader 发送 `Authorization: Bearer <deviceCredential>` 和 `x-agent-insight-client-id`，服务端只把凭据解析出的 ID 保存为可信 `Execution.clientId`，API Key 与设备凭据跨账号或请求体 ID 不一致时拒绝绑定。兼容 `~/.agent-insight/client.json` 仍可上传，但其自报 ID 不建立客户端绑定。正式 uploader 直接访问公网 `IP:3000` 时无需代理配置：服务端读取 Next.js 从 TCP 连接补入的来源地址并只保存公网 IP；若 uploader 运行在服务端本机，连接来源是回环或私网地址，则仅在已认证 uploader 上报的 hostname 与服务端一致时，保存请求目标中的公网 IP。经过代理部署时仍由 `AGENT_INSIGHT_TRUSTED_PROXY_HEADER=x-forwarded-for|x-real-ip|cf-connecting-ip` 指定、且必须由最外层代理清洗覆盖的来源头。兼容旧 uploader 不启用直连 IP 绑定。四个客户端/主机字段均采用首次非空快照，后续重传不覆盖；根/child `Execution` 继承同一快照，且不复用表示模型推理源的 `Execution.endpoint`。

## 资源属性 (Resource)

客户端在 `resource.attributes` 中设置以下字段：

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `service.name` | string | 是 | 建议固定为 `"openclaw"`；兼容 `"openclaw-agent"`，服务端据此选择 OpenClaw adapter |
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
| `witty.agent.id` | string | 是 | Agent 运行标识；子 Agent 用它生成稳定的 `subagent_session_id` |
| `witty.session.id` | string | 是 | 一次对话/任务的 session ID |
| `witty.user.id` | string | 否 | 用户标识 |
| `gen_ai.system` | string | 推荐 | 如 `"opencode"`、`"custom"` |
| `gen_ai.request.model` | string | 推荐 | 本次执行使用的模型，如 `"gpt-4"` |

Span 名称建议使用 `"agent {agent_name}"`；服务端以 `witty.agent.*` 或 `gen_ai.span.kind=agent|entry` 分类，不依赖这一种名称。Trace ID 必须使用 OTLP span 自带的 `traceId`，父子关系必须使用 OTLP `parentSpanId`。

### Skill 调用 Span

代表一次 Skill 的触发与执行。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.skill.name` | string | 是 | Skill 名称 |
| `witty.skill.version` | string | 否 | Skill 版本标识 |
| `witty.skill.trigger_type` | string | 推荐 | 触发方式：`"auto"`、`"user_request"`、`"sub_agent"` |

Span 名称建议使用 `"skill {skill_name}"`；`witty.skill.name` 存在时服务端会将它归为工具类事件，并保留为 Skill 调用。

### 工具调用 Span

代表一次外部工具/函数调用。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.tool.name` | string | 是 | 工具名称 |
| `witty.tool.input` | string | 推荐 | 工具调用输入（截断至 4096 字符） |
| `witty.tool.result` | string | 否 | 工具调用输出摘要 |
| `witty.tool.error` | boolean | 否 | 是否发生错误 |

Span 名称建议使用 `"tool {tool_name}"`；同时兼容 `tool.name`、`tool.arguments`、`tool.result` / `tool.output` 与标准 `error.*` 属性。

### LLM 请求 Span

代表一次 LLM 模型推理调用。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `gen_ai.system` | string | 是 | 模型平台，如 `"openai"`、`"anthropic"` |
| `gen_ai.request.model` | string | 是 | 模型名称 |
| `gen_ai.response.model` | string | 否 | 实际响应模型（可能与请求不同） |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.prompt_tokens` | int | 推荐 | 输入 Token 数；前者优先 |
| `gen_ai.usage.output_tokens` / `gen_ai.usage.completion_tokens` | int | 推荐 | 输出 Token 数；前者优先 |
| `gen_ai.usage.reasoning_tokens` | int | 否 | 推理 Token 数 |
| `gen_ai.usage.total_tokens` | int | 推荐 | 总 Token 数 |

Span 名称约定：`"llm {model_name}"`。

### 子 Agent Span

代表主 Agent 委派给子 Agent 的执行。

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `witty.agent.name` | string | 是 | 子 Agent 名称 |
| `witty.agent.id` | string | 是 | 子 Agent 唯一标识 |
| OTLP `parentSpanId` | string | 是 | 直接使用 OTLP span 字段表达父子关系，不另写 `witty.parent_span_id` |

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

服务端按以下层次识别和归属数据：
1. `x-witty-api-key` Header → 查找用户记录；认证用户优先于载荷内的 `witty.user.id`
2. `resource.attributes["service.name"]` → `"openclaw"` / `"openclaw-agent"` 选择 OpenClaw adapter
3. Session ID 依次取 span `witty.session.id`、resource `witty.session.id`、`session.id` / `session_id` 等兼容属性、`service.instance.id`、OTLP `traceId`
4. Agent 名称依次取 `witty.agent.name`、`gen_ai.agent.name`、`agent.name`，缺失时回退为 `openclaw`

OpenClaw adapter 按 `traceId + spanId` 去重后重建 agent/LLM/tool/skill 与子 Agent 树。只有 LLM span 计入 Token 与 LLM 调用数；tool/skill span 计入工具调用数，`witty.tool.error=true` 或标准错误属性计入工具错误数。聚合输出采用 snapshot replace，重复消费同一批 span 不会重复累计。

## Watcher 兼容路径

OpenClaw watcher 与 OTel 是两种互斥接入方式：

- 当前 watcher 将完整 record 直接上报到 `POST /api/ingest/upload`。
- 旧 watcher 的 `POST /api/ingest/openclaw/upload` 直接委托同一个通用 handler，完整保留 interactions。
- 缺少可归属身份返回 400，错误 `x-witty-api-key` 返回 401；兼容入口不会返回假成功。
- 不要在同一 OpenClaw 实例同时启用 watcher 和 OTel，否则同一次运行会形成两份 Trace。

## CodeAgent 兼容契约

CodeAgent 使用自己的 LogRecord 协议而非上述通用 span 属性。服务端用 resource attribute `service.name=CodeAgentOC` 识别该来源，并执行 signal 级分流：

| Signal | 服务端行为 |
|------|------|
| Logs | 仅支持 OTLP/HTTP JSON；写入 `otel_data/codeagent`，按 `session.id` 聚合 |
| Traces | JSON/Protobuf 解码后返回 `accepted + ignored`，不写 trace spool |
| Metrics | JSON/Protobuf 解码后返回 `accepted + ignored`，不创建 InfraSource/InfraMetricSample |

Logs 中的 `api_request` / `api_response`、`tool_request` / `tool_response`、`agent.start` / `agent.finish` 是 CodeAgent Execution 的权威输入。工具事件通过 `tool_call_id` 与 `inference_id` 关联；`execution.agent_run_id` 与 `execution.parent_agent_run_id` 表达父子运行关系；root 与 child 的 Agent 名称优先读取 `agent_name`，其次读取 `execution.agent_id`，仅在两者都缺失时使用框架兜底名；没有独立 `user_prompt` 事件时，接收端从 root 首个 `api_request.request_text` 提取用户消息并补成 `role=user` interaction；`skill_name` 及 Skill 参数表达技能调用。接收端将 `Skill` 规范化为 `skill`，将 `Agent` / `Task` 规范化为 `task`，再复用统一 Execution 树与 Skill 归属逻辑。

setup wrapper 只设置 `CODEAGENT3_ENABLE_TELEMETRY=1`、OTLP base endpoint、JSON protocol 和认证 header，不写 `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none`；CodeAgent 当前会覆盖这类关闭变量。

## 环境变量 (OpenClaw 侧)

以下环境变量控制 OpenClaw 的 OTel 导出行为：

| 变量 | 说明 | 建议值 |
|------|------|--------|
| `CLAW_ENABLE_TELEMETRY` | 启用 OTel 上报 | `1` |
| `OTEL_LOGS_EXPORTER` | Logs 导出器 | `otlp` |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Logs 传输协议 | `http/json` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Logs 端点 URL | `http://<host>:3000/api/ingest/otel/v1/logs` |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Traces 传输协议 | `http/json`（也接受 `http/protobuf`） |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces 端点 URL | `http://<host>:3000/api/ingest/otel/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS` | 公共 Headers | `x-witty-api-key=<your-api-key>` |
| `OTEL_SERVICE_NAME` | OTel service.name | `openclaw` |

setup 生成的同名 `openclaw` 包装函数和末尾纯配置块都使用 `http/json`，Logs 与 Traces 分别指向 `/v1/logs`、`/v1/traces`。两者只是两种配置呈现方式，不应与 watcher 同时启用。

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

落库模型：`RasAnomalyEvent`。实现：`src/lib/ingest/ras/*`、`src/app/api/ingest/ras-events`；推送方：同进程 `agent_ras/ras_runtime/insight_push.py`（fail-open）。同一 `taskId + deliveryId` 幂等更新；相同内容的两次真实异常使用不同 `deliveryId`，不会被错误合并。`payload.actions[]` 保留动作类型及完整 `message`；`payload.trace_anchor` 使用 `message_id + part_id + channel` 定位**检测点**，或使用 `call_id + channel=tool_call` 定位工具调用。`action_result` 携带同一检测锚点、实际投递内容，以及可选的 `payload.delivery_anchor`（`message_id` 必须是**平台分配**的投递消息 id，才可把投递交互重分类为 RAS；`channel` 为 `ras_notice` 或 `ras_steering`）。拿不到平台真 id 时**省略** `delivery_anchor`，**禁止**客户端伪造 id。**不做**正文匹配兜底。

宿主上传生命周期：`fire_push_*` 注册 per-session pending handle；平台在异常与全部 `action_result` 入队后调用内部 `flush(timeout_ms)`，以 HTTP 2xx 作为 ack。flush 只等待调用时的 pending 快照，返回 `attempted/acked/failed/pending/timed_out`；并发 flush 各自使用本地快照结算，不会互相消费回执。未 flush 的完成回执按 session 最多保留 256 条，避免长驻宿主无界增长。超时不得取消上传或向 Agent 主流程抛错。OpenCode 的主 flush 点是 `onActions` 末尾，idle/bye 仅兜底，`reset` 不清理 pending。该有界 drain 保证正常短生命周期结束；SIGKILL/断电保证需另建持久化 outbox。

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.4 | 2026-08-17 | `delivery_anchor.message_id` 必须为平台分配；OpenCode 已认证 uploader 直连公网 `IP:3000` 时记录来源公网 IP，并支持服务端本机通过自身公网地址上报 |
| 1.3 | 2026-08-14 | RAS 旁路上传增加 per-session receipt、正常退出前 bounded flush，并明确 GIL/线程生命周期 |
| 1.2 | 2026-07-31 | RAS 契约收紧：仅 flat+必填 deliveryId；移除 witty.* / rasEventId / 深路径 rewrite / 正文兜底 |
| 1.1 | 2026-08-04 | 对齐实际 OpenClaw JSON/Protobuf 归一化、幂等聚合、watcher 兼容和停用模型代理语义；补充 RAS 旁路 ingest（非 OTLP） |
| 1.0 | 2026-07-14 | 初版，定义 OTLP 属性契约 (FR-011) |
