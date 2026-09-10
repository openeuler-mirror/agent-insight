# Agent-Insight — 开发者指南

> Agent-Insight（`@witty-ai/skill-insight`）是一个框架无关、自托管的平台，用于**观测**、**评测**和**优化** AI Agent 及其 Skill。
> 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + Prisma + Tailwind，内部 Agent 使用 LangChain/LangGraph + deepagents，trace 接入使用 OpenTelemetry。受众：开发者与 LLM 编码 Agent。
> 于 2026-06-04 通过静态分析生成（515 个 TS 文件、2551 个函数、890 个类型、16004 条调用边）。请先阅读本 INDEX，再按需加载所需文件。

## Source commit (provenance)
本指南反映**截至下方 commit 的**仓库状态。更新文档时，请与此 commit 做 diff，仅查看自那之后发生的变更，并重新生成受影响的页面。

| Field | Value |
|---|---|
| Commit | `820d82db0d48b10204e803cb81bf75438e939fd5` (`820d82db`) |
| Branch | `swebench-develop` |
| Date | 2026-09-08 |
| Author | mintuyang |
| Subject | `修复benmark执行器绑定平台问题` |
| Working tree overlay | 当前工作树在该快照之上同步了 FI Python 版本化 managed venv、AgentDebug 能力说明与 RAS catalog 解耦；补齐 launchd bootout/bootstrap 竞态重试与真实状态校验，让 systemd/launchd 固化安装终端 PATH 以发现用户目录中的 Agent；同时为可靠性数据集增加独立故障模式说明并施加界面/API 双重只读，将评测器分数契约与前端范围统一为 0-100，并在实验模型选项中展示 provider 以区分同名模型。当前工作树还修复了未绑定 Skill 会话的右栏空状态，并将历史会话改为带明确文字入口的顶栏临时浮层；同时恢复“运行观测 → 版本分析”导航入口，通过页面顶部“版本分析 / 版本管理”页签将标签管理收为版本分析的子能力，两个既有页面、API 与数据口径保持不变；新增自建评估器 `dataset_input` 变量、确定性数据集匹配门控与 `ExperimentCase.datasetInput` 快照，并统一“预期输出”展示术语；轨迹质量实验恢复独立 Skill 改进建议，并采用评分 5 分钟、建议每次 7 分钟且最多尝试 2 次的专属超时策略；Skill Copilot 的思考与命令过程现统一为默认折叠、可展开的状态行，并通过 `sessionId` 深链接与服务端增量 checkpoint 在多个页面间恢复同一运行状态；OpenCode 插件动态 Agent 发现通过 loopback `/agent` 读取 resolved Agent，每 30 秒在隔离子进程中绕过缓存并同步能力，macOS 后台服务使用独立 launchd helper 对齐交互式 OpenCode 环境，实验向导第一步定时及聚焦刷新候选；本轮另新增与历史组织集成隔离的 IDaaS OAuth 登录路由、模式契约与前端登录流程，并让开发启动在该模式下以状态接口判定就绪、跳过 admin Key 创建，同时让服务端日志输出不含配置值的具体 IDaaS 配置错误，并增加部署根路径下的 `/callback` 回调入口；userinfo 返回的 UUID 去除首尾空白后直接作为本地账号，首次登录自动创建、后续复用同一用户；修复页面重开时错误小写化 UUID 导致的 401，恢复登录保持 UUID 原始大小写；IDaaS 模式保留通用退出菜单，退出仅清理本地认证状态，不触发统一单点登出；新增默认关闭的地区访问限制，在用户创建前及 API Key 恢复时固定以 `uuids` 数组按 UUID 执行欧盟检查，地区服务异常失败关闭，并以独立文案区分地区受限与校验故障。 |

