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
- **Trace lifecycle**: callers with an explicit invocation window pass `trace_started_at` and `trace_completed_at`; `saveExecutionRecord` writes valid values to `Session.startTime/endTime` and rejects an end earlier than the explicit start. Callers that only know completion may continue to pass `trace_completed_at`. Hermes records without an explicit value are allowed to infer completion from the latest interaction timestamp only when a final result is present. OpenCode uploader treats `session.idle` plus a final assistant result as an explicit completion point and sends `trace_completed_at`; the observe read side also applies the 60s quiet-window fallback to Hermes/OpenCode traces whose completion was not persisted. Observe pages derive trace execution status from `Session.endTime` or read-side lifecycle inference, not from evaluation status.
- **Trace list pagination**: Trace 页面使用 `/api/observe/data?paginated=1&databasePagination=1` 显式启用数据库分页；在 SQLite/Prisma 主路径将可下推过滤、排序、`skip/take` 与 `count` 放进数据库查询，随后只对当前页附加标签、评测状态和生命周期。仅按计算型状态过滤/排序时保留兼容扫描路径；未传 `databasePagination=1` 的既有分页调用方保持原读取语义。分页响应包含 `records/total/page/pageSize/stats`。
- **Trace user-tag filter**: `/api/observe/data` 的 `tagIds` 接收逗号分隔的最多 20 个版本标签或业务标签 ID；标签必须属于当前用户，多个标签使用 AND 语义。旧 `bizTag` 参数继续兼容，仅匹配业务标签，逗号分隔的多个值保持 OR 语义；同时传入时以 `tagIds` 为准。
- **Trace detail loading**: `/api/observe/session` 默认或 `view=full` 保持完整 Session 契约；`view=structure` 返回可建树的轻量 interactions，并在 Langfuse Session 上附加完整 `langfuseTraceNodes`；`view=interaction&index=N` 返回单条完整 interaction，`view=interactions` 在 Prompt/Timeline/搜索确需完整上下文时按需返回全部 interactions。长正文不在存储层截断。Trace 页面与抽屉会把 `Execution.framework` 传给 `AgentTraceView`；`langfuse-langgraph` 使用框架级 `SmartViewerConfigProvider` 将其中所有 JSON 树默认设为完全展开，其他框架保留共享渲染器的两层折叠默认值。

### `GET /api/experiments/agents` / `GET /api/experiments/traces`
- **Agent candidates**: `src/app/api/experiments/agents/route.ts` 只聚合当前用户的 root Trace，并通过 `buildExecutionOwnershipWhere('user')` 排除 `RegisteredAgent.agentOwnership='system'` 以及内置系统 Agent；响应中的 trace 数也使用同一归属口径。
- **Location**: `src/app/api/experiments/traces/route.ts`
- **Scope**: 新建实验第 ② 步的 root Trace 服务端筛选与分页；基础条件为 `user + agent + isSubagent=false + agentOwnership=user`，防止同名系统 Agent 的 Trace 混入。
- **Query contract**: `search` 同时对 `Execution.id`、`taskId`、`query` 做包含匹配；`from` / `to` 接收 ISO 时间并作为闭区间边界；`tagIds` 接收逗号分隔的最多 20 个用户标签 ID，跨版本标签和业务标签使用 AND 语义；`pageSize` 上限 100。响应保持 `{ total, page, pageSize, items }`，其中 `total` 是应用全部筛选后的数量。
- **Selection contract**: 前端分页和跨页全选必须复用同一组筛选参数；筛选条件只影响已有 Trace 候选，不持久化为 `Experiment.watchMode` 的监听规则。监听模式收到新 Trace 后会再次应用用户归属条件，系统 Agent Trace 不进入实验。

