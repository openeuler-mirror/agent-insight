---
title: "HTTP 接口与用户身份"
description: "平台接口分类、用户解析、响应格式及调用边界。"
---

本页是现有 HTTP 接口的阅读入口。不同入口使用不同的身份和响应约定；文档按当前实现说明，不承诺所有路由采用统一鉴权、统一错误对象或版本化稳定性。

## 接口分类

| 入口 | 用途 | 契约 |
| --- | --- | --- |
| 平台业务 API | 实验查询、创建和控制 | [实验 HTTP 接口](../evaluation/experiments-api.md) |
| Trace 接入 API | 接收采集器或 OTel 导出器数据 | [Trace HTTP 接入](../observability/trace-ingestion.md) |
| 平台内置评估器 | 将单次评估结果交给平台 | [评估器输出](../evaluation/evaluator-output.md) |
| 独立 Benchmark Evaluator | 平台派发官方 Benchmark 评判任务 | [Benchmark 评测协议](../evaluation/benchmark-protocol.md) |
| 内部引擎函数、数据模型 | 仓内开发与扩展 | [API 与内部契约](./api-and-contracts.md) |

URL 使用部署地址作为前缀；若部署在子路径下，还需包含实际配置的路径前缀。平台默认端口 `3000` 与独立 Evaluator 端口是不同配置，见[运行配置](./configuration.md)。

## 平台用户解析

采用 `resolveUser(request, explicitUser)` 的路由按以下顺序解析：

1. 路由传入非空 `explicitUser` 时直接使用该值；部分路由从请求体或查询参数 `user` 传入。
2. 否则查找请求头 `x-witty-api-key`，使用匹配用户。
3. 请求头没有该字段时，再读取查询参数 `apiKey`。
4. 未匹配到用户则返回空身份，由路由自行处理。无效的请求头 Key 不会继续尝试查询参数 Key。

因此，显式 `user` 是兼容性的用户选择方式，不能当作已验证凭证或安全隔离证明。集成调用应携带目标账号的 `x-witty-api-key`，并避免同时传入覆盖身份的 `user`；Key 从当前账号的客户端安装指导获取。浏览器登录、IDaaS 和各采集器的身份流程应查对应操作指南，不能从上述函数推断所有路由行为。

只读实验列表在身份为空时可能不加用户筛选，其他接口可能返回 `400`、`401` 或 `404`。不要用一次列表请求成功来判断 Key 已通过验证；详情和写操作还会按各自逻辑核对归属。对外访问边界仍需按实际部署设置。

```bash
# 仅演示读取；地址与 Key 由调用方环境提供。
curl --fail-with-body \
  -H "x-witty-api-key: $AGENT_INSIGHT_API_KEY" \
  "$AGENT_INSIGHT_BASE_URL/api/experiments?limit=20&offset=0"
```

## 响应与重试

| 情况 | 处理方式 |
| --- | --- |
| HTTP `200` / `201` | 阅读对应接口的响应；创建成功、接收成功与执行完成是不同事件 |
| HTTP `202` | 异步任务已受理或取消仍待确认，继续查询任务状态 |
| HTTP `400` / `401` / `403` / `404` | 依据路由核对参数、凭证、归属及目标；不要无限重试 |
| HTTP `409` | 状态、任务或幂等冲突，查询已有任务再决定下一步 |
| HTTP `413` / `415` / `422` | 核对大小、内容类型或协议校验；部分接入响应可能已接受部分数据 |
| HTTP `5xx` / 网络中断 | 保存请求上下文；重试前核对接口的幂等规则，不假定所有 POST 都幂等 |

常见平台错误为 `{ "error": "说明" }`，部分接口还包含 `code`、`detail` 或 `hint`；Benchmark 服务使用结构化错误。应同时处理 HTTP 状态与响应体，不将所有错误强行解析为同一结构。请求取消也不等于远端进程已经退出。

## 实现依据

- [用户解析函数](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/auth/auth.ts)
- [实验列表与创建](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/experiments/route.ts)
- [客户端安装操作](../../how-to/platform/settings/access-control.md)

[English](../../../en/reference/platform/http-api.md)
