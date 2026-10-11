---
title: "QwenPaw Trace Collector"
description: "QwenPaw 采集器的安装、验证、Trace 展示、排障与卸载指南"
---

# QwenPaw Trace Collector

本文同时作为安装器生成的运行时 ZIP 的 `README.md` 内容源；当前发布版本为 `1.0.0`。

`agent-insight-qwenpaw` 是 Agent Insight 的 QwenPaw Trace 采集器。它以 QwenPaw hook 插件
形式加载，不需要修改 QwenPaw 源码，也不要求修改现有对话入口。采集器会记录用户输入、真实
Agent 名称、LLM、Tool、Skill、MCP、Cron 和子 Agent 调用关系，并通过 OTLP 上传到 Agent
Insight。

公开平台名统一为 `QwenPaw`，框架值统一为 `qwenpaw`。采集器内部 Python 模块名是
`qwenpaw_insight`，这是为了避免和真实 QwenPaw Python 包 `qwenpaw` 发生导入冲突。

## 支持范围

| 类型 | 已采集信息 |
| --- | --- |
| 对话 | `session_id`、`root_session_id`、turn、用户问题、状态和完成时间 |
| Agent | QwenPaw Agent ID、真实配置名称、根 Agent 与子 Agent 父子关系 |
| LLM | model、provider、输入、输出、prompt/completion/reasoning/total tokens、耗时和错误 |
| Tool | 工具名、参数、输出、状态、exit code、耗时和错误 |
| Skill | Skill 名称、版本、slash 触发参数、输出和状态 |
| MCP | MCP server、tool、arguments、result、状态和耗时 |
| 子 Agent | `spawn_subagent`、batch/fork、跨 Agent 对话和嵌套委派 |
| Cron | job id、job name、trigger、状态和输出 |

最终 Trace 结构是：

```text
AGENT -> USER -> LLM/TOOL
```

如果一次对话中调用了子 Agent，详情页会按树展示：

```text
Default
  -> TASK
      -> Default · Subagent
          -> LLM / TOOL
```

同一 QwenPaw 对话里每次发送新问题都会生成新的 Trace；详情页仍会按树展示该问题下的
Agent、Task、LLM、Tool 和子 Agent 关系。

## 前置条件

- 已部署并能访问 Agent Insight 服务端；
- 当前账号拥有 Agent Insight API Key；
- QwenPaw 所在机器可以访问 Agent Insight 的 `/api/ingest/otel/v1/traces`；
- QwenPaw 所在机器有 Python 3.11 或更高版本；
- 安装后可以重启 QwenPaw。

Windows 用户可以直接使用安装指导页生成的 PowerShell 命令。把命令复制到普通 PowerShell
窗口执行即可；如果你的 QwenPaw 安装目录或插件目录需要管理员权限，再使用管理员 PowerShell。

## 一键安装

进入 Agent Insight 看板：

```text
配置 -> 客户端安装
```

在框架选择中勾选 `QwenPaw`，复制对应系统的一行命令：

```bash
curl -sSf "http://<Agent-Insight-Host>/api/ingest/setup?key=<api-key>&yes=1&frameworks=qwenpaw" | bash
```

Windows PowerShell：

```powershell
irm "http://<Agent-Insight-Host>/api/ingest/setup?key=<api-key>&yes=1&frameworks=qwenpaw" | iex
```

脚本会完成以下动作：

1. 检查 Python 版本；
2. 从当前 Agent Insight 服务端下载 QwenPaw collector zip；
3. 解压到 `~/.agent-insight/collectors/qwenpaw/current/`；
4. 执行 `python -m pip install --disable-pip-version-check --upgrade` 安装本地 collector 包；
5. 执行 `python -m qwenpaw_insight.cli install` 注册 QwenPaw 插件；
6. 写入插件 `config.json`；
7. 创建本地 spool 目录。

安装完成后重启 QwenPaw。插件只有在 QwenPaw 重新启动后才会被加载。

## 手动安装

如果你在 Agent Insight 源码树中调试，可以手动安装：

