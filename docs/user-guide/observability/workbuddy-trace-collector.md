---
title: "WorkBuddy Trace Collector"
description: "腾讯 WorkBuddy（Windows 桌面版）采集器的安装、管理、数据范围与卸载指南"
---

# WorkBuddy Trace Collector

本文是 Agent Insight 的 WorkBuddy（Windows 桌面版）采集器用户指南。

WorkBuddy 是腾讯的闭源 Electron 桌面 Agent，**不提供 Hook/插件扩展点，也没有原生 OpenTelemetry 上报**。因此采集器不嵌入 WorkBuddy，而是作为一个独立的常驻进程，**监听 WorkBuddy 落盘到 `~/.workbuddy/` 的本地数据**（trace 文件 + SQLite 会话库），转换成 Agent Insight 标准 OTLP trace 后上传。采集器与 WorkBuddy 完全解耦：任一方崩溃、重启、升级都不影响另一方。

> 平台内部设计文档见 [`docs/design/workbuddy-trace-collector/`](../../design/workbuddy-trace-collector/)。

## 前提条件

- **操作系统**：Windows（采集器通过 Windows 计划任务实现登录自启动）。
- **已安装并至少打开过一次 WorkBuddy**：安装器需要 `~/.workbuddy` 目录存在。
- **无需单独安装 Node.js**：采集器复用 WorkBuddy 自带的 Electron 运行时（`WorkBuddy.exe` 在 `ELECTRON_RUN_AS_NODE=1` 下等价于 node）。找不到 WorkBuddy.exe 时才回退到系统 `node`。
- 一个 Agent Insight API Key。

## 支持范围

| 类型 | 已采集信息 |
| --- | --- |
| Agent | sessionId、用户原始提问、Agent 名称（内部 `cli` 归一化为 `WorkBuddy`）、会话模式（ask/craft/work）、模型、耗时、状态、最终结果 |
| LLM | 模型名、逐轮 input/output/reasoning/cache 精确 token、prompt/completion 内容、耗时 |
| Tool | Read/Write/Edit/Bash/Glob 等真实工具调用的名称、参数（**保留真实文件路径**）、返回值、状态、耗时 |
| 子 Agent | WorkBuddy 通过名为 `Agent` 的工具派发的子 Agent，还原为命名正确的子 Agent 节点（名取 `description`，如「造门店运营数据」），并与发起它的 LLM 关联 |
| Token | 逐轮精确拆分（来自 trace 文件）+ 会话级"当前上下文占用/窗口上限"（来自 SQLite），两个维度分开呈现 |

已验证的 WorkBuddy 版本：`appVersion 5.5.3`（内嵌 CLI 内核 `2.137.1`）。WorkBuddy 属闭源内部实现，其本地数据格式可能随版本变化；采集器对字段缺失做降级处理，不会因此崩溃或中断其余数据采集。

**已知边界**：子 Agent 的**内部执行步骤**（它自己的 LLM/工具调用）由 WorkBuddy 在独立 worker 进程中运行、未落盘到可关联的本地文件，因此子 Agent 节点只展示其最终报告，不含内部时间线。WorkBuddy 内部的 `terminalTitleGenerator`（生成侧边栏标题）等工具类 trace 会被主动跳过，不计入用户会话。

## 安装（推荐：一键安装）

在 Agent Insight 的「接入配置 / 安装」页面勾选 **WorkBuddy**、选择 **Windows**，把生成的一行命令拷贝到 **Windows PowerShell** 执行即可：

```powershell
irm "http://<agent-insight-host>:3000/api/ingest/setup?key=<API_KEY>&yes=1&frameworks=workbuddy" | iex
```

脚本会：探测 WorkBuddy → 下载采集器文件到 `~/.agent-insight/packages/workbuddy` → 写配置 `~/.agent-insight/otel_data/workbuddy/config.json` → 生成隐藏窗口启动器并注册计划任务 `AgentInsight-WorkBuddyCollector`（登录触发 + 失败自动重启）→ 立即启动一次。

> WorkBuddy 是 Windows 桌面应用，在非 Windows（curl \| bash）环境下脚本只会提示"请在 Windows 运行"，不做安装。

安装完成后，脚本会打印可直接复制的管理命令（见下节）。

## 管理采集器

以下命令均可直接复制到 PowerShell 执行，**无需 Node.js**。任务名固定为 `AgentInsight-WorkBuddyCollector`。