### OTel spool consumer  {#otel-spool-consumer}
- **External endpoints**: `POST /api/ingest/otel/v1/logs` accepts OTLP http/json payloads. `POST /api/ingest/otel/v1/traces` accepts OTLP http/json and OTLP http/protobuf payloads, normalizes events, appends JSONL spool rows, and returns `status: "accepted"` after the append succeeds. `POST /api/public/otel/v1/traces` is a Langfuse-compatible alias that reuses the same traces handler. `POST /api/ingest/otel/v1/metrics` accepts vLLM OTLP metrics over JSON or protobuf, normalizes them to the infra metric sample shape, persists them best-effort to `InfraMetricSample`, and returns an immediate diagnosis verdict. The response means accepted, not necessarily already visible in every observe query or persisted to `Execution`.
- **Spool layout**: new OTel writes are day + session sharded: ClaudeCode logs go to `~/.agent-insight/otel_data/claude/YYYY-MM-DD/sessions/<safe-session>/logs.jsonl`; Hermes and generic traces go to `~/.agent-insight/otel_data/traces/YYYY-MM-DD/sessions/<safe-session>/traces.jsonl`. File discovery is recursive and still consumes legacy daily files such as `YYYY-MM-DD/logs.jsonl` and `YYYY-MM-DD/traces.jsonl`.
- **AcTrail curl setup**: both `GET /api/ingest/setup` and `GET /api/ingest/setup/auto` expose AcTrail alongside the existing framework choices. Setup never installs or wraps AcTrail. On Unix/WSL it locates an already-installed official `otel-http` manifest, writes `~/.agent-insight/actrail/otel-http.config.toml` with the current OTLP traces endpoint, `attribute_mode = "full"`, protobuf encoding and the current user's `x-witty-api-key`, then loads the `agent-insight.otel-http` instance through the running daemon with `--persist`. The default operator config is `/etc/actrail/actraild.conf`; non-default deployments can set `ACTRAIL_OPERATOR_CONFIG` and `ACTRAIL_PLUGIN_DIR` before running setup. Native PowerShell generation keeps the option visible but directs the user to execute the Unix setup inside the WSL environment where AcTrail runs.

