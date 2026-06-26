# 质量监控：结果维度评测合并方案

版本：3.0  
日期：2026-06-26  
范围：合并“结果维度执行方案”“忠实度重设计”“指令遵循与答案质量解耦重设计”，并按当前项目实现校正；不新增 API 路由，不再保留旧的合并评测调用方案

## 1. 结论

结果维只评 Agent 的最终交付，不评工具选择、步骤顺序等执行过程。当前实现已经将结果维拆为四个独立指标：

| 指标 | metricKey | 核心问题 | 输入边界 | 方法 |
|-|-|-|-|-|
| 忠实度 | `faithfulness` | 最终结果中的可验证事实主张，是否被本次 trace 的工具证据支持 | `query + finalResult + interactions` | `grounding` |
| 指令遵循 | `instruction-adherence` | 最终结果是否满足显式输出约束 | `query + relevantSystemInstructions + finalResult` | `self-rubric` |
| 答案质量 | `answer-quality` | 最终结果是否相关、完整、连贯 | `query + finalResult` | `self-rubric` |
| 准确性 | `accuracy` | 最终结果是否符合评测数据集的预期输出关键观点 | `query + finalResult + matched dataset case` | `gt-rubric` |

四项指标独立版本、独立输入 hash、独立 LLM 调用、独立失败和独立落库。某项不满足评测条件时返回 `score=null`，表示 `N/A`，不按 0 分处理；某项调用或解析失败时写 `status=failed`，不能伪装成 `N/A`。

当前实现入口：

- 编排与落库：[result-quality-evaluator.ts](../../../src/lib/engine/evaluation/result-quality-evaluator.ts)
- 忠实度：[faithfulness-evaluator.ts](../../../src/lib/engine/evaluation/faithfulness-evaluator.ts)
- 指令遵循：[instruction-adherence-evaluator.ts](../../../src/lib/engine/evaluation/instruction-adherence-evaluator.ts)
- 答案质量：[answer-quality-evaluator.ts](../../../src/lib/engine/evaluation/answer-quality-evaluator.ts)
- 准确性：[result-accuracy-evaluator.ts](../../../src/lib/engine/evaluation/result-accuracy-evaluator.ts)
- 结构化 Prompt：[result-faithfulness-prompt.ts](../../../src/prompts/result-faithfulness-prompt.ts)、[result-instruction-adherence-prompt.ts](../../../src/prompts/result-instruction-adherence-prompt.ts)、[result-answer-quality-prompt.ts](../../../src/prompts/result-answer-quality-prompt.ts)、[result-accuracy-prompt.ts](../../../src/prompts/result-accuracy-prompt.ts)

## 2. 当前数据与执行链路

结果评测不在质量监控查询时临时调用 LLM，而是在 trace 完成后的写路径或回填路径执行，并把明细写入 `TraceEvaluation`：

```prisma
model TraceEvaluation {
  id               String   @id @default(cuid())
  executionId      String
  evaluatorId      String
  evaluatorVersion String
  dimension        String
  metricKey        String
  status           String   // pending | running | done | failed
  score            Float?   // 0-100；null = N/A
  method           String
  confidence       Float
  evidenceJson     String?
  note             String?
  interactionsHash String
  errorMessage     String?
  ranAt            DateTime
  updatedAt        DateTime

  @@unique([executionId, evaluatorId, metricKey])
}
```

整体链路：

```text
trace 完成并保存 Execution/Session
        ↓
scheduleResultEvaluation(executionId)
        ↓
evaluateResultQuality(executionId)
        ↓
加载 query、finalResult、Session.interactions、用户评测数据集
        ↓
按单指标计算 input hash，复用未变化的 done 记录
        ↓
需要重跑的指标先 upsert 为 running
        ↓
并行运行 faithfulness / instruction-adherence / answer-quality / accuracy
        ↓
每项独立 upsert TraceEvaluation(done/failed)
        ↓
质量监控 collector 批量 join TraceEvaluation
        ↓
dimension-scorer 聚合结果维、趋势和问题摘要
```