```powershell
python -m pip install --upgrade D:\openeuler\agent-insight\scripts\qwenpaw-collector
python -m qwenpaw_insight.cli install --host http://localhost:3000 --api-key <Agent-Insight-API-Key>
```

Linux/macOS：

```bash
python -m pip install --upgrade /path/to/agent-insight/scripts/qwenpaw-collector
python -m qwenpaw_insight.cli install --host http://localhost:3000 --api-key <Agent-Insight-API-Key>
```

安装后的 QwenPaw 插件目录包含：

```text
agent-insight-qwenpaw/
├── plugin.json
├── backend.py
├── config.json
└── qwenpaw_insight/
```

## 配置

配置优先级从高到低为：

1. 环境变量；
2. 插件目录下的 `config.json`；
3. `~/.agent-insight/.env`；
4. 内置默认值。

常用环境变量：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `AGENT_INSIGHT_HOST` | Agent Insight 服务地址，会自动补全 OTLP Trace 路径 | 空 |
| `AGENT_INSIGHT_OTLP_ENDPOINT` | 完整 OTLP traces endpoint | 空 |
| `AGENT_INSIGHT_API_KEY` | Agent Insight API Key | 空 |
| `OTEL_SERVICE_NAME` | OTLP service name | `qwenpaw` |

默认 spool 路径：

```text
~/.agent-insight/otel_data/qwenpaw/
```

启用 API Key 隔离后，不同 API Key 写入不同摘要子目录：

```text
~/.agent-insight/otel_data/qwenpaw/<api-key-hash-8>/
```

API Key 不会写入 span 内容、日志或文件名。

## 验证 Trace

安装并重启 QwenPaw 后，创建一个新对话并发送一条简单问题，例如：

```text
能告诉我你有哪些技能吗？
```

回到 Agent Insight：

```text
运行观测 -> 链路追踪
```

确认列表中出现新的 QwenPaw Trace。重点检查：

- `AGENT` 列显示真实 Agent 名称，例如 `Default`，不是固定占位名；
- `任务内容` 显示你的真实问题，不是 `QwenPaw Session`；
- 详情页第一条根事件是 `USER`；
- LLM 行显示模型、Token 和耗时；
- 调用 Tool、Skill 或 MCP 时有对应节点；
- 调用子 Agent 时出现可展开的 `TASK -> AGENT` 树。

继续在同一个 QwenPaw 对话里追问一次。Agent Insight 列表应该新增第二条 Trace；两条 Trace
分别对应两次提问。进入第一条 Trace 仍只能看到第一轮问题和后续调用。

## 页面展示口径

QwenPaw Trace 的字段口径如下：

- `framework` 固定为 `qwenpaw`；
- `AGENT` 列优先显示 QwenPaw Agent 配置名；
- `query` 使用当前问题对应的真实根 USER；
- 每个问题对应一条 Trace，且只插入一次根 USER；
- system prompt 和历史 assistant/tool 消息只作为详情内容，不作为用户问题；
- 自动标题生成 LLM 归入对应对话，但不会单独创建一条 Trace；
- 子 Agent 默认不在 Trace 列表中作为根任务展示，只在详情树和下钻数据中出现。
- Tool/Skill 的执行状态与 Output 独立展示。调用失败时，详情显示失败原因和已采集的退出码；
  返回内容仍保留在 Output，可展开查看和复制。后续重试成功不会改写前一次调用的失败状态。

## 故障排查

### Tool/Skill 有 Output，但详情显示失败

先检查该调用的退出码和失败原因。有 Output 表示工具返回了内容，失败命令也会返回 stdout、
stderr 或部分结果。Shell 非零退出码、实际异常、取消或拒绝都会记录为失败；例如
`Cannot find module 'docx'` 是该次 Node 命令的真实依赖加载失败，后续命令重试成功后会单独显示成功。

