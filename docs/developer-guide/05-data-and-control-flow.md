# 数据与控制流

> 两个视角：（1）分析器从页面/组件入口点出发，沿 React 调用图追踪出的前端流程；（2）从 API 路由处理器和引擎入口函数重建出的后端流水线。前端追踪使用真实的调用边；后端流水线则是从入口点 + 调用图与命名推导而来（确切的内部调用边可能有所不同——在需要时请核对源码）。

## Entry points
| Entry | File | Kind |
|---|---|---|
| `POST` ingest upload | `src/app/api/ingest/upload/route.ts` | HTTP |
| `POST/OPTIONS` OTel | `src/app/api/ingest/otel/v1/{logs,metrics,traces}/route.ts` | HTTP |
| `POST` agent run/stream | `src/app/api/agent/{run,stream}/route.ts` | HTTP |
| `POST` trajectory eval | `src/app/api/eval/trajectory/run/route.ts` | HTTP |
| `POST` grayscale tasks | `src/app/api/debug/grayscale-tasks/[taskId]/route.ts` | HTTP |
| `POST` skill-generator chat | `src/app/api/skill-generator/chat/route.ts` | HTTP |
| `POST` skill-opt chat | `src/app/api/skill-opt/chat/route.ts` | HTTP |
| `POST` fault diagnosis | `src/app/api/fault/diagnosis/stream/route.ts` | HTTP |
| `Claude Code OTel logs` | `src/app/api/ingest/setup/route.ts` | 客户端 OTel 配置 |
| `WittySkillInsightOtelPlugin` | `scripts/opencode_plugin_otel.ts` | 客户端插件 |

## 前端流程（分析器追踪）
静态分析器从 10 个页面/组件入口出发跟踪调用边。其中最大的几个：

| Entry | File | Modules touched | Project fns |
|---|---|---|---|
| `Dashboard` | `components/eval/Dashboard.tsx` | components, lib, app | 47 |
| `GrayscaleEvaluation` | `app/(main)/skill-eval/grayscale/page.tsx` | app, lib | 30 |
| `PlaygroundPage` | `app/(main)/skill-generator/page.tsx` | app, lib | 12 |
| `TrajectoryEvalCenter` | `components/eval/TrajectoryEvalCenter.tsx` | components, lib | 34 |
| `AgentTraceView` | `components/observe/AgentTraceView.tsx` | components, lib, scripts, app | 37 |
| `BatchEvaluation` | `app/(main)/skill-eval/_batch/page.tsx` | app, lib, components | 6 |
| `SkillOptimizePage` | `app/(main)/skill-opt/[name]/[version]/page.tsx` | app, lib | 7 |
| `AgentDatasetCenter` | `components/AgentDatasetCenter.tsx` | components, lib | 22 |

通用形态：页面/组件拉取 context hooks（`useAuth`、`useLocale`、`useTheme`），调用 `apiFetch`（`src/lib/client/api.ts`）请求某个路由处理器，然后运行本地的纯转换函数（评分/格式化辅助函数，如 `compositeScore`、`calculateAbScoring`、`formatTokens`、`normalizeConfig*`）。示例——A/B（灰度）页面：

Version Analysis reuses the same `Tag` / `ExecutionTag` tables. `/api/observe/version-analysis/compare` returns a de-duplicated global `summary`, per-version aggregates, and question facets; user, agent, framework, time-window, and root-only filters apply globally. `questionKey` only narrows the per-version comparison data for single-question drilldown. `/api/observe/version-analysis/tags/:tagId/traces` returns trace details for one version tag and uses the same global filters except the comparison question drilldown.

```mermaid
flowchart TD
    GE["GrayscaleEvaluation (page)"] --> useAuth
    GE --> apiFetch["apiFetch → /api/debug/grayscale-tasks"]
    GE --> calc["calculateAbScoring"]
    calc --> compositeScore
    calc --> capabilityScore
    calc --> applyCostCoupling
    calc --> gradeFor
    GE --> scoreTierFromComposite
```

## 后端流水线：接入（agent run → Execution 记录）

