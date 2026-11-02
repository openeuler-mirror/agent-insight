---
title: "Agent-Insight — 开发者指南"
description: "提供 Agent Insight 开发者指南的主题导航、实现查找入口与常用术语解释。"
keywords: ["Agent Insight", "开发者指南", "文档导航", "术语表"]
changefreq: monthly
---

<a id="agent-insight-—-开发者指南"></a>
<a id="agent-insight--开发者指南"></a>
> Agent-Insight（npm 包 `agent-insight`）是一个框架无关、自托管的平台，用于**观测**、**评测**和**优化** AI Agent 及其 Skill。
> 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + Prisma + Tailwind，内部 Agent 使用 LangChain/LangGraph + deepagents，trace 接入使用 OpenTelemetry。受众：开发者与 LLM 编码 Agent。
> 本页用于查找开发者指南和常用术语；按需阅读对应页面。

## Documents
- [positioning.md](./positioning.md)：项目为何存在、面向谁、所属领域、成熟度。
- [architecture.md](./architecture.md)：系统形态、技术栈、分层、模块依赖图、入口面。
- [modules.md](./modules.md)：每个模块的职责；哪些是核心模块、哪些是外围模块。
- [file-map.md](../../reference/platform/file-map.md)：文件 → 模块 → 符号的查找表，用于定位代码。
- [api-and-contracts.md](../../reference/platform/api-and-contracts.md)：导出的函数签名及其调用关系、数据模型/类型、扩展点。
- [data-control-flow.md](./data-control-flow.md)：核心流程（接入、评测、生成、优化、诊断）的入口与执行轨迹。
- [frontend.md](./frontend.md)：前端框架、路由、组件关系。
- [conventions-and-extension.md](../../how-to/platform/conventions-and-extension.md)：约定以及如何新增代码；关键实现入口。
- [design-system.md](../../reference/platform/design-system.md)：视觉设计语言、设计令牌、排版、控件尺寸、UI/UX 审计与漂移检测。机器可读的令牌：[design-tokens.json](../../reference/platform/design-tokens.json)。
- [otlp-attribute-contract.md](../../reference/observability/otlp-attribute-contract.md)：OTLP 属性契约（FR-011），定义 OpenClaw 及其他 OTLP 客户端上报 trace/log 时必须遵守的属性规范；含 RAS 旁路 ingest（非 OTLP）说明。
- [develop-evaluator.md](../../how-to/evaluation/develop-evaluator.md)：新增/改造评测中心评估器。含打分方法论（禁止自由打分、分解+确定性汇总、三档锚定、精确率/召回率/有据性三轴）与工程接入（契约、注册元数据、canonical 影响面、坑位）。
- [usage-analytics.md](./usage-analytics.md)：平台用量统计（管理员专用）。有效使用口径注册表、有界队列与故障隔离约束、双数据库存储契约、新增统计事件的方法。
- [goal-plus.md](../observability/goal-plus.md)：重构后 Goal Plus 的 Pi 主绑定、worker OTLP、关系 outbox 与主从 Trace 展示契约。
- [cross-session-collaboration.md](../observability/cross-session-collaboration.md)：跨 Session 绑定/关系事件、端点解析、查询 API 与 reported Goal Plus 投影。
- [MCTS xGovernor 方案设计](https://gitcode.com/openeuler/agent-insight/blob/master/design/observability/mcts-trace-observability/phase2-requirements-design.md)：非侵入式透明代理、Runtime/checkpoint ledger、OTLP 与跨 Session 关系采集契约。
- [benchmark/README.md](../evaluation/benchmarks/navigation.md)：自定义 Benchmark 的客户入口、需求发现、统一接入开发规范和[通用服务部署指南](../../how-to/evaluation/benchmarks/deploy-services.md)。
- [benchmark/swe-bench-deployment-guide.md](../../how-to/evaluation/benchmarks/deploy-swe-bench.md)：SWE-bench 数据集、Case 源码、评测镜像与部署验收。
- [benchmark/zsoft-deployment-guide.md](../../how-to/evaluation/benchmarks/deploy-zsoft.md)：ZSoft 数据集、原生任务目录、评测资产、内核加速与部署验收。
- [release-zsoft-assets.md](../../how-to/evaluation/benchmarks/release-zsoft-assets.md)：维护者构建、冻结和发布 ZSoft userspace 与内核评测资产。
- [qoder-cn-acceptance-validation.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/observability/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md)：Qoder CN 产品家族 Trace 采集器 AC1–AC37 的完整验收、真实客户端演示、性能、卸载和数据正确性测试。
- [qoder-cn-cross-machine-validation.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/observability/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md)：Qoder CN 采集器与 Agent Insight 服务端分布在不同机器时的安装、上传、排查和卸载验证。
- [release-docker-image.md](../../how-to/platform/release-docker-image.md)：维护者发布 Docker Hub 多架构镜像、验证 manifest、导出离线 `.tar` 镜像包的流程。
- 仓根 [`agent_ras/`](https://gitcode.com/openeuler/agent-insight/tree/master/agent_ras)：环内可靠性同进程真源（OpenCode L3 inproc）；统一安装入口见 [`scripts/install-ras.js`](https://gitcode.com/openeuler/agent-insight/blob/master/scripts/install-ras.js)。
- 仓根 [`agent_fault_injection/`](https://gitcode.com/openeuler/agent-insight/tree/master/agent_fault_injection)：故障注入引擎（注入+采集）；文档 [`docs/zh/explanation/reliability/agent-fault-injection/`](../reliability/agent-fault-injection/navigation.md)；UI `/agent-ras/fault-injection/tasks`（目录 `/faults`），BFF `/api/fault-injection`。
- Agent RAS 文档统一入口：[`docs/zh/explanation/reliability/agent-ras/`](../reliability/agent-ras/navigation.md)（[designs](https://gitcode.com/openeuler/agent-insight/tree/master/design/reliability/agent-ras) / [guides](../../how-to/reliability/agent-ras/)）。

## Quick lookup
| 我想要... | 前往 |
|---|---|
| 了解整体全貌 | [architecture.md](./architecture.md) |
| 了解每个目录的作用 | [modules.md](./modules.md) |
| 查找哪个文件实现了 X | [file-map.md](../../reference/platform/file-map.md) |
| 调用或扩展某个引擎 API / 类型 | [api-and-contracts.md](../../reference/platform/api-and-contracts.md) |
| 端到端跟踪接入 / 评测流程 | [data-control-flow.md](./data-control-flow.md) |
| 接入新的 Benchmark | [Benchmark 文档关系与开发指南](../evaluation/benchmarks/navigation.md) · [conventions-and-extension.md](../../how-to/platform/conventions-and-extension.md) |
| 部署 Benchmark 服务与数据 | [通用服务部署](../../how-to/evaluation/benchmarks/deploy-services.md) · [SWE-bench](../../how-to/evaluation/benchmarks/deploy-swe-bench.md) · [ZSoft](../../how-to/evaluation/benchmarks/deploy-zsoft.md) |
| 新增 API 路由或页面 | [architecture.md](./architecture.md) · [conventions-and-extension.md](../../how-to/platform/conventions-and-extension.md) |
| 为页面设置样式 / 使用正确的颜色、间距或组件 | [design-system.md](../../reference/platform/design-system.md) |
| 遵循项目的模式 | [conventions-and-extension.md](../../how-to/platform/conventions-and-extension.md) |
| 新增或改造评估器 / 设计打分口径 | [develop-evaluator.md](../../how-to/evaluation/develop-evaluator.md) |
| 验收 Qoder CN Trace 采集器 | [qoder-cn-acceptance-validation.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/observability/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md) |
| 验证 Qoder CN 跨机器上报 | [qoder-cn-cross-machine-validation.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/observability/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md) |
| 发布 Docker Hub 镜像 / 导出离线镜像包 | [release-docker-image.md](../../how-to/platform/release-docker-image.md) |

## Glossary
- **Skill**：一个带版本、自包含的 Agent 能力（即一个包含 `SKILL.md` 的文件夹）。在这里是一等实体——可被生成、评测、A/B 测试和优化。对应数据库模型 `Skill` + `SkillVersion`。
- **Execution / trace**：接入平台的一次 Agent 运行（Prisma `Execution`）。一次主运行被拆分为一个根执行 + N 个子 Agent 执行，通过 `parentExecutionId` / `rootExecutionId` 关联。
- **Trajectory evaluation**：针对某次执行的工具/Skill 路径，对照预期流程逐步打分（`evaluateTrajectory`、`TrajectoryEvalResult`）。
- **Outcome vs Routing evaluation**：结果评测 = 最终答案是否与标准答案匹配；路由评测 = Agent 是否调用了预期的 Skill。参见 `ConfigDatasetType`、`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`。
- **Preset result evaluators**：评测中心提供准确性、答案质量、忠实度和指令遵循四个结果类预置评估器，只在用户主动运行实验时执行；质量监控不再包含结果维评测。
- **Grayscale (A/B)**：在一个数据集上对两个 Skill 版本进行对比（`GrayscaleTask`、`ab-scoring.ts`）。
- **Config (dataset config)**：某个查询的标准答案记录——预期 Skill、标准答案、根因、关键动作（Prisma `Config`、`ConfigItem`）。
- **General agent / deepagents**：内部的 LangGraph/deepagents 运行时（`runGeneralAgent`），为 Skill 生成、优化和 LLM 评测器提供支撑。
- **Ingest**：通过 OpenTelemetry 端点或框架 watcher/插件（包括 OpenCode、Claude、OpenClaw、AcTrail）接收 Agent 运行数据，并将其规范化为 `Execution` 记录。
- **智能采样**：Agent Insight 基于 Trace 生成评测数据集时使用的生产采样能力；当前策略实现版本为 `trace-coverage-v6.35`，名称不表示与其他产品采用同一算法。
- **Collaboration trace**：独立于原生 Execution 树的跨 Session 关系覆盖层；事件正文不可变，端点到 Execution 的关联可随 Trace 到达重算。
- **Skill issue / optimization point**：由静态或动态评测产生的、已发现的改进点（`SkillIssue`）；供 skill-opt 流程消费。

## HTTP 与评测契约导航

- [平台 HTTP 接口与身份](../../reference/platform/http-api.md)
- [Trace 接入](../../reference/observability/trace-ingestion.md)
- [实验接口](../../reference/evaluation/experiments-api.md)
- [评估器输出](../../reference/evaluation/evaluator-output.md)
- [独立 Benchmark 协议](../../reference/evaluation/benchmark-protocol.md)