- **Trace normalization**: `src/lib/ingest/otel/decode.ts` converts transport payloads into the JSON-compatible OTLP shape. `normalizeClaudeOtlpTraces` maps common `gen_ai.*` / `llm.*` fields plus Hermes-style `llm.model_name`, `llm.token_count.*`, `input.value`, `output.value`, and `hermes.session_id`. Langfuse Python SDK / LangChain CallbackHandler payloads are detected by `langfuse.observation.type`; when a Langfuse payload has no valid `x-witty-api-key`, the traces route requires Langfuse credentials where the public key is an Agent Insight username and the secret key is that user's Agent Insight API Key, otherwise the request is rejected before writing spool. `src/lib/ingest/otel/langfuse.ts` preserves `span/chain/agent/tool/generation` events, uses the authenticated user as owner, and keeps `langfuse.observation.*` metadata for aggregation. Langfuse traceId becomes the Agent Insight execution id; Langfuse `session_id` is optional cross-trace conversation metadata. `aggregateOtelTraceEvents` delegates AcTrail sessions to `src/lib/ingest/otel/adapters/actrail.ts`, Langfuse LangGraph sessions to `src/lib/ingest/otel/adapters/langfuse-langgraph.ts`, Hermes sessions to `src/lib/ingest/otel/adapters/hermes.ts`, and non-specialized traces to the generic adapter. The Langfuse adapter keeps the legacy interactions projection for evaluation compatibility and additionally uses `langfuse-trace.ts` to map every observation to a `LangfuseTraceNode`; snapshots merge monotonically by spanId into `Session.langfuseTraceNodes`. Agent observations that produce independent child executions also persist `subagentSessionId`, whose value equals the child `Execution.taskId`; the display projection uses it for Trace navigation, and derives the same deterministic value from the root Session ID plus spanId when reading historical nodes that predate this field. Because Langfuse exports completed spans incrementally, aggregation requires either `langfuse.internal.is_app_root` or an actually observed top-level span before persisting a root `Execution`; a child `agent` span whose parent has not arrived is not promoted to a provisional root. The sub-agent scope includes the named `agent` span itself as well as its descendants. `langfuse-agent-trace.ts` translates the root request's last user/human message and visible observations into the existing `AgentTraceView` model: the question becomes a USER event, agent observations become expandable Agent calls, LLM/tool observations keep their event kind, and business chain/span observations become nested CHAIN rows with input/output details. LLM events carry a bounded, role-normalized projection of their own generation request messages; tool-definition payloads shaped as `{type:"function",function:{name,description|parameters}}` are excluded from the conversation projection, while real tool results retain their `tool_call_id`. `AgentTraceView` uses that projection as the exclusive Prompt snapshot source, includes assistant tool calls in cross-generation prefix alignment, separates stable system/prior turns into History and the latest user/tool suffix into Current input, and never treats neighboring chain/span outputs as chat history. Generation output `tool_calls` are projected onto the assistant interaction so the Output section shows the selected tool and arguments. `sourceSpanId` and `parentSourceSpanId` preserve the visible hierarchy after wrapper collapsing. Known LangGraph wrapper nodes with children and empty leaf wrappers are omitted from the display projection without being deleted from `langfuseTraceNodes`; their children are promoted to the nearest visible parent, while a leaf wrapper with independent input/output remains visible even when its duration is zero. This field and projection are only used for `langfuse` and `langfuse-langgraph`; other framework adapters, Session behavior, and UI tree building are unchanged. The adapter still maps `follow_skill` to a `skill` tool call, `call_report_subagent` to a `task` call, and nested LangGraph spans to `role=subagent` interactions. Hermes registers `sessionMergeStrategy: "snapshot-replace"`; the first-party plugin sends completed-span delta OTLP payloads, while the server-side trace spool re-reads all retained events for the session and replaces the stored record with that current aggregate. Non-specialized traces continue through the common OTel aggregator.
- **AcTrail specialization**: AcTrail payloads are detected by `actrail.trace.id`, an `actrail.*` instrumentation scope, or `actrail.action.kind`. `normalizeActrailOtlpTraces` preserves semantic-action links and response usage. The AcTrail adapter applies last-arrival-wins only to duplicate AcTrail Span IDs, pairs `llm.call` with its request and response action IDs, and projects model content, logical tool calls and Skill calls into the common interaction shape. It registers snapshot replacement so later snapshots replace partial projections instead of accumulating duplicate interactions. Explicit user-turn and session fields remain preferable to the current request-header heuristic.
- **Qoder CN specialization**: `src/lib/ingest/otel/adapters/qoder.ts` is registered before the generic adapter. It selects the newest completed snapshot for a reused session; maps CLI/Desktop/JetBrains/Work Agent, Quest, Experts, LLM, Tool, Skill, MCP, connector, and Subagent spans into `ExecutionRecord`; and preserves nested Subagent ownership through `Task` calls plus `subagent_session_id`. MCP calls expose `mcp_server_name`/`mcp_tool_name`; built-in connectors additionally expose `connector_name`/`connector_tool_name`. The Qoder `FrameworkAdapter` declares `snapshot-replace`, Skill extraction, Subagent tree support, and the trusted server-side `allowSnapshotShrink` capability. Incoming payloads cannot enable snapshot shrink themselves.
- **Qoder plugin downloads**: `GET /api/ingest/setup/qoder-desktop-vsix` deterministically builds the Qoder CN Desktop VSIX from `integrations/qoder-desktop/`, reusing `.next/cache/qoder-plugins/` only while its source-mtime signature is current. `GET /api/ingest/setup/qoder-jetbrains-plugin` resolves a compiled JetBrains ZIP in this order: current source-signature cache, configured/default trusted Release attachment, still-valid stale cache, then local source build. Remote packages are size-limited and accepted only when the ZIP contains a compiled plugin JAR with `META-INF/plugin.xml`. The final source-build fallback requires `JETBRAINS_HOME`/an IDE JBR or Gradle `buildPlugin`; Java source files are never served as an installable plugin. The default Release URL and `AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL` override are centralized in `src/lib/ingest/qoder-plugin-release.ts`. Package names come from source manifests; both routes use attachment filenames, disable MIME sniffing, and accept no caller-controlled filesystem path.

