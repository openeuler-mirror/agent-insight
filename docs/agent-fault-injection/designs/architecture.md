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
| Judge 在 Insight（二维 outcome×containment） | 本机 Python Judge（已删除） |
| 注入方式五类落地 | 与环内 RAS detector **混同检测**；写 OTLP spool |
| FI Run / Session 观测注入结果 | ~~激活后桥接 `RasAnomalyEvent`~~（已移除；观测靠正常轨迹上报） |
| 本机 FI Worker claim / heartbeat / stop | Next 进程内 `spawn` collector（已废弃） |

## 分层（当前实现）

```text
Browser → Next /api/fault-injection（建任务 queued / 展示 / Judge）
本机 FI Worker → claim → Python CLI(inject+collect)
       → POST /runs/:runId/collect-result
       → Session.interactions + Run.injectionEvidenceJson（恒为 `{}`，字段已废弃）
       → server judge（写入 FI Run；不写 RasAnomalyEvent）
       → FI Run 页 / AgentTraceView

任务创建后一律 `queued`，由本机 Worker claim 执行（不再提供 dry-run / 服务端 stub 产品入口）。
```

旧同机 spawn 路径已删除。单机调试 = Next + Worker 两进程。
Worker inventory：`which` + 静态 builtin agents + 读本地配置 models（**不**在启动时调 `opencode agent list` / `opencode models`）。

## 包目录（Python）

```text
agent_fault_injection/
├── cli.py
├── pipeline/          # inject → run → artifacts → collect-result
│   └── interactions_mapper.py   # 原 trace/
├── fault_inject/
│   ├── skills/
│   ├── catalog/       # models / registry / ui_catalog / yamls
│   └── injection/     # installer / apply_plan / file_ops / rewrite_engine
└── platform_adapters/
```

## 注入方式（catalog key）

`skill_inject` | `file_tamper` | `prompt_modify` | `tool_result_tamper` | `intercept_rewrite`

详见 [fault-inject.md](modules/fault-inject.md) · [fault-catalog.md](fault-catalog.md) · [runtime-middleware-fault-injection.md](runtime-middleware-fault-injection.md)。

## 注入能力分层（三维）

| 轴 | 含义 | 落点 |
|----|------|------|
| **注入方式** | 怎么注入 | catalog `injection_method` |
| **故障类型** | 注入什么语义 | `fault_inject/skills/*` |
| **变异模式** | Structure vs Semantic | runtime op（P0 多为 Structure） |

代码分层：

```text
catalog / fault.json + capability_api.yaml  → L2 能力面（封闭 op/method）
apply_plan / runtime_env / lifecycle        → 薄胶水
fault_inject/injection/                     → L3：file_ops + rewrite_engine
PlatformAdapter Template Method + SPI       → L4：平台只接线
OpenCode rewrite-runtime.ts（`platform_adapters/opencode/lib/`） → 表驱动薄层（隔离环境拷到 `config/lib/`，勿进 `plugins/`）
collect_payload                             → interactions（injectionEvidence 固定 `{}`，已废弃）→ Insight Judge
```

不做：完整 Ports 六边形；L2 Method 类 Facade；FI→RasAnomalyEvent bridge。