> 2026-09-04 working-tree overlay：新增 Benchmark Agent 步骤 01～13。统一实验入口按 `scope=benchmark` 分流；真实 SWE-bench Verified Parquet 由官方 loader 导入，Adapter 隔离 Harness 数据、构造 Agent Task、校验 Agent Patch、冻结不含 gold patch 的 EvaluationJob，并归一化原生结果。执行器在独立 Git 工作区产出 Patch；常驻 Evaluator Controller 容器通过 Docker Socket 启动官方 Case 镜像，直接调用固定官方源码的 `make_test_spec()` 与 `run_instance()`，再上传证据并回调原生终态。结果处理先冻结 Raw Result，以 `primaryMetric` 做固定分母聚合，仅投影安全 `nativeMetrics`；确定性归一化失败收敛为非重试终态。新增 Benchmark 实验分页结果 API 和带用户/实验归属校验的证据下载 API。01～13 已复用真实数据库和真实 Case 通过 API 级串联；ARM64 Docker Desktop 上的 09～13 双层容器验收和 `deepseek/deepseek-v4-flash` + `pallets__flask-5014` 全真实 01～13 开发冒烟均通过，后者 Harness 判定为 pass；正式计分仍需 x86_64 Linux 验收。仍不包含前端、部署脚本、服务注册与 Verified 500 批量调度。

> 2026-09-05 working-tree overlay：Benchmark 扩展契约对齐高保真开发者模型。`benchmark.yaml` 成为 Manifest 唯一真源，构建期 Generator 生成平台 Adapter、Manifest 与 Evaluator Catalog；`AbstractBenchmarkAdapter` 收敛为五个业务 hook 并统一执行 Case/Result Schema 与 public/private 边界校验。执行器删除 SWE-bench Profile，改用 Workspace、Agent Runtime 和 Artifact Collector 三类通用能力注册表并支持多 Artifact；评测 Worker 删除 SWE-bench 直接依赖，改用 `doctor`、`evaluate --request ... --output ...` 文件 Entrypoint。SWE-bench 仅作为 `benchmarks/swe-bench/` 接入实例；新增 Benchmark 通常不改公共 API、调度器、执行器 Runner、评测 Worker 或 Prisma Schema。

> 2026-09-08 working-tree overlay：Benchmark 执行目标复用普通实验的客户端动态能力发现，按 `clientId + platform + agent` 返回并二次校验候选；SWE-bench Manifest 不再固定 OpenCode，所选平台动态要求 `agent-runtime/{platform}/v1`。Benchmark Agent 任务改由现有客户端 `RUN_BENCHMARK_CASE` 白名单指令经 WSS/HTTPS 长轮询下发，常驻客户端直接调用本地 Runner，不再保存或配置 `executorBaseUrl`/监听地址；Git 工作区、Patch、Outbox、独立 Evaluator 和 Official Harness 链路不变。

> 2026-09-08 working-tree overlay：Benchmark 前端最小接入复用数据集、四步实验向导、实验列表与详情路由；`SWE-bench Verified` 通过只读公共投影进入普通数据集入口，Official Harness 自动绑定，已有 Trace/监听及依赖参考答案的评估器在 Benchmark 下禁用。通用实验列表新增同配置立即运行与复用配置预填；Benchmark Case 详情只展示官方契约说明、Patch/证据元数据和归一化测试计数。Case 重跑复用通用入口，Official 重评复用最新 Patch 且默认单任务串行。

> 2026-09-08 working-tree overlay：独立 Evaluator Controller 增加 Linux/macOS 源码一键部署、Docker restart policy、当前 context Socket 解析、持久化数据卷、容器内外 Doctor 和显式 SWE-bench Gold Smoke；普通启动不预拉 Case 镜像。每次部署在新镜像就绪后重建 Controller 容器，Doctor 成功后只清理旧 Controller 镜像，保留命名 volume 和 Case 镜像。Agent Insight 增加 `data/config/benchmark-evaluator.env` 原子热加载与进程环境变量兜底，目标 URL 和发送 Token 从同一快照冻结，回调鉴权支持当前/宽限期 Token，切换评测机或通信凭证不再要求重启主进程。Controller 基础健康与各 Evaluator 的 `ready/formalEligible` 分离，并输出宿主、Docker、源码 revision、`sourceDirty` 和镜像事实。版本化的构建期 Catalog 迁移到可见目录 `generated/benchmark-catalog/`，并用 `adapters.ts` 与 `catalog-lock.json` 明确 Adapter 注册表和内容指纹语义。Controller 构建默认使用带官方回退的国内 Debian/PyPI 镜像，SWE-bench Harness 改为下载固定 commit 的官方 GitHub codeload archive 并校验固定 SHA-256；Node 和 Case 镜像默认保留官方名称并复用宿主 registry mirror，仅在显式配置 `SWE_BENCH_IMAGE_PROXY_PREFIX` 时先经指定代理拉取。

