# Benchmark xGovernor 本地 Docker 接入需求分析

本文描述设计意图；实施状态统一见[全仓需求清单](../../README.md)。

阅读顺序：本文 → [需求设计与 Mermaid 架构图](phase2-requirements-design.md) → [开发计划与验收](phase3-development-plan.md)。

## 1. 背景与目标

将原生单 Agent Pi/xiaoO 的 SWE-bench 执行整体切换到 xGovernor 本地 Docker：由 xGovernor 管理 Runtime 和工具沙箱，Agent Insight 继续负责实验、Case 调度、产物上传、Trace 关联和权威评测。

本次接入同时建立可替换的执行后端边界。后续 xGovernor 支持 OpenCode 时，可以复用 Docker 环境、Patch 收集、取消清理和评测链路；更换沙箱时，不应重新编写 Benchmark 调度或实例 Adapter。

## 2. 范围

| 对象 | 本轮要求 |
| --- | --- |
| Benchmark | SWE-bench，沿用已有 Case、任务说明、提交物与权威判分契约 |
| Agent | `pi-agent`、`xiaoo`，保持已有平台身份和 Agent 身份映射 |
| 执行环境 | 执行机本地 Docker，每 Case 独立环境，由 xGovernor 管理 |
| 接入方式 | 客户端管理每 Case 的 xGovernor daemon，通过会话 API 执行 |
| 产物 | 从本次环境工作树生成 `model.patch`，沿用现有上传协议 |
| Trace | 精确关联本次 Run、会话和原生轨迹，复用现有采集上传通道 |
| 生命周期 | 准备、执行、收集、取消、清理、客户端重启恢复 |
| 后续扩展 | 保留 OpenCode Runtime 注册、xGovernor Provider 替换、整个执行后端替换的边界 |

本轮不迁移 MCTS、OpenCode、普通生成 Trace 实验、Skill 实验或故障注入；不替换 Evaluator、官方 Harness、评测镜像池和结果归一化；不建设共享 xGovernor daemon、多租户执行平台或可视化沙箱配置中心。

OpenCode 在本轮只作为架构扩展约束，不能因登记了名称就开放运行能力。

## 3. 当前执行链路的约束

代码核对基线为 2026-10-20，以下事实用于解释改动原因，不表示目标方案已经实现。

| 位置 | 当前约束 | 接入需要解决的问题 |
| --- | --- | --- |
| [执行器 Runner](../../../services/executor/src/index.cjs) | 先准备本机 Git 目录，将 `workspace.path` 传给 Agent；Collector 与恢复清理也依赖本机路径 | 执行、收集与清理必须使用同一执行环境句柄 |
| [常驻客户端](../../../scripts/reliability-client.cjs) | 原生 CLI 探测和 `runExperimentCase()` 支撑普通实验及部分 Benchmark 执行 | Benchmark readiness 要与普通实验 readiness 分开 |
| [任务协议](../../../packages/benchmark-protocol/src/contracts.ts)及 [JSON Schema](../../../packages/benchmark-protocol/schemas/agent-task.schema.json) | 没有独立执行环境描述，Schema 顶层拒绝未知字段 | 明确扩展字段、配置冻结和客户端能力门控 |
| [SWE-bench Adapter](../../../benchmarks/swe-bench/adapter/index.ts) | 输出公开任务、Git 仓库与基线；当前网络策略为 `client-default` | 为新执行目标声明容器环境需求，网络策略显式切换为 `deny` |
| [调度 watchdog](../../../src/lib/benchmark/scheduler.ts) | 准备与运行阶段采用现有超时规则 | 镜像准备、Agent 执行和失联检测需要分别计时 |

仅替换 `runAgent` 命令无法覆盖上述生命周期，不作为本次接入方案。

## 4. xGovernor 的接入前提