Hermes setup 现在安装仓库内置的 `scripts/hermes_agent_insight_plugin.py`，运行时目录为 `$HERMES_HOME/plugins/agent_insight_hermes/`。插件直接消费 Hermes lifecycle hooks，用 Python 标准库为每个已完成 span 生成 OTLP/HTTP JSON delta payload；LLM/API/tool/subagent spans 共用 root trace，并通过 `hermes.session_id`、`hermes.parent_session_id`、`hermes.root_session_id` 保留归属；root span 还会写入 `hermes.profile.name` 和 `hermes.agent.name`，profile 名优先从 Hermes 运行态 `HERMES_HOME` 的 `profiles/<name>` 路径推断；active profile 为 `default` 时聚合成 `hermes`，其他 profile 聚合成同名 root `Execution.agentName`。每个 delta payload 先原子写到 `~/.agent-insight/data/hermes-otel-spool/`，成功上报后删除，retryable failure 按指数退避；服务端 OTel trace spool 按 session 累积事件，聚合时重读该 session 已收到的全部 span，再用当前聚合快照替换存储记录。状态日志写入 `~/.agent-insight/logs/hermes-plugin.log`。平台 Hermes trace adapter 将 child interactions 标为 `role=subagent`，随后复用 `buildAgentCallTree` 与 `deriveSubagentExecutions`；child Execution 投影 self-only 的结果、模型、token、latency、调用统计和 skill，root 继续表示整棵 trace 总量。setup 只管理 `agent_insight_hermes`，不会更改 `hermes_otel` 等其他插件的启用状态或配置。OpenCode 式原生事件/snapshot API 保留为 exporter 备用方案，当前不新增第二条后端写入链路。
客户端 agent（OpenCode 插件 + uploader、Claude Code 官方 OTel logs、Hermes `agent_insight_hermes` 插件、OpenClaw watcher、OTel SDK、Langfuse Python SDK）将运行数据推送到接入路由。平台将原始 session 规范化为一棵 `Execution` 树。Claude Code 的 `tool_result` log 只包含工具名、输入和结果大小等 metadata；工具输出正文从 raw API request body 的 `tool_result` blocks 回填，因此安装脚本将 `OTEL_LOG_RAW_API_BODIES` 配成 `file:<dir>`，避免 inline `1` 模式被 Claude Code 截断到 60 KB。Hermes 插件注册 `api_request_error`，并优先消费 Hermes 规范化后的 assistant message，同时兼容 choices/output/candidates 文本结构。OTel `logs` / `traces` 是异步摄取：HTTP 端点只负责解码、校验、归一化、写 JSONL spool 并返回已受理；`OtelSpoolConsumer` 再按 checkpoint 增量消费。traces 从 `src/lib/ingest/otel/{normalize,spool,aggregate}.ts` 进入 `adapter-registry.ts`，Langfuse LangGraph adapter 处理 `langfuse.observation.*` span tree 并还原 skill/tool/subagent，Hermes adapter 重建 `spanId` / `parentSpanId` 树，generic adapter 处理其他标准 OTel traces；Claude logs 专属聚合仍留在 `claude-otel`。Langfuse-Langgraph 与 Hermes 的 `FrameworkAdapter` 都声明 `skills` 与 `subagentTree`，归一化后的 `skill`/`skill_view` 等调用会写入 agent 作用域的 `ExecutionSkill` / `invokedSkills`；Langfuse-Langgraph 的展示框架名固定为 `Langfuse-Langgraph`，主 agent 名称优先来自显式 agent metadata，其次来自 `create_react_agent(name=...)` 产生的 graph 顶层 span，旧数据可回退到 AI message `name`，不把 `agent-run-*` root span 或 LangGraph 内部 `agent`/`tools` node 名当成 agent 身份。

OTel spool 新写入按 day + session 分片：ClaudeCode logs 使用 `otel_data/claude/YYYY-MM-DD/sessions/<safe-session>/logs.jsonl`，Hermes/通用 traces 使用 `otel_data/traces/YYYY-MM-DD/sessions/<safe-session>/traces.jsonl`。Consumer 递归发现 JSONL shard，并继续兼容旧的 `YYYY-MM-DD/logs.jsonl` / `YYYY-MM-DD/traces.jsonl` 日文件。

