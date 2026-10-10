# Design Feasibility Review — FI Server-Client Split

> Reviewer: Red Team (feasibility checklist)  
> SDD: [`phase2-requirements-design.md`](../phase2-requirements-design.md)  
> IR: [`phase1-requirements-analysis.md`](../phase1-requirements-analysis.md)  
> Spot-check: `queue.ts` / `engine.ts` / `store.ts` / `platforms.ts` / `tasks/route.ts` / `install-fault-injection.js` / Prisma FI models / `package.json` `files`  
> Date: 2026-08-05

## Fact

- [ERROR] [Fact] IF-N01 写成「CLI `run --run-id`」易被读成「仅凭 runId 即可采集」。现网 [`cli.py`](../../../agent_fault_injection/cli.py) 中 `--run-id` 只是产物 ID；`--platform/--agent/--fault/--prompt/--workspace` 等仍为必填（除非 YAML config）。Worker 必须按 claim 回包拼齐参数，与 [`engine.runCollector`](../../../src/lib/fault-injection/engine.ts) 一致。
- [WARNING] [Fact] IF-E01b 写 `taskId`，现网 [`tasks/stop/route.ts`](../../../src/app/api/fault-injection/tasks/stop/route.ts) 契约是 `taskIds: string[]`，且仅当 `task.status === 'running'` 才处理；目标态若引入 Task `queued`，现 stop 门闩会直接跳过未开跑任务。
- [WARNING] [Fact] §5.3 称创建后 Task 可为 `queued`，并「沿用 `refreshTaskProgress`」。现 [`store.createTaskWithRuns`](../../../src/lib/fault-injection/store.ts) 固定 `status: 'running'`，且 `refreshTaskProgress` 在未全部终态时一律写成 `running`——「全 queued」展示不会自然出现，必须改聚合规则，不能只扩枚举。
- [WARNING] [Fact] 状态机 §3.3 缺现网已存在的 Run/Task 状态 `dry_run`（[`ingestCollectAndJudge`](../../../src/lib/fault-injection/store.ts) / `refreshTaskProgress` 已统计）。冻结 Judge 契约的同时漏掉 stub 终态会误导实现与 UI。
- [INFO] [Fact] 对现状瓶颈的判断正确：[`tasks/route.ts`](../../../src/app/api/fault-injection/tasks/route.ts) → `enqueueFaultInjectionRuns` / 同步 `runCollector`；[`platforms.ts`](../../../src/lib/fault-injection/platforms.ts) / health 用服务端 `which`；`package.json` `files` 已含 `agent_fault_injection/`；Prisma 尚无 Worker 表与 Run 租约字段——与 IR/SDD 一致。

## Omission

- [ERROR] [Omission] **Workspace 本机解析未定义**。UI 对 `~` 路径传 `undefined`，服务端用 `os.homedir()` 展开并写入 `FaultInjectionTask.workspace`（[`tasks/route.ts`](../../../src/app/api/fault-injection/tasks/route.ts) + [`tasks/new/page.tsx`](../../../src/app/(main)/agent-ras/fault-injection/tasks/new/page.tsx)）。分离后该绝对路径属于**服务器用户家目录**，Worker 在用户本机执行会指向错误目录甚至无权限。仅列 `workspaceBase` 配置不够，必须规定：服务端禁止展开 `~`、Worker 用本机 `workspaceBase` 解析、存量绝对路径如何迁移。
- [ERROR] [Omission] **Dry-run / 同步 stub 路径未设计**。现网 `dryRun:true` 与 `AGENT_INSIGHT_FI_DRY_RUN=1` 在 Next 内 `buildStubCollectPayload` 或同步 `runCollector`，不经队列。D-001 禁止服务端 spawn 后，E2E/联调 stub 落在 Worker 还是服务端无进程 stub，设计未选边；测试与验收会悬空。
- [WARNING] [Omission] **Claim 超时回收缺少执行主体**。§2.2.1 要求 BFF 回收 `collecting`，但 §6.3 把 `claimTimeoutSec` 放进 Worker `config.json`；未说明 cron / 每次 claim|heartbeat 顺带 sweep / 独立 job。无调度点则租约泄漏，任务永久卡在 `collecting`。
- [WARNING] [Omission] **Stop 竞态未钉死**。现 stop 立即 `updateMany` 把 `queued|collecting|…` 标 `stopped` 并进程内 `killCollector`。目标态若仍抢先改终态，会与 Worker 稍后 `collect-result` 上传冲突（设计提 409 但未规定 stop 后是否允许 partial ingest、Task 何时从 `running` 变 `stopped`）。
- [WARNING] [Omission] **入口面覆盖不全**：[`task/.../rerun`](../../../src/app/api/fault-injection/task/[taskId]/rerun/route.ts) 仍同步 `runCollector`（迁移 §8.2 点到但模块表未列）；[`health`](../../../src/app/api/fault-injection/health/route.ts) 仍 `listPlatformsPreflight`（UI 创建页依赖）；[`faults`](../../../src/app/api/fault-injection/faults/route.ts) 仍服务端 `listFaultsViaPython`——远程部署无 Python/包路径时 catalog 也会挂，设计未声明「faults 留服务端包内」或「改静态/缓存」。

