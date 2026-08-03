# LlamaIndex Trace 采集器：Phase 1 需求分析

## 1. 目标

为 LlamaIndex Python 应用提供低侵入 Trace 采集器，覆盖 Agent、子 Agent、Tool、LLM、RAG 与 Workflow，并可靠上报至 Agent Insight。采集基线复用官方 `llama-index-observability-otel==0.6.4`；已验证的业务环境为 `llama-index-core 0.14.23`、`llama-index-instrumentation 0.5.0`、`llama-index-workflows 2.22.2`，同时以能力探测兼容相邻版本。

## 2. 功能需求

| 编号 | 能力 | 验收口径 |
|-|-|-|
| FR-001 | Agent 会话 | 记录 sessionId、用户查询、Agent/模型、Token、延迟、结果与状态 |
| FR-002 | 子 Agent | 按真实 span 父子关系记录名称、任务、状态、Token；多级与并发不串线 |
| FR-003 | Tool/Skill | FunctionTool、QueryEngineTool、MCP Tool 均记录名称、参数、耗时、结果和错误 |
| FR-004 | LLM | Chat/Completion 记录 provider/model、输入输出 Token、耗时与截断后的内容 |
| FR-005 | RAG | Retriever 记录 query、节点来源和 score；Synthesizer 记录 query 与结果 |
| FR-006 | Workflow | 记录 workflow run 与 step 名称、输入/输出、耗时和状态 |
| FR-007 | 可靠上传 | 持久化 spool、后台上传、时间/容量/flush 触发、重启续传、指数退避和抖动 |
| FR-008 | 安装 | Agent Insight 服务端由 npm 安装并携带采集器源码；setup API 将 Python 采集器直接部署到 Agent Insight 专属目录；CLI 支持配置、自检和零代码启动 |
| FR-009 | 卸载 | 专属卸载脚本删除采集器源码与环境入口；可选 purge 显式清理运行时 spool/config，避免默认丢数据 |
| FR-010 | 性能 | 用户线程不做网络 I/O；队列、内容与磁盘均有上限；采集异常不影响业务 |

## 3. 事实与约束

- LlamaIndex 当前 instrumentation 同时提供全局 Dispatcher 和基于 ContextVar 的活动 Span 上下文；官方 `llama-index-observability-otel` 提供 `LlamaIndexOpenTelemetry`、`OTelCompatibleSpanHandler` 和 `OTelCompatibleEventHandler`。采集器应继承这些官方实现，不自行维护线程全局父栈。
- LLM、Retrieval、Synthesis 有明确 start/end instrumentation event；Workflow run/step 由 dispatcher span 包裹；Agent workflow 的 AgentInput、AgentOutput、ToolCall、ToolCallResult 可从 step span 的参数与结果提取。
- MCP 工具最终以 LlamaIndex Tool 接口进入 Agent 的 `call_tool` step，因此以工具协议能力识别，不依赖具体工具类。
- 平台已提供 OTLP/HTTP JSON/protobuf 接口、服务端 spool/consumer、Execution/Session 存储和 Agent Trace 树，禁止复制另一套摄入协议。
- Python 模块名为 `agent_insight_llamaindex`。服务端提供直接部署的运行时归档，不发布 Python 包；彻底清理由 LlamaIndex 专属卸载脚本完成。

## 4. 非目标

- 不修改 LlamaIndex 源码，不 monkey-patch Agent、Tool、Retriever 或 Workflow 类。
- 不新增 Prisma 字段；仅新增只读的内置采集器 zip 下载路由，不新增摄入协议。
- 不在采集器中实现评价、成本定价或模型调用代理。
- 不默认采集完整敏感内容；所有内容字段按配置截断，并支持完全关闭内容采集。

## 5. 风险

- 相邻 LlamaIndex 版本的事件字段可能变化：使用 duck typing、能力探测与序列化兜底。
- start/end event 可能缺一侧：以 dispatcher span exit/drop 为权威生命周期，事件只做语义富化。
- 用户进程崩溃导致内存队列未落盘：后台 writer 高频批量落盘；显式 `flush()`/`shutdown()` 与 atexit 尽力清空，但不承诺捕获 SIGKILL 前的内存事件。
- 服务端通用 normalizer 当前会把 agent/chain 降为 llm：为 `service.name=llamaindex` 增加专用 normalizer 和 adapter。

## 6. 验收范围

单测覆盖序列化、父子关系、并发、截断、spool 恢复、重试、配置和卸载；集成测试覆盖 ReActAgent/AgentWorkflow、并发 Tool、RAG、Workflow 和 OTLP 服务端映射；性能测试验证采集关闭与开启的增量开销和队列饱和降级。标准化验收用例还必须在运行结果中记录采集器版本、官方 OTel 版本、Handler 类型和 exporter 类型，防止测试误用旧版回调实现。