> 2026-09-08 working-tree overlay：Benchmark Evaluator 双向认证新增显式 `token|none` 模式，默认继续使用共享 Bearer Token；仅在安全组或防火墙已限制两台服务互访时可选择 `none`，此时健康检查、任务下发、接单、Artifact 下载和全部评测回调都省略 Authorization。认证模式进入热加载配置与目标修订，启动脚本、Doctor 和配置脚本同步支持无 Token 部署。

> 2026-09-09 working-tree overlay：Benchmark Catalog 新增 Dataset Loader、Dataset Profile 与声明式 Presentation；管理员可从任意服务端可读路径一次导入系统共享数据集，并选择在成功后删除源文件。共享数据集对所有用户只读，实验仍按用户隔离；管理员删除未引用数据，已引用数据改为归档。实验向导、执行目标和 Benchmark 结果卡按当前 Adapter/Manifest 动态渲染，不再依赖 SWE-bench 字段或固定 Evaluator ID。

> 2026-09-10 working-tree overlay：Benchmark 平台新增运行失活 watchdog，按 Git 准备、冻结 Agent 上限加宽限期及后处理阶段分别设置阈值，以 CAS 将无进度 Case 收敛为失败并防止迟到回调复活。客户端执行器将 Artifact/完成回调重试拆为不占 Agent 槽的持久化投递 lane，增加指数退避与单次请求超时；Git shallow fetch 增加进程组级超时、瞬时错误白名单三次重试、工作区重建与命令级 HTTP/1.1 兜底，避免一次模型、回调或 GitHub 链路故障阻塞后续实验。Agent 执行第一阶段新增 `AGENT_TIMEOUT`、高置信 `MODEL_UNAVAILABLE`、`AGENT_EXIT_NONZERO` 与 `AGENT_NO_OUTPUT` 失败码，确定性失败立即终止且不自动重试，并在 Case 详情中明确展示；`0 LLM Turn` 因依赖异步 Trace 入库留待后续追踪阶段。

> 2026-09-10 working-tree overlay：Benchmark 官方评测可靠性进一步收敛。SWE-bench Raw Result 使用严格 boolean 和官方报告结构；归一化同时绑定冻结实例/测试名单、正式资格以及重读并校验摘要的三类证据，字符串 `"false"`、错误实例、空/重复/未知测试或证据漂移均不能产生成绩。Evaluator 的 abort 成为不可逆 `EVALUATION_TIMEOUT`，callback 只接受结构与状态匹配的 ACK。平台增加 Evaluation 分阶段 watchdog、下发 attempt owner CAS、normalizing 恢复和带 owner lease 的持久化 continuation，终态 ACK 前先落续跑意图，服务重启可恢复且补充评估器不重复执行；旧 Run 无法覆盖 Case 重跑后的投影。聚合只取重试图叶子并稳定排序，防止历史尝试重复计分。官方 Harness 判定代码保持不变。

**如何更新：** `git diff 820d82db HEAD -- src/ scripts/ packages/ benchmarks/` 可显示自此快照以来的代码变更；重新生成受影响的文档，然后将本区块更新到新的 `HEAD` commit。

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
| 接入新的 Benchmark | [07-conventions-and-extension.md](07-conventions-and-extension.md) · [扩展改造方案](../../评测服务文档/benchmark-extension-refactor-plan.md) |
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
