---
title: "运行观测"
description: "链路追踪、智能诊断与质量监控总览"
---

# 运行观测

运行观测用于还原 Agent 在真实环境中的执行事实，并支撑问题定位、样本筛选与后续分析。其核心关注点包括：一次执行具体发生了什么、异常更可能出在哪里、哪些样本值得继续沉淀，以及推理基础设施是否参与了异常。

> **Note**
> 如果 Agent 管理回答的是“有哪些资产”，那么运行观测回答的是“这些资产最近实际运行得如何”。

## 核心作用

- 确认真实执行是否已进入平台并生成 Trace
- 回看失败、变慢或结果偏差的完整执行链路
- 判断问题更接近模型、工具、Skill 还是流程编排
- 关联推理 infra 指标，判断是否存在排队、KV cache、decode 延迟等瓶颈
- 从线上执行中筛选高价值样本，沉淀为后续评测与优化输入

## 页面构成

### 链路追踪

链路追踪是运行观测的主入口，用于查看一次执行从入口到结束的完整 Trace。适合完成样本筛选、过程还原与关键节点定位，是多数分析动作的起点。

对应文档： [链路追踪](./view-traces)

### 智能诊断

智能诊断基于 Trace 上下文对失败、异常或效果偏差样本做归因分析，输出问题类型、证据节点与建议方向。它更适合作为 Trace 阅读之后的辅助判断层，而不是替代原始执行事实。

对应文档： [智能诊断](./diagnosis)

### 质量监控

质量监控面向趋势观察与持续巡检，但当前页面暂未开放使用。现阶段如需查看执行细节或定位异常，仍以链路追踪和智能诊断为主要路径。

对应文档： [质量监控](./quality-monitoring)

### 推理 Infra

推理 Infra 用于登记和观测 vLLM / OpenAI 兼容推理服务的 Prometheus 或 OTLP 指标。平台会把执行记录中的真实 endpoint 与已注册 infra 源关联，在 Trace 详情的 Infra tab 中展示 session 时间窗内的诊断结论、瓶颈类型和指标曲线。

## 推荐使用顺序

大多数问题可按以下顺序处理：

1. 先在链路追踪里找到异常执行
2. 进入详情看 Trace、Span 和上下文
3. 如果怀疑是推理服务慢或不可用，查看 Trace 详情里的 Infra tab 或进入推理 Infra 页面
4. 对失败或偏差样本使用智能诊断
5. 对重复出现或高价值样本沉淀为评测数据集或优化输入

## 运行观测和评测中心有什么区别

这两个模块经常配合使用，但职责边界不同：

- **运行观测**：看真实线上执行发生了什么
- **评测中心**：把问题转成可重复、可回归的离线验证

前者偏向发现与还原问题，后者偏向验证与回归问题。

## 下一步

- 查看单次执行细节： [链路追踪](./view-traces)
- 查看异常样本归因： [智能诊断](./diagnosis)
- 了解趋势能力当前状态： [质量监控](./quality-monitoring)
- 将线上问题沉淀为回归验证： [评测中心](../evaluation/index)

## Hermes 接入

安装指导页下发的普通交互版 setup 和 auto setup 都支持选择 Hermes。选择后脚本会从 Agent Insight 服务下载固定版本的轻量插件到 `$HERMES_HOME/plugins/agent_insight_hermes/`（未设置 `HERMES_HOME` 时默认为 `~/.hermes`），写入 `plugin.yaml` 与 `config.json`，然后启用 `agent_insight_hermes`。该插件只使用 Python 标准库，不需要访问 GitHub、探测 Hermes venv 或额外安装 OpenTelemetry Python 依赖。setup 不会启用、禁用或改写其他 Hermes 插件；上游 `hermes_otel` 可以继续用于 Langfuse 等独立目的。若两个插件都被配置为向同一个 Agent Insight 端点上报，同一轮对话可能产生重复 telemetry，需要由用户自行调整其中一个插件的 endpoint 或启用状态。

Hermes 插件会把 hook 数据编码为标准 OTLP/HTTP JSON，并直接上报到平台 `/api/ingest/otel/v1/traces`。它优先采集每次 API 调用的真实 assistant content，工具结果最多保留 200000 字符并附带截断元数据；subagent start/stop hook 会把 parent、root、child session 关系编码到同一 trace。插件按已完成 span 发送 delta payload；平台从服务端 session spool 重读已收到的全部 span，继续按 span tree 生成用户输入、工具步骤、中间 LLM 回复和最终回复。

插件不会只把待发送数据放在内存里。每个已完成 span 的 delta payload 先写入 `~/.agent-insight/data/hermes-otel-spool/`，上传成功后删除；断网、HTTP 408/429/5xx 会自动退避重试，进程重启后也会继续发送残留 delta 文件。运行日志位于 `~/.agent-insight/logs/hermes-plugin.log`，滚动文件为同目录下的 `hermes-plugin.log.1`。日志不记录 API key 或对话正文。

## CodeAgent 接入

普通交互版 setup 和 auto setup 都支持选择 CodeAgent。setup 不修改 CodeAgent 源码：Unix 安装 `~/.agent-insight/bin/codeagent`，并由 `codeagent_otel_env.sh` 通过 shell profile 将该目录放到 PATH 前面；Windows 安装 `%USERPROFILE%\.agent-insight\bin\codeagent.cmd` 和 `codeagent-wrapper.ps1`，同时把该目录置于用户级 PATH 前面，`codeagent_otel_env.ps1` 负责刷新当前 PowerShell 会话并清理旧 Alias/函数。两端包装器每次都会排除自身目录查找当前环境中的真实 CodeAgent，找不到时回退到安装时记录的路径，只为 CodeAgent 子进程注入 OTel 配置。重启终端或加载环境脚本后仍使用原来的 `codeagent` 命令；Shell、PowerShell、CMD、Python、Node 等继承 PATH 的子脚本都会经过包装器。cron、systemd、容器、Windows 服务等不继承用户 PATH 的独立环境需显式加入对应 `~/.agent-insight/bin` 目录或直接调用包装器。

