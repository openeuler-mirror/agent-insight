# 任务完成度（无标准答案）预置评估器

> 归档目标：`docs/design/build-in-evaluators/task-completion-no-ref-evaluator.md`
> 更新时间：2026-08-29

## 1. 定位与前置条件

`preset-task-completion-no-ref` 是结果类预置评估器，用于在**无标准答案**的情况下评估 Agent 任务的完成度。评估器接收（用户输入, Agent 输出）作为输入，不依赖参考答案、不依赖轨迹、不依赖 Tool 目录。

## 2. 三阶段评估方法

### 第一阶段——需求推断

从用户输入中推断出需求清单，分三类：

- `explicit`：用户明确提出的要求或问题
- `implicit`：从语境中可推断出的限制条件
- `business_must_have`：在该业务场景下必须覆盖的要素

每条需求标注 `confidence`：high / medium / low。

### 第二阶段——逐条对齐

将 Agent 输出与推断需求逐条对比，判定：

- `covered`：Agent 输出明确满足了该需求
- `partially_covered`：部分满足但不够完整
- `not_covered`：未满足该需求
- `not_applicable`：推断的需求在当前上下文中不适用

### 第三阶段——综合评分

三个维度加权，**代码按规则算分，不让 LLM 自由打分**：

### 输出契约校验（fail-fast）

Judge 需同时返回 `inferred_requirements`（推断需求）与 `requirement_results`（逐条判定）两个数组，
代码会校验两者**数量相同且逐条在 content / type / confidence 上完全一致**。

- 有推断需求但没有对应判定项（或反之），判为输出契约错误、抛异常，**不默认满分**；
- 逐条字段不匹配同样抛异常。

这条约束保证「少返回判定项反而得高分」的误判不可复现。

## 3. 评分公式

### 显式需求完成度（权重 0.5）

按**适用需求的加权覆盖比例**计分（而非固定每条扣分），对需求拆分粒度稳定：

```
适用集合 = explicit + 仅 high 置信度的 business_must_have（排除 not_applicable）
每条权重：covered = 1.0 / partially_covered = 0.5 / not_covered = 0
显式分 = Σ权重 / 适用数 × 100（无适用需求 → 100）
```

- `not_applicable` 排除分母，不因「推断出不适用需求」拉低覆盖比例；
- `business_must_have` 是模型自行推断的必答点，**仅 high 置信度计入显式分**；
  medium/low 置信度的必答点降级为隐含约束（见下）。

比例制保证「1/2 未完成（50%）」与「4/20 未完成（80%）」得分不同，同一覆盖比例无论拆成几条得分相同。

### 隐含约束满足度（权重 0.3）

同样按覆盖比例，低置信度未满足扣分减半：

```
适用集合 = implicit + 非 high 置信度的 business_must_have（排除 not_applicable）
每条权重：covered = 1.0 / partially_covered = 0.5
          not_covered（high/medium）= 0
          not_covered（low）= 0.5（扣分减半）
隐含分 = Σ权重 / 适用数 × 100（无适用需求 → 100）
```

### 信息充分性与中立性（权重 0.2）

LLM 只给**离散档位**（`sufficient` / `mostly_sufficient` / `insufficient` / `severely_insufficient`），
代码映射到固定分数：

| 档位 | 分数 |
|---|---|
| sufficient | 100 |
| mostly_sufficient | 80 |
| insufficient | 50 |
| severely_insufficient | 20 |

三个维度全部由代码算分，LLM 不参与任何连续打分，保证同一条 trace 重评结果稳定。

### 加权总分

```
总分 = 显式 × 0.5 + 隐含 × 0.3 + 信息充分性 × 0.2
```

## 4. 评分点设计

三个固定维度对应三个评分点：

- **显式需求完成度**（含 high 置信度的 `business_must_have`，标签内区分）：evidence 展示需求清单及逐条判定
- **隐含约束满足度**（始终展示，无隐含约束时显示提示；含被降级的非 high 置信度必答点）：evidence 同上
- **信息充分性与中立性**：evidence 展示 LLM 的总体分析

每个评分点都有 `score` + `status`（≥80 covered / ≥60 partial / <60 missing）。

## 5. verdict 判定

```
score ≥ 80 → pass
60 ≤ score < 80 → warn
score < 60 → fail
```

## 6. summary 与 reason

- **summary**：简洁结论（≤80 字），讲最要命的具体问题
- **reason**：与 `summary` 同文案（一句结论），避免与评分点证据重复展示。
  `isEvidenceRedundant` 会判重隐藏卡级证据，展开区只显示三张评分点的明细。

详细数据放在对应评分点的 `evidence.md`：

- 显式需求完成度：每条需求的判定（✅/⚠️/❌）+ 置信度 + 理由
- 隐含约束满足度：同上；无隐含约束时显示「本次任务未推断出隐含约束」
- 信息充分性与中立性：LLM 给的 `overall_analysis`

> 旧实现曾把需求推断明细、综合评分（每个维度的分数和权重）再写一遍到 `reason`，又同时塞 `evidence.json`，但 `EvidenceSchema` 是 `{md}` 或 `{json}` 二选一，`coerceEvidence` md 优先导致 json 字段实际被丢弃。改为单行 reason + 评分点证据后，证据完整且不重复。

## 7. 注册信息

| 字段 | 值 |
|---|---|
| `id` | `preset-task-completion-no-ref` |
| `evaluatorType` | `LLM` |
| `source` | `preset` |
| `category` | `res` |
| `requires` | `[]` |
| `runtimeNote` | `task-completion-preset-evaluators.ts` |
