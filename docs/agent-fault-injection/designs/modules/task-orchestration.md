# Task 编排

> **当前实现**：服务端只写 `queued`；本机 FI Worker `claim` 后执行。协议见 [server-client-split.md](../server-client-split.md) / [phase2 SDD](../../../design/fi-server-client-split/phase2-requirements-design.md)。

## 模型

- **FaultInjectionTask**（`task-{hex}`）：一次实验，含 N 个故障项；状态含 `queued|running|completed|failed|stopped|dry_run`
- **FaultInjectionRun**：单故障一次采集+评判；`sessionTaskId` 对齐 `Session.taskId`；含 `workerId` / `stopRequested` / `queuedAt` / `claimedAt`
- **FaultInjectionWorker**：本机 Worker 注册；`lastSeenAt` + `inventoryJson`（平台 agents/models）

`Task.workspace` 存**逻辑值**（`__default__` / 相对 / `~` / 用户绝对路径原文），禁止服务端用自家 `homedir` 展开后写入跨主机路径；Worker 用本机 `workspaceBase` 解析。

## BFF（`/api/fault-injection`）

任务与展示：

- `POST/GET /tasks`、`GET /task/:taskId`、`POST /tasks/stop`、`POST /tasks/delete`、`POST /task/:taskId/rerun`
- `GET /runs/:runId`、`GET .../trace`、`POST .../rejudge`
- `GET /faults`、`GET /platforms`、`GET /platforms/:platform/agents|models`、`/health`
- `GET /setup` — curl 安装脚本

Worker 协议：

- `POST /worker/heartbeat` — 续命 + inventory；入口做 claim 超时 sweep
- `POST /worker/claim` — 原子认领 `queued` → `collecting`
- `POST /worker/commands` — 拉取 stop 等命令
- `POST /runs/:runId/collect-result` — ingest + judge + RAS bridge

行为要点：

- `POST /tasks`：真实路径只落库 `queued`，**不** `enqueue`/`spawn`；`dryRun:true` 或 `AGENT_INSIGHT_FI_DRY_RUN=1` 走服务端 stub
- Stop：`queued`+`stopRequested` 可直接 `stopped`；`collecting` 保持至 Worker kill 后上报或超时
- platforms/health：读在线 Worker inventory；无 Worker → 引导安装，禁假目录
- 鉴权：`x-witty-api-key` → user。并行度在 Worker config `maxParallel`（默认 2）

服务端 which/adapter catalog 与同机 spawn 队列已删除；采集只经 FI Worker。