```mermaid
flowchart TD
    client["client plugin/uploader/OTel"] --> route["POST /api/ingest/{upload,otel/*,proxy/*}"]
    route --> otelspool["OTel logs/traces spool\n(session-sharded JSONL accepted response)"]
    otelspool --> consumer["OtelSpoolConsumer\ncheckpoint + dual debounce"]
    consumer --> adapter["FrameworkAdapter registry\n(resolve framework / extract skills / storage normalize)"]
    route --> adapter
    adapter --> parse["lib/ingest + observability parsers\n(claude-parser / openclaw-parser / buildAgentCallTree)"]
    parse --> derive["deriveSubagentExecutions\n(split root + sub-agents)"]
    derive --> save["saveExecutionRecord → DatabaseAdapter"]
    save --> db[("Execution / Session (Prisma)")]
```
关键函数：接入路由处理器（`processUploadAsync`、`proxyFetch`、OTel `POST`）→ OTel traces 路由的 `decodeOtlpRequest` → `otel/normalize.ts:normalizeOtlpTraces` + `otel/spool.ts:appendOtelTraceEvents` → `otel-consumer/consumer.ts:startOtelSpoolConsumer` / `runOtelSpoolConsumerTick` → `otel/aggregate.ts:aggregateOtelTraceEvents` → `otel/adapter-registry.ts:getOtelTraceAdapter` → `otel/adapters/{langfuse-langgraph,hermes,generic}.ts` → `ingest/adapters/registry.ts:getAdapter` / `storage/data-service.ts:extractInvokedSkillsFromSessionInteractions` → `agent-trace.ts:buildAgentCallTree` → `storage/data-service.ts:saveExecutionRecord` / `deriveSubagentExecutions`。OTel trace adapter 负责 transport-normalized span 到 `ExecutionRecord` 的纯转换，FrameworkAdapter 负责框架能力、skill 抽取和存储合并策略，两者都不直接写库。

## 后端流水线：Trace 标签
Trace 用户标签分为版本标签和业务标签。标签定义写入 `Tag`，Trace 绑定写入 `ExecutionTag`；系统标签不持久化为 `Tag`，由前端根据 `Execution` 派生。`GET/POST /api/tags` 与 `PUT/DELETE /api/tags/[id]` 维护标签定义；`GET/PUT/POST/DELETE /api/observe/executions/[executionId]/tags` 维护单条 Trace 的绑定。`GET /api/observe/data?includeTags=1` 在 `readRecords` 批量 hydrate 阶段通过 `getTraceTagsByExecutionIds` 附加 `ExecutionRecord.userTags`；`bizTag=<tagId>` 会先经 `ExecutionTag` 反查 executionId，再与其它 where 条件取交集。`facet=tags&kind=business` 返回业务标签及使用次数，供 Trace 页快捷筛选。

```mermaid
flowchart TD
    ui["TracePage 标签列 / 业务标签筛选"] --> tagsApi["/api/tags"]
    ui --> bindApi["/api/observe/executions/:executionId/tags"]
    ui --> dataApi["/api/observe/data?includeTags=1&bizTag=..."]
    tagsApi --> tagTable[(Tag)]
    bindApi --> linkTable[(ExecutionTag)]
    dataApi --> readRecords["readRecords / hydrateAndNormalizeBatch"]
    readRecords --> linkTable
    readRecords --> execution[(Execution)]
```

## 后端流水线：评测（Config → Execution → Decision）
数据集 `Config` 提供真值；将执行记录进行匹配并评分；结果转化为 `Evaluation` + `SkillIssue` 行。

```mermaid
flowchart TD
    cfg["readConfig / findBestRoutingConfig / findBestOutcomeConfig"] --> run["agent run\n(runGeneralAgent or existing Execution)"]
    run --> match["semantic-dataset-match\n(config / case)"]
    match --> judge["judgeAnswer (outcome)\n+ evaluateTrajectory (trajectory)"]
    judge --> derive["derive-skill-opt-points\n→ SkillIssue"]
    judge --> persist["persist Evaluation / TrajectoryEvalResult"]
    derive --> issues[("SkillIssue (Prisma)")]
```
入口路由：`eval/config/*`、`eval/trajectory/run`、`eval/rejudge`、`debug/batch-tasks/*`、`debug/grayscale-tasks/*`（A/B 经由 `ab-scoring.ts`）。引擎：`evaluation/judge.ts:judgeAnswer`、`trajectory-evaluator.ts:evaluateTrajectory`、`semantic-dataset-match.ts`、`derive-skill-opt-points.ts`、`result-artifact-extractor.ts`。轨迹评测的实际 trace 证据由 `trace-summarizer.ts` 基于 `Session.interactions` 生成事件级步骤；`ExecutionMatch.extractedSteps` 仍用于 Skill 流程对齐/可视化缓存，不作为轨迹评测唯一输入。结果评测会在运行前按轨迹评测同口径解析 trace 关联 Skill（含 `execution.skill` fallback）并写入 `rawAnalysis.resultSkillMode`；`no-skill` 分支不生成 Skill 归因、改进建议或 `SkillIssue`。任务完成度评测的 `rawAnalysis.key_point_findings` 负责关键观点覆盖与等权算分；`rawAnalysis.result_issues` 单独承载关键观点之外的事实错误、编造内容、冗余或格式问题，只作为可归因的动态优化点输入，不直接参与任务完成度分数。

