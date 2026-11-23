## 问题

模型服务常在自己的 HTTP 响应头返回 `X-Request-Id`，推理平台按该值保存推理记录。现有链路只使用本地转发网关为每次尝试生成的 UUID，导致用户拿到服务侧真实 ID 后无法在 Trace 中定位对应 LLM 调用，也无法直接打开推理详情。

本 PR 在不改变平台 Trace/Span 主键、不新增数据库表的前提下，采集模型服务响应头 ID，按实际调用尝试关联 Trace 与 LLM 节点，并在详情中展示、复制和跳转。

Closes #390

## 修改

- **网关**：读取上游响应头 `X-Request-Id`（大小写不敏感），保留服务端原值；收到响应头即写入 journal，覆盖流式、错误、超时和取消场景。网关本地调用 ID 仍作为 `X-Request-Id` 返回给 Agent，服务 ID 通过内部头 `x-agent-insight-upstream-request-id` 单独转发，并剥离上游伪造的 `x-agent-insight-*` 响应头。
- **重复头**：使用 Node `headersDistinct` 区分重复头与值内逗号；同值重复折叠，冲突值按不可获取处理，不猜测。
- **OpenCode 1.x/2.x**：V1 fetch 与 V2 原生 http hook 读取网关中继头；直连模式下仅在能证明 call ID 归属时读取 `x-request-id`。`upstream_request_id` 随 attempt 进入上传 payload。
- **Qoder CN CLI**：网关 journal 的服务 ID 进入 OTLP 属性；已归属的写入 `agent_insight.inference.upstream_request_ids`，无法归属的保留在 Trace 级未分配调用。
- **存储与类型**：交互 JSON 新增 `inference_upstream_request_ids`、attempt/unassigned 的 `upstream_request_id`；Qoder adapter 解析并过滤非字符串归属，不新增 Prisma 模型或迁移。
- **关联规则**：服务 ID 只挂到已证明归属的 `call_id`，不跨 LLM 分配；多轮、重试、并发和子 Agent 调用按尝试独立保留。
- **Trace 详情**：LLM 节点展示并复制唯一服务 ID；多个 ID 显示数量并引导到“推理分析”；无 ID 时明确显示“未提供”。
- **推理分析**：每次尝试同时展示网关调用 ID 与服务 Request ID，新增按服务 ID 的 `/model-performance?GlobalTrackNO=<ID>` 链接（URL 编码），沿用 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN`；复制 JSON 包含 `upstream_request_ids`。
- **文档**：更新中英文推理关联契约、接入指南和 Trace 查看说明；新增设计文档与设计索引。

## 支持边界

| 路径 | 支持情况 |
| --- | --- |
| OpenCode 1.x/2.x → 本地网关 | 支持 |
| Qoder CN CLI → 本地网关 | 支持 |
| OpenCode 直连、未接管 Provider | 仅当响应头可见且归属可证明 |
| Qoder Desktop / JetBrains | 不支持（无已验证响应头访问路径） |
| OTLP/日志型采集器（Claude Code、Codex、Hermes、Langfuse 等） | 不支持（框架 telemetry 未暴露原始响应头） |
| 平台内置评测/优化调用 | 不进入用户 Trace 存储 |

缺失、冲突或响应头未到达时不生成链接、不用调用 ID/Trace ID 回填；已经收到响应头后的错误与取消仍保留真实 ID 和调用状态。

## 验证

- `node --import tsx --test test/inference-correlation.test.ts test/inference-analysis.test.ts test/inference-storage.test.ts`：77/77 通过，覆盖网关分离/缺失/错误与流式取消/重复冲突头、OpenCode 与 Qoder 归属、上传与 SQLite 投影、UI 展示和链接。
- `node --check` 通过：`scripts/inference_gateway.mjs`、`scripts/opencode_uploader_client.js`、`scripts/qoder_trace_collector.mjs`。
- 对修改的 TypeScript 文件执行定向 `tsc --noEmit`，无新增类型错误；全项目 typecheck 受当前环境 Next 类型文件不完整影响未完成。
- 未启动 dev server，未做真实模型服务端到端浏览器验收；该验收需在具备网关与推理详情入口的环境执行。

## 设计文档

- [模型响应头 X-Request-Id 采集与推理详情关联](design/observability/issue-390-model-response-request-id.md)
- [统一推理请求关联契约](docs/zh/reference/observability/inference-correlation.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
