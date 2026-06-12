# 质量监控 — 全量自动评测与可信度体系 设计规格（草案）

版本：1.0-draft（待确认，未提交）
最后更新：2026-06-11

> 阶段：质量监控第二阶段设计 ｜ 上游：[需求 v1.2](./quality-monitoring-requirements.md) ｜ [设计 v1.1](./quality-monitoring-design.md) ｜ [实现状态/Gap](./quality-monitoring-implementation-status.md)
> 目标：把"每条 trace 上报即自动评测"做实——让基本每条 trace 都被细致分析；评测以**可配置评估器集**形式组织；引入**无 GT（无标准答案）评测**与**证据+置信度**体系。
> 本期成本约束：**暂不做成本治理，默认所有需要模型的评估一律走异步模型调用**（预算/采样/限流留作后续，仅预留挂载点）。

---

## §0 一句话目标

trace 上报 → 自动异步跑一套**可配置评估器**（必选 + 可选）→ 每条 trace 在结果/过程/成本/错误维都拿到分 + **证据 + 置信度** → 写回规范字段与新评测表 → 质量监控只读呈现。**无标准答案的 trace 也能评（过程/接地/自生 rubric），但分数带置信度、绝不冒充确定结论。**

---

## §1 设计原则

1. **评测即评估器**：每一种分析都是一个 `TraceEvaluator`，统一注册、可配置启停、声明自己的维度/执行方式/是否依赖 GT。复用平台已有评估器抽象（`src/lib/evaluators/`、`evaluator-execution-recorder`）。
2. **评测在 ingest 触发、按 trace 决策**：「怎么评」由评估器在评测时决定（决策归位）；ingest 自动跑评估器集。**读路径（质量监控 `/report`）保持零模型调用（D-001 不变）**。
3. **默认全异步模型调用**：需要模型的评估器一律异步调模型，不阻塞上报；本期不做预算/采样/限流（仅留挂载点）。
4. **无 GT 也要能评**：结果维分层（确定性→有GT→自生rubric→reference-free→无故障打底），过程维走 reference-free（轨迹 `trace_only`）。
5. **可信度贯穿**：每个分都带 `method + confidence + evidence`；LLM judge 必须产出证据与置信度；聚合/趋势/呈现按方法分层、不混为一个无差别的数。
6. **单一 SoR**：评测结果写回规范字段（`Execution.answerScore` 等）+ 新评测明细表；manual/auto/backfill 三入口收敛到同一套评估器与同一存储。

---

## §2 总体架构

```
trace 上报 (ingest/upload → processUploadAsync)
        │  保存 Execution 后，异步入队
        ▼
evaluateTrace(executionId)              ← 编排器（新）
        │  读取该 agent 的「评估器配置集」(必选 + 已启用可选)
        ▼
   ┌───────────────┬───────────────┬───────────────┐
   每个 TraceEvaluator.run(input)：
   - deterministic → 内联算（免费）
   - direct-llm    → 异步调模型（默认走这条）
   - agent         → opencode 会话（withBackgroundOpencodeSlot）
   各自产出 EvalResult{score, method, confidence, evidence}
        ▼
   写回：① 规范字段(answerScore/isAnswerCorrect…，向后兼容)
        ② TraceEvaluation 明细表(逐评估器: method/confidence/evidence)
        ▼
质量监控 /report 只读这些落库结果聚合呈现（零模型调用）
```

**与现有三入口的关系**：
- ingest 自动评测（本设计，新主力）、manual 评测运行（`eval/trajectory/run` 等）、采样回填（历史补齐）——**三者调用同一套 `TraceEvaluator` 与编排器**，写同一存储，靠 `executionId + interactionsHash` 去重。

---

## §3 评估器模型（核心抽象）

### 3.1 接口契约

