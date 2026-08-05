# Agent Fault Injection — 架构

## 目标

将原 `agent-fault-injection`（包名曾用 `agent-ras-eval`）合并进 agent-insight：

- Python：`agent_fault_injection/` — 六类注入 + 跑被测 Agent + 产出 `RawInteraction[]` 与注入证据
- Insight：Task/Run 编排、鉴权、Prisma、**服务端 Judge**（`getActiveConfig`）、可靠性 UI
- 本机：**FI Worker**（`scripts/fi-worker.js`）认领任务、spawn CLI、上传 `collect-result`

## 与 Insight / RAS 的边界

| | **agent-insight（平台）** | **agent-ras（模块）** | **agent-fi（本目录）** |
|--|--------------------------|----------------------|------------------------|
| 角色 | UI · API/协议 · DB · Judge | 环内检测 + 恢复实现 | 注入 + 采集实现 |
| 进程 | 服务端 | 用户本机 · 宿主同进程 | 用户本机 · Worker/CLI |
| 对 Agent | 不直接跑 | 被动检测并恢复 | 主动注入故障 |
| 交界 | 拥有契约与落库 | → `POST /api/ingest/ras-events` | → Worker + `collect-result` |

**前端与 Prisma（含 FaultInjection* / RasAnomalyEvent）一律属 Insight**，不算进 agent-fi / agent-ras 模块。

展开见关系说明：[ras-fi-insight-relationship.md](./ras-fi-insight-relationship.md)。分离拓扑：[server-client-split.md](./server-client-split.md)。

## 边界

| 做 | 不做 |
|----|------|
| Task 1:N Run；Faults/Tasks/Run 详情 UI | 保留 FastAPI / 独立 Vite |
| 轨迹唯一真源 `Session.interactions`（Prisma） | 产品契约暴露 trajectory/execution 多文件树；服务端读本机 artifact 路径 |
| Judge 在 Insight（二维 outcome×containment） | 本机 OpenCode `ras-judge`（默认） |
| 注入方式五类落地 + `route_manipulate` 预留 | 与环内 RAS detector **混同检测**；写 OTLP spool |
| 激活后桥接 `RasAnomalyEvent`（`source=fault_injection`） | 把注入实验伪装成环内实时检出 |
| 本机 FI Worker claim / heartbeat / stop | Next 进程内 `spawn` collector（已废弃） |

## 分层（当前实现）

```text
Browser → Next /api/fault-injection（建任务 queued / 展示 / Judge）
本机 FI Worker → heartbeat + claim → Python CLI(inject+collect)
       → POST /runs/:runId/collect-result
       → Session.interactions + Run.injectionEvidenceJson
       → server judge → RasAnomalyEvent bridge（dry-run 不写）
       → AgentTraceView / 可靠性观测

Dry-run：仅服务端 stub，不经 Worker。
```

旧同机 spawn 路径已删除。单机调试 = Next + Worker 两进程。

## 注入方式（catalog key）

`skill_inject` | `file_tamper` | `prompt_modify` | `tool_result_tamper` | `intercept_rewrite` | `route_manipulate`(不实现)

详见 [fault-inject.md](modules/fault-inject.md)。