### 质量监控结果评测

`processUploadAsync` 在 `Execution`/`Session` 落库后调用 `scheduleResultEvaluation`，proxy end 在 root trace 完成后触发同一入口。`evaluateResultQuality` 读取 query、最终交付和完整 interactions，四个结果指标独立运行、独立失败和独立写入 `TraceEvaluation`。

忠实度与链路追踪共用 `buildAgentCallTree`：在最终交付所属 Agent 节点上读取有 output 的 TOOL 事件，排除 Skill/Task 控制调用，并在 compaction 后只使用仍对最终交付可见的证据。`faithfulness-evaluator.ts` 先单独提取关键事实主张，再验证工具 context；长输出按行切块并按 claim 召回最多 5 个候选，随后将最多 8 条 claim 合成一批交给模型裁决。模型返回逐项 verdict 和引用，代码只校验 claim ID、verdict ID 集合与引用的 context ID 是否来自本次输入，不再要求模型给出的 `sourceQuote/evidenceQuote` 与原文逐字子串匹配；总分由支持主张占比计算。

指令遵循不再与答案质量共用一次 LLM 响应：`instruction-adherence-evaluator.ts` 先仅凭 query 与相关 system 指令提取显式输出约束，再把约束和最终结果交给第二次 LLM 逐项裁决；代码校验约束 ID、裁决 ID 集合、Schema 与枚举类型，计算比例分并生成本指标原因，不再对 `sourceQuote/evidenceQuote` 做逐字命中校验。格式、语言、长度、字段、数量等约束也由这两次 LLM 统一处理，不再维护正则检查器。

答案质量由 `answer-quality-evaluator.ts` 执行五次专用调用。statement 提取、requirement 提取和固定 0–4 rubric 的连贯性评价同时启动；相关性在 statements 就绪后启动，完整性在 requirements 就绪后启动。代码校验 statement/requirement ID 唯一和裁决 ID 集合一致，不再对 statement、requirement、完整性证据或连贯性问题引用做逐字命中校验；随后分别计算相关性、重要性加权完整性和连贯性子分，再按 30%/50%/20% 汇总并从本指标证据生成原因。普通业务必答内容只进入完整性，不进入指令遵循。

准确性不再读取旧 Config 的 `standardAnswer/rootCauses`。`dataset-case-match.ts` 复用评测中心口径，在当前用户的评测数据集中先做规范化 input 精确匹配，再以 LLM 语义匹配兜底，并且只接受带 `expectedOutput` 的 Case。关键观点优先读取 Case 按 `expectedOutput hash` 缓存的 `rootCauses`，缓存无效时实时提取；`result-accuracy-evaluator.ts` 不拆实际输出，而是让 Judge 对完整最终答案逐条返回 `correct/partially_correct/wrong/not_mentioned`，其中 `not_mentioned` 不进入准确率，关键观点之外的事实错误和编造内容以零分项进入分母。代码校验观点 ID、状态分数和必要字段，不再要求 `actualEvidence/expectedEvidence/additionalErrors.evidence` 逐字命中对应文本；随后按关键观点 weight 计算总分。

每个指标使用自己的输入 hash 与 evaluator version 控制幂等，因此只重跑输入或版本发生变化的指标。准确性 hash 额外包含当前用户评测数据集范围快照；Case、预期输出或关键观点变化会使旧分数失效。回填读取 `evaluatorVersion` 和 evidence 中的 `datasetScopeHash`，可重新选择旧 N/A、失败、版本过期或 GT 已变化的 trace。有效准确性兼容写回 `Execution.answerScore/isAnswerCorrect/judgmentReason`。`GET /api/quality/report` 只批量读取已落库明细；`POST /api/quality/backfill` 为历史 trace 补齐或刷新结果指标。