```ts
type EvalExecution = 'deterministic' | 'direct-llm' | 'agent';
type EvalDimension = 'result' | 'process' | 'cost' | 'error' | 'safety';
type EvalMethod =
  | 'deterministic'      // 规则/确定性
  | 'gt-rubric'          // 有 GT，rubric judge
  | 'self-rubric'        // 无 GT，从 query 自生 rubric 再判
  | 'reference-free'     // 无 GT，直接质量判
  | 'trajectory'         // 过程，trace_only 轨迹判
  | 'grounding'          // 接地/忠实度
  | 'presumptive';       // 无故障打底

interface EvalTraceInput {
  executionId: string;
  query?: string;
  finalResult?: string;
  interactions?: unknown[];           // 按需加载
  steps?: AgentStepLite[];            // fault-path 摘要
  deterministicSignals: { toolCallCount?: number; toolCallErrorCount?: number; failures?: FailureItem[]; tokens?: number; latency?: number; stepCount?: number; };
  groundTruth?: { criteria?: JudgeCriteria; matchConfidence?: number; matchedBy?: 'exact'|'semantic'|'none' };
  user: string | null;
}

interface EvalResult {
  evaluatorId: string;
  dimension: EvalDimension;
  metricKey: string;                  // 'completion' | 'tool-correctness' | ...
  score: number | null;               // 0–100；null = N/A（不入分母）
  method: EvalMethod;
  confidence: number;                 // 0–1
  evidence?: EvalEvidence;            // LLM judge 必填
  note?: string;
}

interface EvalEvidence {
  reason: string;                     // 一句话结论
  citations?: { stepId?: string; toolCallId?: string; quote?: string }[];  // 引用证据
  perCriterion?: { content: string; matched: number; why: string }[];      // rubric 逐条
  selfConsistency?: { runs: number; agreement: number };                   // k-vote 一致度
}

interface TraceEvaluator {
  id: string;
  dimension: EvalDimension;
  required: boolean;
  execution: EvalExecution;
  needsGroundTruth: boolean;
  run(input: EvalTraceInput): Promise<EvalResult | EvalResult[]>;
}
```

### 3.2 评估器清单

**必选集（默认对每条 trace 跑）**

| id | 维度 | 执行 | 说明 |
|-|-|-|-|
| `result-completion` | result | direct-llm（分层，见 §4.1） | 任务完成度，按 GT 可得性分层 |
| `result-safety` | result | deterministic | 注入/越权/PII（本期正则，后续换检测件） |
| `process-tool-correctness` | process | deterministic | 1 − 工具错误率 |
| `process-trajectory` | process | direct-llm | trace_only：工具选择/冗余/完成（reference-free，§4.2） |
| `cost` | cost | deterministic | tokens/latency/steps 归一 |
| `error-clustering` | error | deterministic | 节点×错误码×对象 聚类（从 trace 解析） |

**可选集（按 agent 配置启用，业界映射）**

| id | 维度 | 执行 | 业界对应 |
|-|-|-|-|
| `process-grounding` | process | direct-llm | RAGAS faithfulness：主张能否溯源到工具返回 |
| `process-constraint-adherence` | process | direct-llm | System-prompt + Skill SOP 遵循（两层，BR-005） |
| `process-attribution` | process | direct-llm/agent | 反事实归因：工具返回变→回答应变（FR-013） |
| `result-user-frustration` | result | direct-llm | 用户挫败/不满信号（FR-017） |

> 维度↔评估器是多对一：一个维度的分由其下若干评估器在有效样本上聚合（N/A 不入分母）。

### 3.3 配置

- 每个 agent（或平台默认）一份「启用评估器集」配置：必选恒开，可选按需勾选。
- 存储：复用/扩展现有评估器中心配置（`src/lib/evaluators/`）；MVP 可先用一个默认集常量 + 后续做成 UI 可配。

---

## §4 无 GT 评测设计

### 4.1 结果维（完成度）—— 业界确认的子维度与方法

结果维不是单一"完成度"分，而是业界收敛的一组 reference-free 子维度（跨 RAGAS / DeepEval / G-Eval / HealthBench / Galileo 交叉确认，来源见本节末）。`result-completion` 产出这些子维度分 + 加权综合，**逐准则可追溯**。

**结果维子维度（无 GT 即可评）**

| 子维度 | 判什么 | 评估方式 | 需要输入 | 置信 | 权重起点\* |
|-|-|-|-|-|-|
| 忠实度/接地 | 主张能否被工具返回/上下文支撑、有无幻觉 | 主张拆解→逐条验证是否被上下文蕴含→支撑比例 | 工具输出 | 高 | — |
| 指令遵循 | 是否遵守显式指令/格式/约束 | 输出对照指令直接判 | query/system-prompt | 高 | 4% |
| 答案相关性 | 是否真正回应问题、有无跑题/灌水 | 答案↔问题语义匹配（或从答案反生成问题比对原 query） | query | 中高 | — |
| 完整性 | 是否覆盖问题要求的所有要点 | 自生 rubric 逐点核查 | query(+rubric) | 中 | 39% |
| 准确性 | 事实是否正确 | 自生分析式 rubric 逐准则判 | query→LLM rubric | 中低 | 33% |
| 连贯/沟通 | 结构清晰、表达得当 | CoT 直接判 | 输出 | 低 | 8% |