- **Startup**: `src/instrumentation-node.ts:setupNodeRuntime()` calls `startOtelSpoolConsumer()` for the Node runtime. The consumer is process-local and guarded by `globalThis.__otelSpoolConsumer`.
- **Infra poller**: the same startup path calls `startInfraPoller()` from `src/lib/infra/poller.ts`; it periodically scrapes enabled pull sources from `InfraSource` and saves samples through `src/lib/infra/store.ts`.
- **Consumer API**: `startOtelSpoolConsumer(options?)`, `stopOtelSpoolConsumer()`, and `runOtelSpoolConsumerTick(state)` live in `src/lib/ingest/otel-consumer/consumer.ts`.
- **Source API**: `SpoolSource` in `src/lib/ingest/otel-consumer/sources.ts` registers `claude-otel-logs` and `otel-traces`. Sources own aggregation; the consumer owns scheduling/checkpoints and must not branch on framework names.
- **State files**: checkpoints are stored as `consumer-checkpoint.json` beside each spool root and keyed by relative JSONL path, including nested `sessions/<safe-session>/...` shards. Checkpoints advance only after fast save succeeds; if a file is truncated or recreated and the stored byte offset points past EOF, the next read restarts at byte `0` and persists the new cursor. Duplicate protection is handled by source-level dedupe plus `saveExecutionRecord` upsert keys.
- **LlamaIndex adapter**: 运行时信息来自 LlamaIndex instrumentation dispatcher；`scripts/llamaindex_extension` 只注册 Agent Insight 自定义 Handler，并继承官方 `llama-index-observability-otel` 的 Handler 基类来复用 OTel span/context 生命周期，不并行注册官方默认 Handler。客户端使用隔离 `TracerProvider` 和 `SimpleSpanProcessor`；自定义 `AgentInsightSpanExporter` 只把结束的 `ReadableSpan` 转为 `SpanRecord` 并执行非阻塞入队，磁盘与 HTTP 均由后台线程处理。它输出 `service.name=llamaindex` 的 OTLP/HTTP JSON span，但不替换进程全局 Provider。`src/lib/ingest/otel/llamaindex.ts` 负责来源识别，`src/lib/ingest/otel/adapters/llamaindex.ts` 按 `agent.instance.id` 重建 Agent 实例、同名并发与多级父子关系，去除同一逻辑调用的 LLM 包装 Span，并把 Tool、LLM、Retriever、Synthesizer、Workflow step 归一化为既有 `ExecutionRecord`/interaction 契约。服务端 Adapter 负责从 `CompletionResponse`/`ChatResponse` 提取可读正文、将 ReAct `Action`/`Action Input` 留给 Tool/Skill Interaction、规范化 LlamaIndex 工具包装名，并从展示投影排除 `init_run`、`setup_agent`、`parse_agent_output`、`aggregate_tool_results` 等低价值步骤；`run_agent_step`、自定义 Workflow Step、Retriever 和 Synthesizer 仍保留。通用 `agent-trace.ts` 只消费归一化字段，并为 Skill 版本及安全标量 Tool 参数生成框架无关摘要。npm 安装 Agent Insight 服务端并携带采集器源码；setup/auto setup 在所选解释器中安装固定版本 `llama-index-observability-otel==0.6.4`，再从只读 zip 路由取得 Agent Insight 运行时归档并直接部署到 `~/.agent-insight/collectors/llamaindex/current/`。归档把 `docs/user-guide/observability/llamaindex-trace-collector.md` 作为根目录 `README.md`，避免项目指南与离线说明维护两份副本。安装后 CLI 将 endpoint 与 API Key 写入 `~/.agent-insight/llamaindex.json`。卸载只移除 Agent Insight 专属源码、入口、配置与可选 spool，不卸载共享官方 OTel 包。

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
- **Model connection contract**: `ModelConfig.headers?: Record<string, string>` 仅对 `provider=custom`（含 Local AI 与 Custom OpenAI Compatible）开放；这类配置以 `baseUrl + model` 判定连接完整，`apiKey` 与 `headers` 均可选。服务端持久化前校验请求头，返回浏览器时掩码所有 Header 值，实际 OpenAI-compatible 调用通过 `defaultHeaders` 透传。

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
| `UserSettings` | 按用户维度的设置 | `settingsJson`（ServerSettingsV2） |
| `ParsedFlow` / `ExecutionMatch` | skill 流程 + 静态/动态对齐 | `flowJson`/`mermaidCode`；`matchJson`、`staticMermaid`、`dynamicMermaid` |
| `AgentEvalDataset` | 行为评测数据集 | `fieldsJson` 保存动态字段 schema；`casesJson` 保存完整样本；`caseCount` 与 `referenceCasesJson` 是不含轨迹的读取投影，`projectionReady` 标记历史数据是否已回填；另有 `datasetKind`、`targetSkill` |
| `Experiment` / `ExperimentCase` / `ExperimentEvalResult` | 离线评测实验、样本和单项结果 | `ExperimentCase.evaluatorContextJson` 保存可空的版本化 Tool/Skill 目录；结果按 case × evaluator 持久化 |
| `BatchEvalTask` / `GrayscaleTask` | 批量与 A/B 编排状态 | `configJson`、`caseStatesJson` |
| `DebugJobResult` / `DebugHistory` | 调试/运行任务结果 | `output`、`sessionId` |
| `TrajectoryEvalResult` | 一条轨迹评测结果 | `trajectoryScore`、`dimensionScoresJson`、`deviationStepsJson`、`evaluatorRunId` |
| `TraceEvaluation` | 历史 trace 结果评测数据（兼容保留） | 当前质量监控与上传链路均不读写；未做物理迁移或历史数据清理 |
| `RegisteredAgent` | 已知的 agent 身份 | `platform`+`name`+`user` 唯一、`agentType`、`agentOwnership` |
| `FaultDiagnosisSession` / `Message` | 故障诊断对话 | 关联到 `executionId` |
| `AgentDebugReport` | 存储的 AgentDebug 主诊断报告 | `reportJson`、`interactionsHash`、`status`；不再承载 Skills 分析 |
| `AgentDebugSkillsAnalysis` | AgentDebug 专用 Skills 步骤核验缓存 | `analysisJson`、`interactionsHash`、`status`、`keyActionCount` |
| `SkillGeneratorSession`/`Message`、`SkillOptSession`/`Message`/`Iteration` | playground 与优化对话历史 | `opencodeSessionId`、`files`（JSON），优化 `iterations` 带 `draftNumber` |
| `SkillTriggerEvalSet` / `Run` | 触发准确率数据集与运行 | `itemsJson`、`resultsJson`、`passRate`/`truePositiveRate`/`falsePositiveRate` |

