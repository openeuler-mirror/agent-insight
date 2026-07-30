# File Map

> 查找表：文件 → 模块 → 关键符号。内容经过筛选（仓库共有 454 个已分析的 TS 文件）；覆盖你实际会查找的导航目标。所有路径均真实存在。完整的 UI 路由清单见 [06-frontend.md](06-frontend.md)；HTTP 处理器见下方的 "API routes" 一节。

## lib — engine: evaluation (`src/lib/engine/evaluation/`)
| File | Key symbols |
|---|---|
| `evaluation-types.ts` | `EvaluationResult`、`ABExperiment`、`TestCase`、`QualityBenchmark`、`DimensionScore`、`MetricValue`、`EvaluationRunRequest`（评测类型契约） |
| `judge.ts` | `judgeAnswer`、`analyzeEvaluationItems`、`analyzeFailures`、`analyzeSession`；`JudgmentResult`、`JudgeCriteria`、`FailureAnalysisResult` |
| `trajectory-evaluator.ts` | `evaluateTrajectory`、`aggregateTrajectoryScore`；`TrajectoryEvalInput/Output`、`TrajectoryDeviationStep` |
| `opencode-trajectory-evaluator.ts` | 基于 deepagents 的轨迹评测执行器 |
| `opencode-task-completion-evaluator.ts` | `TaskCompletionEvalInput/Output` |
| `custom-llm-evaluator.ts` | `CustomEvaluatorInput/Result`（用户自定义的 LLM 评测器） |
| `semantic-dataset-match.ts` | `SemanticConfigMatchResult`、`SemanticCaseMatchResult`、`ExtractedUserInput` |
| `config-target.ts` / `config-dataset.ts` | `normalizeConfigSkillName`、`normalizeConfigQuery`、`normalizeConfigDatasetType`、`ConfigDatasetType` |
| `derive-skill-opt-points.ts` / `derive-trigger-opt-points.ts` | `DeriveOptPointsArgs`，从评测中推导 `SkillIssue` |
| `result-artifact-extractor.ts` | `ResultArtifactExtractionResult`（在 trace 中查找答案） |
| `trace-summarizer.ts` | `TraceStep`、`TraceSummary`、`SummarizeOptions` |
| `task-completion-scoring.ts` | `TaskCompletionScoreSummary` |
| `evaluator-execution-recorder.ts` | 将评测器执行记录为 `Execution` |
| `alignment-attribution.ts` | 将流程偏差归因到某个 skill |

## lib — engine: other subsystems
| File | Module area | Key symbols |
|---|---|---|
| `engine/general-agent/runner.ts` | general-agent | `runGeneralAgent`；`RunGeneralAgentInput/Result`、`InteractionRecord` |
| `engine/general-agent/concurrency-limiter.ts` | general-agent | `withBackgroundOpencodeSlot`、`BackgroundTaskOptions` |
| `engine/general-agent/skill-resolver.ts` / `skill-workspace-deployer.ts` | general-agent | `ResolvedSkill`、`DeployResult` |
| `engine/skill-generation/index.ts` | skill-generation | `generateSkill`、`generateSkillStream`；`GenerationOptions` |
| `engine/skill-generation/types.ts` | skill-generation | `SkillSpec`、`EvalReport`、`IterationRecord` |
| `engine/skill-generation/opencode-agent-cli/opencode-client.ts` | skill-generation | OpenCode SDK 客户端 + 事件信封类型 |
| `engine/skill-issues/index.ts` | skill-issues | `IssueWithPrevalence`、`AggregateResult`（普遍度聚合） |
| `engine/skill-issues/static-evaluator/index.ts` | skill-issues | `runStaticEvaluation`；`RunArgs`、`RunResult` |
| `engine/skill-issues/static-evaluator/{linter,llm-evaluator,content-loader}.ts` | skill-issues | 静态合规扫描 |
| `engine/agent-debug/types.ts` | agent-debug | `AgentDebugReportPayload`、`AgentDebugIssue`、`AgentDebugRootCause`、`DebugTurn` |
| `engine/agent-debug/runner.ts` / `trace-adapter.ts`；`skills/agent-debug-diagnosis/scripts/{agentdebug_static,agentdebug_inspect,agentdebug_validate,detector_runner}.py` | agent-debug | 调试报告生成 |
| `engine/observability/agent-trace.ts` | observability | `buildAgentCallTree`、`walkTree`、`findNode`、`formatTokens`；`AgentNode`、`AgentEvent`、`ToolCall` |
| `engine/observability/flow-parser.ts` | observability | `ParsedFlowResult`、`TraceSkillAlignment`、`ExecutionMatchResult`（skill 流程对齐） |
| `engine/observability/{claude-parser,openclaw-parser}.ts` | observability | 特定平台的 trace 解析 |
| `engine/observability/fault-path.ts` | observability | `FaultPathStep`、`AnchorableFailure` |