\*权重起点取自 HealthBench 五轴（准确性 33 / 完整性 39 / 上下文 16 / 沟通 8 / 指令 4），为可调默认、非定论。

**核心方法：HealthBench 式分析式 rubric（T1/T2 的具体算法）**
```
1. 生成 rubric：有 GT→用 Config 的 root_causes/key_actions；无 GT→LLM 从 query 生成带权重准则
2. 逐准则评分：grader 对每条准则独立判 met/not-met，满足给该准则权重分、否则 0
3. 加权聚合：Σ命中权重 / Σ总权重 → 子维度 [0,1] 分
4. 证据天然产出：命中/缺失的准则即 evidence（满足本设计"judge 必带证据"约束）
```
> 工程铁律（HealthBench 核心发现）：**逐准则判再聚合 比 让模型直接给一个笼统分 更可靠、可解释**——judge 必须输出 per-criterion，禁止只回一个不透明的数。

**分档路由（每档带固有置信上限）**

| 档 | 触发 | rubric 来源 | method | 置信上限 |
|-|-|-|-|-|
| T0 确定性 | 有失败信号（工具错/failures） | — | deterministic | 高 |
| T1 有 GT | 语义匹配命中 Config（`matchConfidence ≥ θ_match`） | Config 准则 | gt-rubric | 高×matchConfidence |
| T2 自生 rubric | 无 GT | LLM 从 query 生成（**新 prompt**） | self-rubric | 中 |
| floor 无故障打底 | 无信号、未启用模型判 | — | presumptive | 最低（命名"无故障"，非"完成度"） |

- GT 恢复用 `findBestSemanticConfigMatch`（语义 + `matchConfidence`），替代 ingest 现有词面 `findBestMatchConfig`。
- 纯 reference-free 直判（不生成 rubric、直接问"对不对"）置信最低，仅作 T2 失败兜底，默认不单列（见 §8 待定）。

**置信地板（Galileo 口径）**：无 GT 时，**忠实度/接地 + 指令遵循**两个高置信子维度构成可靠"质量地板"；完整性/准确性（自生 rubric）叠在其上、置信更低。结果维综合分按子维度置信加权，**地板项主导**。
> 注：忠实度/接地虽在 §3.2 以 `process-grounding` 落地，但同时是**无 GT 下最可靠的结果正确性代理**（我们有工具输出可对照），聚合时计入结果维地板。

> **参考来源**：RAGAS（faithfulness / answer-relevancy，reference-free）；DeepEval（G-Eval / faithfulness / hallucination）；G-Eval（coherence/consistency/fluency/relevance，CoT + form-filling，与人类相关性最高）；OpenAI **HealthBench**（分析式 rubric、LLM 生成 rubric、五轴加权）；Galileo（correctness / completeness / instruction-adherence，无 GT "质量地板"）；RubricEval（rubric 判分的元评测）。完整链接见 §12。

### 4.2 过程维（reference-free）

- `process-tool-correctness`：确定性。
- `process-trajectory`：复用轨迹评测器的 **`comparisonMode='trace_only'`**（reference 字段全可选）——对单条轨迹独立评 工具选择/冗余/完成，**不需要 gold answer**。本期用 **direct-llm 轻量化**（喂 fault-path 步骤摘要），不走 opencode 重路径。
- `process-grounding`：检查主张能否溯源到工具返回，reference-free。

### 4.3 错误维（错误 / 可靠性）

确定性、无需 GT、无需模型。错误信号对齐 **OpenTelemetry GenAI 语义约定**（`error.type` + span status），分类学参考 **MAST**（多智能体失败分类）/ **TRAIL**（trace 错误定位）。

