---
title: "运行观测"
description: "Agent 概览、链路追踪与推理基础设施总览"
---

# 运行观测

运行观测用于还原 Agent 在真实环境中的执行事实，并支撑问题定位、样本筛选与后续分析。其核心关注点包括：一次执行具体发生了什么、异常更可能出在哪里、哪些样本值得继续沉淀，以及推理基础设施是否参与了异常。

> **Note**
> Agent 概览回答“有哪些资产”，链路追踪与推理基础设施回答“这些资产最近实际运行得如何”。

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

### Agent 概览

Agent 概览沿用原 Agent 管理页面，用于查看平台识别到的 Agent，并处理登记、归属与接入信息。

对应文档： [Agent 概览](../agent-management)

### 推理 Infra

推理 Infra 用于登记和观测 vLLM / OpenAI 兼容推理服务的 Prometheus 或 OTLP 指标。平台会把执行记录中的真实 endpoint 与已注册 infra 源关联，在 Trace 详情的 Infra tab 中展示 session 时间窗内的诊断结论、瓶颈类型和指标曲线。

## 推荐使用顺序

大多数问题可按以下顺序处理：

1. 先在链路追踪里找到异常执行
2. 进入详情看 Trace、Span 和上下文
3. 如果怀疑是推理服务慢或不可用，查看 Trace 详情里的 Infra tab 或进入推理 Infra 页面
4. 对失败或偏差样本进入独立的诊断分析模块
5. 对重复出现或高价值样本沉淀为评测数据集或优化输入

## 运行观测和评估与实验有什么区别

这两个模块经常配合使用，但职责边界不同：

- **运行观测**：看真实线上执行发生了什么
- **评估与实验**：把问题转成可重复、可回归的离线验证

前者偏向发现与还原问题，后者偏向验证与回归问题。

## 下一步

- 查看单次执行细节： [链路追踪](./view-traces)
- 查看异常样本归因： [诊断分析](./diagnosis)
- 将线上问题沉淀为回归验证： [评估与实验](../evaluation/index)

## Hermes 接入

客户端安装页下发的普通交互版 setup 和 auto setup 都支持选择 Hermes。选择后脚本会从 Agent Insight 服务下载固定版本的轻量插件到 `$HERMES_HOME/plugins/agent_insight_hermes/`（未设置 `HERMES_HOME` 时默认为 `~/.hermes`），写入 `plugin.yaml` 与 `config.json`，然后启用 `agent_insight_hermes`。该插件只使用 Python 标准库，不需要访问 GitHub、探测 Hermes venv 或额外安装 OpenTelemetry Python 依赖。setup 不会启用、禁用或改写其他 Hermes 插件；上游 `hermes_otel` 可以继续用于 Langfuse 等独立目的。若两个插件都被配置为向同一个 Agent Insight 端点上报，同一轮对话可能产生重复 telemetry，需要由用户自行调整其中一个插件的 endpoint 或启用状态。

Hermes 插件会把 hook 数据编码为标准 OTLP/HTTP JSON，并直接上报到平台 `/api/ingest/otel/v1/traces`。它优先采集每次 API 调用的真实 assistant content，工具结果最多保留 200000 字符并附带截断元数据；subagent start/stop hook 会把 parent、root、child session 关系编码到同一 trace。插件按已完成 span 发送 delta payload；平台从服务端 session spool 重读已收到的全部 span，继续按 span tree 生成用户输入、工具步骤、中间 LLM 回复和最终回复。

插件不会只把待发送数据放在内存里。每个已完成 span 的 delta payload 先写入 `~/.agent-insight/data/hermes-otel-spool/`，上传成功后删除；断网、HTTP 408/429/5xx 会自动退避重试，进程重启后也会继续发送残留 delta 文件。运行日志位于 `~/.agent-insight/logs/hermes-plugin.log`，滚动文件为同目录下的 `hermes-plugin.log.1`。日志不记录 API key 或对话正文。

