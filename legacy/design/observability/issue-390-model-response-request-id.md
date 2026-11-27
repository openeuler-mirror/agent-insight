# 模型响应头 X-Request-Id 采集与推理详情关联

关联 issue：[`openeuler/agent-insight#390`](https://atomgit.com/openeuler/agent-insight/issues/390)

## 1. 背景与目标

已有推理关联链路由本地转发网关为每次实际模型请求生成 `X-Request-Id`，推理服务按该值持久化并提供查询页。但部分推理服务会主动在响应头返回自己的 `X-Request-Id`。该值属于模型服务响应层，与网关本地生成的调用 ID 不是同一个标识，当前没有被采集，用户无法用服务侧真正记录的值定位推理详情。

本设计在不改变现有 Trace/Span 主键与父子关系的前提下：

- 从模型 HTTP 响应头读取 `X-Request-Id`，大小写不敏感；
- 保留服务端原值，不用网关 UUID 或 Trace ID 替代；
- 按“实际 HTTP 尝试”关联到所属 Trace、LLM 节点和调用尝试；
- 在 Trace 详情中展示、复制，并允许按该 ID 打开已配置的推理详情入口；
- 缺失时明确说明不可获取，不伪造 ID；
- 明确网关 ID 与上游服务 ID 的来源层。

## 2. 支持路径与边界

| 路径 | 响应头来源 | 支持情况 |
| --- | --- | --- |
| OpenCode 1.x → 本地转发网关 | 网关读取上游响应头，写入本地 journal 与响应头 | 支持 |
| OpenCode 2.x → 本地转发网关 | 同上，原生 http hook 读取 `x-agent-insight-upstream-request-id` | 支持 |
| Qoder CN CLI → 本地转发网关 | 网关 journal 由 CLI hook 在 Stop/SessionEnd 时读取 | 支持 |
| OpenCode 直连、未接管 Provider | Agent 可见的 `x-request-id` 响应头 | 仅当 SDK/fetch 暴露响应头且 call ID 可证明归属时支持 |
| Qoder Desktop / JetBrains | 无经过验证的 HTTP 响应头访问 | 不支持；保持原有响应 ID 边界 |
| OTLP/日志型采集器（Claude Code、Codex、Hermes、Langfuse 等） | 框架 telemetry 未暴露原始 HTTP 响应头 | 不支持；需框架先提供属性，再另行适配 |
| 平台内置评测/优化模型调用 | OpenAI SDK 自定义 fetch 可获取响应头，但不产生用户 Trace/LLM 节点 | 本 issue 不进入 Trace 存储；边界记录在此 |

流式调用在收到响应头后立即落盘，不等待流结束。4xx/5xx、超时、用户取消若已收到响应头，仍保留真实 ID 与调用状态。

## 3. 字段与关联契约

### 3.1 网关本地 journal

路径保持 `$AGENT_INSIGHT_HOME/inference-gateway/<账号摘要>/<agent>/<会话摘要>/<call_id>.json`。每条记录在当前字段外新增：

```json
{
  "call_id": "<网关生成的 UUID，仍作为本地调用主键>",
  "upstream_request_id": "<服务响应头原值，可选>",
  "upstream_request_id_header": "x-request-id",
  "state": "started | completed | cancelled | timeout | stream_error | transport_error",
  "status_code": 200
}
```

- 不保存认证、Cookie 或其他响应头。
- 重复的同值响应头折叠为一个值；互相冲突的多个值视为不可获取。
- 未收到响应头时字段缺省，不使用 `call_id` 回填。

### 3.2 Trace 交互元数据

沿用 `Session.interactions` JSON，不新增数据库表：

```ts
inference_upstream_request_ids?: Array<{
  call_id: string;   // 已证明归属的本地调用 ID
  request_id: string; // 服务响应头原值
  source?: string;    // 当前为 "model-response-header"
}>;

inference_attempts[].upstream_request_id?: string;
inference_unassigned_calls[].upstream_request_id?: string;
```

关联规则：

- 只有已建立 `call_id` 归属的 LLM 才能挂载服务 ID；无法证明归属时仅进入 Trace 级 `inference_unassigned_calls`。
- 多轮、重试、并发与父子 Agent 调用各自按 `call_id` 保存，不覆盖、不按时间推断。
- 同一调用允许多个尝试各自带服务 ID；页面逐次展示。
- 前端提交后 ID 进入现有 interactions JSON，异步上传、补传、刷新与服务重启后保持可读；历史 Trace 无字段时继续正常展示。

## 4. 展示与推理详情入口

- LLM 节点详情：唯一服务 ID 直接展示并复制；多个 ID 显示次数并引导到「推理分析」逐次查看；存在调用但没有服务 ID 时显示“未提供”。
- 「推理分析」弹窗：每次尝试同时展示网关调用 ID 与服务 Request ID；缺失时明确说明。保留现有 `GlobalTrackNO=<call_id>` 链接，另提供服务 ID 链接 `/model-performance?GlobalTrackNO=<upstream_request_id>`，由同一 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 配置控制。
- ID 作为 URL 参数编码；未配置、配置无效或无 ID 时不生成链接，不泄露其他用户数据。

## 5. 测试与验收

- 网关：大小写不敏感读取、与 `call_id` 区分、缺失不伪造、错误/流式取消保留、冲突重复头不可用。
- OpenCode：journal → attempt → interaction → LLM 节点 → 推理分析目标全链路；上传指纹包含新字段。
- Qoder：journal → OTLP 属性 → adapter → LLM 节点；无法归属时仅 Trace 级。
- 存储：上传、SQLite 保存、`/api/observe/session` 投影后字段保持。
- UI：展示、复制、服务 ID 链接编码、缺失提示。

真实服务端到端验收需在具备网关与推理详情入口的环境中执行，并记录服务与 SDK/采集器版本；本仓库自动化测试不替代该验收。