**计算**
```
每条 trace（确定性识别错误信号，OTel 口径）：
  errSignals = span.status=ERROR ∪ error.type≠∅ ∪ toolCallErrorCount>0 ∪ failures≠∅
  severity   = 硬错(Timeout/5xx/权限/RateLimit) = 1.0
             | 软错(输出不符/答非所问)          = 0.5
             | 其他                            = 0.3   // 取该 trace 命中信号中的最高 severity
聚合(整个 T)：
  错误维分 = 100 × (1 − Σ_trace severity / N)          // 严重度加权的「无错率」
  错误密度 = Σ errSignals / N                          // 每 trace 错误数，旁标
  错误聚类 = group by (节点 × error.type × 对象) 签名 → Pareto（top-k 簇覆盖 X%）
```
- **分类学只用于归一/命名、不进分数**：`error.type` 文本按 MAST 三类（系统设计 / 协同失配 / 任务校验）或 TRAIL 类型归并，便于聚类与可读，不改变分值。
- **错误定位很难**：TRAIL 实测 SOTA 模型联合定位准确率仅 ~11% → 坚持**确定性识别 + 签名聚类打底**，模型归因（§3.2 `process-attribution`）仅作加成、标低置信。
- 可选可靠性：同类任务一致失败率 / `pass^k`（有重试时）。

### 4.4 成本维（成本 / 效率）

确定性、必有。原始量对齐 **OpenTelemetry GenAI metrics**（`gen_ai.client.token.usage` / `gen_ai.client.operation.duration`）。

**原始量（直接采集，必有）**
```
tokens   = input + output（cache_read 单列）          // OTel：同时报计费 token 时以计费为准
cost$    = Σ(模型 token × 模型单价)
latency  = 端到端；分布报 P50/P95/P99
steps    = LLM 调用数（+ 工具调用数）
```
**派生效率**
```
cache 命中率 = cache_read / input
步骤效率     = 实际步数 / 最小可行步数（>1 = 有冗余动作）   // step-wise efficiency
```
**归一成 [0,100] 分（需基线 / 预算）**
```
成本维分 = 100 × clamp01(预算 / 实际成本)   或   相对同类任务中位数的位次
```
> ⚠️ **绝对成本与任务类型强相关，业界无通用「成本分」**。基线 / 预算是**按任务类型配置的参数**；无基线时只报原始量、分数标 N/A（不硬凑会误导的绝对分）。页面提供「归一分 ↔ 原始单位」切换（设计 FR-014）。

**跨维效率（最有信息量，可选）**
```
Cost-per-Success (CPS) = Σcost / 成功任务数       // 失败也耗成本
质量-成本 Pareto        = (综合分, cost) 散点 → 前沿
```
> 依据：cost-per-success / cost-normalized-accuracy 与 Pareto 前沿是业界比成本的主口径；实测最高准确率的 agent 成本可达 Pareto-最优方案的 4.4–10.8×（CLEAR 框架），故成本须与质量联看、不可孤立追低。

---

## §5 置信度体系

### 5.1 置信度来源（合成到每个 EvalResult.confidence ∈ [0,1]）

```
confidence = f(
  方法档先验,          // deterministic > gt-rubric > self-rubric > reference-free > presumptive
  matchConfidence,     // T1：语义匹配越虚越低
  judge 决断度/自一致性,// 分接近 0/1 高；模糊带低；或 k-vote 一致度
)
```
- LLM judge **必须**产出 `evidence`（结论 + 引用 + 逐 rubric）与 confidence。
- **本期置信度先用便宜信号**（方法档 × 匹配置信 × 自一致性/决断度）；**独立 verifier 模型暂不做**（§8 待定）。

### 5.2 聚合（维度分）

- 推荐**分层聚合**而非混合均值：维度分附"实评 X% / 自生 rubric Y% / 无故障打底 Z%"构成；
- 综合分：只计高置信（实评 + 有 GT）completion，打底单列；或置信度加权（§8 待定二选一）。

### 5.3 呈现（不加新视图，增强现有）

- 逐 trace：分数旁置信 chip + 证据可 hover；
- 维度卡：coverage → coverage + 均置信；"无故障打底"**正名**，不叫完成度；
- 趋势：**同尺（只趋势实评子集）或覆盖带 + 口径变更标注**——防"接 judge 后覆盖率上涨导致综合分下移被误读为退化"；
- 低置信：置灰（BR-007 扩展到逐指标/逐 trace）。

---

## §6 数据模型

### 6.1 新增明细表 `TraceEvaluation`

```prisma
model TraceEvaluation {
  id            String   @id @default(cuid())
  executionId   String
  evaluatorId   String          // 'result-completion' ...
  dimension     String
  metricKey     String
  score         Float?          // null=N/A
  method        String          // EvalMethod
  confidence    Float           // 0–1
  evidenceJson  String?         // EvalEvidence（含逐准则命中/缺失）
  interactionsHash String        // 幂等/失效
  ranAt         DateTime @default(now())
  // 一个评估器可产多个子维度分（如 result-completion → 准确性/完整性/接地/指令遵循…），
  // 故唯一键含 metricKey，逐子维度一行（各带自己的 method/confidence/evidence）。
  @@unique([executionId, evaluatorId, metricKey])
  @@index([executionId])
}
```

