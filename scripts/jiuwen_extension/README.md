# agent-insight observability extension (JiuwenSwarm)

零代码把 **JiuwenSwarm** 接入 agent-insight 观测：装上本扩展 + 配好 `telemetry:`，
之后正常跑 jiuwen，agent / LLM / tool 的 trace 就自动推到 agent-insight，
**不用在业务代码里写任何 `init_observability`**。

这是 OpenCode `curl|bash` 一键接入在 jiuwen 侧的等价物——jiuwen 是产品，提供了
`extensions/` 插件系统和 `config.yaml` 的 `telemetry:` 配置段，本扩展把两者接到
agent-core 内建的 OTLP exporter 上。

## 它做什么

`register_extensions(registry)`（jiuwenswarm `ExtensionLoader` 在 **agentserver**
启动时调用的入口）读取 telemetry 配置 → 设置 `OTEL_EXPORTER_OTLP_*_HEADERS`
环境变量（携带 `x-witty-api-key` 做 user 归属）→ 调一次
`init_observability(ObservabilityConfig(exporter="otlp_http", endpoint=..., service_name="jiuwenswarm"))`，
把 OTLP exporter + callback handler 挂到 `Runner.callback_framework`。

新版 SDK 还通过 `openjiuwen.harness.observability.acquire_observability` 启用单 Agent 的
root span；只初始化 exporter 不会让新版单 Agent 产生 Trace。扩展按 API 能力检测，
没有该接口的旧 SDK 保留原初始化路径，无需额外修改 `agent_observability.enabled`。

> 为什么是 `register_extensions` 而不是 `initialize`：jiuwenswarm 的 loader 只调用
> 模块级 `register_extensions`，从不调 `BaseExtension.initialize`。

## 安装（手动；自动化见 `/api/ingest/setup`）

1. 把本目录拷到 jiuwen 工作区的扩展目录：

   ```
   ~/.jiuwenswarm/extensions/agent-insight-observability/{extension.yaml,extension.py}
   ```

2. 在 `~/.jiuwenswarm/config/config.yaml` 注册扩展搜索目录 + 填 telemetry：

   ```yaml
   extensions:
     extension_dirs: "~/.jiuwenswarm/extensions"   # ';' 分隔多个

   telemetry:
     enabled: true
     exporter: otlp
     protocol: http
     endpoint: http://<agent-insight-host>:3000/api/ingest/otel/v1/traces
     service_name: jiuwenswarm
     headers:
       x-witty-api-key: <your-api-key>
   ```

   或用环境变量（写进 `~/.jiuwenswarm/config/.env`，优先级更高）：

   ```
   OTEL_ENABLED=true
   AGENT_INSIGHT_OTLP_ENDPOINT=http://<host>:3000/api/ingest/otel/v1/traces
   AGENT_INSIGHT_API_KEY=<your-api-key>
   ```

3. 重启 jiuwen（`jiuwenswarm-app` / agentserver）。启动日志应出现
   `[agent-insight-observability] 已接入 ...`。

## 依赖

需要 `opentelemetry-exporter-otlp-proto-http`——jiuwenswarm 的 pyproject 已声明，
通常无需额外安装。`extension.yaml` 的 `dependencies` 故意留空，避免 loader 在产品
进程里同步 pip-install。

## 新旧 Span 契约

服务端同时识别旧版 `llm.call` / `tool.*` 和新版 `chat <model>` / `execute_tool <name>`。
新版读取结构化 `gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.tool.call.*` 及
`gen_ai.usage.input_tokens` / `output_tokens`，保留工具参数、结果、失败状态和每次调用的用量。
独立 reasoning / context event Span 不重复计为模型调用或 Token。工具与模型调用通过明确父链
或相同 tool-call ID 关联；缺少关联证据时保留独立工具事件。新版单 Agent 的 task-iteration
边界不会被当作团队标记，带 `openjiuwen.trace.complete=true` 的 root span 作为明确完成信号。

## 鉴权细节

agent-core 的 `ObservabilityConfig` 没有通用 `headers` 字段，但它构造 OTLP http
exporter 时传空 dict，底层 `OTLPSpanExporter` 会回退读 `OTEL_EXPORTER_OTLP_TRACES_HEADERS`
环境变量——本扩展据此注入 `x-witty-api-key`，服务端 route 解析为 user 归属。

## 源（source of truth）

`agent-insight` 仓库 `scripts/jiuwen_extension/`。`/api/ingest/setup` 据此分发安装
（与 OpenCode 插件同一套路）。改这里后要同步到已安装副本。
