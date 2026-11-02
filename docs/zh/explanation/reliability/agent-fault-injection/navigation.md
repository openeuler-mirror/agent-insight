---
title: "Agent Fault Injection 文档"
description: "汇总 Agent FI 的模块职责、与平台及 RAS 的关系，以及安装使用和设计文档入口。"
keywords: ["Agent FI", "故障注入", "可靠性评测", "文档导航"]
changefreq: monthly
---


仓根 [`agent_fault_injection/`](https://gitcode.com/openeuler/agent-insight/tree/master/agent_fault_injection)：**agent-fi 功能实现模块**（注入 + 采集）。\
**前端 / DB / Worker 协议 / Judge** 属既有平台 [agent-insight](https://gitcode.com/openeuler/agent-insight/tree/master/)；环内检测见 [`agent_ras/`](https://gitcode.com/openeuler/agent-insight/tree/master/agent_ras)。

## 关系说明（先读）

| | agent-insight（平台） | agent-ras（模块） | agent-fi（模块） |
|--|---------------------|-------------------|------------------|
| 职责 | UI · API/协议 · DB · Judge | 环内检测 + 恢复实现 | 注入 + 采集实现 |
| 部署 | 服务端（可远程） | 用户本机 · 宿主同进程 | 用户本机 · Worker/CLI |
| 不含 | — | 前端 / schema / 契约设计 | 前端 / FaultInjection* 表 / Judge |

展开：[ras-fi-insight-relationship.md](./modules/ras-fi-insight-relationship.md) §0–§1。

本页串联四类文档中的故障注入专题，内部方案位于仓根 `design/reliability/agent-fault-injection/`。历史状态说明保留，未在本轮重新验收。

## 先读什么

| 目的 | 打开 |
|------|------|
| **Insight · RAS · FI 关系说明** | [ras-fi-insight-relationship.md](./modules/ras-fi-insight-relationship.md) |
| **服务端/客户端分离（FI）** | [server-client-split.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/server-client-split.md) · [phase2 SDD](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/fi-server-client-split/phase2-requirements-design.md) |
| **本机 curl 安装过程** | [local-install-process.md](../../../how-to/reliability/agent-fault-injection/local-install-process.md) |
| FI 模块架构摘要 | [architecture.md](./architecture.md) |
| 内置故障覆盖矩阵 | [fault-catalog.md](../../../reference/reliability/agent-fault-injection/fault-catalog.md) |
| **新增故障模式** | [fault-mode-plugins.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/fault-mode-plugins.md) |
| 运行时注入（prompt / tool_result / intercept） | [runtime-middleware-fault-injection.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/runtime-middleware-fault-injection.md) |
| Task / Worker / Judge（Insight） | [server-client-split.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/server-client-split.md) |
| 最短启用 | [01-getting-started.md](../../../tutorial/reliability/agent-fault-injection/01-getting-started.md) |
| **用户指南（产品路径）** | [user-guide/observability/fault-injection.md](../../../how-to/reliability/agent-fault-injection/run-injection.md) |

---

## designs/ — 设计

原 designs 目录已按用途归位：当前架构与模块解释见本专题，内部需求方案见仓根 design/reliability。标题保留供历史锚点引用。

### 架构

| 文档 | 内容 | 状态 |
|------|------|------|
| [architecture.md](./architecture.md) | FI 模块边界摘要 | ✅ |

### 模块

| 文档 | 内容 | 状态 |
|------|------|------|
| [ras-fi-insight-relationship.md](./modules/ras-fi-insight-relationship.md) | 三者关系设计说明 | ✅ |
| [fault-catalog.md](../../../reference/reliability/agent-fault-injection/fault-catalog.md) | 内置故障覆盖矩阵 | ✅ |
| [xiaoo-platform-adaptation.md](./modules/xiaoo-platform-adaptation.md) | xiaoO 被测平台适配 | ✅ |
| [opencode-platform-adaptation.md](./modules/opencode-platform-adaptation.md) | OpenCode 被测平台适配 | ✅ |

### 特性

| 文档 | 内容 | 状态 |
|------|------|------|
| [server-client-split.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/server-client-split.md) | 远程任务 + 本机 Worker；collect/Judge/Trace join | ✅ 已落地（2026-08-05 浏览器 E2E） |
| [runtime-middleware-fault-injection.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/runtime-middleware-fault-injection.md) | 运行时数据面注入方案：挂点、步骤契约、表驱动同源 | ✅ |
| [platform-adapter.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/platform-adapter.md) | Adapter SPI 与最小接入 | ✅ |
| [fault-mode-plugins.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/fault-mode-plugins.md) | 故障模式插件化：五类 method、能力面、配方契约 | ✅ 已落地（2026-08-10） |
| [memory-file-loss.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/memory-file-loss.md) | 记忆丢失/损坏/投毒 FI 方案（FI-P0 文件层已落地；检测器属 RAS 规划） | 🟡 FI-P0 已落地 |
| [memory-noise-interference.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/memory-noise-interference.md) | 记忆噪声干扰 FI（Skill S1–S3 + middleware S4 已落地；S5 压缩失真未实施） | ✅ S1–S4 已落地 |
| [thinking-dead-loop.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/thinking-dead-loop.md) | 思考死循环 FI（Skill 三场景已落地；检测属 RAS） | ✅ |
| [tool-repeat-dead-loop.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/tool-repeat-dead-loop.md) | 工具重复死循环 FI（Skill 四场景已落地；检测属 RAS） | ✅ |
| [domain-cognitive-bias.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/reliability/agent-fault-injection/domain-cognitive-bias.md) | 领域认知偏差六类场景（FI 剧本 Phase1；检测器属 RAS 规划） | ⬜ 未实现（规划中） |

---

## guides/ — 使用

使用文档已迁入 tutorial/reliability 与 how-to/reliability，下列链接指向新位置。

| 文档 | 内容 | 状态 |
|------|------|------|
| [01-getting-started.md](../../../tutorial/reliability/agent-fault-injection/01-getting-started.md) | 最短启用 | ✅ |
| [local-install-process.md](../../../how-to/reliability/agent-fault-injection/local-install-process.md) | curl setup 逐步：目录 / Worker / 数据源 | ✅ |
