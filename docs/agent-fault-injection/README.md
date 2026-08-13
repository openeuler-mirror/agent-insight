# Agent Fault Injection 文档

仓根 [`agent_fault_injection/`](../../agent_fault_injection/)：**agent-fi 功能实现模块**（注入 + 采集）。  
**前端 / DB / Worker 协议 / Judge** 属既有平台 [agent-insight](../..)；环内检测见 [`agent_ras/`](../../agent_ras/)。

## 关系说明（先读）

| | agent-insight（平台） | agent-ras（模块） | agent-fi（模块） |
|--|---------------------|-------------------|------------------|
| 职责 | UI · API/协议 · DB · Judge | 环内检测 + 恢复实现 | 注入 + 采集实现 |
| 部署 | 服务端（可远程） | 用户本机 · 宿主同进程 | 用户本机 · Worker/CLI |
| 不含 | — | 前端 / schema / 契约设计 | 前端 / FaultInjection* 表 / Judge |

展开：[designs/modules/ras-fi-insight-relationship.md](designs/modules/ras-fi-insight-relationship.md) §0–§1。

## 先读什么

| 目的 | 打开 |
|------|------|
| **Insight · RAS · FI 关系说明** | [designs/modules/ras-fi-insight-relationship.md](designs/modules/ras-fi-insight-relationship.md) |
| **服务端/客户端分离（FI）** | [designs/features/server-client-split.md](designs/features/server-client-split.md) · [phase2 SDD](../design/fi-server-client-split/phase2-requirements-design.md) |
| **本机 curl 安装过程** | [guides/local-install-process.md](guides/local-install-process.md) |
| FI 模块架构摘要 | [designs/architecture.md](designs/architecture.md) |
| 内置故障覆盖矩阵 | [designs/modules/fault-catalog.md](designs/modules/fault-catalog.md) |
| **新增故障模式** | [designs/features/fault-mode-plugins.md](designs/features/fault-mode-plugins.md) |
| 运行时注入（prompt / tool_result / intercept） | [designs/features/runtime-middleware-fault-injection.md](designs/features/runtime-middleware-fault-injection.md) |
| Task / Worker / Judge（Insight） | [designs/features/server-client-split.md](designs/features/server-client-split.md) |
| 最短启用 | [guides/getting-started.md](guides/getting-started.md) |
| **用户指南（产品路径）** | [user-guide/observability/fault-injection.md](../user-guide/observability/fault-injection.md) |

---

## designs/ — 设计

### 架构

| 文档 | 内容 | 状态 |
|------|------|------|
| [architecture.md](designs/architecture.md) | FI 模块边界摘要 | ✅ |

### 模块

| 文档 | 内容 | 状态 |
|------|------|------|
| [ras-fi-insight-relationship.md](designs/modules/ras-fi-insight-relationship.md) | 三者关系设计说明 | ✅ |
| [fault-catalog.md](designs/modules/fault-catalog.md) | 内置故障覆盖矩阵 | ✅ |
| [xiaoo-platform-adaptation.md](designs/modules/xiaoo-platform-adaptation.md) | xiaoO 被测平台适配 | ✅ |
| [opencode-platform-adaptation.md](designs/modules/opencode-platform-adaptation.md) | OpenCode 被测平台适配 | ✅ |

### 特性

| 文档 | 内容 | 状态 |
|------|------|------|
| [server-client-split.md](designs/features/server-client-split.md) | 远程任务 + 本机 Worker；collect/Judge/Trace join | ✅ 已落地（2026-08-05 浏览器 E2E） |
| [runtime-middleware-fault-injection.md](designs/features/runtime-middleware-fault-injection.md) | 运行时数据面注入方案：挂点、步骤契约、表驱动同源 | ✅ |
| [platform-adapter.md](designs/features/platform-adapter.md) | Adapter SPI 与最小接入 | ✅ |
| [fault-mode-plugins.md](designs/features/fault-mode-plugins.md) | 故障模式插件化：五类 method、能力面、配方契约 | ✅ 已落地（2026-08-10） |
| [memory-file-loss.md](designs/features/memory-file-loss.md) | 记忆丢失/损坏/投毒 FI 方案（FI-P0 文件层已落地；检测器属 RAS 规划） | 🟡 FI-P0 已落地 |
| [memory-noise-interference.md](designs/features/memory-noise-interference.md) | 记忆噪声干扰 FI（Skill S1–S3 + middleware S4 已落地；S5 压缩失真未实施） | ✅ S1–S4 已落地 |
| [thinking-dead-loop.md](designs/features/thinking-dead-loop.md) | 思考死循环 FI（Skill 三场景已落地；检测属 RAS） | ✅ |
| [tool-repeat-dead-loop.md](designs/features/tool-repeat-dead-loop.md) | 工具重复死循环 FI（Skill 四场景已落地；检测属 RAS） | ✅ |
| [domain-cognitive-bias.md](designs/features/domain-cognitive-bias.md) | 领域认知偏差六类场景（FI 剧本 Phase1；检测器属 RAS 规划） | ⬜ 未实现（规划中） |

---

## guides/ — 使用

| 文档 | 内容 | 状态 |
|------|------|------|
| [getting-started.md](guides/getting-started.md) | 最短启用 | ✅ |
| [local-install-process.md](guides/local-install-process.md) | curl setup 逐步：目录 / Worker / 数据源 | ✅ |