触发点包括：

- 上传入口：[upload/route.ts](../../../src/app/api/ingest/upload/route.ts)
- proxy end 入口：[end/route.ts](../../../src/app/api/ingest/proxy/[taskId]/end/route.ts)
- OTel consumer：[consumer.ts](../../../src/lib/ingest/otel-consumer/consumer.ts)
- 质量监控回填：[sampling.ts](../../../src/lib/engine/quality-monitoring/sampling.ts)

## 3. 四项指标边界

### 3.1 忠实度

忠实度判断：最终结果中的事实主张，是否能被生成该结果时可用的上下文证据支持。

本项目采用 Ragas、DeepEval 的基本模式：

```text
response
   ↓ LLM A
原子事实主张 claims
   +
retrieved_contexts
   ↓ LLM B
逐主张 supported / contradicted / not_covered
   ↓ 代码计算
faithfulness = supported / all claims
```

关键约束：

- `retrieved_contexts` 来自 trace 中统一事件模型里的工具输出；
- context 提取是确定性代码，不使用 LLM，也不做外部检索；
- 忠实度代码只认识统一的 `AgentEvent/ToolEvent`，不认识 OpenCode、Hermes、Claude、OpenClaw 等框架字段；
- 框架字段差异必须在 ingest/trace adapter 层完成，新增框架不能修改忠实度 evaluator；
- 主张拆分与证据裁决分成两次 LLM 调用，模型不直接输出总分；
- 没有有效 context 或没有可验证主张时返回 `N/A`，不能算 100 分。

### 3.2 指令遵循

指令遵循只回答“最终结果是否遵守显式输出约束”。它不评价答案是否相关、完整、事实正确或有工具证据。

指令来源只接受：

- 当前用户 query 中显式要求的格式、语言、长度、范围、必含字段/关键词/章节、精确数量和禁止事项；
- 与最终输出直接相关的 system 指令。

不得进入指令列表：

- Skill SOP、工具调用步骤和内部执行建议；
- “正确回答用户问题”一类通用目标；
- 用户要求回答的普通业务问题和语义要点，这些只进入答案完整性；
- evaluator 自己的 Prompt 文本；
- 与本次最终交付无关的通用 Agent 人设和运行时说明。

普通业务问法，例如“找出最高频 IP，并说明频率、目标账户和时间窗”，只产生答案完整性 requirements，不产生指令遵循 constraints。只有“必须包含 `ip/frequency/account/time_window` 字段”这类明确输出契约才进入指令遵循。

### 3.3 答案质量

答案质量只回答“最终结果是否相关、完整、连贯”。它不读取 system prompt、确定性约束、工具输出或 GT，从输入层阻断与指令遵循、忠实度、准确性的串扰。

答案质量包含三个子项：

- 相关性：回答是否直接服务于用户问题；
- 完整性：显式必答要点是否得到充分覆盖；
- 连贯性：内容是否清晰、有组织、无明显自相矛盾或无意义重复。

同一用户要求可能同时产生不同角度的证据。例如“列出 3 个风险”：

- 指令遵循检查是否确实列出 3 项；
- 答案质量检查这 3 项是否直接相关、覆盖核心风险、表达清楚。

二者可能同分，但原因必须不同，不能复用同一个 `reason`。

### 3.4 准确性

准确性只在匹配到带 `expectedOutput` 的用户评测数据集 Case 时运行。当前实现不再读取旧 Config 的 `standardAnswer/rootCauses` 作为质量监控准确性 GT。

当前 GT 路由：

1. 通过 [dataset-case-match.ts](../../../src/lib/engine/evaluation/dataset-case-match.ts) 在当前用户的 Agent 评测数据集中匹配 Case；
2. 只接受带 `expectedOutput` 的 Case；
3. 关键观点优先读取 Case 按 `expectedOutput hash` 缓存的 `rootCauses`；
4. 缓存不可用时，用 [root-cause-extractor.ts](../../../src/lib/engine/evaluation/root-cause-extractor.ts) 从 expected output 实时提取关键观点；
5. Judge 对完整最终答案逐条返回 `correct / partially_correct / wrong / not_mentioned`；
6. `not_mentioned` 不进入准确率分母，关键观点之外的事实错误和编造内容以零分项进入分母。

