# Phase1：FI 服务端/客户端分离 — 需求分析

> IR 名称：FI Server-Client Split  
> 创建时间：2026-08-05  
> 状态：设计输入（对齐用户口述需求）

## 1. 问题陈述

当前故障注入（FI）在 Insight **Next 进程内** `spawn` Python collector（[`queue.ts`](../../../src/lib/fault-injection/queue.ts) → [`engine.ts`](../../../src/lib/fault-injection/engine.ts)）。这要求被测 Agent（OpenCode / xiaoO）与 Insight **同机**，与平台既定拓扑——**远程 Insight 服务 + 用户本机薄客户端**——冲突。

agent-ras 已证明可行路径：本机安装能力（`install-ras` / setup curl），服务端只做配置与观测。

## 2. 目标与非目标

**目标**

- 任务下发、状态/结果展示、Judge、可靠性桥接留在 **Insight 服务端**。
- 故障注入编排与注入能力实现在 **用户本机客户端（FI Worker）**。
- 用户使用前有与 agent-ras 同级的 **curl / CLI 安装步骤**，能力装到本机。
- 服务端与客户端边界清晰，可独立演进与部署。

**非目标**

- 不改变 FI 与环内 RAS 的产品边界（注入评测 ≠ 运行时检测恢复）。
- 不在本需求内重写故障 catalog / platform adapter 注入语义。
- 不把 Judge 下沉到本机。
- 不引入 WebSocket 作为 MVP 必需（可用短轮询）。

## 3. 用户故事

1. 作为远程 Insight 用户，我在 Web 创建注入任务后，任务在**我本机**跑 Agent，结果回传到服务端展示。
2. 作为用户，我通过一条 curl（或 `npx agent-insight install-fault-injection`）完成本机 Worker 安装与配置。
3. 作为用户，未安装/未启动 Worker 时，UI 明确提示，而不是静默假数据或服务端报错难懂。
4. 作为用户，我可在 UI 停止任务；本机 Worker 终止对应 collector 进程。

## 4. 约束

- 鉴权对齐 ingest：`x-witty-api-key` → 用户隔离。
- `agent_fault_injection/` 已在 npm `files` 中发布，安装路径可复用 `install-ras` 的「从包内拷贝/ pip install -e」。
- Prisma 已有 `FaultInjectionTask` / `FaultInjectionRun`；需扩展 Worker 与认领字段。
- 单机开发：允许同机跑 Next + Worker 两进程，但**禁止** Next 再 spawn collector。

## 5. 验收信号（设计阶段）

- 设计文档明确拓扑、协议、状态机、安装 UX、迁移与冻结区。
- 评审覆盖合理性 / 可行性 / 可维护性 / 可用性，结论可指导开发计划。
