---
title: "统一推理请求关联契约"
description: "模型转发入口与模型服务响应头的 X-Request-Id、重试及 Trace/LLM 关联边界。"
---

# 统一推理请求关联契约

Agent → 客户端本地转发入口 → 原模型推理服务。原模型地址由用户显式登记，不由采集安装隐式改写。平台的 Trace 采集路径不变。无新增数据库表或平台 API，关联信息保存在现有 Trace 交互元数据中。

链路上有两个来源不同、用途不同的 `X-Request-Id`：

- **网关调用 ID**：本地转发入口为每次实际转发的模型 HTTP 请求生成的 UUID，用于推理服务按请求落库和平台本地关联。
- **模型服务响应 ID**：模型服务（或其前置网关）在响应头返回的 `X-Request-Id`，用于服务侧自己的推理记录检索。

两者不互相覆盖、不假设全局唯一，也不替代平台 Trace/Span ID。

## 网关调用 ID：推理服务只需适配一种请求头

| 字段 | 规则 |
| --- | --- |
| `X-Request-Id` | 网关为每一次实际转发的模型 HTTP 请求生成标准 UUID v4，覆盖同名入站值；成功、HTTP 错误和重试均使用此字段 |
| 作用域 | 一次 HTTP 尝试；不是 Trace ID，也不是逻辑 LLM span ID。重试各有不同 UUID |
| 推理分析 URL | `http(s)://<服务地址>/model-performance?GlobalTrackNO=<UUID>`，每次只接受一个 ID |

推理服务在收到请求时读取并持久化该头，将它绑定到本次推理记录，错误也按同样方式记录，并提供上述页面。服务侧不需要识别 OpenCode、Qoder、其会话格式或插件字段。中间负载均衡/反向代理应透传此头，不得覆盖；后续内部链路也应保留这个外部关联值。

调用尚未到达推理服务即 DNS/TCP 失败、取消或网关本地存储失败时，推理服务无法收到请求/ID；平台只保留本地可观测证据。已经收到的请求即使返回 4xx/5xx，仍携带完整请求头。网关不自行重试；Agent 重试会生成新 UUID。失败在推理页面中如何展示由推理服务决定。

## 模型服务响应 ID：采集另一层标识

当模型服务在响应头返回 `X-Request-Id` 时，本地转发入口和已接管的采集器会读取该值，作为**模型服务响应 ID**单独保存：

| 规则 | 行为 |
| --- | --- |
| 头名称 | `X-Request-Id`，HTTP 头名称大小写不敏感；只接受这一个约定头，不收集认证、Cookie 或其他响应头 |
| 取值 | 保留服务端原值；不裁剪为 UUID，也不与网关 UUID 互换 |
| 时机 | 收到响应头即记录，不等待响应体或流结束；流式与非流式一致 |
| 尝试粒度 | 每次实际 HTTP 尝试独立记录；重试的每个尝试可以有不同服务 ID |
| 重复与冲突 | 同名头重复且值相同视为一个值；出现多个不同值时不猜测，按不可获取处理 |
| 缺失 | 服务未返回、被中间件剥离、传输失败或尚未收到响应头时，显式标记“未提供”，不用调用 ID、Trace ID 或时间推断补造 |
| 错误与取消 | 已收到响应头后发生 4xx/5xx、超时或用户取消，仍保留该次尝试的真实服务 ID 与状态 |
| 来源标注 | 采集结果标记来源 `model-response-header`，与网关生成的调用 ID 区分 |

网关在本地 journal 中保存服务 ID，并通过内部响应头 `x-agent-insight-upstream-request-id` 传给 Agent 侧采集器；该内部头不转发到推理服务的请求中，其他上游返回的 `x-agent-insight-*` 响应头也会被剥离。直连模式下，只有 SDK/fetch 能读取响应头且调用归属可证明时才记录；无法证明归属的值只进入整条 Trace 的未分配列表。

## 支持路径