## Feasibility

- [ERROR] [Feasibility] Workspace 未本机化时，默认 golden path（UI 留空/`~` → 建任务 → Worker claim → CLI `--workspace`）在远程 Insight 上**必然失败**；这不是边角，是主路径可行性缺口，开发前必须补契约。
- [WARNING] [Feasibility] §4.1「先取 `queued` LIMIT 1 再按 `runId` 更新」存在 TOCTOU；真正防双领需单语句条件更新（`updateMany` where `status=queued` 且校验 `count`）或事务内「读改写」并接受 SQLite 写串行。伪代码两写法并列，实现易选错。
- [WARNING] [Feasibility] [`install-fault-injection.js`](../../../scripts/install-fault-injection.js) 现状只 `pip install -e $cwd/agent_fault_injection`，无 `insightBaseUrl`/`apiKey`/`--start`、无 npm 包内路径解析；设计目标正确但相对现状落差大，且 **Worker 常驻**无 systemd/launchd/用户级 supervisor，仅「可选启」在登出/关机后不可用——可用性与安装验收成本被低估。
- [WARNING] [Feasibility] `engine.ts` 的 `packageRoot()=process.cwd()/agent_fault_injection` 与进程组杀逻辑迁到 Worker 后，若「共享 lib 拷贝」落地成双份，kill/artifact 查找易漂移；应明确单一模块归属（Worker 脚本引用打包路径，Next 仅保留 stub/faults 所需最小面）。
- [INFO] [Feasibility] 短轮询 + Prisma 条件更新 + 复用 CLI + Judge 留服务端，技术栈成熟，与 ingest apiKey 模型一致；`collect-result` 路由确为新增（当前无该 API），MVP 不分片可接受但需文档化 payload 上限预期。

## Alternatives

| 路线 | 相对本设计 | 评注 |
|------|------------|------|
| 服务端 opt-in spawn | 设计已否决 | 同意：远程误开风险与双路径漂移真实存在于当前 `useAsync`/`dryRun` 分叉。 |
| 浏览器直连本机 Worker | 设计已否决 | 同意：破坏远程 UI / TLS。 |
| 无常驻、按需拉起 | 设计已否决 | 同意：stop/claim 时效不够；但应补「用户级常驻」最小方案（如 `agent-insight fi-worker` + 安装后提示 keep-alive），否则常驻本身成为采用障碍。 |
| **未讨论：服务端只存逻辑 workspace，物理路径仅 Worker 解析** | — | 应升为默认方案，否则无法落地。 |
| **未讨论：dry-run 纯服务端 stub（`buildStubCollectPayload`，零 spawn）** | — | 可保留联调/E2E 而不违反 D-001；比强制 Worker 跑 stub 更便宜。 |
| WS/SSE 推送 stop | MVP 否决合理 | 可接受 pollInterval 延迟；非阻塞。 |

## Key Attentions

1. **Workspace 契约**：禁止服务端 `os.homedir()` 写入跨主机无意义绝对路径；Worker 用本机 `workspaceBase` 解析；迁移存量 Task。
2. **Stop / claim 租约**：`stopRequested` 与终态写入时序、upload 409/partial、以及 **服务端** claim 超时 sweep 的触发点必须在 phase3 前写成硬规则。
3. **删除 spawn 的完整调用闭包**：`tasks` / `rerun` / 同步 dry-run / E2E；并改写 `health` inventory 来源，避免 UI 继续相信服务端 PATH。

## Gate

- grade: conditionally passed
- reason: 拓扑拆分（BFF 元数据 + 本机 Worker claim/CLI + Judge 留云）与现状代码及 IR 目标对齐，技术路线可行且否决项合理；但默认 workspace 仍按服务端家目录落库、dry-run/stub 与 claim 超时调度未定义、stop 与现网立即终态化冲突，属开发前必须补齐的契约缺口，而非推倒重来。补齐上述三项后方可进 phase3。

## Dimensions

| 维度 | 分 | 证据 |
|------|----|------|
| reasonableness（合理性） | 80 | D-001～003 与远程 Insight + 本机 Agent 拓扑、agent-ras 对照一致；问题诊断匹配 `queue`/`engine` 现实。 |
| feasibility（可行性） | 60 | 主路径 workspace 跨机错误未解；租约回收与 dry-run 落点缺失；安装器/常驻相对现状落差大。 |
| maintainability（可维护性） | 75 | 单路径删除 spawn 正确；但 engine 迁移动作若「拷贝」易双实现；入口表漏 rerun/health。 |
| usability（可用性） | 68 | curl/npx 对齐 RAS 方向对；常驻 Worker、health/假 PATH、stop 延迟与无 Worker 引导需更硬的产品契约。 |

**综合分**: 71（四维平均）