## lib — storage / ingest / auth / shared
| File | Area | Key symbols |
|---|---|---|
| `storage/data-service.ts` | storage | `saveExecutionRecord`、`extractInvokedSkillsFromSessionInteractions`、`readRecords`、`readConfig`、`findBestRoutingConfig`、`findBestOutcomeConfig`、`deriveSubagentExecutions`；`ExecutionRecord`、`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`、`ConfigItem` |
| `trace-tags.ts` | storage | `listTraceTags`、`createTraceTag`、`updateTraceTag`、`deleteTraceTag`、`getExecutionTraceTags`、`addExecutionTraceTags`、`replaceExecutionTraceTags`、`removeExecutionTraceTag`、`getTraceTagsByExecutionIds` |
| `storage/db-interface.ts` | storage | `getDatabaseAdapter`；`DatabaseAdapter`、`OpenGaussAdapter.query` |
| `storage/prisma.ts` | storage | Prisma 客户端单例 |
| `storage/server-config.ts` | storage | `getActiveConfig`、`getUserSettings`、`saveUserSettings`；`ModelConfig`、`UserSettings` |
| `auth/auth.ts` | auth | `resolveUser`、`canAccessSkill`；`AuthResult` |
| `ingest/proxy-config.ts` / `proxy-store.ts` | ingest | `getProxyConfig`；`ProxyConfig`、`SessionData` |
| `ingest/adapters/{registry,types,opencode,claude,codeagent,openclaw,hermes,langfuse-langgraph,qoder,actrail}.ts` | ingest | `getAdapter`、`resolveFrameworkId`、`listFrameworks`；`FrameworkAdapter`、`FrameworkDescriptor` |
| `ingest/routing-signature.ts` | ingest | `RoutingSemanticSignature`、`RoutingSemanticMatch` |
| `ingest/claude-otel/` / `ingest/codeagent-otel/` / `ingest/otel-consumer/` / `openclaw-watcher.ts` | ingest | 特定框架的接入与 OTel spool 消费 |
| `ingest/otel/langfuse.ts` / `ingest/otel/adapters/{langfuse-langgraph,langfuse-trace}.ts` | ingest | Langfuse Python SDK / LangGraph OTLP 归属转换；现有 interactions 投影与无损 `LangfuseTraceNode` 投影并行生成 |
| `engine/observability/langfuse-agent-trace.ts` | engine | Langfuse 可见 observation → 原 Agent Trace 节点/事件模型；不含业务节点名称规则 |
| `ingest/otel/adapters/hermes.ts` / `scripts/hermes_agent_insight_plugin.py` | ingest | Hermes span tree 归属转换；Hermes hooks 到累计 OTLP JSON snapshot |
| `ingest/otel/adapters/qoder.ts` / `scripts/qoder_{trace_collector,uploader_client,setup,work_setup,token_usage_env}.mjs` | ingest | Qoder CN 家族 hooks、产品/账号隔离 spool、Token usage 环境变量生命周期、异步上传及 Qoder OTLP snapshot 转换 |
| `integrations/qoder-desktop/` / `integrations/qoder-jetbrains/` / `api/ingest/setup/qoder-*` | integration | Qoder Desktop VSIX 与 JetBrains 插件的状态栏、设置、owner 安装、卸载清理及服务端安装包下载 |
| `ingest/otel/actrail.ts` / `ingest/otel/adapters/actrail.ts` | ingest | AcTrail semantic actions 归一、Span 修订合并与 Trace 投影 |
| `shared/model-config.ts` / `default-model-config.ts` | shared | `ModelPricing`，定价/上下文窗口查询 |
| `shared/interaction-utils.ts` | shared | `InvokedSkill`，交互解析 |
| `client/api.ts` | client | `apiFetch`（标准的客户端 fetch 封装） |
| `client/{auth,locale,theme,sidebar}-context.tsx` | client | React context provider/hook |
| `agent-adapter.ts` | lib | 用于 playground 的 assistant-ui `ChatModelAdapter` |
| `llm-providers.ts` | lib | `LlmProvider` 注册表 |
| `system-agents.ts` / `system-agent-names.ts` | lib | `SystemAgentDefinition`，内部 agent 身份标识 |
| `utils.ts` | lib | `cn`（class 合并 —— 调用最频繁的函数） |

