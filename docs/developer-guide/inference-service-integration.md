# 推理服务模型调用 ID 接入说明

Agent Insight 会在经我们入口转发的模型请求中携带统一的调用 ID。请推理服务将这个 ID 与本次请求的推理记录绑定，后续平台即可按 ID 打开对应分析页面。Qoder、OpenCode 及不同模型均使用同一字段，推理侧无需按 Agent 分别适配。

## 1. 我们发送什么

| 项目 | 约定 |
| --- | --- |
| HTTP 请求头 | `X-Agent-Insight-Call-Id`，请求头名称大小写不敏感 |
| 值 | UUID v4 字符串，36 个字符，例如 `33a79f06-9821-4e5e-8db4-1e1e809df41c` |
| 生成方 | Agent Insight 本地转发入口，在发送模型请求前生成 |
| 粒度 | 每次经过入口的实际模型 HTTP 请求一个新 ID；客户端重试使用新 ID |
| 适用请求 | OpenAI 兼容的 `/chat/completions`、`/responses`，Anthropic 兼容的 `/messages` 模型 POST；流式与非流式相同 |

以下为请求示例，模型名、鉴权方式和请求体继续遵循推理服务原有协议：

```http
POST /v1/chat/completions HTTP/1.1
Content-Type: application/json
Authorization: Bearer <existing-token>
X-Agent-Insight-Call-Id: 33a79f06-9821-4e5e-8db4-1e1e809df41c

{"model":"your-model","messages":[{"role":"user","content":"ping"}],"stream":true}
```

该 ID 不写入 prompt 或模型请求体，也不是平台 Trace ID、Agent session ID、模型响应 ID、鉴权凭证或幂等键。模型列表等非推理请求不生成此 ID。

## 2. 推理服务需要做什么

1. **在统一模型入口读取请求头**：尽早读取并建立请求记录，覆盖校验、排队和执行阶段。前置反向代理、模型路由及执行进程之间应保留该值或传递等价的请求上下文。
2. **原样保存并绑定推理记录**：可新增索引字段 `agent_insight_call_id`，关联服务自身的 request ID、日志和分析数据。存储字段名由推理侧决定，HTTP 请求头名称按上述约定固定。查询仍遵循现有账号和访问权限。
3. **覆盖成功、失败和中断**：只要请求已到达接入入口，4xx、5xx、超时或流式中断记录也应保留这个 ID。具体失败分析页面如何展示由推理侧决定。请求未到达推理服务时，推理侧自然没有对应记录。
4. **支持按 ID 打开分析页**：提供 `/model-performance?GlobalTrackNO=<call_id>`，`GlobalTrackNO` 每次只接收一个完整调用 ID。成功和失败请求均通过这一入口查询。

推理服务内部发生重试或拆分执行时，保留同一个外部调用 ID，并用自身的子请求 ID 区分内部尝试。不要把外部调用 ID 当作业务幂等键。没有该请求头的其他客户端请求继续按原有方式处理。

响应继续遵循原模型协议，正常返回原生响应 ID，保证不同响应可区分、同一响应的 response/message ID 在 SSE 流中保持一致；无需将响应 ID 改成我们的调用 ID。也无需新增响应头回传：Agent Insight 转发入口会在返回 Agent 时补上同值的 `X-Agent-Insight-Call-Id`。

## 3. 我们如何关联 Trace

Agent Insight 在本地保存“调用 ID ↔ Agent 会话与消息”的关联记录，再随采集数据上传到平台，写入对应 LLM 节点的 `inference_call_ids`。这部分由我们完成，推理服务只需要维护“调用 ID ↔ 推理记录”。

| 平台入口 | 后续交给推理分析服务的查询条件 |
| --- | --- |
| 单个 LLM 节点 | 默认打开可唯一确定的最近一次请求；重试的其他调用也可逐条打开，每个链接只传一个 ID |
| 整条 Trace | 平台列出全部模型请求及未归属请求，每条分别生成单个 ID 的链接 |

例如：Trace T 中，节点 A 对应 C1，节点 B 首次失败与重试分别对应 C2、C3。节点 B 的默认链接对应最近一次请求 C3，失败请求 C2 也有独立链接；整体入口列出 C1、C2、C3，逐条打开。这里 C1 等只是示意，实际传递完整 UUID，不能逗号拼接或重复 GlobalTrackNO 参数。

目前 Qoder 缺少真实响应 ID 的失败尝试可能只能关联整条 Trace，不能精确归属 LLM 节点；它们仍使用同一请求头、同一查询方式。推理侧无需为此增加 Qoder 专用处理逻辑。

## 4. 联调验收

- 不同 Agent、模型和模型协议均能通过 `X-Agent-Insight-Call-Id` 查询到对应记录。
- 连续调用及并发调用的 ID 不同；流式响应期间保留同一个调用 ID。
- 首次返回 503、客户端重试成功时，两次请求分别携带不同 ID，失败与成功记录均可查询。
- 推理记录保存的 ID，与 Agent Insight Trace / LLM 节点中的 ID 完全一致。

平台运行时环境变量 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 配置分析服务的协议、主机和端口，例如 `http://inference.example.com:8080`，重启后生效。平台自动拼接 `/model-performance` 与经过 URL 编码的 `GlobalTrackNO`，浏览器在新标签页访问；页面登录与权限由推理服务负责。
