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

普通交互版 setup 和 auto setup 都支持选择 CodeAgent。setup 不修改 CodeAgent 源码，而是在 `~/.agent-insight/codeagent_otel_env.sh`（PowerShell 为 `codeagent_otel_env.ps1`）安装同名 `codeagent` 启动函数，并通过 shell profile 持久加载。重启终端后继续使用原来的 `codeagent` 命令即可，函数只为 CodeAgent 子进程注入 OTel 配置。

CodeAgent 当前会同时发出 Logs、Traces 和 Metrics，且内部配置会覆盖常规 exporter 关闭变量。Agent Insight 因此只把 `service.name=CodeAgentOC` 的 Logs 写入 `~/.agent-insight/otel_data/codeagent` 并聚合为 `framework=codeagent`；同来源的 Traces/Metrics 返回成功后直接丢弃，不写 trace spool、InfraSource 或指标样本。Skill 调用会映射为标准 `skill` 事件；`Agent`/`Task` 调用会映射为 `task`，用于生成子 Agent Trace 和按节点隔离 Skill。
