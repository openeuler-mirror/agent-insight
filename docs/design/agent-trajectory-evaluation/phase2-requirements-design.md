# Agent 执行步骤效率与执行过程质量评估器：Phase 2 需求设计

> 关联任务：[openeuler/opensource-intern#168](https://gitcode.com/openeuler/opensource-intern/issues/168)<br>
> 前置文档：[Phase 1 需求分析](phase1-requirements-analysis.md)<br>
> 日期：2026-08-24<br>
> 基线：`master@0f8006e7`
> 状态：已批准（2026-08-24）

## 目录

1. [设计结论](#1-设计结论)
2. [架构与数据流](#2-架构与数据流)
3. [模块边界](#3-模块边界)
4. [统一轨迹事实](#4-统一轨迹事实)
5. [Judge 输出契约](#5-judge-输出契约)
6. [执行步骤效率规则](#6-执行步骤效率规则)
7. [轨迹质量规则](#7-轨迹质量规则)
8. [评分和封顶](#8-评分和封顶)
9. [兼容与多入口一致性](#9-兼容与多入口一致性)
10. [错误处理](#10-错误处理)
11. [输出与持久化](#11-输出与持久化)
12. [24 个验收场景映射](#12-24-个验收场景映射)
13. [测试设计](#13-测试设计)
14. [文件影响范围](#14-文件影响范围)
15. [实施顺序](#15-实施顺序)
16. [Phase 2 完成条件](#16-phase-2-完成条件)

## 1. 设计结论

Phase 2 冻结以下设计：

1. 新增 `preset-agent-step-efficiency`，只进入实验评测链路，不进入旧 `/api/eval/trajectory/run` 批量评测链路。
2. 新增 `preset-agent-process-quality`，以独立卡片承载 Issue #168 的六维过程质量口径，并只进入实验评测链路。
3. 现有 `preset-agent-trace-quality` 保持原卡片、faithful runner、opencode 三维口径和旧轨迹入口不变。
4. 六维质量能力只由新 ID 调用；不迁移旧 API、Skill 对齐或质量监控消费者。
5. 两个评估器均采用“完整事实输入 → LLM 离散判断 → 代码事实锚定 → 代码计分和封顶”。
6. 效率五维等权，质量六维等权。后续修改权重必须提升 `rubricVersion`。
7. 历史结果不重算；两个 ID 的结果从注册、分发到持久化均保持独立。
8. 新质量卡不生成旧三维兼容信号，也不要求旧消费者读取新结果。
9. 不新增 Prisma 字段。新评估器结果写入现有 `ExperimentEvalResult`。

## 2. 架构与数据流

```text
Execution.interactions
        │
        ▼
extractAgentTrajectoryFacts
  - 保留全部步骤索引
  - 归一化状态、耗时、Token、参数/输出指纹
  - 生成重复、重试、连续同类调用候选
        │
        ├───────────────────────┐
        ▼                       ▼
效率 Prompt + schema       质量 Prompt + schema
        │                       │
        ▼                       ▼
callJudgeLlm（统一可注入边界，temperature=0）
  - 首次输出发生契约错误时，canonical 内部最多追加一次安全 repair
  - 每次 canonical invocation 最多 2 次逻辑 callJudge
        │                       │
        ▼                       ▼
Zod 严格校验 → 事实锚定 → 问题去重 → 维度计分 → 严重问题封顶
        │                       │
        ▼                       ▼
Experiment EvaluatorOutput（仅实验入口）
```

Judge 不接触权重和封顶值。它只判断固定维度的 `met | partial | missing`，并返回问题代码、证据步骤和建议。代码决定分数，因此同一 Judge 输出始终得到相同结果。

## 3. 模块边界

### 3.1 Canonical 轨迹能力

放在 `src/lib/engine/evaluation/`，供两个新实验评估器共同调用：

- `agent-trajectory-facts.ts`：从 `interactions` 提取事实和确定性候选；
- `agent-trajectory-assessment.ts`：维度定义、问题白名单、Zod 契约、事实锚定、去重、计分、封顶和领域输出；
- `agent-trajectory-judge.ts`：组合 Prompt、调用传入的 Judge caller、解析结构化结果；首次输出发生契约错误时最多执行一次安全 repair；不直接持久化。

Canonical 能力不返回 `EvaluatorOutput`，也不访问 Prisma。它返回稳定的领域结果 `AgentTrajectoryAssessment`，由实验适配层转换为统一输出。

### 3.2 实验适配层

`src/lib/engine/experiment/agent-trajectory-preset-evaluators.ts` 负责：

- 声明两个预置 ID 和归属判断；
- 调用 canonical 能力；
- 将领域结果映射为 `EvaluatorOutput`；
- 通过函数内动态导入调用 `judge-llm.ts`，保持测试加载轻量。

该文件只认领 `preset-agent-step-efficiency` 与 `preset-agent-process-quality`。`faithful-preset-evaluators.ts` 继续认领原有任务完成度和 `preset-agent-trace-quality`，两个质量 ID 不共享 runner。

### 3.3 旧轨迹链路隔离

`/api/eval/trajectory/run`、`trajectory-evaluator.ts`、Skill 对齐和质量监控继续使用原 `preset-agent-trace-quality` 行为。本需求不修改这些文件，也不把 `preset-agent-process-quality` 暴露到旧轨迹 API 或 Skill 入口。

`agent-debug/skills-analysis.ts` 和 faithful runner 继续调用原 `evaluateTrajectoryViaOpencode()`。这是旧评估器及 Skill 诊断的既有实现，不与新六维评估器合并。

新六维评估器基于实验上下文与统一轨迹事实评分，不依赖 Skill 关键动作引用，也不改变旧完整性、工具选择和冗余度信号。

## 4. 统一轨迹事实

### 4.1 步骤结构

```ts
interface AgentTrajectoryStepFact {
  index: number;
  interactionIndex: number;
  agent?: string;
  depth: number;
  kind: 'user' | 'llm' | 'tool' | 'skill' | 'task';
  name?: string;
  argsSummary?: string;
  argsFingerprint?: string;
  outputSummary?: string;
  outputFingerprint?: string;
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'unknown';
  errorSummary?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    estimated?: boolean;
  };
}
```

步骤索引必须沿用当前 Trace 展示顺序：基于 `buildAgentCallTree()` 和 `walkTree()`，跳过 `ras` 事件，其余事件从 0 连续编号。`anchors: ['step-N']` 必须能回到同一条可见 Trace 步骤。

### 4.2 指纹与文本边界

- 参数和输出先做稳定键排序，再生成 SHA-256；
- 指纹只用于比较，不进入用户展示；
- 每个参数、输出和文本摘要最多 500 字；
- Prompt 保留所有步骤，不做头尾抽样；
- Prompt 总字符超过 120,000 时，本次评估失败并提示“完整轨迹超过当前 Judge 上下文限制”，不得静默截掉中段后出分。

### 4.3 状态与 Token

- 状态优先读取 `AgentEvent.toolStatus`，再读取底层 interaction 的 `trace_status`、`status` 和 error 字段；
- 无明确状态时使用 `unknown`，不能把缺失状态当成功；
- Token 从事件 `usage` 读取。没有逐步 Token 时保留缺失，只使用可验证的全轨迹统计；
- 单步 Token 缺失不导致评估失败，但不得据此生成“单步 Token 异常”的问题。

### 4.4 确定性候选

事实层只生成候选，不直接扣分：

- `repeatedSameCallCandidates`：相同名称和参数指纹重复；
- `repeatedSameResultCandidates`：重复调用且输出指纹相同；
- `unchangedRetryCandidates`：失败、超时后同参重试；
- `consecutiveSimilarCandidates`：连续同类 Tool/Skill/LLM 步骤；
- `callStatistics`：各类调用数、失败数、总 Token、总耗时和集中度。

Judge 结合任务语义确认候选是否真的低效，避免把分页、分片、轮询、幂等重试和必要串行调用误判为问题。

## 5. Judge 输出契约

### 5.1 公共结构

```json
{
  "summary": "一句中文结论，不超过 200 字",
  "dimensions": [
    {
      "dimension": "固定维度 key",
      "verdict": "met | partial | missing",
      "reason": "基于可观察轨迹的判断依据",
      "suggestion": "未完全达成时的改进建议"
    }
  ],
  "issues": [
    {
      "code": "白名单问题代码",
      "severity": "minor | major | critical",
      "dimension": "固定维度 key",
      "stepIndexes": [3, 4],
      "toolName": "可选，必须匹配锚定步骤",
      "reason": "问题说明",
      "suggestion": "改进建议"
    }
  ]
}
```

质量 Judge 只返回六维判断与问题，不返回 Skill 关键动作或旧兼容字段。Judge 不得返回分数、权重、总分或封顶。

### 5.2 严格校验

- `dimensions` 长度和 key 集合必须完整、唯一、无额外值；
- `met` 的 `suggestion` 必须为空；`partial` 和 `missing` 必须有建议；
- 每个非 `met` 维度至少有一个通过事实锚定的同维问题；
- `met` 维度不得关联负面问题；
- 每个问题代码只能归属预定义维度；
- `stepIndexes` 非空、去重，且必须全部存在；
- `toolName` 存在时，所有锚定的具名工具步骤都必须匹配该 `name`；非工具步骤不强制匹配；
- 确定性问题代码必须匹配事实层对应候选；
- 无效问题不参与分数和封顶，并记录到 `discardedIssues`；若无效问题导致非 `met` 维度失去全部证据，则由 canonical 将该次输出判为契约错误，并在同一次 invocation 内进入唯一一次安全 repair，而不是生成兜底分或交给行级重复整次评估。

## 6. 执行步骤效率规则

### 6.1 维度与权重

| 维度 | 权重 | 判定口径 |
|---|---:|---|
| `step_necessity` | 20% | 每一步是否对目标、必要验证或合理恢复有贡献 |
| `path_detour` | 20% | 是否存在可避免的偏航、上下文切换或长路径 |
| `cost_efficiency` | 20% | 是否存在可证实的无信息增量 LLM、Token 或耗时浪费 |
| `step_density` | 20% | 步骤粒度是否合理，是否存在明确可合并操作 |
| `retry_efficiency` | 20% | 失败后是否调整参数或策略，回退范围是否必要 |

没有工具、错误或重试不是 N/A。只要轨迹不需要相应行为，该维度视为满足，可得到 100 分，保证直接回答类任务能够满分。

### 6.2 问题代码和封顶

| code | 固定维度 | 触发边界 | 维度上限 | 附加维度上限 | 总分上限 |
|---|---|---|---:|---|---:|
| `duplicate_no_gain` | `step_necessity` | 至少 3 次同参调用且结果无新增信息 | 40 | — | 50 |
| `irrelevant_detour` | `path_detour` | 主任务前后插入明显无关探索或上下文切换 | 30 | — | 40 |
| `unchanged_retry_loop` | `retry_efficiency` | 连续失败后参数和策略均未变化，形成原地重试 | 20 | — | 40 |
| `avoidable_llm_overuse` | `cost_efficiency` | LLM 仅重复、转述或处理可由已有确定信息直接完成的操作 | 30 | — | 50 |
| `fragmented_mergeable_steps` | `step_density` | 至少 3 个独立同类步骤在当前任务和调用能力下可安全合并 | 50 | — | 60 |
| `excessive_detour` | `path_detour` | 核心动作被多步非必要探索显著延后 | 20 | `step_necessity ≤ 30` | 30 |
| `unused_tool_result_processing` | `cost_efficiency` | 工具结果已直接包含答案，终态回答前仍有额外处理且未增加有效信息；须锚定成功工具结果、额外处理和终态回答 | 30 | — | 50 |
| `overrollback` | `retry_efficiency` | 局部失败后无依据重做已完成的前序链路 | 20 | — | 40 |

`irrelevant_detour` 和 `excessive_detour` 互斥：同一组根因步骤只保留严重程度更高的 `excessive_detour`。同一问题即使影响多个维度，也只生成一个根问题；需要影响第二维时通过封顶映射完成，不复制问题。

没有预算、同任务历史或模型价格时，不允许仅凭绝对 Token 数或绝对耗时判低分。MVP 只评价能从当前轨迹证明的可避免消耗。

## 7. 轨迹质量规则

### 7.1 维度与权重

六个维度各占 `1/6`：

| 维度 | 判定口径 |
|---|---|
| `goal_alignment` | 每个关键动作和最终结果是否持续服务用户原始目标 |
| `planning_completeness` | 可观察计划或执行路径是否覆盖明显必要的前置、子任务和验证 |
| `reasoning_coherence` | 可观察决策是否有前序证据支撑并保持前后一致 |
| `exception_handling` | 遇到错误或异常结果时是否验证、调整、恢复、降级或合理终止 |
| `path_robustness` | 决策和实现路径是否稳定，改变方案时是否有新证据 |
| `information_utilization` | 是否正确且充分使用已有上下文、工具返回和中间状态 |

无显式计划文本时，`planning_completeness` 根据实际动作覆盖评价，不能因为没有输出“计划”两个字直接扣分。无错误时 `exception_handling` 视为满足。无隐藏推理数据时只评价可观察消息、工具参数、工具返回和决策结果。

### 7.2 问题代码和封顶

| code | 固定维度 | 触发边界 | 维度上限 | 总分上限 |
|---|---|---|---:|---:|
| `goal_drift` | `goal_alignment` | 执行目标无依据扩大、替换或长期偏离 | 40 | 50 |
| `missing_required_step` | `planning_completeness` | 遗漏任务明确要求或结果成立所必需的步骤/验证 | 30 | 50 |
| `unsupported_reasoning_jump` | `reasoning_coherence` | 关键决策缺少可观察证据或必要检查 | 40 | 50 |
| `unhandled_recoverable_error` | `exception_handling` | 可恢复错误后直接失败，未重试、调整或降级 | 30 | 40 |
| `contradicted_tool_result` | `information_utilization` | 后续结论与已返回的关键工具事实矛盾 | 30 | 50 |
| `decision_thrashing` | `path_robustness` | 没有新证据却反复切换已选方案 | 30 | 40 |
| `internal_contradiction` | `reasoning_coherence` | 不同步骤对同一关键事实给出直接冲突结论 | 30 | 40 |
| `unused_required_information` | `information_utilization` | 工具已返回回答所需字段，但最终过程或答案遗漏必要信息 | 50 | 60 |

`missing_required_step` 只能引用以下依据之一：用户明确要求、工具/任务显式前置关系、已提供的 Skill 关键动作、或使当前结论成立的明显验证步骤。Judge 不能凭行业习惯自行发明“标准流程”。

## 8. 评分和封顶

### 8.1 计算顺序

1. 将 Judge verdict 映射为原始维度分：`met=100`、`partial=50`、`missing=0`；
2. 对每个维度应用已通过事实锚定的问题上限和附加维度上限，得到最终维度分；
3. 按固定权重计算 `baseScore`；
4. 对已通过事实锚定的问题应用总分上限，多个上限取最小值；
5. `score = min(baseScore, appliedTotalCap)`，保留一位小数；
6. `score >= 80` 为达成，`60–79.9` 为部分达成，低于 60 为未达成。

### 8.2 状态与去重

- 最终维度分 100 → `covered`；
- 最终维度分 40–99.9 → `partial`；
- 最终维度分低于 40 → `missing`；
- 同一 `code + dimension + stepIndexes + toolName` 只保留一次；
- 多个问题可以影响同一维度，但维度只应用最低上限；
- 总分证据同时保存 verdict 原始分、维度封顶后分、基础总分、命中的总分上限和最终分。

## 9. 兼容与多入口一致性

### 9.1 质量 rubric 版本

```text
agent-process-quality/1.0.0
```

该版本只属于新 ID `preset-agent-process-quality`，不表示旧 `preset-agent-trace-quality` 的语义升级。

效率 rubric 版本为：

```text
agent-step-efficiency/1.0.0
```

### 9.2 新旧评估器隔离

- 新质量 Judge 只返回六维 verdict、问题和建议，不生成旧 `toolChoice`、`redundancy` 或 `keyActions` 兼容信号；
- 原 `preset-agent-trace-quality` 继续生成和持久化其既有结果；
- `alignment-attribution.ts`、`derive-skill-opt-points.ts`、质量监控和 AgentDebug 不读取新 ID 的结果；
- 旧历史结果、旧解析器和旧展示不做迁移。

### 9.4 评估器可用入口

registry 只新增 `preset-agent-process-quality` 的既有运行元数据，不扩展公共元数据结构，也不改动任何既有卡。实验执行引擎通过 canonical runner 唯一认领新 ID。

三处旧 Skill 页面在原 `ready` 过滤基础上显式排除 `preset-agent-process-quality`；旧 `/api/eval/trajectory/run` 白名单保持不变，因此不会出现“下拉框可选、后端报 unsupported evaluators”。该隔离不改变旧 `preset-agent-trace-quality`、历史结果名称解析或其它评估器的可见性。

## 10. 错误处理

以下情况把首次 Judge 输出判为 `JudgeOutputParseError`，并由 canonical 在**同一次 invocation 内**最多执行一次安全 repair：

- Judge 返回非 JSON；
- 维度缺失、重复或出现未知 key；
- 非 `met` 维度缺少有效问题；
- 问题引用不存在步骤或错误工具名；
- 确定性问题代码与事实候选不匹配；
- `partial`/`missing` 缺少原因或建议。

Repair 只追加程序白名单生成的错误代码、问题维度和安全骨架，不回显模型自由文本，也不改变原始任务、事实和 rubric。计数口径是逻辑 `callJudge`：首次调用加至多一次 repair，因此每次 canonical invocation 最多为 2 次；底层 SDK 的网络重试和 direct→opencode fallback 是传输层实现细节，不计入这两个逻辑调用。

第二次调用无论再次返回契约错误，还是发生 transport/timeout 等其它失败，都统一转为不可行级重试的 `AgentTrajectoryContractExhaustedError`，该行直接失败，避免实验行重试把一轮错误放大成 4 或 6 次 Judge 调用。旧轨迹适配层不再额外包裹 retry，它与实验入口共用这一个 canonical repair 边界。

首次调用若发生纯 transport 失败，尚未产生可修复的 Judge 输出，不进入 contract repair；仍按 `callJudgeLlm` 既有的 SDK retry、direct→opencode fallback 和实验行级超时分类策略处理。本节的调用上限是 canonical 逻辑调用上限，不是网络请求次数的硬上限。

以下情况直接失败，不重试为伪造分数：

- Trace 无可评估步骤；
- 完整 Prompt 超过 120,000 字符；
- interactions 无法解析为 Trace 树；
- 模型连接未配置。

旧轨迹链路继续使用现有 staged error 和诊断映射。新增错误信息必须说明是输入、Judge 契约还是模型连接问题，不把评估失败描述成 Agent 得 0 分。

## 11. 输出与持久化

### 11.1 Experiment `EvaluatorOutput`

每个正式维度生成一个评分点：

```ts
{
  label,
  score,
  status,
  evidence: { json: { verdict, reason, issues } },
  suggestion,
  anchors: ['step-N']
}
```

卡级 evidence：

```json
{
  "schemaVersion": 1,
  "rubricVersion": "agent-process-quality/1.0.0",
  "dimensions": [],
  "issues": [],
  "discardedIssues": [],
  "suggestions": [],
  "factsSummary": {},
  "baseScore": 83.3,
  "appliedCaps": [],
  "finalScore": 83.3
}
```

效率 evidence 使用同一结构。

### 11.2 旧 `TrajectoryEvalResult`

本需求不修改旧 `TrajectoryEvalResult` 的写入、JSON 结构、注释、类型或解析器。新六维结果只写入现有 `ExperimentEvalResult`，因此无需 Prisma schema 变更。

## 12. 24 个验收场景映射

### 12.1 执行步骤效率

| 用例 | 主要判断 | 必须命中的问题/结果 | 验收阈值 |
|---:|---|---|---|
| 1 | 单步直接查询 | 无问题，五维 `met` | 总分 100、各维 100 |
| 2 | 三次重复搜索且结果相同 | `duplicate_no_gain` | 总分 ≤50，必要性 ≤40 |
| 3 | 天气、新闻后才发邮件 | `irrelevant_detour` | 总分 ≤40，绕路 ≤30 |
| 4 | 同参失败原地重试 | `unchanged_retry_loop` | 总分 ≤40，重试 ≤20 |
| 5 | 简单拼接仍反复调用 LLM | `avoidable_llm_overuse` | 总分 ≤50，成本 ≤30 |
| 6 | 三次可合并读取 | `fragmented_mergeable_steps` | 总分 ≤60，密度 ≤50 |
| 7 | 参数错误后立即修正成功 | 无负面重试问题，重试维 `met` | 总分 ≥80，重试 ≥80 |
| 8 | 翻译前进行长路径探索 | `excessive_detour` | 总分 ≤30，绕路 ≤20，必要性 ≤30 |
| 9 | 工具已有答案仍调用 LLM 转述 | `unused_tool_result_processing` | 总分 ≤50，成本 ≤30 |
| 10 | `2+2` 单步回答 | 无问题，五维 `met` | 总分 100、各维 100 |
| 11 | 有依赖的必要多步链 | 无低效问题 | 总分 ≥90 |
| 12 | 局部失败后从头重做 | `overrollback` | 总分 ≤40，重试 ≤20 |

### 12.2 轨迹质量

| 用例 | 主要判断 | 必须命中的问题/结果 | 验收阈值 |
|---:|---|---|---|
| 1 | 查询天气并提醒带伞 | 无问题，六维 `met` | 总分 ≥95，各维 ≥90 |
| 2 | 查询预算时长期偏离 | `goal_drift` | 总分 ≤50，对齐 ≤40 |
| 3 | 部署后遗漏验证 | `missing_required_step` | 总分 ≤50，规划 ≤30 |
| 4 | 登录慢直接跳到扩容数据库 | `unsupported_reasoning_jump` | 总分 ≤50，连贯 ≤40 |
| 5 | 连接失败后直接终止 | `unhandled_recoverable_error` | 总分 ≤40，异常处理 ≤30 |
| 6 | 最终数据违背检索结果 | `contradicted_tool_result` | 总分 ≤50，信息利用 ≤30 |
| 7 | Python/Shell 无依据切换 | `decision_thrashing` | 总分 ≤40，稳健性 ≤30 |
| 8 | 前后判断数据库状态矛盾 | `internal_contradiction` | 总分 ≤40，连贯 ≤30 |
| 9 | 无工具的直接事实回答 | 无问题，六维 `met` | 总分 100 |
| 10 | 完整 503 排障链 | 无严重问题，六维应为 `met` | 总分 ≥85，各维 ≥80 |
| 11 | 忽略工具返回的必要字段 | `unused_required_information` | 总分 ≤60，信息利用 ≤50 |
| 12 | 主源失败后正确降级 | 无负面异常问题，异常处理 `met` | 总分 ≥80，异常处理 ≥80 |

## 13. 测试设计

### 13.1 单元测试

- 事实提取：索引稳定、状态归一、Token、耗时、指纹、重复和重试候选；
- Schema：缺维、重复维、未知代码、空建议、虚构步骤和工具名均失败；
- Grounding：确定性问题必须匹配候选，语义问题必须匹配真实步骤；
- 计分：等权、维度上限、总分上限、多个上限取最小、去重和边界 0/100；
- 输出：每个有分评分点都有证据，状态和最终维度分一致；
- 兼容：新 evidence、旧评分点和旧 rawAnalysis 三层读取顺序。

### 13.2 24 场景契约测试

每个场景使用最小 synthetic interactions 和 `setJudgeLlmCallerForTest` 返回结构化 Judge 结果，调用真实评估器入口。测试必须经过事实提取、Zod、grounding、计分和输出映射，不能直接 fake 整个 runner。

对每类封顶做破坏验证：临时移除相应 cap 或将聚合改为常数时，对应用例必须失败。

### 13.3 集成和回归

- registry 每张卡恰好一个分发归属；
- 新质量 ID 只被 canonical 轨迹 runner 认领，旧质量 ID 仍只被 faithful 族认领；
- 实验结果可以保存六维评分点和 evidence；
- 旧轨迹结果 API、AgentDebug Skill 分析和质量监控保持基线行为；
- 旧历史结果仍能解析和展示。

### 13.4 验证命令

实现阶段按仓库门禁执行：

```text
npm run test
npx tsc --noEmit
npx eslint <本需求改动的 TypeScript 文件>
```

随后在 openEuler 24.03 LTS SP4 使用真实 Judge 模型运行 24 个验收场景，并把自动化结果和真实模型结果分开记录。这里定义的是验收方法，不表示真实 Judge 的 24 场景已经全量通过；实际状态必须以独立验收报告为准。

## 14. 文件影响范围

### 14.1 新增文件

```text
src/lib/engine/evaluation/agent-trajectory-facts.ts
src/lib/engine/evaluation/agent-trajectory-assessment.ts
src/lib/engine/evaluation/agent-trajectory-judge.ts
src/lib/engine/experiment/agent-trajectory-preset-evaluators.ts
src/prompts/agent-step-efficiency-prompt.ts
src/prompts/agent-process-quality-prompt.ts
test/agent-trajectory-facts.test.ts
test/agent-trajectory-preset-evaluators.test.ts
```

### 14.2 主要修改文件

```text
src/lib/evaluators/preset-evaluators.ts
src/lib/evaluators/registry.ts
test/preset-registry-consistency.test.ts
docs/developer-guide/10-evaluator-development.md
docs/user-guide/evaluation/evaluators.md
```

实际实施不得顺手重构无关评估器或改动 Prisma schema。

## 15. 实施顺序

1. 先写 24 场景测试骨架和事实提取测试，使其因功能缺失而失败；
2. 实现统一事实层和确定性候选；
3. 实现公共 Judge 契约、事实锚定、计分与封顶；
4. 实现效率评估器并跑 12 个效率场景；
5. 实现六维质量评估器并跑 12 个质量场景；
6. 接入实验 registry 和分发，同时验证旧 faithful 族仍唯一认领旧 ID；
7. 运行旧轨迹、Skill 和质量监控回归，证明旧链路未改变；
8. 跑目标测试、全量测试、类型检查和改动文件 lint；
9. 更新开发指南、用户指南和设计索引；
10. 在 openEuler SP4 完成真实模型验收。

## 16. Phase 2 完成条件

Phase 2 在以下设计被确认后结束：

- 接受效率卡仅进入实验链路的 MVP 边界；
- 接受新增 `preset-agent-process-quality` 且只进入实验链路；
- 接受 `preset-agent-trace-quality` 及其旧消费者保持不变；
- 接受两个评估器的等权和问题封顶表；
- 接受 Prompt 超限时失败而不是截断后出分；
- 接受第 12 节对 24 个场景的测试映射；
- 同意进入 Phase 3 编写逐文件开发计划。
