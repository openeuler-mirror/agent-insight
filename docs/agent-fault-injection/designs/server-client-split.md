# FI 服务端 / 客户端分离

> **状态**：✅ 已落地（2026-08-05）— 浏览器 E2E：无 Worker 提示 / dry-run stub / Worker inventory / claim→collect-result  

> **完整 SDD**：[phase2-requirements-design.md](../../design/fi-server-client-split/phase2-requirements-design.md)  
> **开发计划**：[phase3-development-plan.md](../../design/fi-server-client-split/phase3-development-plan.md)  
> **需求输入**：[phase1-requirements-analysis.md](../../design/fi-server-client-split/phase1-requirements-analysis.md)  
> **读者总览**：[ras-fi-insight-relationship.md](./ras-fi-insight-relationship.md)（Insight · RAS · FI 关系说明）

## 一句话

Insight **远程服务端**负责任务下发、状态/结果展示与 Judge；用户本机经 **curl / `install-fault-injection`** 安装 **FI Worker**，负责注入编排与 `agent_fault_injection` 能力；协议为 heartbeat + claim + collect-result（对齐 agent-ras 的「本机安装 + HTTP」，FI 因实验生命周期需要常驻 Worker）。

## 目标拓扑

```mermaid
flowchart TB
  subgraph remote [Insight_Server]
    UI[Browser_UI]
    API[FI_BFF]
    DB[(Prisma)]
    Judge[Judge]
  end
  subgraph userHost [User_Machine]
    Install[install_curl_or_npx]
    Worker[FI_Worker]
    CLI[agent_fault_injection]
    Agents[opencode_xiaoo]
  end
  Install --> Worker
  UI --> API --> DB
  Worker -->|claim_heartbeat| API
  Worker --> CLI --> Agents
  Worker -->|collect_result| API
  API --> Judge
```

## 废弃

旧「Next 同机 spawn collector」路径已删除；单机调试 = Next + Worker 两进程。

## 安装

```bash
# 远程 Insight
curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash

# 仓内 / npm
npx agent-insight install-fault-injection --start
# 检查
npx agent-insight install-fault-injection --check
```

细节与接口表见完整 SDD。

**评审**：初评 conditionally passed（71）→ 修订后四维约 83，见 [design-dimensions-review.md](../../design/fi-server-client-split/review/design-dimensions-review.md)。