### 6.2 规范字段（向后兼容）

- `result-completion` 仍写回 `Execution.{answerScore, isAnswerCorrect, judgmentReason}`（全平台在读，不能断）；
- 其余评估器明细只进 `TraceEvaluation`；
- 质量监控读取时：规范字段给基线，`TraceEvaluation` 给 method/confidence/evidence 与多评估器明细。

> schema 变更（新表）需破"MVP 不改 schema"——见 §8 待定。

---

## §7 接口与复用

### 7.1 新增

- `evaluateTrace(executionId, opts)`：编排器，取配置集 → 逐评估器 run → 写回。供 ingest / 回填 / manual 三入口调用。
- `TraceEvaluator` 实现：`result-completion` / `process-trajectory` / `process-grounding` / `result-self-rubric prompt` / `reference-free prompt`（新 prompt 2 个）。

### 7.2 复用（零改或最小改）

- `judgeAnswer`（gt-rubric / 可包装 self-rubric）、`trajectory-evaluator` 的 `trace_only`、`findBestSemanticConfigMatch`、评估器注册表 `src/lib/evaluators/`、`evaluator-execution-recorder`、`withBackgroundOpencodeSlot`（agent 模式）、`isEvaluatorTrace`（污染隔离）。

### 7.3 ingest 改动

- `processUploadAsync` 末尾：`void evaluateTrace(executionId)`（异步、不阻塞 ACK）；
- 词面匹配 `findBestMatchConfig` → 语义 `findBestSemanticConfigMatch`（在 `result-completion` 内）。

---

## §8 待定决策（需确认，附默认建议）

| # | 决策 | 默认建议 |
|-|-|-|
| 1 | 必选集 | result-completion / result-safety / process-tool-correctness / process-trajectory / cost / error-clustering |
| 2 | T3 reference-free 直判是否启用 | **先不启用**，无 GT 默认到 T2（自生 rubric）+ floor；T3 后置且永远低置信 |
| 3 | 独立 verifier 置信模型 | **本期不做**，用便宜信号（方法档×匹配置信×自一致性） |
| 4 | schema 新表 `TraceEvaluation` | **新建**（证据/置信/多评估器无处可塞，必须破不改 schema 原则） |
| 5 | 综合分聚合 | 分层聚合 + 只计高置信 completion，打底单列 |
| 6 | 成本治理 | **本期不做**，全异步模型调用；预留 `evaluateTrace` 的预算/采样挂载点 |

---

## §9 分阶段实施（指导开发）

```
P1 评估器骨架 + 自动触发
  - TraceEvaluator 接口 + 注册表 + 默认必选集
  - evaluateTrace 编排器；ingest processUploadAsync 末尾挂接（异步）
  - 接入：确定性评估器(tool-correctness/cost/error/safety) + result-completion(T0/T1，语义匹配恢复 GT) + process-trajectory(trace_only direct-llm)
  - 新表 TraceEvaluation；result-completion 同时写回 Execution.answerScore
  - 每个 EvalResult 带 method+confidence(便宜信号)+evidence
  验收：上传一条 trace → 自动产生各维 TraceEvaluation 行 + answerScore；judge 输出含证据/置信

P2 无 GT 深化
  - result self-rubric(T2) + 新 prompt；process-grounding 评估器
  - 自一致性置信（k-vote）
  验收：无 Config 命中的 trace 也有 completion(self-rubric, 中置信) + grounding 分

P3 可信度收口（接入质量监控呈现）
  - 维度分分层聚合 + 综合分只计高置信 + "无故障打底"正名
  - 逐 trace 置信 chip + 证据 hover；趋势同尺/覆盖带/口径标注
  验收：覆盖率变化不再让趋势"假摔"；低置信项置灰；证据可查

P4（后置）
  - 抽样人审校准置信度；reference-free(T3)；成本治理（预算/采样/限流）；可选 verifier 模型
```

---

## §10 验收准则（P1–P3 汇总）