无用户归属、无匹配 Case、Case 缺少 `expectedOutput`、预期输出无法提取关键观点时，准确性返回 `N/A`。

## 4. 忠实度设计

### 4.1 `retrieved_contexts` 的边界

业界的 `retrieved_contexts` 一般包含：

- 检索到的文档 chunk；
- 数据库查询返回的记录；
- 搜索、API 或知识库返回的正文；
- 其他实际提供给生成模型的外部事实材料。

一般不包含：

- 用户问题本身；
- system prompt；
- 标准答案；
- 模型自己的中间回答；
- 工具调用参数；
- 与最终回答无关的完整 trace 元数据。

在 Agent 场景中，RAG 的文档 chunk 对应的是信息型工具输出，而不是整个 trace。

### 4.2 当前提取路径

当前项目没有单独存储“最终模型的 retrieved contexts”，工具输出正文主要保存在 `Session.interactions` 中，因此 trace 是忠实度证据的事实源。

忠实度复用链路追踪的统一事件树：

```text
Session.interactions
    ↓ buildAgentCallTree
AgentNode tree
    ↓ findProducerNode(finalResult)
最终交付所属 AgentNode
    ↓ 选择该节点上 finalResult 之前、compaction 之后、有 output 的 tool event
RetrievedContext[]
    ↓ faithfulness evaluator
claims + contexts 评测
```

当前实现位于 [extractRetrievedContexts](../../../src/lib/engine/evaluation/faithfulness-evaluator.ts)。它只取最终交付所属 Agent 节点上的 `event.kind === 'tool'`，排除其他节点内部没有上浮给最终交付者的工具证据。

统一输入结构：

```ts
interface RetrievedContext {
  contextId: string;
  content: string;
  toolName?: string;
  status?: 'success' | 'error';
  source: {
    contextId: string;
    toolCallId?: string;
    interactionIndex: number;
    outputHash: string;
    agentNodeId: string;
  };
}
```

真正发送给 LLM 的必要字段只有 `contextId`、`content`，可附带 `toolName/status`。回源信息留在代码侧，不需要占用 Judge 上下文。

### 4.3 context 提取规则

从统一事件序列中按时间顺序提取：

```text
event.kind === 'tool'
AND event.output 非空
AND event 在最终结果产生之前
AND event 位于最终交付所属 Agent 节点
AND event 未被最终交付前的 compaction 淘汰
```

具体规则：

- `content` 直接使用 `AgentEvent.output`；
- 工具参数只放 provenance，不进入 `content`；
- 工具失败输出可以证明“工具失败”，不能证明它原本要查询的业务事实；
- `skill/load_skill/skill_view` 返回的 Skill 文档默认不属于业务事实 context；
- `task` 派发参数不属于 context；
- 子 Agent 内部使用、但没有返回给最终 Agent 的工具输出，不进入 root 最终结果忠实度 context；
- system/user/assistant 消息不进入 `retrievedContexts`；
- 标准答案只供准确性评测，不进入忠实度；
- 每个 `AgentEvent` 只生成一个 context；
- 无输出正文、只有 metadata 的工具调用不生成 context。

### 4.4 长工具输出

短 context 原样保留。长日志或文件按行切成稳定 chunk：

```ts
interface RetrievedContextChunk {
  contextId: string;      // ctx-6#2
  parentContextId: string;
  content: string;
  startLine?: number;
  endLine?: number;
}
```

当前参数：

- 全量 context 发送预算：约 30,000 字符；
- chunk 大小：约 2,500 字符；
- 每条 claim 最多召回 5 个候选 context；
- 每批最多验证 8 条 claim；
- 最多提取 20 条关键事实 claim。

召回逻辑使用本地 token、数字、IP、时间、路径、错误码和关键词匹配；首版不引入 embedding，也不调用 LLM 做 context 提取。

