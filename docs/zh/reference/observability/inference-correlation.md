---
title: "统一推理请求关联契约"
description: "模型转发入口的 X-Request-Id、重试及 Trace/LLM 关联边界。"
---

# 统一推理请求关联契约

Agent → 客户端本地转发入口 → 原模型推理服务。原模型地址由用户显式登记，不由采集安装隐式改写。平台的 Trace 采集路径不变。无新增数据库表或平台 API，关联信息保存在现有 Trace 交互元数据中。

## 推理服务只需适配一种请求头

| 字段 | 规则 |
| --- | --- |
| `X-Request-Id` | 网关为每一次实际转发的模型 HTTP 请求生成标准 UUID v4，覆盖同名入站值；成功、HTTP 错误和重试均使用此字段 |
| 作用域 | 一次 HTTP 尝试；不是 Trace ID，也不是逻辑 LLM span ID。重试各有不同 UUID |
| 推理分析 URL | `http(s)://<服务地址>/model-performance?GlobalTrackNO=<UUID>`，每次只接受一个 ID |

推理服务在收到请求时读取并持久化该头，将它绑定到本次推理记录，错误也按同样方式记录，并提供上述页面。服务侧不需要识别 OpenCode、Qoder、其会话格式或插件字段。中间负载均衡/反向代理应透传此头，不得覆盖；后续内部链路也应保留这个外部关联值。

调用尚未到达推理服务即 DNS/TCP 失败、取消或网关本地存储失败时，推理服务无法收到请求/ID；平台只保留本地可观测证据。已经收到的请求即使返回 4xx/5xx，仍携带完整请求头。网关不自行重试；Agent 重试会生成新 UUID。失败在推理页面中如何展示由推理服务决定。

## Agent 差异由本地适配屏蔽

OpenCode 1.x 通过消息钩子和受控 fetch 记录会话、assistant message 与每次传输尝试；2.x 通过原生 model/http hook 和延迟的 step 事件建立同样关系。只对显式接入的端点生效，其他 Provider 不改变传输方式。2.x 受管 Provider 使用 HTTP 传输，未接管的 Provider 保留原传输。

Qoder CN CLI 通过其 `session-id` 记录会话，唯一且真实的响应 `message.id` 用于回填 LLM。合成的本地错误消息 ID 不充当推理服务响应 ID。GUI 产品无已验证响应身份，不能宣称同样支持。

本地 `x-agent-insight-session-id`、`x-agent-insight-message-id`、`x-agent-insight-request-id`、`x-agent-insight-attempt-id` 仅用于客户端关联，转发时剥离，不要求推理侧适配；Qoder 会话头也不作为下游契约。网关给 Agent 的响应返回 `X-Request-Id`；为兼容旧采集器另返回本地别名 `x-agent-insight-call-id`，该别名不下发到推理侧。

## 存储与关联

本地日志位于 `$AGENT_INSIGHT_HOME/inference-gateway/<账号摘要>/<agent>/<会话摘要>/`，只记录 ID、时间、状态和已核验响应 ID，不存提示词或模型凭据。配置及备份仅限当前用户访问。采集器按安装账号读取，OpenCode 会在网关日志更新时重新上传已有会话，并在上传失败后重试，避免错过迟到的 ID。

`inference_call_ids` 是节点拥有的网关 UUID 列表；`inference_attempts` 保留请求、尝试、状态与时间；`inference_unassigned_calls` 仅属于整条 Trace。父 Trace 汇总已观测的子 Agent 调用，每个 LLM 只使用可证明属于自己的 ID。存在多个尝试时页面列出所有请求，有唯一最新时间才推荐最近一次；一个 Trace 不会被假装映射为单个模型请求。

配置步骤、备份与人工恢复见 [接入指南](../../how-to/observability/inference-gateway.md)。
