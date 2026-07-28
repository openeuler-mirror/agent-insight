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

## Qoder CN 产品家族接入

四种产品形态使用同一套 OTLP Trace 结构，但安装入口和 spool 相互隔离。CLI、Desktop、JetBrains 和 Work 的数据统一位于 `~/.agent-insight/otel_data/qoder/<product>/<api-key-hash>/`。切换 API Key 后会自动使用新的摘要子目录，不会混用不同产品、不同账号的 pending、retry 或 uploader lock。升级前的 `qoder-{product}` 目录只作为兼容清理目标，不再写入新数据。

在平台的“安装指导”中执行 curl/PowerShell 安装命令，或使用本地制作的 Agent Insight npm 包执行 `npx agent-insight install` 时，可在不影响原有框架选项的前提下勾选 **Qoder CN product family**。安装器会配置 CLI、Desktop、JetBrains 和 Work 的 Hook、运行脚本及上传器。Desktop 的状态栏/Settings 仍需安装本地 VSIX，JetBrains 的 IDE marker 与设置项仍需安装本地 ZIP；这两个界面插件不会从 npm 发布。

### Qoder CN Desktop

从源码构建 VSIX：

```powershell
powershell -ExecutionPolicy Bypass -File integrations/qoder-desktop/build-vsix.ps1
```

在 Qoder CN Desktop 的 Extensions 面板选择 **Install from VSIX**，安装 `integrations/qoder-desktop/build/distributions/agent-insight-qoder-desktop-<version>.vsix`。安装后状态栏出现 `Agent Insight`，Settings 中出现 `Agent Insight Qoder CN Collector`。点击状态栏可配置服务地址和 API Key；API Key 写入扩展 SecretStorage，同时同步给本机采集进程。扩展把用户级 Hook 写入 `~/.qoder-cn/settings.json`，读取 `~/.qoder-cn/cache/projects/.../conversation-history/` 会话记录，并在 Windows 上只读查询 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db` 的精确 Token。通过 `/skill-name` 手动触发的 Skill 会从 Qoder CN transcript 的 slash-command 元数据还原，在 Trace 中显示 Skill 名称、版本、触发方式、参数和结果。扩展停用或 Qoder CN Desktop 退出时，会把尚未结束的活动会话生成最后一份 snapshot，并等待一次强制上传；网络失败时 pending 文件仍保留在 spool，下一次启动继续重试。卸载监视器只清理 Desktop owner 与 `qoder/desktop` spool；CLI、JetBrains、Work 不受影响。

### Qoder CN CLI

在源码目录执行以下命令，把采集器安装到当前用户的 Qoder 配置；`--scope=local` 可改为仅当前项目生效，`--scope=project` 可写入项目共享配置。一个安装实例只选择一种 scope。

```bash
node scripts/qoder_setup.mjs install --host=http://localhost:3000 --api-key=<Agent-Insight-API-Key> --scope=user --product=cli --owner=cli
```

用户级安装写入 `~/.qoder-cn/settings.json`；项目级与本地级安装仍写入项目的 `.qoder/settings.json` 或 `.qoder/settings.local.json`。安装会保留已有 Qoder CN hooks，把采集脚本复制到 `~/.agent-insight/`，并启动异步 uploader。重启 Qoder CN CLI（命令 `qoderclicn`）后执行一次真实会话，事件与待上传 snapshot 会写入 `~/.agent-insight/otel_data/qoder/cli/<api-key-hash>/`；不同 API Key 使用不同子目录。采集内容包括会话输入与结果、模型与可获得的 token、Tool/Skill 调用、错误状态以及多层 Subagent 关系。CLI 的 Agent 工具结果会按真实 `agentId` 还原为子 Agent；多个并发 Agent 在详情页显示为独立子节点，而不只显示 Task 行。CLI 通过 `/skill-name` 激活 Skill 时产生的 `Skill **name** activated.` informational 记录会还原为独立 Skill Span。内容默认截断到 2000 字符，并对 API Key、token、authorization、cookie 和 password 等字段脱敏。

卸载只移除 `agent-insight-qoder` hooks 和 Qoder 专用脚本，不会删除其他框架共用的 Host/API Key。增加 `--purge` 会同时删除全部 Qoder CLI spool：

```bash
node scripts/qoder_setup.mjs uninstall --scope=user --product=cli --owner=cli --purge
```

### Qoder for JetBrains

使用 `integrations/qoder-jetbrains/build-plugin.ps1 -IdeHome <JetBrains-IDE目录>` 构建 ZIP，然后在 JetBrains IDE 的 Plugins 页面选择 **Install Plugin from Disk**。插件安装后显示 Agent Insight 状态栏和设置项，并通过 IDE 进程 marker 将共享 Qoder transcript 标记为 `Qoder for JetBrains`。IDE 关闭、应用服务销毁或插件动态卸载前，插件都会先执行同样的活动会话 snapshot 与强制上传；失败数据继续留在 pending spool。插件动态卸载完成后只移除 `jetbrains` owner、marker、运行目录与 `qoder/jetbrains` spool。

### Qoder Work CN

Qoder Work 使用独立配置目录和安装器：

```bash
node scripts/qoder_work_setup.mjs install
```

安装器读取 `~/.agent-insight/config` 中的 Host/API Key，把 Hook 写入 `~/.qoderworkcn/settings.json`（国际版回退 `~/.qoderwork/settings.json`），运行文件写入 `~/.agent-insight/qoder-work/`。采集内容包括办公任务、文件/终端工具、Skill、LLM、自定义 MCP 和内置连接器。Qoder Work 的懒加载 `qw_mcp_call` 会在平台中还原为真实 MCP 或 `connector__<name>__<tool>` 调用。

```bash
node scripts/qoder_work_setup.mjs uninstall --purge
```

所有形态默认截断正文到 2000 字符，并对 API Key、token、authorization、cookie、password 等字段脱敏。工具耗时通常取 Pre/Post Hook；异步 Hook 时间戳重合时自动回退到 transcript 的真实调用与返回时间，避免短 MCP 调用误显示为 `0ms`。采集器按 `diagnostics/Hook 精确值 > Desktop/JetBrains 本地 SQLite 精确值 > 可见 transcript 估算 > 不可用` 选择 Token 来源。Qoder CN Desktop 自动只读查询 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db`，JetBrains 自动只读查询 `~/.qoder/shared_client/cache/db/local.db`；仅访问 `chat_message` 的会话、请求、模型和 `token_info` 字段，不修改 Qoder 数据。SQLite Schema 是 Qoder 客户端内部接口，版本不兼容、数据库忙或当前 Node 不支持内置 SQLite 时会安全回退。

仅在前两种精确来源都不可用时，才可在 `~/.agent-insight/config` 中显式设置 `AGENT_INSIGHT_QODER_ESTIMATE_VISIBLE_TOKENS=1`，实验性地估算当前轮 transcript 中可见的用户消息、助手输出、工具参数和工具结果。Trace 详情以 `≈` 标识，并记录 `local_visible_transcript`、`visible_transcript` 和 `missing_context=true`。估算不包含客户端隐藏的 system prompt、Rules、Skill/MCP schema、内部推理与被压缩上下文，在真实 Agent 会话中可能严重低估，因此不能用于账单核对，也不会填充执行记录的精确 input/output Token 字段。CLI/Work 未提供 usage 时仍显示不可用，不启用该兜底。