如果成功加载的 Skill、文件写入等调用也全部标为失败，确认 collector 已更新并完全重启 QwenPaw。
旧版曾将消费最终响应后正常关闭异步生成器时的 `GeneratorExit` 误记为错误，新版已修复。
更新后不需要先删除插件；历史 Trace 的状态需按原始工具结果定向修复，刷新页面不会修改历史数据。

### 安装后页面没有新 Trace

先确认 QwenPaw 已经完全重启。插件在启动时加载，只执行安装命令但不重启，旧进程不会自动拥有
collector。

然后检查本地配置：

```powershell
python -m qwenpaw_insight.cli status
```

确认 `endpoint` 指向当前 Agent Insight 服务端，并且 `api_key` 属于当前登录账号。

### spool 一直堆积

查看本地目录：

```text
~/.agent-insight/otel_data/qwenpaw/
```

如果存在大量待上传文件，通常是网络、endpoint 或 API Key 问题。修复后重启 QwenPaw 或等待后台
上传器下一轮扫描即可。上传成功的数据会标记为已发送，避免重复入库。

### 列表仍显示 `QwenPaw Session`

这通常说明当前 Trace 是旧采集器产生的历史数据，或者该 span 中没有可恢复的真实 user/human
消息。重新安装新版 collector、重启 QwenPaw，并用新对话验证。

如果历史 spool 仍在，可以由维护者运行回填脚本：

```powershell
node --import tsx scripts/backfill-qwenpaw-user-traces.ts
node --import tsx scripts/backfill-qwenpaw-user-traces.ts --apply
```

默认 dry-run 只输出统计，`--apply` 才写数据库。spool 丢失或没有真实 USER 的历史记录不会被猜测
修复。

### 没有 USER 行

新数据中 USER 来自 `qwenpaw.user_input` 或标准消息字段。确认采集器版本已更新，并重启
QwenPaw。旧版只有 LLM span 且 `input.value` 不能解析时，平台不会从 system prompt 或 assistant
回复猜造 USER。

### 子 Agent 没有树形展示

确认子任务是通过 QwenPaw 的 `spawn_subagent`、batch/fork、`chat_with_agent` 或
`submit_to_agent` 触发。详情页需要看到委派 Tool 被规范化为 `task`，其参数里有
`subagent_session_id`、`subagent_type` 和 `description`。

### Agent 名称不对

QwenPaw 根 Agent 名称优先来自 `ctx.agent_config.name`。如果页面显示为 `qwenpaw`，说明当前
span 没有拿到真实 Agent 配置名。优先确认 Hook 是否成功注册，插件是否被 QwenPaw 加载，以及
当前 Trace 是否为旧数据。

## 卸载

先停止正在运行的 QwenPaw，再执行：

```powershell
agent-insight-qwenpaw uninstall
python -m pip uninstall agent-insight-qwenpaw
```

Linux/macOS 同样适用：

```bash
agent-insight-qwenpaw uninstall
python -m pip uninstall agent-insight-qwenpaw
```

`agent-insight-qwenpaw uninstall` 会删除 QwenPaw 插件目录、配置和默认 spool。`pip uninstall`
只会移除 Python site-packages 中的包，无法清理用户目录里的 QwenPaw 插件和 telemetry 数据，
因此建议先运行 collector 自带卸载命令。

如果要保留未上传数据：

```powershell
agent-insight-qwenpaw uninstall --keep-spool
```

## 开发与验证

在 Agent Insight 仓库中：

```powershell
python -m compileall -q scripts\qwenpaw-collector\qwenpaw_insight
$env:PYTHONPATH='scripts/qwenpaw-collector'; python -m unittest discover -s test/qwenpaw -p 'test_*.py'
node --import tsx --test test/qwenpaw-setup-env.test.ts test/qwenpaw-otel-adapter.test.ts test/framework-adapter-registry.test.ts test/otel-trace-aggregator.test.ts
```

命名守卫：

```powershell
rg -n -i "<deprecated-qwenpaw-alias>" .
rg --files | rg -i "<deprecated-qwenpaw-alias>"
```

两条命令都应没有输出。安装页、setup 脚本和文档中也不应出现重复的 QwenPaw 显示名。
