# Agent Fault Injection 文档

仓根 [`agent_fault_injection/`](../../agent_fault_injection/)：**agent-fi 功能实现模块**（注入 + 采集）。  
**前端 / DB / Worker 协议 / Judge** 属既有平台 [agent-insight](../..)；环内检测见 [`agent_ras/`](../../agent_ras/)。

## 关系说明（先读）

| | agent-insight（平台） | agent-ras（模块） | agent-fi（模块） |
|--|---------------------|-------------------|------------------|
| 职责 | UI · API/协议 · DB · Judge | 环内检测 + 恢复实现 | 注入 + 采集实现 |
| 部署 | 服务端（可远程） | 用户本机 · 宿主同进程 | 用户本机 · Worker/CLI |
| 不含 | — | 前端 / schema / 契约设计 | 前端 / FaultInjection* 表 / Judge |

展开：[designs/ras-fi-insight-relationship.md](designs/ras-fi-insight-relationship.md) §0–§1。

## 先读什么

| 目的 | 打开 |
|------|------|
| **Insight · RAS · FI 关系说明** | [designs/ras-fi-insight-relationship.md](designs/ras-fi-insight-relationship.md) · [图文](designs/ras-fi-insight-relationship.html) · [三产品逻辑图](designs/agent-insight-ras-fi-logic.html) |
| **服务端/客户端分离（FI）** | [designs/server-client-split.md](designs/server-client-split.md) · [phase2 SDD](../design/fi-server-client-split/phase2-requirements-design.md) |
| FI 模块架构摘要 | [designs/architecture.md](designs/architecture.md) |
| 内置故障覆盖矩阵 | [designs/fault-catalog.md](designs/fault-catalog.md) |
| **Lane A：新增故障模式** | [guides/lane-a-add-fault.md](guides/lane-a-add-fault.md) |
| 运行时注入（prompt / tool_result / intercept） | [designs/runtime-middleware-fault-injection.md](designs/runtime-middleware-fault-injection.md) |
| Task / Worker API（Insight） | [designs/modules/task-orchestration.md](designs/modules/task-orchestration.md) |
| 最短启用 | [guides/getting-started.md](guides/getting-started.md) |

## 特性状态

| 文档 | 内容 | 状态 |
|------|------|------|
| [ras-fi-insight-relationship.md](designs/ras-fi-insight-relationship.md) | 三者关系设计说明 | ✅ |
| [server-client-split.md](designs/server-client-split.md) | 远程任务 + 本机 Worker | ✅ 已落地（2026-08-05 浏览器 E2E） |
| [architecture.md](designs/architecture.md) | FI 模块边界摘要 | ✅ |
| [fault-catalog.md](designs/fault-catalog.md) | 内置故障覆盖矩阵 | ✅ |
| [runtime-middleware-fault-injection.md](designs/runtime-middleware-fault-injection.md) | 文件/运行时注入与证据边界 | ✅ |
| [xiaoo-platform-adaptation.md](designs/xiaoo-platform-adaptation.md) | xiaoO 被测平台适配 | ✅ |
| [insight-trace-compat.md](designs/insight-trace-compat.md) | interactions 契约 | ✅ |
| [agent-semantic-fault-injection-survey.md](designs/agent-semantic-fault-injection-survey.md) | 语义层 FI 调研附录 | ✅ |
| [task-orchestration.md](designs/modules/task-orchestration.md) | Insight FI API | ✅ |
| [fault-inject.md](designs/modules/fault-inject.md) | 六类 injection_method + 扩展车道 | ✅（route 未落地） |
| [lane-a-add-fault.md](guides/lane-a-add-fault.md) | Lane A 新增故障模式操作指南 | ✅ |
| [platform-adapter-contract.md](designs/modules/platform-adapter-contract.md) | Adapter 接入契约 | ✅ |
| [platform-adapter-spi.md](designs/modules/platform-adapter-spi.md) | Template Method SPI 对照 | ✅ |
| [opencode-rewrite-spike.md](designs/opencode-rewrite-spike.md) | OpenCode 消镜像 spike | ✅ |
| [server-judge.md](designs/modules/server-judge.md) | Insight Judge（含 inconclusive） | ✅ |
| [insight-bridge.md](designs/modules/insight-bridge.md) | Session 采集（已去 RAS bridge） | ✅ |
