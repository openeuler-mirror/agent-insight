---
title: "OpenCode 接入"
description: "介绍 OpenCode 接入 Agent RAS 的安装方式、同进程运行架构及能力限制。"
keywords: ["Agent RAS", "OpenCode", "同进程集成", "可靠性"]
changefreq: monthly
---

<a id="opencode-接入"></a>
同进程：`ras_runtime` + bun:ffi；能力为 partial（非 jiuwen 同级 chunk abort）。

**inproc 如何加载 libpython、模块如何互相调用**：见 [architecture.md §4](../../../explanation/reliability/agent-ras/architecture.md)。

## 架构

```mermaid
flowchart LR
  Install[install-ras] --> Plugin[opencode_plugin]
  Plugin --> Embed[ras_runtime]
  Embed --> Core[L0_core]
  Embed -.-> Insight[insight_push]
```

## 安装

在 Agent Insight 仓库根：

```bash
npx agent-insight install-ras
# 开发：node scripts/install-ras.js
# 检查：node scripts/install-ras.js --check
```

安装器写入 `~/.agent-insight/ras/`，合并 `ras-judge` 等到 OpenCode 配置。详细步骤见源码旁 [`platform_adapter/opencode/INSTALL.md`](https://gitcode.com/openeuler/agent-insight/blob/master/agent_ras/platform_adapter/opencode/INSTALL.md)。\
看板 curl / `npm pack` / 本机目录树与数据源见 [local-install-process.md](./local-install-process.md)。

判定 Agent 的模型由 OpenCode 的 agent.ras-judge.model 独立指定，当前模板使用 zhipuai-coding-plan/GLM-5.2。该模型需在本机 provider 中可用；业务默认模型变化不会自动覆盖已有判定模型配置。修改后新建会话生效。

## 注意

- 仅 inproc；不启本地 RAS 端口或守护进程
- 语义 Judge 默认开；可在配置中关闭
- 旁路事件 fail-open；UI 契约见 developer-guide

配置见 [01-getting-started.md](../../../tutorial/reliability/agent-ras/01-getting-started.md)。