| 路径 | 服务响应 ID 支持 |
| --- | --- |
| OpenCode 1.x / 2.x → 本地转发入口 | 支持；2.x 通过原生 HTTP hook 读取网关内部响应头 |
| Qoder CN CLI → 本地转发入口 | 支持；网关 journal 由 CLI 钩子在会话结束时读取 |
| OpenCode 直连、未接管 Provider | 有条件支持；仅当响应头对 Agent 可见且 call ID 归属可证明 |
| Qoder Desktop / JetBrains | 不支持；无可验证的响应头访问路径 |
| OTLP/日志型采集器（Claude Code、Codex、Hermes、Langfuse 等） | 不支持；框架 telemetry 当前不暴露原始 HTTP 响应头 |
| 平台内置评测/优化模型调用 | 不进入用户 Trace 存储，本契约不覆盖 |

## Agent 差异由本地适配屏蔽

OpenCode 1.x 通过消息钩子和受控 fetch 记录会话、assistant message 与每次传输尝试；2.x 通过原生 model/http hook 和延迟的 step 事件建立同样关系。只对显式接入的端点生效，其他 Provider 不改变传输方式。2.x 受管 Provider 使用 HTTP 传输，未接管的 Provider 保留原传输。

Qoder CN CLI 通过其 `session-id` 记录会话，唯一且真实的响应 `message.id` 用于回填 LLM。合成的本地错误消息 ID 不充当推理服务响应 ID。GUI 产品无已验证响应身份，不能宣称同样支持。

模型服务响应 ID 不是消息 ID 或响应体 ID。它只在收到 HTTP 响应头后存在，因此 Qoder CLI 的失败调用即使没有可回填的 `message.id`，只要响应头已到达，仍可在整条 Trace 的未分配调用中保留服务 ID。

本地 `x-agent-insight-session-id`、`x-agent-insight-message-id`、`x-agent-insight-request-id`、`x-agent-insight-attempt-id` 仅用于客户端关联，转发时剥离，不要求推理侧适配；Qoder 会话头也不作为下游契约。网关给 Agent 的响应返回 `X-Request-Id`；为兼容旧采集器另返回本地别名 `x-agent-insight-call-id`，该别名不下发到推理侧。

## 存储与关联

本地日志位于 `$AGENT_INSIGHT_HOME/inference-gateway/<账号摘要>/<agent>/<会话摘要>/`，只记录 ID、时间、状态和已核验响应 ID，不存提示词或模型凭据。配置及备份仅限当前用户访问。采集器按安装账号读取，OpenCode 会在网关日志更新时重新上传已有会话，并在上传失败后重试，避免错过迟到的 ID。

`inference_call_ids` 是节点拥有的网关 UUID 列表；`inference_attempts` 保留请求、尝试、状态与时间；`inference_unassigned_calls` 仅属于整条 Trace。父 Trace 汇总已观测的子 Agent 调用，每个 LLM 只使用可证明属于自己的 ID。存在多个尝试时页面列出所有请求，有唯一最新时间才推荐最近一次；一个 Trace 不会被假装映射为单个模型请求。

模型服务响应 ID 使用同一套归属证据，额外保存在：

| 字段 | 含义 |
| --- | --- |
| `inference_upstream_request_ids` | 已归属到节点的 `{ call_id, request_id, source }` 列表；`source` 当前为 `model-response-header` |
| `inference_attempts[].upstream_request_id` | 单次尝试对应的服务 ID |
| `inference_unassigned_calls[].upstream_request_id` | 无法证明 LLM 归属、只属于整条 Trace 的服务 ID |

服务 ID 只挂到已确认归属的 `call_id`，不会跨 LLM 分配；同一调用有多次尝试时逐个保留。异步上传、补传、服务重启和历史数据刷新均以现有 interactions JSON 为准，历史 Trace 没有该字段时继续正常展示。

## 展示与查询

LLM 节点详情在存在服务 ID 时显示并支持复制：唯一值直接展示；多个值显示数量并引导到「推理分析」逐次查看；存在调用但没有服务 ID 时显示“未提供”。「推理分析」同时保留网关调用 ID 与服务 ID，并提供两个查询链接，均由 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 控制。服务 ID 作为 URL 参数编码，不配置入口、配置无效或 ID 缺失时不生成链接。

配置步骤、备份与人工恢复见 [接入指南](../../how-to/observability/inference-gateway.md)。
