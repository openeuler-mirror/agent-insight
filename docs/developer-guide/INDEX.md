# Agent-Insight — 开发者指南

> Agent-Insight（`@witty-ai/skill-insight`）是一个框架无关、自托管的平台，用于**观测**、**评测**和**优化** AI Agent 及其 Skill。
> 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + Prisma + Tailwind，内部 Agent 使用 LangChain/LangGraph + deepagents，trace 接入使用 OpenTelemetry。受众：开发者与 LLM 编码 Agent。
> 于 2026-06-04 通过静态分析生成（515 个 TS 文件、2551 个函数、890 个类型、16004 条调用边）。请先阅读本 INDEX，再按需加载所需文件。

## Source commit (provenance)
本指南反映**截至下方 commit 的**仓库状态。更新文档时，请与此 commit 做 diff，仅查看自那之后发生的变更，并重新生成受影响的页面。

| Field | Value |
|---|---|
| Commit | `a65aa8b0bbead76329c0782425770578cedac83b` (`a65aa8b`) |
| Branch | `dev_agent_ras` |
| Date | 2026-08-05 |
| Author | iceory |
| Subject | `feat(fi): 吸收 Judge 证据边界与 injection_tools 扁平化` |

**如何更新：** `git diff a65aa8b HEAD -- src/` 可显示自此快照以来的代码变更；重新生成受影响的文档，然后将本区块更新到新的 `HEAD` commit。

## Documents
- [00-positioning.md](00-positioning.md)：项目为何存在、面向谁、所属领域、成熟度。
- [01-architecture.md](01-architecture.md)：系统形态、技术栈、分层、模块依赖图、入口面。
- [02-modules.md](02-modules.md)：每个模块的职责；哪些是核心模块、哪些是外围模块。
- [03-file-map.md](03-file-map.md)：文件 → 模块 → 符号的查找表，用于定位代码。
- [04-api-and-contracts.md](04-api-and-contracts.md)：导出的函数签名及其调用关系、数据模型/类型、扩展点。
- [05-data-and-control-flow.md](05-data-and-control-flow.md)：核心流程（接入、评测、生成、优化、诊断）的入口与执行轨迹。
- [06-frontend.md](06-frontend.md)：前端框架、路由、组件关系。
- [07-conventions-and-extension.md](07-conventions-and-extension.md)：约定以及如何新增代码；关键实现入口。
- [08-design-system.md](08-design-system.md)：视觉设计语言、设计令牌、排版、控件尺寸、UI/UX 审计与漂移检测。机器可读的令牌：[design-tokens.json](design-tokens.json)。
- [docker-image-release.md](docker-image-release.md)：维护者发布 Docker Hub 多架构镜像、验证 manifest、导出离线 `.tar` 镜像包的流程。

- [09-otlp-attribute-contract.md](09-otlp-attribute-contract.md)：OTLP 属性契约（FR-011），定义 OpenClaw 及其他 OTLP 客户端上报 trace/log 时必须遵守的属性规范；含 RAS 旁路 ingest（非 OTLP）说明。
- 仓根 [`agent_ras/`](../../agent_ras/)：环内可靠性同进程真源（OpenCode L3 inproc）；统一安装入口见 [`scripts/install-ras.js`](../../scripts/install-ras.js)。
- 仓根 [`agent_fault_injection/`](../../agent_fault_injection/)：故障注入引擎（注入+采集）；文档 [`docs/agent-fault-injection/`](../agent-fault-injection/README.md)；UI `/agent-ras/fault-injection`，BFF `/api/fault-injection`。
- Agent RAS 文档统一入口：[`docs/agent-ras/`](../agent-ras/README.md)（[designs](../agent-ras/designs/) / [guides](../agent-ras/guides/)）。

## Quick lookup
| 我想要... | 前往 |
|---|---|
| 了解整体全貌 | [01-architecture.md](01-architecture.md) |
| 了解每个目录的作用 | [02-modules.md](02-modules.md) |
| 查找哪个文件实现了 X | [03-file-map.md](03-file-map.md) |
| 调用或扩展某个引擎 API / 类型 | [04-api-and-contracts.md](04-api-and-contracts.md) |
| 端到端跟踪接入 / 评测流程 | [05-data-and-control-flow.md](05-data-and-control-flow.md) |
| 新增 API 路由或页面 | [01-architecture.md](01-architecture.md) · [07-conventions-and-extension.md](07-conventions-and-extension.md) |
| 为页面设置样式 / 使用正确的颜色、间距或组件 | [08-design-system.md](08-design-system.md) |
| 遵循项目的模式 | [07-conventions-and-extension.md](07-conventions-and-extension.md) |
| 发布 Docker Hub 镜像 / 导出离线镜像包 | [docker-image-release.md](docker-image-release.md) |

## Glossary
- **Skill**：一个带版本、自包含的 Agent 能力（即一个包含 `SKILL.md` 的文件夹）。在这里是一等实体——可被生成、评测、A/B 测试和优化。对应数据库模型 `Skill` + `SkillVersion`。
- **Execution / trace**：接入平台的一次 Agent 运行（Prisma `Execution`）。一次主运行被拆分为一个根执行 + N 个子 Agent 执行，通过 `parentExecutionId` / `rootExecutionId` 关联。
- **Trajectory evaluation**：针对某次执行的工具/Skill 路径，对照预期流程逐步打分（`evaluateTrajectory`、`TrajectoryEvalResult`）。
- **Outcome vs Routing evaluation**：结果评测 = 最终答案是否与标准答案匹配；路由评测 = Agent 是否调用了预期的 Skill。参见 `ConfigDatasetType`、`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`。
- **Result quality evaluation**：质量监控的结果维评测，将最终交付拆为忠实度、指令遵循、答案质量和准确性，按 trace 写入 `TraceEvaluation`。
- **Grayscale (A/B)**：在一个数据集上对两个 Skill 版本进行对比（`GrayscaleTask`、`ab-scoring.ts`）。
- **Config (dataset config)**：某个查询的标准答案记录——预期 Skill、标准答案、根因、关键动作（Prisma `Config`、`ConfigItem`）。
- **General agent / deepagents**：内部的 LangGraph/deepagents 运行时（`runGeneralAgent`），为 Skill 生成、优化和 LLM 评测器提供支撑。
- **Ingest**：通过 OpenTelemetry 端点或框架 watcher/插件（OpenCode、Claude、OpenClaw）接收 Agent 运行数据，并将其规范化为 `Execution` 记录。
- **Skill issue / optimization point**：由静态或动态评测产生的、已发现的改进点（`SkillIssue`）；供 skill-opt 流程消费。
