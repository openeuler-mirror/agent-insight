---
title: "Trace HTTP 接入"
description: "OTLP 与兼容 JSON 上传的输入、身份处理和接收语义。"
---

优先使用对应框架的客户端安装流程。本页用于导出器集成和问题定位；OTLP 与兼容上传的 JSON 不能相互替代。

## OTLP/HTTP Traces

`POST /api/ingest/otel/v1/traces` 接收 OTLP Trace 请求，`POST /api/public/otel/v1/traces` 复用相同处理器。这里的 `public` 是路由名称，不代表任意来源均可匿名写入。字段映射见 [OTLP 属性契约](./otlp-attribute-contract.md)。

| 项目 | 约定 |
| --- | --- |
| JSON | `Content-Type: application/json`，使用 OTLP `resourceSpans` 结构 |
| Protobuf | `Content-Type: application/x-protobuf`，使用 OTLP Trace 编码；其他类型由解码器决定是否支持，非法类型返回 `415` |
| 平台 Key | `x-witty-api-key`；显式传入但未匹配到用户时返回 `401`，不回退到资源里的用户字段 |
| Langfuse 兼容来源 | 没有已验证平台 Key 时，以 Basic 的 `publicKey:secretKey`，或 `x-langfuse-public-key` / `x-langfuse-secret-key` 验证；分别对应用户名和该用户 API Key |
| LlamaIndex | 必须通过平台 Key 验证，不能用 `resource.user.id` 选择任意归属 |
| 其他来源 | 部分适配器保留来源属性归属路径；不要把它理解为账号凭证验证，接入应按框架指南配置 Key |

一般成功响应如下，计数是归一化事件数，不保证等于原始 Span 数：

```json
{
  "status": "accepted",
  "received": 2,
  "persisted": 1,
  "deduplicated": 1,
  "sessions": ["example-session"]
}
```

`persisted` 表示本次新增写入 spool 的事件，`deduplicated` 表示识别到的重复事件，`sessions` 是需要后续处理的会话 ID。框架专用路径可能返回 `framework` 等不同字段；全是被忽略的 CodeAgent 资源时会返回 `ignored: true` 和 `received: 0`。不要用 HTTP `200` 断言业务 Trace 已完成展示。

| 状态 | 语义 |
| --- | --- |
| `200` | 已受理；仍需后续消费、聚合和投影 |
| `400` | JSON/Protobuf 无法解码或请求无效 |
| `401` | 显式 Key 无效，或需要验证的来源缺少有效凭证 |
| `413` 且 `status: partial` | Goal Plus 会话身份数量达到 spool 限制；部分事件可能已受理，查看 `received` 和 `rejected.spool` |
| `415` | 不支持的内容类型 |
| `500` | 服务处理失败；保留未确认数据供按采集器策略重试 |

接收 ACK、spool 落盘、消费者保存 Execution/Session、界面可见是不同阶段。排查时逐段确认；重发也应沿用采集器已有的去重身份，不要为同一事件随意生成新 ID。

## 兼容 JSON 上传

`POST /api/ingest/upload` 接收既有采集器使用的执行记录对象。常见字段有 `framework`、`task_id`、`query`、`final_result`、`interactions` 和生命周期字段；具体框架字段按其采集器契约传递，不把这些字段视为可替代 OTLP 的通用 Schema。

身份处理与 OTLP 不同：

- 有效 `x-witty-api-key` 可确定账号。OpenCode 请求还可使用已注册设备的 Bearer 凭证和 `x-agent-insight-client-id`；设备凭证流程由客户端管理。
- 两份凭证都有效时必须属于同一账号，否则 `403`。其中一份无效、另一份有效时可接受，但不使用失效凭证绑定客户端；两份都无效时拒绝。
- 未提供有效验证身份时，部分旧客户端可以用请求体 `user`，或服务端显式配置的 `AGENT_INSIGHT_DEFAULT_INGEST_USER` 选择归属；这些是兼容/共享账号路径。完全没有身份来源时返回 `400`，显式无效 Key 不会静默回退到共享账号。

成功响应包含 `success: true`、`upload_id`、`auto_evaluation`、`background_analysis`，进行中的 OpenCode 快照另带 `in_progress: true`。`auto_evaluation: false` 不等于本次上传失败。初次记录保存失败返回 `500`，客户端不应写“已上传”检查点；后台分析是否完成应另外核对，不能由 `background_analysis: true` 推断。

## 实现依据

- [OTLP Trace 路由](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/otel/v1/traces/route.ts)与[解码器](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/ingest/otel/decode.ts)
- [兼容上传路由](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/ingest/upload/route.ts)
- [查看 Trace](../../how-to/observability/view-traces.md)

[English](../../../en/reference/observability/trace-ingestion.md)
