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
| OTel spool consumer | [#otel-spool-consumer](#otel-spool-consumer) | lib/ingest |
| `getAdapter` / `resolveFrameworkId` / `listFrameworks` | [#framework-adapter-registry](#framework-adapter-registry) | lib/ingest |
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
- **Related**: `aggregateTrajectoryScore(dims, deviations): { trajectoryScore; rawWeightedScore; scoreAggregation }`（同一文件）。
- **Trace evidence**: `/api/eval/trajectory/run` 使用 `trace-summarizer.ts:summarizeTrace + formatTraceForLLM` 从 `Session.interactions` 生成事件级 `actualExtractedSteps`（user/llm/tool/skill/task），不再把 `ExecutionMatch.extractedSteps` 的高层业务步骤作为轨迹评测的唯一事实来源。

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
- **Framework skill dispatcher**: `extractInvokedSkillsFromSessionInteractions(framework, interactions): InvokedSkill[] | null` 统一经由 `FrameworkAdapter.extractSkills`，未知框架返回 `null`。
- **Trace lifecycle**: callers that have an explicit completion signal pass `trace_completed_at`; `saveExecutionRecord` writes it to `Session.endTime`. Hermes records without an explicit value are allowed to infer completion from the latest interaction timestamp only when a final result is present. OpenCode uploader treats `session.idle` plus a final assistant result as an explicit completion point and sends `trace_completed_at`; the observe read side also applies the 60s quiet-window fallback to Hermes/OpenCode traces whose completion was not persisted. Observe pages derive trace execution status from `Session.endTime` or read-side lifecycle inference, not from evaluation status.
- **Trace list pagination**: Trace 页面使用 `/api/observe/data?paginated=1&databasePagination=1` 显式启用数据库分页；在 SQLite/Prisma 主路径将可下推过滤、排序、`skip/take` 与 `count` 放进数据库查询，随后只对当前页附加标签、评测状态和生命周期。仅按计算型状态过滤/排序时保留兼容扫描路径；未传 `databasePagination=1` 的既有分页调用方保持原读取语义。分页响应包含 `records/total/page/pageSize/stats`。
- **Trace detail loading**: `/api/observe/session` 默认或 `view=full` 保持完整 Session 契约；`view=structure` 返回可建树的轻量 interactions，并在 Langfuse Session 上附加完整 `langfuseTraceNodes`；`view=interaction&index=N` 返回单条完整 interaction，`view=interactions` 在 Prompt/Timeline/搜索确需完整上下文时按需返回全部 interactions。长正文不在存储层截断。

### OTel spool consumer  {#otel-spool-consumer}
- **External endpoints**: `POST /api/ingest/otel/v1/logs` accepts OTLP http/json payloads. `POST /api/ingest/otel/v1/traces` accepts OTLP http/json and OTLP http/protobuf payloads, normalizes events, appends JSONL spool rows, and returns `status: "accepted"` after the append succeeds. `POST /api/public/otel/v1/traces` is a Langfuse-compatible alias that reuses the same traces handler. `POST /api/ingest/otel/v1/metrics` accepts vLLM OTLP metrics over JSON or protobuf, normalizes them to the infra metric sample shape, persists them best-effort to `InfraMetricSample`, and returns an immediate diagnosis verdict. The response means accepted, not necessarily already visible in every observe query or persisted to `Execution`.
- **RAS bypass ingest**: `POST /api/ingest/ras-events` accepts JSON single events or `{ events: [...] }` with a valid `x-witty-api-key` (same identity as OTel). Requires flat `taskId`, `type`, and **required** UUID `deliveryId`; atomically upserts by `(taskId, deliveryId)`. No deep-path rewrite, `witty.*` aliases, or `rasEventId`. The route **must not** write OTel spool. `GET ...?taskId=` and `GET ...?summary=1` derive the user exclusively from the API key; a caller-supplied `user` query cannot select another account. Summary mode returns that user's root `Execution` list left-joined with RAS summaries (`traces` only). Synthetic/orphan task IDs remain ingest diagnostics and do not appear as Trace rows. `DELETE /api/ingest/ras-events` with body `{ taskIds: string[] }` (or single `taskId`) deletes only root executions owned by the API-key user, plus matching `Session` and `RasAnomalyEvent` rows (`deleteReliabilityTraces`). Source tree: repo-root `agent_ras/` (pure inproc); install: `scripts/install-ras.js`; config root `~/.agent-insight/ras`. See `docs/agent-ras/designs/modules/ras-embed.md` and `docs/developer-guide/09-otlp-attribute-contract.md`.
- **RAS capability config**: `GET/PUT /api/agent-ras/config?platform=` stores per-user×platform desired `AgentRASConfig` under `~/.agent-insight/data/ras-capability-configs/`. `GET /api/ingest/ras-config?platform=` is the client pull endpoint; when `syncEnabled` is false the payload omits `config`. Client merge (fail-open; preserves `service.*` / `insight.*`): OpenCode plugin startup (`opencode/config_sync.js`), xiaoO hooker session start (`xiaoo/config_sync.py`, TTL-gated per platform). Local file keeps `platforms.<platform>` (+ `syncedFrom` provenance); merge when **content fingerprint** of capability fields differs (Insight wins). Server `revision`/`updatedAt` remain on the API envelope for UI/audit only. UI: `/agent-ras/fault-modes?view=configure`. Design: `docs/agent-ras/designs/features/capability-config-sync.md`.
- **RAS client install lifecycle**: platform `start` never installs or requires the Agent-host RAS runtime. `/api/ingest/setup` and `/api/ingest/setup/auto` install it when OpenCode, Hermes, or OpenClaw is selected, after persisting the current user's host/API key. The generated command pins the serving package name/version through `src/lib/ingest/setup-package.ts`; `AGENT_INSIGHT_CLIENT_PACKAGE_SPEC` may override it with an Agent-host-accessible package URL for source/private-package testing. It downloads the tarball with an isolated npm cache and `npm pack --ignore-scripts`, validates the packaged installer/runtime, executes `scripts/install-ras.js` directly, then performs an authenticated read-only GET preflight against the RAS ingest route. Ordinary component downloads use `/api/ingest/setup/*`, write through temporary files, and report `PARTIAL` instead of a false `READY` when OpenCode telemetry is incomplete. Restart keeps an existing client API key instead of replacing it with the internal admin key.
- **OpenCode RAS recovery**: one assistant message may trigger at most one anomaly/action batch; residual deltas after `abort_stream` are used only to confirm whether the stream stopped. Anomaly payloads preserve the complete requested action array, including `push_steering`/`emit_notice` message content. LLM/tool detection events carry the OpenCode `messageID`/`partID` or `callID` as `trace_anchor`; action results repeat that detection anchor, retain the delivered message, and when prompt delivery succeeds also include `delivery_anchor` (`message_id` of the notice/steering user message, channel `ras_notice`/`ras_steering`). The UI reclassifies those delivery interactions as RAS (not USER), hangs recovery details on detection and delivery nodes, and interleaves each action with its result. In headless `opencode run`, notice delivery uses `session.prompt` with `noReply` and skips TUI-only toast/double-Esc calls. Live scripts that rewrote user config or started/interrupted a real OpenCode process were removed; retained tests call the embedded runtime in isolated state.
- **OpenCode partial stream**: `scripts/opencode_uploader_client.js` accumulates `message.part.delta` by `(messageID, partID, field)` and merges it with `message.part.updated` / `experimental.text.complete`. This is required for RAS-aborted calls because an interrupted assistant turn may never emit the final complete callback. OpenCode event IDs make delta reconstruction idempotent when duplicate telemetry plugin instances observe the same native event.
- **Spool layout**: new OTel writes are day + session sharded: ClaudeCode logs go to `~/.agent-insight/otel_data/claude/YYYY-MM-DD/sessions/<safe-session>/logs.jsonl`; Hermes and generic traces go to `~/.agent-insight/otel_data/traces/YYYY-MM-DD/sessions/<safe-session>/traces.jsonl`. File discovery is recursive and still consumes legacy daily files such as `YYYY-MM-DD/logs.jsonl` and `YYYY-MM-DD/traces.jsonl`.
- **Trace normalization**: `src/lib/ingest/otel/decode.ts` converts transport payloads into the JSON-compatible OTLP shape. `normalizeClaudeOtlpTraces` maps common `gen_ai.*` / `llm.*` fields plus Hermes-style `llm.model_name`, `llm.token_count.*`, `input.value`, `output.value`, and `hermes.session_id`. Langfuse Python SDK / LangChain CallbackHandler payloads are detected by `langfuse.observation.type`; when a Langfuse payload has no valid `x-witty-api-key`, the traces route requires Langfuse credentials where the public key is an Agent Insight username and the secret key is that user's Agent Insight API Key, otherwise the request is rejected before writing spool. `src/lib/ingest/otel/langfuse.ts` preserves `span/chain/agent/tool/generation` events, uses the authenticated user as owner, and keeps `langfuse.observation.*` metadata for aggregation. Langfuse traceId becomes the Agent Insight execution id; Langfuse `session_id` is optional cross-trace conversation metadata. `aggregateOtelTraceEvents` delegates Langfuse LangGraph sessions to `src/lib/ingest/otel/adapters/langfuse-langgraph.ts`, Hermes sessions to `src/lib/ingest/otel/adapters/hermes.ts`, and all other traces to the generic adapter. The Langfuse adapter keeps the legacy interactions projection for evaluation compatibility and additionally uses `langfuse-trace.ts` to map every observation to a `LangfuseTraceNode`; snapshots merge monotonically by spanId into `Session.langfuseTraceNodes`. `langfuse-agent-trace.ts` translates the root request's last user/human message and visible observations into the existing `AgentTraceView` model: the question becomes a USER event, agent observations become expandable Agent calls, LLM/tool observations keep their event kind, and business chain/span observations become nested CHAIN rows with input/output details. `sourceSpanId` and `parentSourceSpanId` preserve the visible hierarchy after wrapper collapsing. Known LangGraph wrapper nodes with children and empty leaf wrappers are omitted from the display projection without being deleted from `langfuseTraceNodes`; their children are promoted to the nearest visible parent, while a leaf wrapper with independent input/output remains visible even when its duration is zero. This field and projection are only used for `langfuse` and `langfuse-langgraph`; other framework adapters, Session behavior, and UI tree building are unchanged. The adapter still maps `follow_skill` to a `skill` tool call, `call_report_subagent` to a `task` call, and nested LangGraph spans to `role=subagent` interactions. Hermes registers `sessionMergeStrategy: "snapshot-replace"`; the first-party plugin sends completed-span delta OTLP payloads, while the server-side trace spool re-reads all retained events for the session and replaces the stored record with that current aggregate. Generic non-Hermes traces continue through the common OTel aggregator.
- **Startup**: `src/instrumentation-node.ts:setupNodeRuntime()` calls `startOtelSpoolConsumer()` for the Node runtime. The consumer is process-local and guarded by `globalThis.__otelSpoolConsumer`.
- **Infra poller**: the same startup path calls `startInfraPoller()` from `src/lib/infra/poller.ts`; it periodically scrapes enabled pull sources from `InfraSource` and saves samples through `src/lib/infra/store.ts`.
- **Consumer API**: `startOtelSpoolConsumer(options?)`, `stopOtelSpoolConsumer()`, and `runOtelSpoolConsumerTick(state)` live in `src/lib/ingest/otel-consumer/consumer.ts`.
- **Source API**: `SpoolSource` in `src/lib/ingest/otel-consumer/sources.ts` registers `claude-otel-logs` and `otel-traces`. Sources own aggregation; the consumer owns scheduling/checkpoints and must not branch on framework names.
- **State files**: checkpoints are stored as `consumer-checkpoint.json` beside each spool root and keyed by relative JSONL path, including nested `sessions/<safe-session>/...` shards. Checkpoints advance only after fast save succeeds; if a file is truncated or recreated and the stored byte offset points past EOF, the next read restarts at byte `0` and persists the new cursor. Duplicate protection is handled by source-level dedupe plus `saveExecutionRecord` upsert keys.

### `getAdapter(framework)` / `resolveFrameworkId(framework)` / `listFrameworks()`  {#framework-adapter-registry}
- **Location**: `src/lib/ingest/adapters/registry.ts`
- **Contract types**: `FrameworkAdapter`、`FrameworkDescriptor`（`src/lib/ingest/adapters/types.ts`）。
- **Current responsibilities**: 框架名别名解析（`claudecode` → `claude`）、框架 skill 抽取分发、Claude 入库前 interactions 归一化。Langfuse-Langgraph 的 OTel adapter 负责 span→`ExecutionRecord` 转换；对应 `FrameworkAdapter` 声明 `skills/subagentTree`，并让归一化后的 `skill` tool call 进入 `ExecutionSkill` / `invokedSkills` 的统一解析路径。adapter 是纯转换层，不访问 DB/网络；入库仍由 `saveExecutionRecord` 负责。

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
| `Tag` | 用户维护的 Trace 标签定义 | `name`、`kind`（`version`/`business`）、`color`、`description`、`user`；系统标签不入库 |
| `ExecutionTag` | Trace 与用户标签的多对多绑定 | `executionId`、`tagId`、`user`；删除 `Tag` 时级联清理绑定，不删除 Trace |
| `InfraSource` | 推理服务指标源 | `endpoint`（session 关联键）、`scrapeUrl`、`kind`（`pull`/`push`）、`model`、`hardwareName`、`scrapeIntervalMs` |
| `InfraMetricSample` | 某个 infra 源的一次指标采样 | `sourceId`、`tsMs`、`via`、`model`、`gauges`/`counters`/`histograms`（JSON） |
| `SessionInfraLink` | session 与 infra 源的人工覆盖关联 | `rootExecutionId`、`sourceId`、`model` |
| `Evaluation` | 一次评测事件（`static`/`dynamic`/`trigger`） | `skillId`+`version`、`executionId`（dynamic）、`contentHash`（static）、`runId`、`generator` |
| `SkillIssue` | 一个优化点 | `source`、`severity`、`summary`、`suggestedFix`、`dedupKey`、`category`、`resolvedAt` |
| `Config` | 一条 ground-truth 数据集条目 | `query`、`datasetType`（`combined`/`routing`/`outcome`）、`expectedSkills`/`routingAnchors`/`standardAnswer`/`rootCauses`/`keyActions`（JSON） |
| `Session` | 原始接入的 session | `taskId`（唯一）、`interactions`（JSON）；Langfuse 专属可空 `langfuseTraceNodes`（完整 observation JSON） |
| `RasAnomalyEvent` | RAS 旁路事件 | `taskId`、`deliveryId`（必填幂等键）、`executionId`、`payloadJson`、`user` |
| `UserSettings` | 按用户维度的设置 | `settingsJson`（ServerSettingsV2） |
| `ParsedFlow` / `ExecutionMatch` | skill 流程 + 静态/动态对齐 | `flowJson`/`mermaidCode`；`matchJson`、`staticMermaid`、`dynamicMermaid` |
| `AgentEvalDataset` | 行为评测数据集 | `fieldsJson` 保存动态字段 schema；`casesJson` 保存固定兼容字段与 `values`；另有 `datasetKind`、`targetSkill` |
| `BatchEvalTask` / `GrayscaleTask` | 批量与 A/B 编排状态 | `configJson`、`caseStatesJson` |
| `DebugJobResult` / `DebugHistory` | 调试/运行任务结果 | `output`、`sessionId` |
| `TrajectoryEvalResult` | 一条轨迹评测结果 | `trajectoryScore`、`dimensionScoresJson`、`deviationStepsJson`、`evaluatorRunId` |
| `TraceEvaluation` | 一个 trace 的单项质量评测 | `evaluatorId`+`metricKey` 幂等唯一，`score=null` 表示 N/A，保留 `confidence`/`method`/`evidenceJson`/`interactionsHash` |
| `RegisteredAgent` | 已知的 agent 身份 | `platform`+`name`+`user` 唯一、`agentType`、`agentOwnership` |
| `FaultDiagnosisSession` / `Message` | 故障诊断对话 | 关联到 `executionId` |
| `AgentDebugReport` | 存储的 AgentDebug 主诊断报告 | `reportJson`、`interactionsHash`、`status`；不再承载 Skills 分析 |
| `AgentDebugSkillsAnalysis` | AgentDebug 专用 Skills 步骤核验缓存 | `analysisJson`、`interactionsHash`、`status`、`keyActionCount` |
| `SkillGeneratorSession`/`Message`、`SkillOptSession`/`Message`/`Iteration` | playground 与优化对话历史 | `opencodeSessionId`、`files`（JSON），优化 `iterations` 带 `draftNumber` |
| `SkillTriggerEvalSet` / `Run` | 触发准确率数据集与运行 | `itemsJson`、`resultsJson`、`passRate`/`truePositiveRate`/`falsePositiveRate` |

## Key TypeScript data contracts (`types`)
核心接口（形状节选；完整成员见源码）：
- **Version analysis** - `VersionCompareResponse` / `VersionTracesResponse` (`lib/version-analysis.ts`): compare APIs only aggregate `Execution.isSubagent=false` traces bound to `Tag.kind=version`; `VersionCompareResponse.summary` is the de-duplicated global summary for the current user/agent/framework/time-window, while `versions` can be narrowed by `questionKey` for single-question comparison; `questionKey` is normalized from `Execution.query`; accuracy uses `Execution.answerScore`; run success rate is derived from `Session.endTime` and is not stored.
- **Ingest / records** — `ExecutionRecord`（`storage/data-service.ts`）：`{ upload_id; task_id; query; framework; tokens; cost; latency; endpoint; final_result; trace_completed_at; skill; invokedSkills: InvokedSkill[]; userTags: TraceTagDto[]; is_skill_correct; is_answer_correct; ... }`；`latency` 统一以秒落库，前端展示通过 `latency-format.ts` 换算为 ms/s/m/h；`endpoint` 归一为 `scheme://host:port`，用于 session 与 infra 源关联；`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`、`ConfigItem`、`InvokedSkill { name; version }`。
- **Framework adapters** — `FrameworkAdapter`（`ingest/adapters/types.ts`）：`{ descriptor; extractSkills?; normalizeForStorage? }`；`FrameworkDescriptor { id; aliases?; label; onboard; platform? }`。
- **Evaluation** — `EvaluationResult`（`evaluation/evaluation-types.ts`）：维度得分（`functionalScore`/`efficiencyScore`/`practicalityScore`/`economicScore`：`DimensionScore`）+ `overallScore`/`weightedScore`；`JudgmentResult { is_correct; score; reason }`、`JudgeCriteria`、`TrajectoryEvalInput/Output`、`ABExperiment`、`TestCase`、`QualityBenchmark`。
- **Agent dataset** — `AgentDatasetRecord` / `DatasetCase` / `DatasetField`（`server/agent_datasets_storage.ts`）：字段 schema 存于 `fields`，样本值存于 `values`。字段名称在单个数据集内唯一，用户新增字段时 key 由前端生成；`POST/PATCH /api/agent-datasets` 在归一化前严格拒绝非法或重复 key，避免写入请求被静默裁剪，历史数据读取仍使用宽松归一化保证兼容。归一化时只同步实际存在的 `input`、`reference_output → expectedOutput`、`trace → trajectory`。数据集存储不强制 `input`，具体评测所需字段由执行入口校验。`POST /api/agent-datasets/trace-drafts` 直接使用 `Execution.query` 作为 input、`Execution.finalResult` 作为 output，并返回调用 `summarizeTrace` 之前的 interactions JSON 数组作为 `trace`；不再调用任务输入/输出提取器。前端以并发度 3 批量调用。`POST /api/agent-datasets/backflow` 要求明确的 `mode`；新建模式接收完整 `fields`，已有模式接收 `datasetId + newFields`，两种模式都接收映射并预览后的 `cases[].values`，JSON 字段会解析为结构化值，字段 schema 与 cases 通过一次存储更新写入。旧的单条 `values + traceSource` 形状仍可兼容，但不会自动补字段。
- **Result quality** — `evaluateResultQuality(executionId)` / `scheduleResultEvaluation(executionId)`（`evaluation/result-quality-evaluator.ts`）返回忠实度、指令遵循、答案质量、准确性四个 `ResultEvalResult`。忠实度由 `faithfulness-evaluator.ts` 复用 `buildAgentCallTree + walkTree`，只把最终交付生成 Agent 可见且有 output 的 TOOL 事件转成 `RetrievedContext`；先独立提取原子 claims，再对短 context 全量验证、对长 context 按行切块和逐 claim Top-K 召回后分批验证。`supported/contradicted` 引用必须命中允许的 context ID 且摘录属于原文，代码计算支持比例；无工具证据或无可验证主张为 N/A。指令遵循 `evidence` 保存 `constraints`、逐项 `verdicts`、两阶段置信度和专属原因；答案质量保存 statements/requirements、相关性与完整性 verdict、连贯性 rubric 结果、三个子分和专属原因。各项在 `evidence.calls` 保留子调用的 stage、状态、耗时和结构化响应；失败时已完成的调用诊断也会落库。四项使用独立 evaluator version 与输入 hash。`TraceLite.resultMetrics` 为质量报告读模型，`MetricScore` 附带 `confidence`/`methodBreakdown`/`naReason`/`evidence`；其中 `MetricScore.evidence[].detail` 保留单条 trace 的结构化 `evidenceJson`，供质量监控页的评测详情表格展示。
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
| `FrameworkAdapter` | interface | `src/lib/ingest/adapters/types.ts` | 新增框架的 skill 抽取、存储归一化、框架描述信息入口 |
| `SystemAgentDefinition` | interface | `src/lib/system-agents.ts` | 注册一个内部/系统 agent 身份 |
| `LlmProvider` | interface | `src/lib/llm-providers.ts` | 向注册表新增一个 LLM provider |
| `LlmEvaluatorConfig` / `CodeEvaluatorConfig` / `EvaluatorCard` | interface | `src/lib/evaluators/custom-evaluator-model.ts` | 定义一个自定义评测器 |
| `RunGeneralAgentInput/Result` | interface | `src/lib/engine/general-agent/runner.ts` | 定义一次内部 agent 运行的形状 |
| `SkillSpec` / `GenerationOptions` | interface | `src/lib/engine/skill-generation/{types,index}.ts` | 驱动 skill 生成 |
| `ParsedFlowResult` / `TraceSkillAlignment` | interface | `src/lib/engine/observability/flow-parser.ts` | 流程对齐结果 |
| `EvaluationResult` & friends | interface | `src/lib/engine/evaluation/evaluation-types.ts` | 评测契约面 |
| `AgentInbox` / `HITLRequest` / `ActionRequest` | interface | `src/components/thread/agent-inbox/types.ts` | human-in-the-loop UI |

完整的按模块清单（lib: 232、components: 42、server: 10、app: 9、prompts: 2）见分析输出。CLI 入口点来自 `package.json` 的 `bin`（`skill-insight` → `bin/cli.js`）。




## Trace Bundle 导入导出契约

- `GET /api/observe/traces/export?executionId=<id>`：校验当前用户可见性；若传入子 Agent Execution，则先解析到根 Execution，再导出整棵树。响应为 `agent-insight.trace-bundle` v1 JSON，并设置下载文件名。
- `POST /api/observe/traces/import`：请求体为 `{ user?, fileName?, bundle }`。服务端限制 50 MB、500 个 Execution 节点，校验格式版本、根节点、父节点存在性、`rootExecutionId` 一致性、重复 ID 和环。成功返回原始 `originalRootExecutionId`、导入后的 `rootExecutionId` / `rootTaskId`、Execution/子 Agent 数量和 `remappedIds`。
- v1 Bundle 顶层字段为 `format`、`version`、`exportedAt`、`rootExecutionId`、`executions`；每个节点包含 portable Execution 与可空 Session。Session `interactions` 保留规范化原始值，不做面向展示的时间格式化。
- `Execution.id` 与 Execution/Session `taskId` 共享冲突检测空间。无冲突 ID 原样保留；有冲突 ID 才生成 `import_<uuid>`，并同步更新父子 ID、root ID、`agentSessionId` 及 interactions 中已知的 session/execution 引用。OTel `traceId` / `spanId` / `parentSpanId` 不参与重映射。
- 导入只创建 Execution、Session 和可重算的 ExecutionSkill；不迁移 Evaluation、TraceEvaluation、AgentDebugReport、ExecutionTag 或基础设施关联，也不调度 LLM 评测。