## CodeAgent 接入

普通交互版 setup 和 auto setup 都支持选择 CodeAgent。setup 不修改 CodeAgent 源码：Unix 安装 `~/.agent-insight/bin/codeagent`，并由 `codeagent_otel_env.sh` 通过 shell profile 将该目录放到 PATH 前面；Windows 安装 `%USERPROFILE%\.agent-insight\bin\codeagent.cmd` 和 `codeagent-wrapper.ps1`，同时把该目录置于用户级 PATH 前面，`codeagent_otel_env.ps1` 负责刷新当前 PowerShell 会话并清理旧 Alias/函数。两端包装器每次都会排除自身目录查找当前环境中的真实 CodeAgent，找不到时回退到安装时记录的路径，只为 CodeAgent 子进程注入 OTel 配置。重启终端或加载环境脚本后仍使用原来的 `codeagent` 命令；Shell、PowerShell、CMD、Python、Node 等继承 PATH 的子脚本都会经过包装器。cron、systemd、容器、Windows 服务等不继承用户 PATH 的独立环境需显式加入对应 `~/.agent-insight/bin` 目录或直接调用包装器。


CodeAgent 当前会同时发出 Logs、Traces 和 Metrics，且内部配置会覆盖常规 exporter 关闭变量。Agent Insight 因此只把 `service.name=CodeAgentOC` 的 Logs 写入 `~/.agent-insight/otel_data/codeagent` 并聚合为 `framework=codeagent`；同来源的 Traces/Metrics 返回成功后直接丢弃，不写 trace spool、InfraSource 或指标样本。Skill 调用会映射为标准 `skill` 事件；`Agent`/`Task` 调用会映射为 `task`，用于生成子 Agent Trace 和按节点隔离 Skill。CodeAgent 在主回答结束后发起的 `extract_memories` 和 `auto_dream` 内部记忆维护仍保留在原始 Logs spool 中，但不会进入用户 Trace 的调用树、耗时及 Token/LLM/工具统计。

## Qoder CN 产品家族接入

四种产品形态使用同一套 OTLP Trace 结构，但安装入口和 spool 相互隔离。CLI、Desktop、JetBrains 和 Work 的数据统一位于 `~/.agent-insight/otel_data/qoder/<product>/<api-key-hash>/`。切换 API Key 后会自动使用新的摘要子目录，不会混用不同产品、不同账号的 pending、retry 或 uploader lock。升级前的 `qoder-{product}` 目录只作为兼容清理目标，不再写入新数据。

平台把“产品来源”和“Agent 名称”分开记录。默认命名如下：

| 产品/模式 | 产品来源 | 根 Agent 名称 |
|---|---|---|
| Qoder CN Desktop | `Qoder CN Desktop` | `Qoder` |
| Qoder for JetBrains | `Qoder for JetBrains` | `Qoder` |
| Qoder CN CLI | `Qoder CN CLI` | `Qoder CLI` |
| Qoder Work CN | `Qoder Work` | `Qoder Work` |
| Quest 模式 | 保留实际产品来源 | `Quest Agent` |
| 专家团模式 | 保留实际产品来源 | `Experts Agent` |

用户显式选择或创建具名 Agent 时，平台保留该名称。列表中的 `AGENT` 列展示 Agent 名称；产品来源可在 Trace 详情和来源属性中确认，因此 Desktop/JetBrains 的普通根 Agent 显示为 `Qoder` 是预期行为。

