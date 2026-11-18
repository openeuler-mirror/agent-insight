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

## 服务端诊断日志

连接探测以 `scope: "ModelConnectionTest"` 输出结构化日志，写入服务端控制台及现有 `agent-insight.log`（目录由 `AGENT_INSIGHT_LOG_DIR` 指定，默认 `/var/log/agent-insight`；不可写时仍保留控制台输出）。失败使用 `error`，默认日志级别即可看到；成功使用 `info`，需配置 `AGENT_INSIGHT_LOG_LEVEL=info` 并重启服务。接口仍返回原有通用错误，不向浏览器透传供应商错误正文。

- `testId/result/elapsedMs/timeoutMs`：每次探测的定位编号、结果和耗时。
- `attempts`：协议适配后的实际请求路径、方法、头名称，以及 `authorizationPresent/apiKeyHeaderPresent`。只记录头名称和鉴权头是否存在，不记录头值；不记录请求正文或模型输出。
- `attempts[].proxy`：`mode` 为 `direct/proxy`；`env` 表示生效的代理环境变量，`endpoint` 只保留代理协议、主机和端口。`noProxyConfigured` 表示配置过排除规则，`bypassed` 表示本次实际匹配并绕过代理。日志和传输使用同一份缓存配置及匹配逻辑，不代表每次重新读取环境变量。自定义注入的传输标记为 `custom`。
- `upstream`：上游 HTTP 状态、Content-Type、Request ID、脱敏后的鉴权挑战及错误原因。兼容 `error.code/type/message`、顶层 `code/message` 和网关 `error_code/error_msg/request_id`；JSON 仅提取诊断字段。纯文本或 HTML 错误保留脱敏文本，移除 HTML 标签。未返回明确原因时仍需结合网关日志排查。
- `proxyTunnelStatus/causeCodes`：代理拒绝 CONNECT 隧道时记录其状态码；DNS、连接等失败保留底层错误码。隧道拒绝与模型 HTTP 响应分别记录，隧道错误正文不在模型响应中。

上游错误正文最多观察 8192 字节，原因最多输出 2048 字符；超限正文全部省略并标记 `bodyTruncated`，超时或取消导致正文未结束时省略片段并标记 `bodyIncomplete`。采集随 SDK 消费响应流进行，不额外读取、重试或延长截止时间。API Key、自定义头的所有值及 URL 凭据、查询参数值均参与回显脱敏，目标 URL 不记录用户信息和查询参数；Cookie、完整响应头和任意 JSON 附加字段不输出。

客户复现连接测试后，可筛选对应时间段的容器日志：

```bash
docker logs --since 10m <容器名> 2>&1 | grep '"scope":"ModelConnectionTest"'
```

结合 `testId`、`attempts[].proxy.mode/bypassed` 和 `upstream.status/errorCode/reason/requestId` 对照成功的 curl。上游 HTTP `401` 仍映射为平台接口 `422`，日志保留真实的上游状态。

实现依据：[当前实现](https://gitcode.com/openeuler/agent-insight/blob/master/src/app/api/eval/settings/test/route.ts)。

[English](../../../en/reference/platform/model-connection-test.md)
