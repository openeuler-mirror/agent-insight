# Agent-Insight — 开发者指南

> Agent-Insight（`@witty-ai/skill-insight`）是一个框架无关、自托管的平台，用于**观测**、**评测**和**优化** AI Agent 及其 Skill。
> 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + Prisma + Tailwind，内部 Agent 使用 LangChain/LangGraph + deepagents，trace 接入使用 OpenTelemetry。受众：开发者与 LLM 编码 Agent。
> 于 2026-06-04 通过静态分析生成（515 个 TS 文件、2551 个函数、890 个类型、16004 条调用边）。请先阅读本 INDEX，再按需加载所需文件。

## Source commit (provenance)
本指南反映**截至下方 commit 的**仓库状态。更新文档时，请与此 commit 做 diff，仅查看自那之后发生的变更，并重新生成受影响的页面。

| Field | Value |
|---|---|
| Commit | `373ec92f1e606328a64ea6b09476959796c5d819` (`373ec92f`) |
| Branch | `new-dev-8-28` |
| Date | 2026-08-27 20:55:40 +0800 |
| Author | openeuler-ci-bot |
| Subject | `!358 docs: 新增仓库速查手册 overview.html，更新项目简介文案` |
| Working tree overlay | 当前工作树在该快照之上同步了 FI Python 版本化 managed venv、AgentDebug 能力说明与 RAS catalog 解耦；补齐 launchd bootout/bootstrap 竞态重试与真实状态校验，让 systemd/launchd 固化安装终端 PATH 以发现用户目录中的 Agent；同时为可靠性数据集增加独立故障模式说明并施加界面/API 双重只读，将评测器分数契约与前端范围统一为 0-100，并在实验模型选项中展示 provider 以区分同名模型。当前工作树还修复了未绑定 Skill 会话的右栏空状态，并将历史会话改为带明确文字入口的顶栏临时浮层；同时恢复“运行观测 → 版本分析”导航入口，通过页面顶部“版本分析 / 版本管理”页签将标签管理收为版本分析的子能力，两个既有页面、API 与数据口径保持不变；新增自建评估器 `dataset_input` 变量、确定性数据集匹配门控与 `ExperimentCase.datasetInput` 快照，并统一“预期输出”展示术语；轨迹质量实验恢复独立 Skill 改进建议，并采用评分 5 分钟、建议每次 7 分钟且最多尝试 2 次的专属超时策略；Skill Copilot 的思考与命令过程现统一为默认折叠、可展开的状态行，并通过 `sessionId` 深链接与服务端增量 checkpoint 在多个页面间恢复同一运行状态；OpenCode 插件动态 Agent 发现通过 loopback `/agent` 读取 resolved Agent，每 30 秒在隔离子进程中绕过缓存并同步能力，macOS 后台服务使用独立 launchd helper 对齐交互式 OpenCode 环境，实验向导第一步定时及聚焦刷新候选；本轮另新增与历史组织集成隔离的 IDaaS OAuth 登录路由、模式契约与前端登录流程，并让开发启动在该模式下以状态接口判定就绪、跳过 admin Key 创建，同时让服务端日志输出不含配置值的具体 IDaaS 配置错误，并增加部署根路径下的 `/callback` 回调入口；userinfo 返回的 UUID 去除首尾空白后直接作为本地账号，首次登录自动创建、后续复用同一用户；修复页面重开时错误小写化 UUID 导致的 401，恢复登录保持 UUID 原始大小写；IDaaS 模式保留通用退出菜单，退出仅清理本地认证状态，不触发统一单点登出；新增默认关闭的地区访问限制，在用户创建前及 API Key 恢复时固定以 `uuids` 数组按 UUID 执行欧盟检查，地区服务异常失败关闭，并以独立文案区分地区受限与校验故障。 |

**如何更新：** `git diff 373ec92f HEAD -- src/ scripts/` 可显示自此快照以来的代码变更；重新生成受影响的文档，然后将本区块更新到新的 `HEAD` commit。

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
- [09-otlp-attribute-contract.md](09-otlp-attribute-contract.md)：OTLP 属性契约（FR-011），定义 OpenClaw 及其他 OTLP 客户端上报 trace/log 时必须遵守的属性规范；含 RAS 旁路 ingest（非 OTLP）说明。
- [10-evaluator-development.md](10-evaluator-development.md)：新增/改造评测中心评估器。含打分方法论（禁止自由打分、分解+确定性汇总、三档锚定、精确率/召回率/有据性三轴）与工程接入（契约、注册元数据、canonical 影响面、坑位）。
- [11-usage-analytics.md](11-usage-analytics.md)：平台用量统计（管理员专用）。有效使用口径注册表、有界队列与故障隔离约束、双数据库存储契约、新增统计事件的方法。
- [qoder-cn-acceptance-validation.md](../design/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md)：Qoder CN 产品家族 Trace 采集器 AC1–AC37 的完整验收、真实客户端演示、性能、卸载和数据正确性测试。
- [qoder-cn-cross-machine-validation.md](../design/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md)：Qoder CN 采集器与 Agent Insight 服务端分布在不同机器时的安装、上传、排查和卸载验证。
- [docker-image-release.md](docker-image-release.md)：维护者发布 Docker Hub 多架构镜像、验证 manifest、导出离线 `.tar` 镜像包的流程。
- 仓根 [`agent_ras/`](../../agent_ras/)：环内可靠性同进程真源（OpenCode L3 inproc）；统一安装入口见 [`scripts/install-ras.js`](../../scripts/install-ras.js)。
- 仓根 [`agent_fault_injection/`](../../agent_fault_injection/)：故障注入引擎（注入+采集）；文档 [`docs/agent-fault-injection/`](../agent-fault-injection/README.md)；UI `/agent-ras/fault-injection/tasks`（目录 `/faults`），BFF `/api/fault-injection`。
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
| 新增或改造评估器 / 设计打分口径 | [10-evaluator-development.md](10-evaluator-development.md) |
| 验收 Qoder CN Trace 采集器 | [qoder-cn-acceptance-validation.md](../design/qoder-cn-trace-validation/qoder-cn-acceptance-validation.md) |
| 验证 Qoder CN 跨机器上报 | [qoder-cn-cross-machine-validation.md](../design/qoder-cn-trace-validation/qoder-cn-cross-machine-validation.md) |
| 发布 Docker Hub 镜像 / 导出离线镜像包 | [docker-image-release.md](docker-image-release.md) |

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
- **Skill issue / optimization point**：由静态或动态评测产生的、已发现的改进点（`SkillIssue`）；供 skill-opt 流程消费。