- 每条新上报 trace 自动产生：四维确定性分 + 过程轨迹分 + completion（含证据/置信/method）落 `TraceEvaluation` 与 `Execution.answerScore`。
- 无 Config 命中的 trace 也有过程分与 completion（self-rubric 或 floor），且**标注 method 与置信度**。
- 质量监控读路径**零模型调用**；评测全部异步发生在 ingest/回填/manual 路径。
- 维度分按方法分层、低置信置灰；趋势在覆盖率变化时不产生误导性位移。
- LLM judge 类结果**均带证据**（结论 + 引用/逐 rubric）。

---

## §11 风险

| 风险 | 缓解 |
|-|-|
| 全异步模型调用 → 成本/并发压力（本期不治理） | 预留 `evaluateTrace` 挂载点；P4 接预算/采样/限流 |
| 无 GT 结果分不可信 | 分层 + 强制置信度 + 正名 + 低置信置灰；T3 后置 |
| 评估器自身产 trace 污染列表 | `isEvaluatorTrace` 严格隔离；agent 模式会话打 internal tag |
| 覆盖率上涨致趋势假摔 | P3 同尺/覆盖带/口径标注，且收口不晚于大规模接 judge |
| 新 prompt（self-rubric/ref-free）质量 | 抽样人审校准（P4）；先标中/低置信 |

---

## §12 参考来源

### 结果维（无 GT 评测，支撑 §4.1）

业界对"无标准答案的结果评测"的维度与方法高度收敛，§4.1 的子维度清单与 HealthBench 式分析式 rubric 方法据此确认：

- **RAGAS** — reference-free 的 faithfulness（主张拆解→逐条对上下文验证→支撑比例）与 answer relevancy（答案↔问题语义匹配）。论文：https://arxiv.org/pdf/2309.15217
- **DeepEval** — G-Eval / Faithfulness / Answer Relevancy / Hallucination，judge 带可解释推理。https://deepeval.com/docs/metrics-llm-evals ｜ RAG 指标：https://www.confident-ai.com/blog/rag-evaluation-metrics-answer-relevancy-faithfulness-and-more
- **G-Eval** — 四维（coherence / consistency / fluency / relevance），NL 准则 + CoT + form-filling 概率加权打分，与人类相关性最高（Spearman 0.514）。https://www.confident-ai.com/blog/g-eval-the-definitive-guide
- **OpenAI HealthBench** — 分析式 rubric（逐准则 met/not-met + 加权聚合）、**LLM 自动生成 per-prompt rubric**、五轴权重（准确性33/完整性39/上下文16/沟通8/指令4）；核心结论"逐准则判优于单一笼统分"。论文：https://cdn.openai.com/pdf/bd7a39d5-9e9f-47b3-903c-8b847ca650c7/healthbench_paper.pdf
- **Galileo** — 无 GT 的 Correctness / Completeness / Instruction Adherence，并提出"接地 + 指令遵循 = 质量地板"。https://docs.galileo.ai/concepts/metrics/response-quality/correctness ｜ https://docs.galileo.ai/concepts/metrics/response-quality/instruction-adherence ｜ https://docs.galileo.ai/concepts/metrics/response-quality/response-quality-overview
- **RubricEval** — rubric-based LLM judge 的元评测基准。https://arxiv.org/html/2603.25133v1

### 错误维（支撑 §4.3）

- **OpenTelemetry GenAI 语义约定** — `error.type` 属性 + span status 的标准错误记录口径。Spans：https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- **MAST《Why Do Multi-Agent LLM Systems Fail?》** — 首个多智能体失败分类学，14 种失败模式 / 3 大类（系统设计、协同失配、任务校验），1600+ 标注 trace。https://arxiv.org/abs/2503.13657
- **TRAIL（Trace Reasoning and Agentic Issue Localization）** — agentic 错误类型分类学 + trace 错误定位基准；SOTA 模型联合定位准确率仅 ~11%（佐证"模型归因不可单独依赖"）。https://arxiv.org/abs/2505.08638

### 成本维（支撑 §4.4）

- **OpenTelemetry GenAI metrics** — `gen_ai.client.token.usage`（input/output、计费 token 优先）、`gen_ai.client.operation.duration`、`time_to_first_chunk`。https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
- **《Beyond Accuracy: 企业级 Agentic AI 多维评测框架》（CLEAR）** — Cost/Latency/Efficacy/Assurance/Reliability 五维；cost-per-success、cost-normalized-accuracy、step-wise efficiency、质量-成本 Pareto；实测最高准确率方案成本达 Pareto-最优的 4.4–10.8×。https://arxiv.org/html/2511.14136v1