## Key TypeScript data contracts (`types`)
核心接口（形状节选；完整成员见源码）：
- **Version analysis** - `VersionCompareResponse` / `VersionTracesResponse` (`lib/version-analysis.ts`): compare APIs only aggregate `Execution.isSubagent=false` traces bound to `Tag.kind=version`; `VersionCompareResponse.summary` is the de-duplicated global summary for the current user/agent/framework/time-window, while `versions` can be narrowed by `questionKey` for single-question comparison; `questionKey` is normalized from `Execution.query`. `taskCompletionScore` comes from the latest successful `ExperimentEvalResult` whose evaluator is `preset-agent-task-completion`, joined through `ExperimentCase.executionId`; legacy cases without that key fall back to `taskId`. Effective score is `humanScore ?? score`, stored and returned on the 0–100 experiment scale. Aggregates expose `taskCompletionScoreAvg` and `taskCompletionScoreCoverage`; `Execution.answerScore` is not used. Run success rate is derived from `Session.endTime` and is not stored.
- **Ingest / records** — `ExecutionRecord`（`storage/data-service.ts`）：`{ upload_id; task_id; query; framework; tokens; cost; latency; endpoint; final_result; trace_started_at; trace_completed_at; skill; invokedSkills: InvokedSkill[]; userTags: TraceTagDto[]; is_skill_correct; is_answer_correct; ... }`；`latency` 统一以秒落库，前端展示通过 `latency-format.ts` 换算为 ms/s/m/h；`trace_started_at/trace_completed_at` 是同一次调用的两个边界而非相同时间；`endpoint` 归一为 `scheme://host:port`，用于 session 与 infra 源关联；`RoutingEvaluationSnapshot`、`OutcomeEvaluationSnapshot`、`ConfigItem`、`InvokedSkill { name; version }`。
- **Framework adapters** — `FrameworkAdapter`（`ingest/adapters/types.ts`）：`{ descriptor; capabilities?; extractSkills?; normalizeForStorage? }`；`FrameworkDescriptor { id; aliases?; label; onboard; platform? }`。`capabilities.ownSkillsFromTree=true` 表示写入根 Execution 的 Skill 时必须从 Agent Tree 根节点提取，以剥离子 Agent Skill；`false` 或未声明时继续使用 adapter 的原生 `extractSkills`，不能仅因框架支持 `subagentTree` 就切换解析路径。
- **Evaluation** — `EvaluationResult`（`evaluation/evaluation-types.ts`）：维度得分（`functionalScore`/`efficiencyScore`/`practicalityScore`/`economicScore`：`DimensionScore`）+ `overallScore`/`weightedScore`；`JudgmentResult { is_correct; score; reason }`、`JudgeCriteria`、`TrajectoryEvalInput/Output`、`ABExperiment`、`TestCase`、`QualityBenchmark`。
- **Evaluator case context** — `EvaluatorCaseContext`（`lib/evaluators/evaluator-case-context.ts`）指向持久化契约 `EvaluatorCaseContextV1`：`{ schemaVersion: 1; availableTools: EvaluatorToolDescriptor[]; availableSkills?: EvaluatorSkillDescriptor[] }`。缺少上下文表示无法评价工具使用；显式空数组表示已确认没有可用能力。`POST /api/experiments` 接受 `cases[].evaluatorContext`；`POST /api/experiments/eval-traces` 接受请求级默认值和 `pairs[].evaluatorContext`，并序列化到 `ExperimentCase.evaluatorContextJson`。目录也可从数据集的 `values.available_tools` 和可选 `values.available_skills` 导入；trace 只提供已发生调用，不用于反推执行时完整的可用能力目录。工具利用率先由 Judge 对目录能力分类，再确定性计算必要能力覆盖率（50%）、调用匹配率（25%）和调用节制率（25%）；分母为零的维度不参与聚合。
- **Trace batch evaluation** — `POST /api/experiments/eval-traces` 对非 `createOnly` 请求返回 `202 Accepted`。路由先为全部目标 Trace 创建或复用 `ExperimentCase`，再为本批 case × 实验评估器预创建 `ExperimentEvalResult`，将实验置为 `running` 后启动后台执行，并通过 Next `after()` 把 completion 注册到请求后生命周期。响应中的 `results[].status` 初始为 `running`；客户端通过 `GET /api/experiments/eval-results?runId=...` 轮询。后台所有实验共用 `experimentEngineConfig.concurrency` 指定的行级并发池；运行中重复提交同一实验/Trace 时复用已有结果任务，不重置或重复执行。任一结果仍为 `pending/running` 时实验不得进入终态，全部结束后才收敛为 `done` 或 `failed`。客户端切换 Skill、版本或重新发起评测时必须取消旧轮询，每次状态请求也受独立超时控制；`createOnly` 仍同步返回 `200` 和空结果。
- **Agent dataset** — `AgentDatasetRecord` / `DatasetCase` / `DatasetField`（`server/agent_datasets_storage.ts`）：字段 schema 存于 `fields`，样本值存于 `values`。字段名称在单个数据集内唯一，用户新增字段时 key 由前端生成；`POST/PATCH /api/agent-datasets` 在归一化前严格拒绝非法或重复 key，避免写入请求被静默裁剪，历史数据读取仍使用宽松归一化保证兼容。归一化时同步 `input`、`reference_output → expectedOutput`、`trajectory` / `trace → trajectory`；来源为 `trace-backflow` 的历史样本还会将旧 `output` 兼容读取为 `expectedOutput`。数据集存储不强制 `input`，具体评测所需字段由执行入口校验。`GET /api/agent-datasets?view=summary` 只返回元数据与 `caseCount`；`view=reference` 返回不含轨迹的参考 case；未传 `view` 仍返回完整数据。`GET /api/agent-datasets/:id?view=items` 用于数据项首屏，保留普通字段并把每条 `trace/trajectory` 截为 600 字符预览；`view=case&caseId=...` 只返回点击的完整 case。集合级修改前客户端再读取完整记录。历史记录在首次轻量读取时通过 `projectionReady=false` 幂等回填，并显式保留原 `updatedAt`；所有创建和更新会与 `casesJson` 原子同步投影。`POST /api/agent-datasets/trace-drafts` 直接使用 `Execution.query` 作为 input、`Execution.finalResult` 作为 output，并返回调用 `summarizeTrace` 之前的 interactions JSON 数组作为 `trace`；不再调用任务输入/输出提取器。前端以并发度 3 批量调用。`POST /api/agent-datasets/backflow` 要求明确的 `mode`；新建模式接收完整 `fields`，已有模式接收 `datasetId + newFields`，两种模式都接收 `fieldMappings` 与预览后的 `cases[].values`。后端按显式映射把 Trace 的 `input/output/trace` 写入 case 的 `input/expectedOutput/trajectory`，新建回流数据集默认使用 `input/reference_output/trajectory` 标准字段；JSON 字段解析为结构化值，字段 schema 与 cases 通过一次存储更新写入。旧客户端省略 `fieldMappings` 时按字段 key 推断，旧的单条 `values + traceSource` 形状仍可兼容，但不会自动补字段。
- **Evaluator dataset fields** — 数据集页面将手动输入的 `available_tools` / `available_skills`（及“可用 Tool”/“可用 Skill”标签）保留为同名 JSON key；JSON 导入遇到这些值时也会补齐对应 schema 字段。实验匹配器只有在 `available_tools` 存在时才构造 `EvaluatorCaseContext`，并将可选的 `available_skills` 一并规范化。
- **Preset result evaluators** — `runSingleResultMetric()`（`evaluation/result-metric-evaluator.ts`）为评测中心的准确性、答案质量、忠实度和指令遵循四个预置评估器提供公共分发与结构化模型传输。`experiment/result-preset-evaluators.ts` 将实验 case 的输入、参考输出和 interactions 适配为各叶子评估器所需参数，再归一成 `EvaluatorOutput`。该能力只由用户主动运行的评测实验调用，不写 `TraceEvaluation`，也不参与质量监控或 trace 上传。
- **A/B scoring** — `AbScoringResult` / `AbScoringPolicy` / `AbScoreBreakdown`（`skill-analysis/ab-scoring.ts`）：评级、决策、`allowRelease`。
- **Agent debug** — `AgentDebugReportPayload`、`AgentDebugIssue`、`AgentDebugRootCause`、`AgentDebugTriage`、`AgentDebugSkillsAnalysis`、`AgentDebugSkillsAnalysisRow`、`DebugTurn`、`DebugToolCall`（`engine/agent-debug/types.ts`）。
- **Trace** — `AgentNode`、`AgentEvent`、`ToolCall`、`RawInteraction`、`AgentNodeStats`（`engine/observability/agent-trace.ts`）。
- **Datasets** — `AgentDataset`、`DatasetCase`、`RootCauseItem`（`lib/agent-dataset-model.ts`、`server/agent_datasets_storage.ts`）。
- **Config / models** — `ModelConfig`、`UserSettings`（`storage/server-config.ts`）、`LlmProvider`（`lib/llm-providers.ts`）、`ModelPricing`（`shared/model-config.ts`）。
- **Skill gen/opt bridges** — `StreamSkillGeneratorOpts/Result`、`StreamSkillOptOpts/Result`（`lib/skill-generator-opencode-bridge.ts`、`lib/skill-opt-bridge.ts`）。

