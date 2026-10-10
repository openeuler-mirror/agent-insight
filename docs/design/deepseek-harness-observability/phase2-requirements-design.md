# DeepSeek Harness 观测接入需求设计

## 总体架构

```text
Harness Session Event
  -> 官方 Session Telemetry OTLP/HTTP Logs
  -> Agent Insight bundle（脱敏、截断、认证配置）
  -> /api/ingest/otel/v1/logs
  -> Harness 原始事件解析与专用 spool
  -> Harness 聚合器
  -> ExecutionRecord / Trace / Skill / Evaluation
```

客户端 bundle 只覆盖官方 `session-telemetry-otel` 行并挂载 `session-telemetry/record` 策略。事件的产生、顺序和生命周期仍由 Harness 官方实现负责。

## 摄入契约

使用以下信号识别 Harness：

- Resource `service.name=deepseek-harness`；
- instrumentation scope `@deepseek-ai/dsh-session-telemetry-otel` 或其 `/ops` 子 scope。

Ledger 事件保存为：

```ts
type DeepSeekHarnessOtelEvent = {
  receivedAt: string
  eventTimestamp: string
  sessionId: string
  eventType: string
  sequence: number
  body: unknown
  attributes: Record<string, unknown>
  resource: Record<string, unknown>
  scope: { name?: string; version?: string }
  user: string
}
```

服务端先从原始 OTLP payload 中分离 Harness Resource，再解析 Harness 事件。不能先经过 Claude normalizer。Harness Resource 必须携带可解析的 `x-witty-api-key`；其他框架维持原有兼容策略。

## 聚合规则

- 按 `sequence` 排序，并以 `(sessionId, sequence)` 去重；重载产生的同序事件采用最后收到的副本。
- `request/header` 提取 model；正文仍保留在原始 spool，不默认显示完整 system/tool schema。
- `user/message` 仅把 `source.kind=user` 作为任务 query，注入型上下文仍可进入 Trace 但不覆盖 query。
- `assistant/message` 生成 assistant interaction，并累计 input/output/reasoning/cache usage。
- `tool/call` 与 `tool/result` 通过 `callId` 配对；失败状态由 result block、error 字段共同决定。
- `tool/call name=skill` 使用 arguments 中的 `name` 作为 Skill 名称。
- `turn/end` 记录完成、取消、阻塞、max-tokens 或 error 结果。
- 未识别事件继续保留在 spool，不阻断标准投影。

聚合器输出 `session_merge_strategy=snapshot-replace`，因为每次都从完整 spool 重建同一 Session 的确定性快照。

## 子 Session

子 Session 以自己的 `session.id` 成为独立 Execution。`session.parent_id` 和 `session.seed_length` 保留在聚合结果中，`subagent/descriptor` 提供子 Agent label/preset。父子 Execution 的最终关联复用平台现有 Agent Tree 语义；一期不复制父 Session 的继承前缀。

## 客户端插件文件

插件包含：

- `cordis.patch.yml`：把官方 telemetry 设为 `FULL`，配置 Agent Insight Logs URL、`x-witty-api-key`、gzip 和有界批处理参数；
- `index.js`：注册同步、无网络的 `session-telemetry/record` waterfall，递归脱敏并截断字符串；
- `package.json`：声明 `dsh.bundle`，可用 `dsh plugin --profile <name> add <path>` 安装。

配置只引用 `AGENT_INSIGHT_BASE_URL` 与 `AGENT_INSIGHT_API_KEY` 环境变量；`dsh --dump-config` 不应展开 secret。

## 安装入口

新增专用 setup API，返回 macOS/Linux shell installer。安装器分别下载三个白名单文件到临时目录，逐一校验 SHA-256 后写入 `~/.agent-insight/deepseek-harness/<source-digest>`，然后安装到 `headless` 与 `web` profile。客户端不依赖 ZIP 或 `unzip`，重复执行应幂等。

## 可靠性边界

Harness 官方 OTel backend 是 best-effort。HTTP 200 表示已接受写入 spool，不表示已经生成 Execution。服务端 consumer 负责稍后聚合；客户端崩溃前未发出的队列一期不补传。