## 后端流水线：Skill 生成与优化
```mermaid
flowchart TD
    gen["POST /api/skill-generator/chat"] --> bridge["skill-generator-opencode-bridge\n(StreamSkillGenerator*)"]
    bridge --> agent["runGeneralAgent / generateSkillStream\n(deepagents + OpenCode)"]
    agent --> files["SKILL.md + assets (FilesState)"]
    files --> save["SkillGeneratorSession (Prisma)"]

    opt["POST /api/skill-opt/chat"] --> optbridge["skill-opt-bridge\n(StreamSkillOpt*) — checked SkillIssues"]
    optbridge --> agent
    agent --> draft["SkillOptIteration draft → publish as new SkillVersion"]
```
引擎：`engine/skill-generation/index.ts:generateSkill*`、`general-agent/runner.ts:runGeneralAgent`、`lib/skill-generator-opencode-bridge.ts`、`lib/skill-opt-bridge.ts`。静态合规检查：`engine/skill-issues/static-evaluator/index.ts:runStaticEvaluation`。

## 后端流水线：故障诊断
`POST /api/fault/diagnosis/stream` 从某个 session/Execution 构建上下文，读取 AgentDebug 上游分析结果并以流式方式回答追问。上游分析由观测页触发：`POST /api/observe/executions/:executionId/agent-debug` 将 `AgentDebugReport` 写成 `running` 后启动 Node 进程内后台任务，任务完成后将 `AgentDebugReportPayload` 持久化到 `AgentDebugReport`；`POST /api/observe/executions/:executionId/agent-debug/skills-analysis` 同样将 `AgentDebugSkillsAnalysis` 写成 `running` 后独立启动 Skills 步骤核验，完成后持久化到 `AgentDebugSkillsAnalysis`。前端 `components/observe/AgentDebugCard.tsx` 会并行触发两条链路，分别轮询 `/agent-debug` 和 `/agent-debug/skills-analysis`，任一结果完成后独立刷新对应区块。后台任务使用 `interactionsHash` 做条件写入，避免旧任务晚完成后覆盖新结果；进程内 active map 用于防重复启动和识别服务重启后的失活 `running`。故障追问上下文读取主诊断报告和新 Skills 分析缓存，不读取旧 `reportJson.skillsAnalysis`。
AgentDebug 主诊断后端只向诊断 Agent 提供执行元数据、turn/node/artifact 数量和输入、静态、trace bundle 文件路径，不再把长 turn 摘要嵌入提示词。Skill 依次运行 `agentdebug_static.py` 全量拆分与静态检测、`agentdebug_inspect.py` 生成五模块候选信号并执行有界的 `tail/range/search/repeated-calls` 查询，再由 Agent 补充语义问题和 Phase 2；`agentdebug_validate.py --static` 校验最终报告未删除静态 step、issue 或 Phase 1 证据。超过 4000 字符的节点输入/输出由 trace bundle 外置为 artifact，查询脚本只返回完整 artifact 中的命中片段。

## 跨模块流程说明
每条后端流水线都跨越 `app`（路由）→ `lib`（引擎/存储），并经常涉及 `prompts`（LLM 模板）和 `server`（Prisma 仓库）。`lib ↔ server` 循环（见 [01-architecture.md](01-architecture.md#layering--pattern)）意味着存储辅助函数与仓库会相互调用；应将它们视为同一个持久化核心。




## 后端流水线：Trace Bundle 回放

```mermaid
flowchart LR
    detail["Trace 详情导出"] --> exportApi["GET /api/observe/traces/export"]
    exportApi --> resolveRoot["定位根 Execution + 全部子 Agent"]
    resolveRoot --> bundle["Trace Bundle v1 JSON"]
    bundle --> importApi["POST /api/observe/traces/import"]
    importApi --> validate["大小 / 版本 / 树结构校验"]
    validate --> collision["Execution + task ID 冲突检测"]
    collision --> remap["仅重映射冲突 ID 与内部引用"]
    remap --> persist["按父节点优先写 Execution / Session"]
    persist --> skills["重算 ExecutionSkill，不触发 LLM 评测"]
```

实现入口为 `src/lib/trace-transfer.ts`（Bundle 校验、排序与 ID 重映射）和 `src/lib/trace-transfer-service.ts`（所有权、完整树查询、持久化与失败清理）。导入目标 user 始终取当前请求身份，不信任 Bundle 中的来源用户。任一节点写入或 Skill 重算失败时，服务会清理本次已创建的 Session 与 Execution，避免保留可见的半棵树。