### `RawInteraction` 归一化字段约定

`RawInteraction` 是各框架 adapter 与共享 Trace 树构建器之间的内部契约。框架差异必须在 adapter 中完成归一化；共享渲染与树构建代码不得按框架名分支。所有字段都是可选增量，未提供时不得改变其他 adapter 的既有行为。

| 字段 | 统一语义 | 填写方与约束 |
|---|---|---|
| `status` | 当前 interaction 的执行状态；错误统一写为 `error` | 任意 adapter；不得用它表示整个 session 状态 |
| `error` | 原始或结构化错误，当前支持字符串或 `{ message }` | 任意 adapter；供详情与通用兜底读取 |
| `error_summary` | 已脱敏、可直接展示的错误摘要 | adapter 在框架原始错误需要归一化时填写；共享渲染器只消费，不解释框架结构 |
| `trace_kind` | 结构 Trace 的类别；当前 `chain` 表示非 LLM/Tool 的链路节点 | 产生 Workflow/RAG/Chain 节点的 adapter |
| `trace_name` | 结构节点的稳定显示名称 | 与 `trace_kind` 同时填写 |
| `trace_args` / `trace_output` | 结构节点的归一化输入与输出 | adapter 应在此之前完成截断、脱敏和框架格式解析 |
| `trace_status` | 结构节点状态 | 仅描述对应 `trace_kind` 节点，不替代 session 状态 |
| `trace_synthetic` | 此 interaction 是 adapter 为表达父子/结构关系生成的占位节点，不代表一次真实 LLM turn | 仅结构归一化 adapter 可设为 `true`；共享树构建器会禁止把它计作 LLM 调用，但仍解析其 Tool/Task 关系 |