```powershell
# 启动
schtasks /run /tn "AgentInsight-WorkBuddyCollector"

# 停止（用 /end 结束整个任务；直接杀采集器子进程会被自动拉回）
schtasks /end /tn "AgentInsight-WorkBuddyCollector"

# 查看任务状态（正常运行时 Status 显示 Running）
schtasks /query /tn "AgentInsight-WorkBuddyCollector" /v /fo LIST

# 确认采集器进程是否在跑
Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" | Where-Object { $_.CommandLine -like '*collector.mjs*' } | Select-Object ProcessId,CreationDate

# 卸载（先结束再删除计划任务）
schtasks /end /tn "AgentInsight-WorkBuddyCollector"; schtasks /delete /tn "AgentInsight-WorkBuddyCollector" /f
```

- 采集器带**单实例锁**：重复启动不会跑出两个实例。
- 启动器 `.vbs` 会**阻塞等待**采集器进程，因此计划任务状态能正确显示 `Running`，采集器崩溃（非零退出）时 `RestartOnFailure` 会在约 1 分钟内自动拉活。

## 使用与验证

1. 确认采集器在跑（上面的"确认采集器进程"命令有输出）。
2. 打开 WorkBuddy，正常发起一段对话。
3. 一次对话结束后，采集器会处理对应 trace 并上传；稍等片刻到 Agent Insight 的**链路追踪**页面即可看到 `framework=workbuddy` 的新会话。

查看本地 spool（排查上传是否推进）：

```powershell
Get-ChildItem -Recurse "$env:USERPROFILE\.agent-insight\otel_data\workbuddy" | Select-Object FullName, Length
```

`events.jsonl` 有内容、`uploader-checkpoint.json` 的 `bytes` 在推进，即表示采集与上传正常。

## 工作原理（简述）

1. **监听**：`fs.watch` 盯 `~/.workbuddy/traces/<pid>/trace_*.json`；WorkBuddy 一次对话写完一条完整 trace 即触发处理（读取前等 mtime 静止防半写）。
2. **关联会话**：持续订阅 `~/.workbuddy/sessions/<pid>.json` 心跳，维护 `pid → sessionId` 缓存并留宽限期，避免心跳被清理后追溯不到会话。
3. **富化**：只读查询 `~/.workbuddy/workbuddy.db`（`PRAGMA query_only`）补全模式/模型/会话级上下文占用。
4. **映射**：把 span 树转成平台 canonical 事件 → OTLP，`service.name=workbuddy`。逐轮 token/model 直接来自 `generation.toolOutput`；工具按时间就近归属到对应 LLM。
5. **上传**：复用平台共享 spool/uploader，每条 trace 处理后即上传，失败落盘重试。

## 数据与隐私

- 上传前对内容做长度截断，并对 **API Key / token / 密码 / 邮箱** 等敏感信息脱敏。
- **文件路径保留真实值**（编码 Agent 的核心观测信号，如 `Read`/`Write` 的目标文件）；真实路径可能含系统用户名（如 `C:\Users\<name>\...`），属自托管自查场景的预期行为。如需连本地路径也一并打码，可在采集器侧开启路径脱敏（默认关闭）。
- Token 语义：逐轮 input/output/cache/reasoning 为模型 API 返回的精确值；会话级"当前上下文占用/窗口上限"为 SQLite 快照，与逐轮值是**两个不同维度**，不要混用（会话总量不等于逐轮之和，因为每轮都会重发上下文）。

## 故障排查

| 现象 | 说明 / 处理 |
| --- | --- |
| 安装报 "WorkBuddy not detected" | 先安装并打开一次 WorkBuddy（需存在 `~/.workbuddy`），再重跑安装 |
| 计划任务状态一直 `Ready` 而非 `Running` | 需为"阻塞等待"版启动器；旧版（发射即退出）会一直显示 Ready，重装一次即可更新启动器 |
| 链路页看不到新会话 | 确认采集器进程在跑；检查 `~/.agent-insight/otel_data/workbuddy` 下 spool 是否产出；确认 API Key/host 配置正确（`~/.agent-insight/otel_data/workbuddy/config.json`） |
| 子 Agent 只有报告、没有内部步骤 | 已知边界：WorkBuddy 未落盘子 Agent 内部执行，无法关联 |

## 卸载

```powershell
schtasks /end /tn "AgentInsight-WorkBuddyCollector"; schtasks /delete /tn "AgentInsight-WorkBuddyCollector" /f
```

如需彻底清理，删除 `~/.agent-insight/packages/workbuddy` 与 `~/.agent-insight/otel_data/workbuddy`。卸载采集器不影响 WorkBuddy 本身。