## server (`src/server/`)
| File | Key symbols |
|---|---|
| `agent_datasets_storage.ts` | `AgentDatasetRecord`、`DatasetCase`、`prepareDatasetCases`，校验类型 |
| `skill_trigger_eval_storage.ts` | `requirePrisma`、`SkillTriggerEvalSetRecord`、`SkillTriggerEvalRunRecord` |
| `user_evaluators_storage.ts` | 自定义评测器持久化 |

## prompts (`src/prompts/`)
| File | Builds prompt for |
|---|---|
| `judge-prompt.ts` | 结果评判（`generateJudgePrompt`） |
| `extraction-prompt.ts` / `config-extraction-prompt.ts` | 从 trace 中提取答案/配置 |
| `failure-analysis-prompt.ts` | 失败分析 |
| `attribution-prompt.ts` / `item-attribution-prompt.ts` | 将问题归因到 skill（`EvaluationItem`、`SkillIssueResult`） |
| `benchmark-generation-prompt.ts` | 生成评测数据集 |
| `flow-parse-prompt.ts` | 将 skill 解析为流程（`ParsedFlow`） |
| `skills-prompt.ts` | 感知 skill 的系统提示词 |

## components (selected) (`src/components/`)
| File | Role |
|---|---|
| `eval/Dashboard.tsx` | 评测仪表盘（最大的 UI 流程） |
| `eval/TrajectoryEvalCenter.tsx`、`eval/TrajectoryDetailView.tsx` | 轨迹评测 UI |
| `eval/SkillEvaluation.tsx`、`eval/EvaluationRunDetailView.tsx` | skill 评测视图 |
| `observe/{AgentTraceView,TraceDrawer,AgentDebugCard}.tsx` | trace 可视化 + 调试；Langfuse observation 经专用投影进入原 Agent Trace 界面，其余框架继续使用 interactions 树 |
| `AgentDatasetCenter.tsx`、`DatasetItemsPage.tsx`、`EvaluatorsCenter.tsx` | 数据集与评测器管理 |
| `config/ModelConfigManager.tsx`、`config/WebSearchConfig.tsx` | 模型/搜索配置 |; Trace tag management page: `app/(main)/version-management/page.tsx` |
| `shell/{AppSidebar,AppTopBar,PageContainer,PageHeader}.tsx` | 应用外壳 |
| `ui/*` | 可复用基础组件（button、card、dialog、select 等）—— 复用它们，不要自行实现 |
| `feedback/{EmptyState,ErrorState,StatusBadge}.tsx` | 标准状态组件 |

## API routes (`src/app/api/`) — grouped
| Group | Route files (under `api/`) | Purpose |
|---|---|---|
| ingest | `ingest/otel/v1/{logs,metrics,traces}`、`ingest/upload`、`ingest/proxy/[taskId]/*`、`ingest/setup/*`（含共享的 `setup/codeagent-setup.ts` 与 `setup/hermes-plugin`）、`ingest/sync/*`、`ingest/opencode/session-complete`、`ingest/parse-document`、`ingest/v1/[...path]` | 接收并归一化 agent 运行数据；下发客户端安装脚本、跨平台 CodeAgent PATH 包装器与 Hermes 插件源码 |
| agent | `agent/{run,respond,stream}` | 驱动内部的通用 agent |
| skills | `skills`、`skills/[id]/*`、`skills/by-name/*`、`skills/{publish,upload,automation/*,sync-enterprise,logs}` | skill 增删改查、版本、发布、企业同步 |
| skill-eval | `skill-eval/trigger/[skillName]/*` | 触发评测集/评测运行 |
| skill-opt | `skill-opt/{chat,sessions/*}` | skill 优化对话 + 历史 |
| skill-generator | `skill-generator/{chat,sessions/*,files/*,attachments,download/*}` | skill 生成 playground 后端 |
| eval | `eval/{config/*,evaluation,rejudge,settings,trajectory/*}` | 数据集配置、评测运行、轨迹评测 |
| debug | `debug/{batch-tasks/*,grayscale-tasks/*,execute/*,history/*}` | 批量与灰度（A/B）执行编排 |
| observe | `observe/{data,session,task-stats,infra/*,executions/[executionId]/*,version-analysis/*}` | Observability data, infra observation, execution analysis, Trace tag binding, and version-analysis aggregation |
| tags | `tags`、`tags/[id]` | Trace 用户标签定义 CRUD（版本标签 / 业务标签） |
| fault | `fault/diagnosis/{session,stream}` | 故障诊断对话（agent-debug） |
| misc | `agents`、`agent-datasets/*`、`auth/*`、`dashboard/stats`、`guide`、`user-evaluators`、`background-tasks`、`evaluation/*` | 注册表、数据集、认证、仪表盘、引导 |
