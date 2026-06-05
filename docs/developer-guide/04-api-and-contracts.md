# API & Contracts

> 引擎从 `lib` 暴露约 380 个函数，从 `server` 暴露约 29 个，外加 14 个 prompt 构建器；代码库声明了约 890 个类型和约 290 个扩展点（接口/抽象类）。本页列出高信噪比的引擎 API、持久化 + 内存数据模型，以及扩展点。仅包含签名与调用关系 —— 不描述行为。所有签名均来自静态分析。

## Engine API — anchor index
| Function | Anchor | Module |
|---|---|---|
| `runGeneralAgent` | [#run-general-agent](#run-general-agent) | engine/general-agent |
| `generateSkill` / `generateSkillStream` | [#generate-skill](#generate-skill) | engine/skill-generation |
| `evaluateTrajectory` | [#evaluate-trajectory](#evaluate-trajectory) | engine/evaluation |
| `judgeAnswer` | [#judge-answer](#judge-answer) | engine/evaluation |
| `runStaticEvaluation` | [#run-static-evaluation](#run-static-evaluation) | engine/skill-issues |
| `buildAgentCallTree` | [#build-agent-call-tree](#build-agent-call-tree) | engine/observability |
| `saveExecutionRecord` / `readRecords` | [#save-execution-record](#save-execution-record) | lib/storage |
| `getDatabaseAdapter` | [#get-database-adapter](#get-database-adapter) | lib/storage |
| `resolveUser` / `canAccessSkill` | [#resolve-user](#resolve-user) | lib/auth |
| `getActiveConfig` / `getUserSettings` | [#get-active-config](#get-active-config) | lib/storage |

## Public API

### `runGeneralAgent(input: RunGeneralAgentInput): Promise<RunGeneralAgentResult>`  {#run-general-agent}
- **Location**: `src/lib/engine/general-agent/runner.ts`
- **Called by**: 约 9 处内部调用点 —— 内部 LangGraph/deepagents 运行时的统一入口；被 skill 生成、优化以及 LLM 评测器使用。

### `generateSkill(spec: SkillSpec, options?: GenerationOptions): Promise<...>`  {#generate-skill}
### `generateSkillStream(spec: SkillSpec, options?: GenerationOptions): AsyncGenerator<...>`
- **Location**: `src/lib/engine/skill-generation/index.ts`
- **Contract types**: `SkillSpec`、`GenerationOptions`、`EvalReport`、`IterationRecord`（`engine/skill-generation/types.ts`）。

### `evaluateTrajectory(input: TrajectoryEvalInput, user?: string | null): Promise<TrajectoryEvalOutput>`  {#evaluate-trajectory}
- **Location**: `src/lib/engine/evaluation/trajectory-evaluator.ts`
- **Related**: `aggregateTrajectoryScore(dims, deviations): { trajectoryScore; rawWeightedScore; cap }`（同一文件）。

### `judgeAnswer(userQuery: string, criteria: JudgeCriteria, actualAnswer: string, user?, executionSteps?): Promise<JudgmentResult>`  {#judge-answer}
- **Location**: `src/lib/engine/evaluation/judge.ts`
- **Calls**: `generateJudgePrompt`（`src/prompts/judge-prompt.ts`）。
- **Siblings**: `analyzeEvaluationItems(...) → SkillImprovementItem[]`、`analyzeFailures(...) → FailureAnalysisResult`、`analyzeSession(...) → AnalysisResult`。

### `runStaticEvaluation(args: RunArgs): Promise<RunResult>`  {#run-static-evaluation}
- **Location**: `src/lib/engine/skill-issues/static-evaluator/index.ts`
- **Called by**: 约 5 处调用点 —— 针对某个 skill 的静态合规扫描（linter + LLM 评测器）。

### `buildAgentCallTree(interactions: RawInteraction[]): AgentNode | null`  {#build-agent-call-tree}
- **Location**: `src/lib/engine/observability/agent-trace.ts`
- **Companions**: `walkTree(root, fn)`、`findNode(root, id)`、`totalNodeCount(root)`、`formatDuration(ms?)`、`formatTokens(n)` —— 供 trace UI 和评测器使用的 trace 树工具集。

### `saveExecutionRecord(data: ExecutionRecord): Promise<{ success: boolean; record: ExecutionRecord }>`  {#save-execution-record}
- **Location**: `src/lib/storage/data-service.ts` · **Called by**: 约 13 处调用点（接入运行数据的核心写入路径）。
- **Read side**: `readRecords(user?, filters?: ReadRecordFilters, options?: ReadRecordsOptions): Promise<ExecutionRecord[]>`、`readConfig(user?, datasetType): Promise<ConfigItem[]>`、`deriveSubagentExecutions(args: DeriveSubagentArgs)`、`findBestRoutingConfig(...)`、`findBestOutcomeConfig(...)`。

### `getDatabaseAdapter(): DatabaseAdapter`  {#get-database-adapter}
- **Location**: `src/lib/storage/db-interface.ts`
- **Contract**: `DatabaseAdapter`（抽象存储接口）；`OpenGaussAdapter.query(text, params?)` 是具体的 OpenGauss/PostgreSQL 实现（调用最频繁的存储方法，约 32 处入向调用）。默认后端为 Prisma+SQLite。

### `resolveUser(request, explicitUser?): Promise<AuthResult>`  {#resolve-user}
### `canAccessSkill(skillId: string, username: string | null): Promise<{ allowed: boolean; skill: any }>`
- **Location**: `src/lib/auth/auth.ts` · `resolveUser` 有约 24 处入向调用 —— 几乎每个 API 路由都通过它解析调用者。

### `getActiveConfig(user?): Promise<ModelConfig | null>`  {#get-active-config}
### `getUserSettings(user?): Promise<UserSettings>` · `saveUserSettings(user, settings): Promise<void>`
- **Location**: `src/lib/storage/server-config.ts` —— 按用户维度的模型注册表与设置。

## Persistent data model (Prisma — `prisma/schema.prisma`)
默认使用 SQLite（`data/witty_insight.db`）；可通过 `DatabaseAdapter` 切换。字符串化的 JSON 列很常见（见下方标注）。

| Model | Purpose | Notable fields |
|---|---|---|
| `Skill` | 一个 skill，按 `(name, user)` 唯一 | `name`、`category`、`activeVersion`、`isUploaded`，关系 → versions/evaluations/issues |
| `SkillVersion` | 不可变的版本快照 | `version`、`content`、`files`（JSON）、`changeLog`、`enterpriseSkillId` |
| `User` | 账户 | `username`、`apiKey`（两者均唯一） |
| `Execution` | 一次接入的 agent 运行 | `taskId`、`framework`，token/成本/延迟指标，`invokedSkills`（JSON）、`answerScore`、`skillScore`，**子 agent 树**：`parentExecutionId` / `rootExecutionId` / `isSubagent` |
| `Evaluation` | 一次评测事件（`static`/`dynamic`/`trigger`） | `skillId`+`version`、`executionId`（dynamic）、`contentHash`（static）、`runId`、`generator` |
| `SkillIssue` | 一个优化点 | `source`、`severity`、`summary`、`suggestedFix`、`dedupKey`、`category`、`resolvedAt` |
| `Config` | 一条 ground-truth 数据集条目 | `query`、`datasetType`（`combined`/`routing`/`outcome`）、`expectedSkills`/`routingAnchors`/`standardAnswer`/`rootCauses`/`keyActions`（JSON） |
| `Session` | 原始接入的 session | `taskId`（唯一）、`interactions`（JSON） |
| `UserSettings` | 按用户维度的设置 | `settingsJson`（ServerSettingsV2） |
| `ParsedFlow` / `ExecutionMatch` | skill 流程 + 静态/动态对齐 | `flowJson`/`mermaidCode`；`matchJson`、`staticMermaid`、`dynamicMermaid` |
| `AgentEvalDataset` | 行为评测数据集 | `casesJson`、`datasetKind`、`targetSkill` |
| `BatchEvalTask` / `GrayscaleTask` | 批量与 A/B 编排状态 | `configJson`、`caseStatesJson` |
| `DebugJobResult` / `DebugHistory` | 调试/运行任务结果 | `output`、`sessionId` |
| `TrajectoryEvalResult` | 一条轨迹评测结果 | `trajectoryScore`、`dimensionScoresJson`、`deviationStepsJson`、`evaluatorRunId` |
| `RegisteredAgent` | 已知的 agent 身份 | `platform`+`name`+`user` 唯一、`agentType`、`agentOwnership` |
| `FaultDiagnosisSession` / `Message` | 故障诊断对话 | 关联到 `executionId` |
| `AgentDebugReport` | 存储的 AgentDebug 主诊断报告 | `reportJson`、`interactionsHash`、`status`；不再承载 Skills 分析 |
| `AgentDebugSkillsAnalysis` | AgentDebug 专用 Skills 步骤核验缓存 | `analysisJson`、`interactionsHash`、`status`、`keyActionCount` |
| `SkillGeneratorSession`/`Message`、`SkillOptSession`/`Message`/`Iteration` | playground 与优化对话历史 | `opencodeSessionId`、`files`（JSON），优化 `iterations` 带 `draftNumber` |
| `SkillTriggerEvalSet` / `Run` | 触发准确率数据集与运行 | `itemsJson`、`resultsJson`、`passRate`/`truePositiveRate`/`falsePositiveRate` |

## Key TypeScript data contracts (`types`)
核心接口（形状节选；完整成员见源码）：
- **Ingest / records** — `ExecutionRecord`（`storage/data-service.ts`）：`{ upload_id; task_id; query; framework; tokens; cost; latency; final_result; skill; invokedSkills: InvokedSkill[]; is_skill_correct; is_answer_correct; ... }`；`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`、`ConfigItem`、`InvokedSkill { name; version }`。
- **Evaluation** — `EvaluationResult`（`evaluation/evaluation-types.ts`）：维度得分（`functionalScore`/`efficiencyScore`/`practicalityScore`/`economicScore`：`DimensionScore`）+ `overallScore`/`weightedScore`；`JudgmentResult { is_correct; score; reason }`、`JudgeCriteria`、`TrajectoryEvalInput/Output`、`ABExperiment`、`TestCase`、`QualityBenchmark`。
- **A/B scoring** — `AbScoringResult` / `AbScoringPolicy` / `AbScoreBreakdown`（`skill-analysis/ab-scoring.ts`）：评级、决策、`allowRelease`。
- **Agent debug** — `AgentDebugReportPayload`、`AgentDebugIssue`、`AgentDebugRootCause`、`AgentDebugTriage`、`AgentDebugSkillsAnalysis`、`AgentDebugSkillsAnalysisRow`、`DebugTurn`、`DebugToolCall`（`engine/agent-debug/types.ts`）。
- **Trace** — `AgentNode`、`AgentEvent`、`ToolCall`、`RawInteraction`、`AgentNodeStats`（`engine/observability/agent-trace.ts`）。
- **Datasets** — `AgentDataset`、`DatasetCase`、`RootCauseItem`（`lib/agent-dataset-model.ts`、`server/agent_datasets_storage.ts`）。
- **Config / models** — `ModelConfig`、`UserSettings`（`storage/server-config.ts`）、`LlmProvider`（`lib/llm-providers.ts`）、`ModelPricing`（`shared/model-config.ts`）。
- **Skill gen/opt bridges** — `StreamSkillGeneratorOpts/Result`、`StreamSkillOptOpts/Result`（`lib/skill-generator-opencode-bridge.ts`、`lib/skill-opt-bridge.ts`）。

## Extension points
分析器报告了约 290 个导出的接口/抽象类（潜在的实现/扩展点）。其中影响力最大的几个：

| Name | Kind | File | Note |
|---|---|---|---|
| `DatabaseAdapter` | interface | `src/lib/storage/db-interface.ts` | 实现它以新增存储后端（已有 Prisma/SQLite 和 OpenGauss） |
| `SystemAgentDefinition` | interface | `src/lib/system-agents.ts` | 注册一个内部/系统 agent 身份 |
| `LlmProvider` | interface | `src/lib/llm-providers.ts` | 向注册表新增一个 LLM provider |
| `LlmEvaluatorConfig` / `CodeEvaluatorConfig` / `EvaluatorCard` | interface | `src/lib/evaluators/custom-evaluator-model.ts` | 定义一个自定义评测器 |
| `RunGeneralAgentInput/Result` | interface | `src/lib/engine/general-agent/runner.ts` | 定义一次内部 agent 运行的形状 |
| `SkillSpec` / `GenerationOptions` | interface | `src/lib/engine/skill-generation/{types,index}.ts` | 驱动 skill 生成 |
| `ParsedFlowResult` / `TraceSkillAlignment` | interface | `src/lib/engine/observability/flow-parser.ts` | 流程对齐结果 |
| `EvaluationResult` & friends | interface | `src/lib/engine/evaluation/evaluation-types.ts` | 评测契约面 |
| `AgentInbox` / `HITLRequest` / `ActionRequest` | interface | `src/components/thread/agent-inbox/types.ts` | human-in-the-loop UI |

完整的按模块清单（lib: 232、components: 42、server: 10、app: 9、prompts: 2）见分析输出。CLI 入口点来自 `package.json` 的 `bin`（`skill-insight` → `bin/cli.js`）。
