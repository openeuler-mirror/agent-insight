# 任务完成度（无标准答案）预置评估器

> 归档目标：`docs/design/build-in-evaluators/task-completion-no-ref-evaluator.md`
> 更新时间：2026-08-11

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

## 3. 评分公式

### 显式需求完成度（权重 0.5）

```
如果所有显式需求均 not_covered → 0
否则：100 - not_covered × 20 - partial × 10（最低 0）
```

即每遗漏一条扣 20，部分覆盖扣 10。全部未覆盖直接归零。

### 隐含约束满足度（权重 0.3）

逐条扣分，低置信度减半：

```
not_covered + high/medium confidence → 扣 20
not_covered + low confidence → 扣 10（减半）
partially_covered → 扣 10
最低 0
```

### 信息充分性与中立性（权重 0.2）

LLM 给出 0-100 分数，直接使用。

### 加权总分

```
总分 = 显式 × 0.5 + 隐含 × 0.3 + 信息充分性 × 0.2
```

## 4. 评分点设计

三个固定维度对应三个评分点：

- **显式需求完成度**（含 `business_must_have`，标签内区分）：evidence 展示需求清单及逐条判定
- **隐含约束满足度**（始终展示，无隐含约束时显示提示）：evidence 同上
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
- **reason**：Markdown 格式详细文本，包含需求推断清单、逐条判定结果（含置信度标记）和综合评分说明

## 7. 注册信息

| 字段 | 值 |
|---|---|
| `id` | `preset-task-completion-no-ref` |
| `evaluatorType` | `LLM` |
| `source` | `preset` |
| `category` | `res` |
| `requires` | `[]` |
| `runtimeNote` | `task-completion-preset-evaluators.ts` |
