---
title: "模型连接测试接口"
description: "测试请求、超时、响应与错误分类。"
keywords: ["Agent Insight", "模型连接", "超时控制", "错误分类"]
changefreq: "monthly"
---

用户身份及调用范围见 [HTTP 接口与用户身份](./http-api.md)。

`POST /api/eval/settings/test` 接受 `provider/protocol/apiKey/baseUrl/model/testTimeoutMs`，兼容 `evalProvider/evalApiKey/evalBaseUrl/evalModel`；所有供应商均可带经过校验的 `headers`。`user/configId` 可用于恢复已保存配置中的脱敏 Key 和头部；这些不是新的统一鉴权机制，按实际部署控制调用范围。测试会向模型供应商发送一次真实小请求。


- `ModelConfig.protocol?: "openai-compatible" | "anthropic"` 存于现有用户设置 JSON；非法协议返回 `400`。新配置由供应商预选，旧配置缺省时保留原路径，不自动改写。显式协议同时用于测试和业务调用，无需 Prisma schema 迁移。
- API Key 可留空。空值不产生默认鉴权头，也不继承供应商环境密钥；自定义头按大小写无关规则覆盖同名标准鉴权头。测试已保存配置时，掩码恢复原 Key，显式空字符串移除 Key。
- `ModelConfig.testTimeoutMs?: number` 存于现有用户设置 JSON；缺省为 `60000`，范围 `10000～300000` 整数毫秒。保存设置和测试接口均校验，非法值返回 `400`；无需 Prisma schema 迁移。该字段不改变评测、生成或优化的业务超时。
- `POST /api/eval/settings/test` 在现有连接参数上接受 `testTimeoutMs`。保存前使用表单值，健康检查发送已保存值。请求按协议执行一次 Chat Completions 或 Anthropic Messages（`Reply with OK.`，`max_tokens: 128`），`maxRetries: 0`。
- 响应包含 `{ success, elapsedMs, timeoutMs, code?, error? }`。失败 `code` 为 `timeout | cancelled | authentication | rate_limit | network | invalid_request | server | invalid_response | unknown`；供应商原始异常不透传，避免 URL、凭据或请求头泄漏。模型鉴权失败映射为 `422`，不冒充平台登录态失效。
- 独立截止时间覆盖模型请求及响应体解析，超时和客户端取消都会 abort 底层请求，结束后释放定时器和监听器。取消表示终止本地等待及传输，不保证供应商立即停止推理。
- 前端只有测试成功且未取消时才调用设置保存接口，测试中冻结表单、阻止重复提交。保存阶段不提供取消，避免误报“未保存”。健康检查区分超时、取消与其他失败；失败信息持续显示并支持显式关闭或重试。


显式 Anthropic 配置的单次评测、诊断等调用由共享传输适配为原生 Messages，保留 system、结构化输出及 token 用量；生成和工具流使用原生 Anthropic 客户端。OpenCode 静态注册每个显式协议连接，连接变化会刷新运行时；同厂商同模型的不同连接相互隔离。无效 JSON 或协议响应归类为 `invalid_response`，不会显示成网络错误。

实现依据：[当前实现](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/eval/settings/test/route.ts)。

[English](../../../en/reference/platform/model-connection-test.md)