例如 LlamaIndex adapter 将 dispatcher span 的失败信息归一到 `status/error/error_summary`，将 Retriever、Synthesizer 与 Workflow step 归一到 `trace_*`；共享 `agent-trace.ts` 只按上述字段生成通用事件。新增 adapter 应复用这些语义，而不是增加框架名判断或重新定义字段含义。

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
- v1 Bundle 顶层字段为 `format`、`version`、`exportedAt`、`rootExecutionId`、`executions`；每个节点包含 portable Execution 与可空 Session。Session `interactions` 保留规范化原始值，不做面向展示的时间格式化；Langfuse Session 还可携带完整 `langfuseTraceNodes`，旧版未包含该可选字段的 v1 Bundle 仍可导入。
- `Execution.id` 与 Execution/Session `taskId` 共享冲突检测空间。无冲突 ID 原样保留；有冲突 ID 才生成 `import_<uuid>`，并同步更新父子 ID、root ID、`agentSessionId`、interactions 中已知的 session/execution 引用及 Langfuse 节点的 `subagentSessionId`。OTel `traceId` / `spanId` / `parentSpanId` 不参与重映射。
- 导入只创建 Execution、Session 和可重算的 ExecutionSkill；不迁移 Evaluation、TraceEvaluation、AgentDebugReport、ExecutionTag 或基础设施关联，也不调度 LLM 评测。