在平台的“客户端安装”中执行 curl/PowerShell 安装命令，或使用本地制作的 Agent Insight npm 包执行 `npx agent-insight install` 时，可在不影响原有框架选项的前提下勾选 **Qoder CN product family**。安装器会配置 CLI、Desktop、JetBrains 和 Work 的 Hook、运行脚本及上传器，并自动把 Desktop VSIX 与 JetBrains ZIP 下载到 `~/.agent-insight/packages/qoder/`。单个插件包下载失败只会显示警告，不会撤销已经完成的采集器安装；可在服务端补齐插件包来源或构建环境后重新执行安装命令。Desktop VSIX 由服务端从 `integrations/qoder-desktop/` 源码构建；JetBrains ZIP 可由服务端从受信任的 Release 附件下载，或在有 IntelliJ/Java 构建环境时从 `integrations/qoder-jetbrains/` 源码构建。两类产物都缓存到 `.next/cache/qoder-plugins/`，仓库及本地 npm 包不携带预编译二进制。

### Qoder CN Desktop

可直接从 Agent Insight 服务端下载 VSIX：

```text
http://<Agent-Insight-Host>/api/ingest/setup/qoder-desktop-vsix
```

也可从源码构建：

```powershell
powershell -ExecutionPolicy Bypass -File integrations/qoder-desktop/build-vsix.ps1
```

Linux/macOS 使用同一 Node 构建器：

```bash
integrations/qoder-desktop/build-vsix.sh
```

一键安装后，在 Qoder CN Desktop 的 Extensions 面板选择 **Install from VSIX**，安装 `~/.agent-insight/packages/qoder/agent-insight-qoder-desktop.vsix`；从源码单独构建时则选择 `integrations/qoder-desktop/build/distributions/agent-insight-qoder-desktop-<version>.vsix`。安装后状态栏出现 `Agent Insight`，Settings 中出现 `Agent Insight Qoder CN Collector`。点击状态栏可配置服务地址和 API Key；API Key 写入扩展 SecretStorage，同时同步给本机采集进程。扩展把用户级 Hook 写入 `~/.qoder-cn/settings.json`，读取 `~/.qoder-cn/cache/projects/.../conversation-history/` 会话记录，并在 Windows 上只读查询 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db` 的精确 Token。通过 `/skill-name` 手动触发的 Skill 会从 Qoder CN transcript 的 slash-command 元数据还原，在 Trace 中显示 Skill 名称、版本、触发方式、参数和结果。扩展停用或 Qoder CN Desktop 退出时，会把尚未结束的活动会话生成最后一份 snapshot，并等待一次强制上传；网络失败时 pending 文件仍保留在 spool，下一次启动继续重试。卸载监视器只清理 Desktop owner 与 `qoder/desktop` spool；CLI、JetBrains、Work 不受影响。

### Qoder CN CLI

在源码目录执行以下命令，把采集器安装到当前用户的 Qoder 配置；`--scope=local` 可改为仅当前项目生效，`--scope=project` 可写入项目共享配置。一个安装实例只选择一种 scope。

```bash
node scripts/qoder_setup.mjs install --host=http://localhost:3000 --api-key=<Agent-Insight-API-Key> --scope=user --product=cli --owner=cli
```

用户级安装写入 `~/.qoder-cn/settings.json`；项目级与本地级安装仍写入项目的 `.qoder/settings.json` 或 `.qoder/settings.local.json`。安装会保留已有 Qoder CN hooks，把采集脚本复制到 `~/.agent-insight/`，启动异步 uploader，并为当前用户配置 `QODERCN_EXPOSE_TOKEN_USAGE=1`。Qoder CN CLI 只有在启动时继承该变量，才会把精确 usage 写入 diagnostics，因此安装后必须关闭已有 CLI 并从新终端重新执行 `qoderclicn`。事件与待上传 snapshot 会写入 `~/.agent-insight/otel_data/qoder/cli/<api-key-hash>/`；不同 API Key 使用不同子目录。采集内容包括会话输入与结果、模型与可获得的 token、Tool/Skill 调用、错误状态以及多层 Subagent 关系。CLI 的 Agent 工具结果会按真实 `agentId` 还原为子 Agent；多个并发 Agent 在详情页显示为独立子节点，而不只显示 Task 行。CLI 通过 `/skill-name` 激活 Skill 时产生的 `Skill **name** activated.` informational 记录会还原为独立 Skill Span。内容默认截断到 2000 字符，并对 API Key、token、authorization、cookie 和 password 等字段脱敏。

卸载只移除 `agent-insight-qoder` hooks 和 Qoder 专用脚本，不会删除其他框架共用的 Host/API Key。CLI 与 Work 共享精确 Token 环境变量的 owner 状态；卸载其中一端不会影响另一端，最后一端卸载后才恢复安装前的用户环境变量。增加 `--purge` 会同时删除全部 Qoder CLI spool：

```bash
node scripts/qoder_setup.mjs uninstall --scope=user --product=cli --owner=cli --purge
```

### Qoder for JetBrains

一键安装会尝试从 `http://<Agent-Insight-Host>/api/ingest/setup/qoder-jetbrains-plugin` 下载 ZIP 到 `~/.agent-insight/packages/qoder/agent-insight-qoder-jetbrains.zip`。源码内置了经过校验的贡献分支 Release 附件默认地址，因此无 JDK/Gradle 的标准部署无需额外配置。正式迁移到 openEuler Release、内网镜像或私有制品仓时，可在 Agent Insight 服务进程中覆盖该地址：

