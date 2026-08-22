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

### OpenCode Trace 公网 IP 快照（非 OTLP）

适用范围只有 `framework=opencode` 的 `POST /api/ingest/upload`，结果保存到 `Execution.observedIp` 并显示在链路追踪列表的 IP 列。Claude Code、Hermes、xiaoO 等其他框架尚未写入该字段；可靠性常驻客户端注册和心跳对直连模式也不启用该分支，它们仍只读取显式配置的可信代理头。

OpenCode uploader 上报 `client_id`、`host.reported_ip` 和 `host.hostname`。正式 `~/.agent-insight/client/config.json` 提供 `clientId + deviceCredential`；兼容 `~/.agent-insight/client.json` 的自报 ID 不建立可信客户端绑定。直连 IP 识别要求上传通过设备凭证或有效 `x-witty-api-key` 认证；仅在请求体填写 `user` 的未认证上传不能启用直连识别。

服务端按以下顺序解析：

1. 如果配置了 `AGENT_INSIGHT_TRUSTED_PROXY_HEADER`，先读取该头的公网地址。`x-forwarded-for` 只取最左侧地址。
2. 对已认证 OpenCode 直连上传，读取 Next.js 在请求未携带 `x-forwarded-for` 时从 TCP socket 补入的来源地址；来源本身是公网地址时直接保存。官方 uploader 不主动发送该头。
3. 如果来源是服务端自身的回环或本机网卡地址，且 uploader 上报的 hostname 与服务端 hostname 一致，则把请求目标中的**公网 IP 字面量**保存为服务器公网 IP。域名、`localhost` 和私网地址不会在该步骤做 DNS 或公网反查。
4. 其余情况保存 `null`。私网、回环、链路本地、保留地址和文档示例地址都会被过滤。

| 部署方式 | 当前支持 | 服务端配置 | 结果 |
|---|---|---|---|
| 外部 OpenCode 直连公网 IP 或公网域名的 `:3000` 服务 | 支持 | 无；上传需通过 API Key 或设备凭证认证 | 客户端网络的公网出口 IP |
| OpenCode 与服务端同机，访问服务端公网 IP 字面量 | 支持 | 无；上传需认证，来源必须是服务端自身地址，hostname 必须一致 | 请求目标中的服务器公网 IP |
| OpenCode 与服务端同机，访问公网域名 | 有条件支持 | 无 | TCP 来源已是公网地址时可保存；本地回环或私网路径下为 `null` |
| Nginx、Apache、负载均衡或 API 网关 | 有条件支持 | 代理覆盖真实来源头；服务端设置 `AGENT_INSIGHT_TRUSTED_PROXY_HEADER=x-forwarded-for` 或 `x-real-ip` | 可信头中的公网 IP |
| Cloudflare | 有条件支持 | 服务端设置 `AGENT_INSIGHT_TRUSTED_PROXY_HEADER=cf-connecting-ip` | Cloudflare 提供的客户端公网 IP |
| Docker、Kubernetes Ingress | 有条件支持 | 推荐由 Ingress 或网关覆盖真实来源头并配置对应环境变量 | 保留公网来源时可保存；只剩容器或节点私网地址时为 `null` |
| `localhost`、服务器私网 IP、局域网、VPN 私网或 SSH 隧道 | 不支持公网 IP 绑定 | 无 | `null` |

`AGENT_INSIGHT_TRUSTED_PROXY_HEADER` 只接受 `x-forwarded-for`、`x-real-ip`、`cf-connecting-ip`。最外层可信代理必须删除或覆盖客户端传入的同名头；使用追加式 `X-Forwarded-For` 而不清洗最左侧值会允许客户端伪造展示 IP。修改服务端环境变量后必须重启 Agent Insight。

`observedIp` 是 Trace 产生时的首次非空快照：重传不会覆盖已有值，根/child `Execution` 继承同一快照，也不复用表示模型推理源的 `Execution.endpoint`。该字段只用于展示和网络排障，不用于认证或唯一标识机器；NAT 后的多台电脑会共享同一个公网出口 IP。

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
| 1.4 | 2026-08-17 | `delivery_anchor.message_id` 必须为平台分配；OpenCode 已认证 uploader 支持直连公网 IP 与服务端同机上报，并明确直连、代理、容器、私网部署矩阵 |
| 1.3 | 2026-08-14 | RAS 旁路上传增加 per-session receipt、正常退出前 bounded flush，并明确 GIL/线程生命周期 |
| 1.2 | 2026-07-31 | RAS 契约收紧：仅 flat+必填 deliveryId；移除 witty.* / rasEventId / 深路径 rewrite / 正文兜底 |
| 1.1 | 2026-08-04 | 对齐实际 OpenClaw JSON/Protobuf 归一化、幂等聚合、watcher 兼容和停用模型代理语义；补充 RAS 旁路 ingest（非 OTLP） |
| 1.2 | 2026-08-11 | 新增 Pi Agent canonical span 与 Adapter 映射 |
| 1.0 | 2026-07-14 | 初版，定义 OTLP 属性契约 (FR-011) |
<!-- Codex canonical traces use agent.insight.framework=codex and redact inline secrets and local paths before spool persistence while preserving numeric usage fields. -->