CodeAgent 当前会同时发出 Logs、Traces 和 Metrics，且内部配置会覆盖常规 exporter 关闭变量。Agent Insight 因此只把 `service.name=CodeAgentOC` 的 Logs 写入 `~/.agent-insight/otel_data/codeagent` 并聚合为 `framework=codeagent`；同来源的 Traces/Metrics 返回成功后直接丢弃，不写 trace spool、InfraSource 或指标样本。Skill 调用会映射为标准 `skill` 事件；`Agent`/`Task` 调用会映射为 `task`，用于生成子 Agent Trace 和按节点隔离 Skill。CodeAgent 在主回答结束后发起的 `extract_memories` 和 `auto_dream` 内部记忆维护仍保留在原始 Logs spool 中，但不会进入用户 Trace 的调用树、耗时及 Token/LLM/工具统计。

## LlamaIndex 接入

完整的安装、配置、代码注册、spool、故障排查和卸载说明见
[LlamaIndex Trace Collector 接入指南](./llamaindex-trace-collector)。

LlamaIndex 项目使用由 Agent Insight 服务端直接分发的 Python 模块 `agent_insight_llamaindex`。运行时信息来自 LlamaIndex instrumentation dispatcher；该模块注册自定义 Span/Event Handler，并继承官方 `llama-index-observability-otel` 的 Handler 基类，复用 OTel Span 生命周期、上下文传播、父子关系和状态管理，再补充 Agent Insight 所需的 Agent、子 Agent、Tool、LLM、Retriever、Synthesizer 和 Workflow 语义。它不会同时注册官方默认 Handler，因此不会重复产生 Span。插件使用持久化 spool 与后台上传线程，支持进程重启续传、事件/定时上传及指数退避，不在业务调用线程执行网络请求。

“安装指导”页面把 `LlamaIndex` 与其他框架放在同一选择器中；勾选后直接运行页面生成的 `curl ... | bash` 或 `irm ... | iex` 一行命令，页面本身不要求填写 Python 环境。普通 setup 脚本开始执行后再询问是否使用虚拟环境，直接回车默认使用全局 `python3`/`python`；选择虚拟环境后输入根目录，脚本自动选择 Linux/macOS 的 `bin/python` 或 Windows 的 `Scripts/python.exe`。auto setup 保持非交互，未预设环境时默认使用全局 Python。普通 setup 和 auto setup 的 Linux/Windows 安装选择均支持该采集器。安装器先在所选环境中安装 `llama-index-observability-otel==0.6.4`，再从当前 Agent Insight 实例下载运行时归档并直接部署到 `~/.agent-insight/collectors/llamaindex/current/`。Agent Insight 模块本身不写入 `site-packages`。安装器还会保存最终解释器路径并生成卸载脚本。自动部署或手写命令也可通过 `AGENT_INSIGHT_LLAMAINDEX_VENV` 指定虚拟环境根目录，或用 `AGENT_INSIGHT_LLAMAINDEX_PYTHON` 直接指定解释器。npm 负责安装 Agent Insight 服务端并携带采集器源码。

该运行时 zip 不是可执行 `pip install` 的 Python 发布包，并有意不包含 `pyproject.toml`。采集器由安装指导脚本直接部署和更新；只有官方 OTel 集成及其 SDK 依赖由脚本通过 pip 安装。LlamaIndex、模型 SDK 与 MCP Tool 等业务依赖仍由项目自己的 Python 环境管理。卸载脚本不会删除共享的官方 OTel 包，以免影响同环境中的其他应用。

采集器为每个 Workflow Context 和 Agent 名称生成实例 ID，同名并发 Agent 不会在 Trace 树中合并。`python -m agent_insight_llamaindex.cli run` 默认读取 `~/.agent-insight/llamaindex.env` 中的模型变量，但不会覆盖调用进程已经设置的值。

LlamaIndex、模型 SDK 和 MCP Tool 依赖继续由业务项目管理。FunctionTool、QueryEngineTool 与由 `McpToolSpec` 创建的 MCP Tool 均沿同一 Tool Trace 路径采集参数、返回值、状态和耗时。

运行时的数据路径是：LlamaIndex dispatcher 发出 Span 生命周期回调和原始 Event；自定义 Handler 对同一次回调先调用官方 OTel 基类创建 Span/context，再读取原始 Event、参数和返回值补充 Agent Insight 语义；自定义 exporter 将结束的 Span 非阻塞送入有界队列，后台线程再写入按 API Key 隔离的 spool 并上传。Agent Insight 接收 OTLP 后由 LlamaIndex Adapter 合并会话、去除同一逻辑 LLM 调用的包装 Span，并生成统一 ExecutionRecord。独立 Retriever 或 LLM 调用不会为了展示而伪造 Agent 根节点；它们保留真实 OTel 根节点，并以 traceId 作为缺省 sessionId。

接入后可先执行 `python -m agent_insight_llamaindex.cli status` 检查 endpoint、账号隔离目录和待上传批次，再运行一个包含真实 LLM 与 Tool 的任务并在“链路追踪”页核对 model、Token、耗时和父子关系。Provider 未返回 usage 时 Token 可能为 0，这不代表 Span 未采集。

需要开始接入时，直接阅读 [LlamaIndex Trace Collector 接入指南](./llamaindex-trace-collector)；该文档同时作为安装器运行时 ZIP 中的 `README.md`，项目文档与离线安装说明使用同一内容源。