```text
AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL=https://<release-attachment-download-url>
```

接口先复用与当前源码 mtime 匹配的新鲜缓存；缓存不存在或已过期时，优先使用环境变量覆盖值，否则使用源码默认附件。校验为 ZIP 且包含编译后的插件 JAR 与 `META-INF/plugin.xml` 后，才原子写入服务端缓存；远端暂时不可用时回退仍可验证的缓存，最后才尝试源码构建。也可在 Windows 使用 `integrations/qoder-jetbrains/build-plugin.ps1 -IdeHome <JetBrains-IDE目录>`、在 Linux/macOS 使用 `JETBRAINS_HOME=<JetBrains-IDE目录> integrations/qoder-jetbrains/build-plugin.sh` 从源码构建。JetBrains 插件必须依赖 IntelliJ Platform SDK 编译 Java 并生成插件 JAR，不能把 Java 源码直接压缩成可安装 ZIP；默认/覆盖 Release 均不可用且缺少 `JETBRAINS_HOME` 或 Java/Gradle 构建环境时，自动下载会显示警告，直接访问接口则返回明确的 503 提示。然后在 JetBrains IDE 的 Plugins 页面选择 **Install Plugin from Disk**，选择下载的 ZIP 并重启 IDE。插件安装后显示 Agent Insight 状态栏和设置项，并通过 IDE 进程 marker 将共享 Qoder transcript 标记为 `Qoder for JetBrains`。IDE 关闭、应用服务销毁或插件动态卸载前，插件都会先执行同样的活动会话 snapshot 与强制上传；失败数据继续留在 pending spool。插件动态卸载完成后只移除 `jetbrains` owner、marker、运行目录与 `qoder/jetbrains` spool。

安装脚本请求本机插件接口失败时，会在终端显示当前生效的 **Release attachment direct URL**（环境变量覆盖值或源码默认值）并自动从该直链重试下载。若直链下载仍失败，终端会继续输出可复制的 `curl -fL ... -o ...`（Linux/macOS）或 `Invoke-WebRequest -Uri ... -OutFile ...`（Windows）命令、目标 ZIP 路径 `~/.agent-insight/packages/qoder/agent-insight-qoder-jetbrains.zip`，以及 **Settings → Plugins → 齿轮 → Install Plugin from Disk** 的安装步骤。源码默认值集中定义在 `src/lib/ingest/qoder-plugin-release.ts`；当前为贡献分支的临时 Release 附件，合入上游并发布正式制品后应改为 openEuler 官方附件地址，部署方也可随时通过 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 覆盖并重启 Agent Insight。

#### Qoder for JetBrains 制品来源声明

