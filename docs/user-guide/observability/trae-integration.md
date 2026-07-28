---
title: "TRAE AI IDE 接入指南"
description: "在 TRAE AI IDE 中安装 Agent Insight 插件，将 Agent 运行数据接入平台进行观测与分析。"
---

# TRAE AI IDE 接入指南

TRAE AI IDE 通过 VS Code 插件方式接入 Agent Insight 平台。插件安装后自动部署 Hook 脚本，监听 session-start、pre-tool-use、post-tool-use、prompt-submit、stop、subagent-detect 等生命周期事件，实时采集运行数据并上报。

## 前置条件

- 已部署并访问 Agent Insight 看板
- 已在平台注册 Agent（参见 [5 分钟上手](../quickstart)）
- TRAE AI IDE 已安装且版本兼容
- 平台服务端与 TRAE IDE 所在机器网络互通

## 接入步骤

TRAE AI IDE 通过统一的 Agent Insight 安装脚本接入。脚本会自动检测操作系统、下载 VSIX 插件并完成安装。

### 1. 获取安装命令

进入 **配置 → 安装指导**，在页面上方选择目标运行时后，页面会生成平台专属的安装命令：

- **Linux / macOS**：
  ```bash
  curl -sSf "http://<host>:3000/api/ingest/setup?key=sk-your-api-key" | bash
  ```
- **Windows (PowerShell)**：
  ```powershell
  irm "http://<host>:3000/api/ingest/setup?key=sk-your-api-key" | iex
  ```

### 2. 选择 TRAE AI IDE

执行安装命令后，会进入交互式框架选择菜单。在菜单中选择 **TRAE AI IDE**（使用方向键移动，空格选中，回车确认）：

```
Select the frameworks to install (use space to select, enter to confirm):
  [x] OpenCode
  [ ] Claude Code
  [x] TRAE AI IDE        ← 选中此项
  [ ] Hermes
  [ ] OpenClaw
  [ ] JiuwenSwarm
```

脚本随后会自动下载 `agent-insight-trae-collector-0.1.0.vsix` 并将其安装到 TRAE IDE 中（优先使用 `trae-cn` / `trae` CLI 命令注册扩展，若无 CLI 则手动复制到扩展目录）。

### 3. 通过 npx 部署（替代方式）

如果已通过 `npx agent-insight install` 部署了平台，也可以在采集器安装交互菜单中选择 TRAE AI IDE 进行安装。

### 4. 配置插件

插件安装完成后，需要在 TRAE IDE 中配置平台连接信息：

1. 打开设置：`Ctrl+Shift+,`（macOS: `Cmd+,`）
2. 搜索 `Agent Insight`
3. 填入以下配置项：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `Host` | 平台服务端地址 | `http://localhost:3000` |
| `Api Key` | Agent 的 API Key（在 Agent 详情页获取） | `sk-xxxx` |

> **Note**
> 如果未在 IDE 设置中配置 Host 和 API Key，插件会尝试从 `~/.agent-insight/.env` 文件读取
> `AGENT_INSIGHT_HOST` 和 `AGENT_INSIGHT_API_KEY` 环境变量。

### 5. 验证接入

1. 在 TRAE IDE 中执行一次 Agent 任务，例如输入 `hello` 并等待回复
2. 登录 Agent Insight 看板，进入 **运行观测 → 链路追踪**
3. 确认出现新的 Trace 记录，包含 TRAE 框架标识

如果 30 秒后仍无数据，按以下顺序排查：

1. 查看状态栏中的 Agent Insight 图标（绿色 = 已连接，红色 = 异常）
2. 检查 IDE 输出面板中的 `Agent Insight` 频道日志
3. 确认 `~/.agent-insight/trae-hooks/` 下的 Hook 脚本已正确部署
4. 检查 `~/.agent-insight/logs/trae_uploader.log` 查看上传状态

## Hook 事件说明

插件在 TRAE IDE 内部署的 Hook 脚本监听以下生命周期事件：

| Hook 事件 | 触发时机 | 采集数据 |
|-----------|----------|----------|
| `session-start` | 新会话开始 | session ID、时间戳、环境信息 |
| `pre-tool-use` | 工具调用前 | 工具名、输入参数 |
| `post-tool-use` | 工具调用后 | 工具名、执行结果、耗时 |
| `prompt-submit` | 用户提交提示词 | 提示词内容（可脱敏） |
| `stop` | 会话结束 | 结束时间、执行摘要 |
| `subagent-detect` | 子 Agent 发起 | 子 Agent 标识、任务描述 |
| `notification` | 系统通知 | 通知内容、级别 |

## 数据脱敏

插件内置敏感信息脱敏功能。以下路径的内容会被自动脱敏：

- API Key / Token 字段
- 包含 `password`、`secret`、`credential` 的环境变量
- 符合 AWS / GitHub Token 格式的字符串

脱敏后的内容 `input.sanitized` 会替代原始 `input` 字段上报。

> **Warning**
> 脱敏规则基于正则匹配实现，**不保证 100% 覆盖**所有敏感信息场景。
> 生产环境建议额外在服务端配置脱敏策略。

## 调试

如果遇到数据上报异常，可以使用插件内置的调试视图：

1. 打开命令面板：`Ctrl+Shift+P`（macOS: `Cmd+Shift+P`）
2. 搜索 `Agent Insight: Debug View`
3. 查看实时事件流、spool 队列状态和上传日志

也可以直接查看本地日志：

```bash
# Linux / macOS
tail -f ~/.agent-insight/logs/trae_uploader.log

# Windows
Get-Content $env:USERPROFILE\.agent-insight\logs\trae_uploader.log -Wait
```

## 卸载

1. 在 TRAE IDE 插件市场中找到 Agent Insight 插件
2. 点击 **卸载**
3. 重启 IDE

卸载后 Hook 脚本会被自动清理，`~/.agent-insight/trae-hooks/` 目录将被移除。如需完全清理（包括历史 spool 数据）：

```bash
# Linux / macOS
bash ~/.agent-insight/trae-hooks/uninstall.sh --clean

# Windows (PowerShell)
& $env:USERPROFILE\.agent-insight\trae-hooks\uninstall.ps1 -Clean
```