### 4.5 LLM 调用与计分

忠实度分两阶段：

```text
finalResult + query
    ↓ claim extraction
claims[]
    ↓ context chunking + candidate selection
claims batch + retrievedContexts
    ↓ verdict
supported / contradicted / not_covered
    ↓ code
score = supported_count / claim_count * 100
```

代码必须校验：

- claim ID 唯一；
- 每个 claim 恰好返回一次 verdict；
- `supported/contradicted` 引用的 context ID 来自本次输入；
- 响应不合法时该指标 failed，不能写成 N/A 或 0 分；
- `sourceQuote/evidenceQuote` 作为展示证据，不做逐字命中硬校验。

状态语义：

- 没有最终结果：`N/A`；
- 没有可验证 claims：`N/A`；
- trace 没有有效工具输出：`N/A`；
- trace 解析失败或 LLM 调用失败：`failed`；
- 正常产生 verdict：代码计算 0-100 分。

## 5. 指令遵循设计

### 5.1 调用链路

指令遵循是两次结构化 LLM 调用：

```text
query + relevantSystemInstructions
    ↓ constraint-extraction
constraints[]
    ↓ constraint-verdict(finalResult)
met / not_met / not_applicable
    ↓ code
score = met_count / applicable_count * 100
```

约束类型固定为：

```text
format | language | length | required_field | required_keyword |
required_section | exact_item_count | prohibited_content | scope | style
```

### 5.2 约束提取

提取阶段只接收 `user_query` 和 `relevant_system_instructions`，不接收 `finalResult`，避免根据答案倒推约束。

输出结构：

```ts
{
  constraints: Array<{
    id: string;
    source: 'user' | 'system';
    sourceQuote: string;
    type: ConstraintType;
    text: string;
  }>;
  confidence: number;
}
```

代码只校验 Schema、ID 唯一和枚举类型，不再使用正则另行发现约束，也不维护 JSON/语言/长度/字段/数量等专用检查器。

### 5.3 约束裁决

裁决阶段接收全部约束和最终结果，逐条返回：

```ts
{
  verdicts: Array<{
    constraintId: string;
    status: 'met' | 'not_met' | 'not_applicable';
    reason: string;
    evidenceQuote: string;
    observedValue: string;
  }>;
  confidence: number;
}
```

代码必须校验 verdict ID 集合与输入 constraint ID 集合完全一致；缺项、重复或未知 ID 均判本指标失败。

没有约束时返回：

```text
score = null
note = 本任务没有明确的输出约束
```

最终原因由代码从本指标 verdict 生成，例如：

- `5 项输出约束全部满足：中文、合法 JSON、长度、必含字段及禁止修复建议。`
- `5 项输出约束满足 4 项；未满足：不要提供修复建议。`

## 6. 答案质量设计

### 6.1 调用 DAG

答案质量不能由一次 LLM 调用同时“生成要求并判断自己生成的要求”。当前实现使用五次专用调用，并按依赖关系流水执行：

```text
finalResult ──> A. statements 提取 ─────> C. relevance 裁决 ────┐
                                                               │
query ────────> B. requirements 提取 ───> D. completeness 裁决 ├──> F. 聚合
                                                               │
query + finalResult ──> E. coherence 评分（独立运行）───────────┘
```

实际调度：

```ts
const statementsPromise = extractAnswerStatements(finalResult);
const requirementsPromise = extractUserRequirements(query);
const coherencePromise = judgeAnswerCoherence(query, finalResult);

const relevancePromise = statementsPromise.then((statements) =>
  judgeStatementRelevance(query, statements),
);
const completenessPromise = requirementsPromise.then((requirements) =>
  judgeRequirementCompleteness(requirements, finalResult),
);

const settled = await Promise.allSettled([
  relevancePromise,
  completenessPromise,
  coherencePromise,
]);
```

A 完成后 C 可立即启动，不等待 B 或 E；B 完成后 D 可立即启动，不等待 A 或 E；E 从开始就独立运行。

### 6.2 相关性

