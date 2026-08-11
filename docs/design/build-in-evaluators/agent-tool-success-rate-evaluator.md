# Agent 工具调用成功率预置评估器

> 归档目标：`docs/design/build-in-evaluators/agent-tool-success-rate-evaluator.md`
> 更新时间：2026-08-11

## 1. 定位与前置条件

`preset-agent-tool-success-rate` 是轨迹类预置评估器，用于评估 Agent 在执行过程中工具调用的成功率。评估器接收（Agent 运行轨迹, 工具调用步骤, 错误码信息）作为输入，输出 0~100 的综合评分和详细的文本解释。

评估器**不依赖 Tool/Skill 目录**——它只统计 Agent 实际调用了什么、成功还是失败，不关心环境里还有什么能力可用。

## 2. 输入与事实锚定

评估器从 `Session.interactions` 中通过 `extractToolTraceFacts` 提取调用事实：

- `name`：工具名称
- `status`：调用状态（`completed` / `error`）
- `error_code`：失败时的错误码（如 `401 Unauthorized`、`network_timeout`、`file_not_found`）

`evaluatorContext`（Tool 目录）为可选输入，提供时用于在 prompt 中展示可用能力清单，缺失时不影响评估。

## 3. 四个评分维度

评估器从四个维度全面分析，代码做确定性统计，LLM 只做离散判断：

| 维度 | 判定方式 | 计分参与 |
|---|---|---|
| 整体成功率 | 代码统计：成功数/总调用数 × 100% | ✅ 计入总分 |
| 按工具聚合失败率 | 代码统计：每个工具的失败率 | 评分点展示，不重复扣分 |
| 错误模式分析 | LLM 离散判断：按错误码聚合模式 | 评分点展示，重复错误在总分中扣分 |
| 失败影响评估 | LLM 离散判断：severe/moderate/minor/none | ✅ 计入总分 |

## 4. 评分公式

```
base = max(50, 100 - (100 - 成功率) / 10 × 10)   // 整体成功率每降 10% 扣 10，最低 50

关键路径失败扣分：
  severe   → -30
  moderate → -20
  minor    → -10

重复错误扣分：
  同一错误码 ≥3 次 → -10（与 severe 关键路径失败互斥，避免双重扣分）

最终 = max(0, base - 关键路径扣分 - 重复错误扣分)
```

## 5. 评分点设计

四个维度对应四个评分点，每个都有 `label` + `evidence`：

- **整体成功率**：`score` = 成功率%，`status` 按阈值（≥80 covered / ≥60 partial / <60 missing）
- **按工具聚合失败率**：`score` 取最高失败率工具判定（>50% → 50 / >20% → 70 / ≤20% → 100），`status` 同上
- **错误模式分析**：`score` 按有无重复错误（无 → 100 / 有重复 → 50 / 有错误 → 70），`status` 同上
- **失败影响评估**：`score` 按影响判定（none → 100 / minor → 80 / moderate → 50 / severe → 20），`status` 同上

## 6. verdict 判定

```
score ≥ 80 → pass
60 ≤ score < 80 → warn
score < 60 → fail
```

## 7. reason 字段

输出 Markdown 格式的详细文本，包含四部分：

- 整体成功率统计
- 各工具成功率表格
- 错误模式聚合列表
- 失败影响分析

## 8. 注册信息

| 字段 | 值 |
|---|---|
| `id` | `preset-agent-tool-success-rate` |
| `evaluatorType` | `LLM` |
| `source` | `preset` |
| `category` | `traj` |
| `requires` | `[]`（不依赖 Tool 目录） |
| `runtimeNote` | `agent-tool-success-rate-evaluator.ts` |