依据上游[协议边界](https://gitcode.com/openeuler/xGovernor/blob/master/docs/protocol_boundaries.md)、[Runtime 接入指南](https://gitcode.com/openeuler/xGovernor/blob/master/docs/agent_runtime_guide.md)、[SWE-bench runner 说明](https://gitcode.com/openeuler/xGovernor/blob/master/docs/swebench_runner.md)及 [Docker 实现](https://gitcode.com/openeuler/xGovernor/blob/master/crates/backend/src/docker/mod.rs)确定以下设计前提。实施时必须固定并记录实际使用的上游 commit、server/worker 和 Runtime 依赖版本，重新执行能力验证。

- Runtime 与 Provider 分层；Pi、xiaoO 通过 `OperationBackend` 执行工具操作。
- 当前 Docker 镜像和 CPU/内存等资源配置属于 daemon 进程级设置，不能假设会话 API 已支持逐 Case 覆盖。
- 上游 SWE-bench runner 使用每 Case 独立 daemon 和官方实例镜像；本轮采用相同部署粒度。
- Docker 接入当前为实验性、管理员使用模式。客户端与临时 daemon 同机，调用 loopback 管理面；必须满足上游要求的监听、认证和租户面配置，不能省略这些启动条件。
- 工具容器可以断网，模型请求由宿主机 Runtime 发出；本轮隔离对象是工具执行环境，CPU/内存限制不等于整个 Agent 控制器的资源限制。
- Pi 原生 JSONL 和 xiaoO 原生轨迹导出应分别验证。SSE 工具活动摘要不足以证明完整轨迹已经采集。
- 上游完整批量脚本还管理数据集、判分和输出，不作为 Agent Insight 的整体执行入口。

这里不承诺任意 Linux 环境具有相同能力。一期正式验收环境是满足所选 xGovernor Docker 版本要求的 Linux、本机 Docker socket、cgroup v2 及对应架构镜像。

## 5. 功能要求

1. 新建的 SWE-bench + Pi/xiaoO 任务选择冻结的 xGovernor Docker Profile；缺失或不满足配置时拒绝执行，不能静默回退到原生宿主机执行。
2. 每个 Case 使用独立 daemon 状态目录、会话、容器和输出目录；并发复用现有实验并发机制，并受本机资源准入限制。
3. 使用受控来源的官方实例镜像，准备后核对仓库与 `baseCommit`，从干净基线开始执行。Agent 不接收参考补丁、测试补丁、隐藏测试名单或评测脚本。
4. Agent 类型和执行环境分别选择与冻结，保留 `pi-agent`、`xiaoo` 身份，不新增 `pi-docker` 等组合平台名。
5. 保留模型 ID 选择与现有任务说明；模型凭据在客户端本机解析，按 xGovernor 合同传递。原生 CLI 的凭据、个人扩展和 Skill 发现不能假定自动继承，不支持的配置必须明确报告。
6. 网络、资源和超时配置有请求值与实际生效事实；不满足冻结要求时，在提交任务说明前失败。
7. Artifact、Trace 和完成回调分别持久化，重试上传或回调不能重新运行 Agent。
8. 取消必须到达本次会话；资源状态不确定时保持待清理状态，不能提前报告清理成功或释放对应资源预算。
9. 客户端重启只恢复记录、回传或清理自己拥有的资源，不自动重跑已提交的 Agent。

## 6. 扩展要求

| 场景 | 允许的扩展落点 | 应直接复用 |
| --- | --- | --- |
| xGovernor 支持 OpenCode | Runtime 映射、参数/模型映射、Trace 转换、能力注册与测试 | Runner、Docker 管理、Git Patch Collector、上传与 Evaluator |
| 保留 xGovernor，替换 Provider | Profile 和 xGovernor 内对应 Provider/normalizer 适配；校验新 Provider 能力 | 任务、Runtime 协议、产物、Trace 关联与平台调度 |
| 替换整个 xGovernor 执行后端 | 新增符合公共合同的 `ExecutionBackend`，负责等价的 Agent 启动和环境操作 | Benchmark Adapter、公共 Runner、回调、Evaluator 与结果页面 |

公共 Runner、平台调度器和通用 Collector 不允许新增 `platform === 'opencode'` 等平台判断来接入新 Runtime。替换整个后端仍需适配其协议，不能把裸沙箱 API 当作完整 Agent 执行能力。

## 7. 数据与文档边界

设计优先复用现有实验配置快照、客户端能力 JSON、任务信封、Run facts 和本地运行日志，不新增 Prisma 表或 Agent Insight API 路由。新增字段与校验属于既有合同扩展，必须同步 Schema、摘要和兼容测试。

本轮产出只包含设计文档和设计索引。实现完成时再同步用户操作指南、开发者指南、安装说明，避免把计划写成现有使用方式。