A 调用只看 `finalResult`，提取最多 24 条关键 statements，不读取 query，避免模型因为知道问题而选择性忽略答案中的跑题内容。

C 调用接收 `query + statements`，逐条判断：

- `relevant`：直接回答问题，或提供理解答案所必需的信息；
- `supporting`：不是直接答案，但属于简短合理背景、限定或解释；
- `irrelevant`：与问题无关、无助于用户目标，或属于不必要扩展。

计分：

```text
relevant = 1
supporting = 0.5
irrelevant = 0
relevance = average(verdictValue) * 100
```

如果答案整体为含糊回避，且没有 relevant statement，则相关性为 0。

### 6.3 完整性

B 调用只看 `query`，提取判断答案完整性所需的原子 requirements，不读取答案，防止根据现有答案降低用户要求。

要求提取规则：

- 只提取用户明确提出或完成任务不可缺少的内容；
- 多个并列问题、括号枚举项和交付物必须拆开；
- 不提取格式、语言、长度、禁止事项；
- `importance` 为 1、2、3，分别表示辅助要求、明确子问题、核心问题。

D 调用接收 `requirements + finalResult`，逐条判断：

- `covered`：完整、明确地回答该 requirement；
- `partial`：触及 requirement，但缺少关键细节、范围或明确结论；
- `missing`：没有回答，或只有无法满足该 requirement 的模糊表述。

计分：

```text
covered = 1
partial = 0.5
missing = 0
completeness = Σ(importance × statusValue) / Σimportance * 100
```

### 6.4 连贯性

E 调用使用固定 G-Eval 风格步骤和固定 0-4 rubric，不让模型为每条 trace 动态发明评分方法。

固定步骤：

1. 找出答案的主结论和信息主线；
2. 检查句子和段落是否围绕主线按合理顺序展开；
3. 检查代词指向、术语、主体、时间线和因果关系是否一致；
4. 检查自相矛盾、无意义重复、信息堆积和突然跳转；
5. 只评价组织表达，不评价事实正确性、任务完整性或格式遵循。

固定 rubric：

| 分数 | 锚点 |
|-|-|
| 4 | 主线明确，顺序自然，指代与术语一致，无矛盾、明显重复或突兀跳转 |
| 3 | 整体清楚，存在一次轻微跳转、重复或组织瑕疵，但不影响理解 |
| 2 | 基本可理解，但多处顺序混乱、重复、弱衔接或局部矛盾 |
| 1 | 明显碎片化，主线难辨，存在严重跳转、指代问题或矛盾 |
| 0 | 基本不可理解，无法形成连贯回答或核心陈述相互冲突 |

计分：

```text
coherence = rating * 25
```

### 6.5 答案质量聚合

只有相关性、完整性、连贯性三个子分都有效时，才输出答案质量总分：

```text
answerQuality = relevance * 0.3
              + completeness * 0.5
              + coherence * 0.2
```

任一子调用失败时，`answer-quality` 标记 failed；statements 或 requirements 为空时返回 `N/A`，不把空集合当满分，也不对剩余权重重新归一。

总体原因由代码从三个子评测自己的负面证据生成，不再调用一个通用 reason Judge。

## 7. 准确性设计

准确性从用户评测数据集匹配 Case，不读取旧 Config。当前实现使用：

- `loadUserAgentDatasets(user)` 加载当前用户 Agent 数据集；
- `matchAgentDatasetCase({ requireExpectedOutput: true })` 匹配 query；
- `canReuseRootCauseCache(expectedOutput, rootCauseMeta)` 判断关键观点缓存是否可用；
- `extractRootCausesFromExpected(query, expectedOutput, user)` 兜底提取关键观点；
- `evaluateResultAccuracy` 让 Judge 对完整最终答案逐条裁决。

Judge 输出必须满足：

- 每个 key point 恰好返回一次；
- 未知或重复 key point ID 判失败；
- `status` 与 `score` 必须一致：`correct=1`、`partially_correct=0.5`、`wrong=0`、`not_mentioned=null`；
- `not_mentioned` 的 `actual_evidence` 必须为空；
- `additional_errors` 按 severity 进入分母，惩罚关键观点之外的事实错误或额外编造。