Qoder for JetBrains 插件必须先由 IntelliJ Platform SDK/JDK 编译为包含插件 JAR 的 ZIP，不能直接安装 Java 源码。仓库只保存可审查的插件源码，不提交预编译 ZIP；标准部署从 Release 附件获取已编译制品。当前源码默认地址可在 `src/lib/ingest/qoder-plugin-release.ts` 查看，服务端实际分发入口为 `/api/ingest/setup/qoder-jetbrains-plugin`，一键安装后的本地文件位于 `~/.agent-insight/packages/qoder/agent-insight-qoder-jetbrains.zip`。当前默认附件发布在贡献者仓库的 `qoder-cn-collector-test-v0.1.0` Release 中，属于合入前的临时制品；上游发布正式附件后，维护者应把默认地址迁移到 openEuler 官方 Release。部署方需要提前切换制品源时，可设置 `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` 覆盖默认地址。完整构建、校验、替换和维护步骤见开发者指南“Qoder for JetBrains Release 制品维护声明”。

### Qoder Work CN

Qoder Work 使用独立配置目录和安装器：

```bash
node scripts/qoder_work_setup.mjs install
```

安装器读取 `~/.agent-insight/config` 中的 Host/API Key，把 Hook 写入 `~/.qoderworkcn/settings.json`（国际版回退 `~/.qoderwork/settings.json`），运行文件写入 `~/.agent-insight/qoder-work/`，并为当前用户配置 `QODERCN_EXPOSE_TOKEN_USAGE=1`。安装后必须完全退出并重新启动 Qoder Work CN，新的进程继承该变量后才会在 diagnostics 中保留精确 Token。采集内容包括办公任务、文件/终端工具、Skill、LLM、自定义 MCP 和内置连接器。Qoder Work 的懒加载 `qw_mcp_call` 会在平台中还原为真实 MCP 或 `connector__<name>__<tool>` 调用。

```bash
node scripts/qoder_work_setup.mjs uninstall --purge
```

所有形态默认截断正文到 2000 字符，并对 API Key、token、authorization、cookie、password 等字段脱敏。工具耗时通常取 Pre/Post Hook；异步 Hook 时间戳重合时自动回退到 transcript 的真实调用与返回时间，避免短 MCP 调用误显示为 `0ms`。采集器按 `diagnostics/Hook 精确值 > Desktop/JetBrains 本地 SQLite 精确值 >（显式开启时）Desktop/JetBrains 可见 transcript 估算 > 不可用` 选择 Token 来源。CLI 与 Work 依赖安装器配置的 `QODERCN_EXPOSE_TOKEN_USAGE=1` 保留 diagnostics 精确值；Desktop 自动只读查询 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db`，JetBrains 自动只读查询 `~/.qoder/shared_client/cache/db/local.db`。SQLite 读取仅访问 `chat_message` 的会话、请求、模型和 `token_info` 字段，不修改 Qoder 数据。SQLite Schema 与 Token 暴露开关都属于 Qoder 客户端内部接口；版本不兼容、数据库忙、变量未被客户端进程继承或当前 Node 不支持内置 SQLite 时会安全回退为 Token 不可用。

仅在前两种精确来源都不可用时，才可在 `~/.agent-insight/config` 中显式设置 `AGENT_INSIGHT_QODER_ESTIMATE_VISIBLE_TOKENS=1`，实验性地估算当前轮 transcript 中可见的用户消息、助手输出、工具参数和工具结果。Trace 详情以 `≈` 标识，并记录 `local_visible_transcript`、`visible_transcript` 和 `missing_context=true`。估算不包含客户端隐藏的 system prompt、Rules、Skill/MCP schema、内部推理与被压缩上下文，在真实 Agent 会话中可能严重低估，因此不能用于账单核对，也不会填充执行记录的精确 input/output Token 字段。CLI/Work 未提供 usage 时仍显示不可用，不启用该兜底。
