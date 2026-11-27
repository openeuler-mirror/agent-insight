---
title: "HTTP 接口与用户身份"
description: "平台接口分类、用户解析、响应格式及调用边界。"
keywords: ["Agent Insight", "HTTP 接口", "用户身份", "平台集成"]
changefreq: "monthly"
---

本页是现有 HTTP 接口的阅读入口。不同入口使用不同的身份和响应约定；文档按当前实现说明，不承诺所有路由采用统一鉴权、统一错误对象或版本化稳定性。

## 接口分类

| 入口 | 用途 | 契约 |
| --- | --- | --- |
| 平台业务 API | 实验查询、创建和控制 | [实验 HTTP 接口](../evaluation/experiments-api.md) |
| 数据集 API | 定义、样本、历史 Trace 自动生成与删除进度 | [数据集 HTTP 接口](../evaluation/datasets-api.md) |
| Skill 管理 API | 资产、版本、文件与发布导入 | [Skill 管理 HTTP 接口](../optimization/skills-api.md) |
| 可靠性客户端 API | 注册、设备凭证、配置与控制回执 | [可靠性客户端与控制接口](../reliability/client-control-api.md) |
| Trace 接入 API | 接收采集器或 OTel 导出器数据 | [Trace HTTP 接入](../observability/trace-ingestion.md) |
| 平台内置评估器 | 将单次评估结果交给平台 | [评估器输出](../evaluation/evaluator-output.md) |
| 独立 Benchmark Evaluator | 平台派发官方 Benchmark 评判任务 | [Benchmark 评测协议](../evaluation/benchmark-protocol.md) |
| 内部引擎函数、数据模型 | 仓内开发与扩展 | [API 与内部契约](./api-and-contracts.md) |

URL 使用部署地址作为前缀；若部署在子路径下，还需包含实际配置的路径前缀。平台默认端口 `3000` 与独立 Evaluator 端口是不同配置，见[运行配置](./configuration.md)。

## 平台用户解析

采用 `resolveUser(request, explicitUser)` 的路由按以下顺序解析：

1. 先查找请求头 `x-witty-api-key`，并用它查询平台用户。
2. 请求头未提供非空 Key 时，再读取查询参数 `apiKey`。
3. 路由若通过请求体或查询参数传入 `explicitUser`，它只用于一致性校验：必须与 Key 对应用户完全相同。
4. Key 无效、Key 与 `explicitUser` 不一致，或只传 `explicitUser` 而没有 Key，都会得到空身份。无效的请求头 Key 不会继续尝试查询参数 Key。

Browser `apiFetch` 会为业务 `/api/*` 请求自动附带本地 API Key，但明确跳过 `/api/auth/*`，避免登录/切换账号时把旧 Key 带到认证端点。集成调用同样必须携带账号的 `x-witty-api-key`，查询参数 `user` 不能单独作为身份或数据隔离凭证。浏览器登录、IDaaS 和各采集器的身份流程应查对应操作指南。

私有资源入口在身份为空时失败关闭；公共 Skill 等明确允许匿名读取的资源仍可返回受限的公开数据。匿名读取公开 Skill 的版本列表时不返回其他用户执行内容。少数只读状态接口（例如企业同步进程状态）仍可能无用户鉴权，不能由单个成功响应推导整页或全站都已隔离。详情和写操作还会核对资源归属。

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