计分：

```text
accuracy = weighted_correct_points / (mentioned_key_point_weight + additional_error_weight) * 100
```

准确性有分时，兼容写回：

```text
Execution.answerScore = accuracy / 100
Execution.isAnswerCorrect = accuracy >= 80
Execution.judgmentReason = accuracy evidence.reason
```

无 GT 或 `score=null` 时不改这些兼容字段。

## 8. 聚合、API 与前端

### 8.1 Collector

[trace-collector.ts](../../../src/lib/engine/quality-monitoring/trace-collector.ts) 按窗口内 executionId 批量查询 `TraceEvaluation(evaluatorId='result-quality')`，组装进：

```ts
TraceLite.resultMetrics?: Partial<Record<
  'faithfulness' | 'instructionAdherence' | 'answerQuality' | 'accuracy',
  ResultMetricLite
>>;
```

`ResultMetricLite` 保留 `status / evaluatorVersion / inputHash / score / method / confidence / evidence / note / errorMessage`，供聚合和前端详情使用。

### 8.2 Scorer

[dimension-scorer.ts](../../../src/lib/engine/quality-monitoring/dimension-scorer.ts) 只用四个结果子指标聚合结果维：

```text
result = mean(valid faithfulness, instructionAdherence, answerQuality, accuracy)
```

规则：

- 单 trace 单指标 `status='done' && score != null` 才进入分母；
- `N/A` 不记 0 分；
- 没有任何结果评测覆盖时，结果维 signal 为“尚无结果评测覆盖”；
- `safety` 保留为综合分硬降级条件，不作为第五个结果子指标；
- 删除“无失败信号即结果 100 分”的旧评分路径；
- 每个子指标返回覆盖率、样本数、平均置信度、method breakdown 和最多三条 evidence reason。

### 8.3 API

不新增 API 路由，扩展现有接口：

- `GET /api/quality/report`：返回 `dimensions.result.metrics` 四项明细；
- `GET /api/quality/executions`：返回单 trace 的结果分、四项指标、状态、N/A 原因和失败信息；
- `POST /api/quality/backfill`：复用真实 `evaluateResultQuality` 回填缺失指标。

查询接口只读数据库，不在用户打开页面时调用 LLM。

### 8.4 前端

当前质量监控页的结果明细面板读取后端返回的四项指标：

- 指标层区分 `pending/running/failed/done + score/null`；
- `pending/running` 展示“评测中”，不显示为 `N/A`；
- `failed` 展示“评测失败”，详情中展示失败阶段和已完成调用；
- `done + score=null` 展示“不适用”及 `note` 或 `evidence.reason`；
- `done + score!=null` 展示分数、置信度、method 和结构化详情；
- 详情表格直接对应 `evidenceJson`，不由前端重新解释评测语义。

前端组件：

- [ResultPanel.tsx](../../../src/components/quality/ResultPanel.tsx)
- [result-detail-tables.ts](../../../src/components/quality/result-detail-tables.ts)

## 9. 幂等、版本与失败隔离

当前版本：

```ts
const RESULT_METRIC_VERSIONS = {
  faithfulness: '2.0.1',
  'instruction-adherence': '2.0.1',
  'answer-quality': '2.0.1',
  accuracy: '2.0.1',
};
```

输入 hash 按单指标计算：

- 忠实度：`finalResult + retrieved context output hashes + interactionIndex`；
- 指令遵循：`query + relevantSystemInstructions + finalResult`；
- 答案质量：`query + finalResult`；
- 准确性：`query + finalResult + dataset scope hash`。

复用条件：

```text
status === done
AND evaluatorVersion === RESULT_METRIC_VERSIONS[metricKey]
AND interactionsHash === currentInputHash
```

失败隔离：

- 忠实度失败不影响其他三项；
- 指令约束提取失败只将指令遵循标为 failed；
- 指令裁决失败不能用约束列表冒充评测结果；
- statement 或 requirement 提取失败会导致答案质量 failed；
- 相关性、完整性、连贯性任一裁决失败会导致答案质量 failed；
- 准确性数据集语义匹配失败标记 accuracy failed；
- 准确性无匹配 GT 返回 N/A，不影响其他指标；
- 任一指标 N/A 仅从结果维分母移除，不记 0 分。

每个指标的 `evidence.calls` 保留子调用的 stage、状态、耗时和结构化响应，方便定位失败发生在拆解阶段还是裁决阶段。

## 10. 旧方案删除点

以下旧口径已废弃，本文档不再采用：

- 指令遵循和答案质量合并为一次结构化 LLM 调用；
- `combined.reason` 同时写入指令遵循和答案质量；
- JSON/语言/长度/字段等约束由代码正则或专用检查器单独裁决；
- 答案质量一次调用同时生成 requirements 并判断覆盖；
- 忠实度直接解析 OpenCode/Hermes/Claude/OpenClaw 原始字段；
- 忠实度把整个 trace、工具参数、标准答案或模型中间回答当作 context；
- 没有工具证据、没有约束、没有 GT 时按满分处理；
- 无结果评测明细时用“无失败信号即 100 分”的 completion 打底；
- 质量监控准确性继续读取旧 Config 的 `standardAnswer/rootCauses/keyActions`；
- 在 `/report` 查询路径实时调用 LLM。

## 11. 验收标准

### 11.1 忠实度

- 链路追踪展示的 TOOL/OUTPUT 能生成对应 `RetrievedContext`；
- 新增框架只需保证链路追踪正确生成 `AgentEvent`，不修改忠实度代码和 Prompt；
- 每个 tool event 只生成一个 context；
- 长日志中间和尾部证据可以被召回；
- 子 Agent 未上浮证据不能支持 root 最终答案；
- supported/contradicted 引用只能使用本次输入的 context ID；
- 没有工具证据或没有可验证主张时返回 N/A。

### 11.2 指令遵循

- 指令 Prompt 不评价 relevance、completeness、coherence；
- “回答 IP、频率、账户、时间窗”等普通业务要点只进入 completeness，不进入 instruction-adherence；
- JSON、语言、长度、必含字段和禁止事项进入 instruction-adherence，不重复进入 completeness；
- 约束提取不读取 finalResult；
- 约束裁决必须返回完整、无重复、无未知 ID 的 verdict 集合；
- 无明确输出约束时返回 N/A。

### 11.3 答案质量

- 答案质量 Prompt 不读取 system instructions、工具输出或 GT；
- statement 提取不读取 query；
- requirement 提取不读取 finalResult；
- 相关性、完整性、连贯性使用独立 Prompt 和 Schema；
- statements 或 requirements 为空时返回 N/A，不当满分；
- 子分权重固定为 30% / 50% / 20%；
- 总体 reason 来自本指标 evidence，不复用指令遵循 reason。

### 11.4 准确性

- 只有匹配到带 `expectedOutput` 的评测数据集 Case 才执行；
- 无用户归属、无匹配 Case、无 expected output 或无关键观点时返回 N/A；
- key point ID 缺失、重复、未知或 status/score 不一致时 failed；
- `not_mentioned` 不进入分母；
- additional errors 按 severity 惩罚；
- 有分时兼容写回 `Execution.answerScore/isAnswerCorrect/judgmentReason`。

### 11.5 聚合与展示

- `/report` 查询过程零 LLM 调用；
- 四项聚合、趋势和执行表使用同一套后端分数；
- 前端能区分“低分、N/A、评测中、评测失败”；
- 覆盖不足不会被显示成 0 分质量；
- 结果详情表格字段直接来自 `evidenceJson`；
- 单元测试覆盖 N/A 分母、四项聚合、幂等复用、失败隔离、结果详情字段映射。

## 12. 需要运行的验证

文档合并本身不改变运行时代码。若后续进入代码调整，应至少运行：

```bash
npm run test
```

如涉及质量监控 UI，再按仓库流程询问是否启动 dev server，并验证结果面板、趋势和执行表下钻。
