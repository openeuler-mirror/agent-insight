# Agent 工具调用成功率预置评估器

> 归档目标：`docs/design/build-in-evaluators/agent-tool-success-rate-evaluator.md`
> 更新时间：2026-08-29

## 1. 定位与前置条件

`preset-agent-tool-success-rate` 是轨迹类预置评估器，用于评估 Agent 在执行过程中工具调用的成功率。评估器接收（Agent 运行轨迹, 工具调用步骤, 错误码信息）作为输入，输出 0~100 的综合评分和详细的文本解释。

评估器**不依赖 Tool/Skill 目录**——它只统计 Agent 实际调用了什么、成功还是失败，不关心环境里还有什么能力可用。

## 2. 输入与事实锚定

评估器从 `Session.interactions` 中通过 `extractToolTraceFacts` 提取调用事实：

- `name`：工具名称
- `status`：调用状态（`completed` / `error`）
- `args`：工具调用参数
- `result`：工具返回值
- `error_code`：失败时的错误码（如 `401 Unauthorized`、`network_timeout`、`file_not_found`）
- `error_message`：失败时的错误消息

除调用事实外，Judge prompt 还传入**用户任务**（`caseInput`）与 **Agent 最终结果**（`actualOutput`），
让「错误模式」与「失败影响」判断有事实锚点而非凭空猜测。

失败消耗由代码确定性计量、不依赖 LLM 估算，且 **Token 与耗时口径分离**：

- `failedTurnTokens`：失败调用**所在回合**的 Token（回合级近似——`usage.total` 属于生成该回合
  的 LLM 消费，含工具调用前的思考，无法精确归因到单个失败工具，故明示为「回合」而非「工具」）。
- `failedToolDurationMs`：失败工具调用**自身**耗时（用工具 `timing.started_at/completed_at` 精确累加）。

两者不再统称「失败工具浪费」，避免把回合级 Token 误读成失败工具的真实成本。

`evaluatorContext`（Tool 目录）为可选输入，提供时用于在 prompt 中展示可用能力清单，缺失时不影响评估。

### 状态四分类与成功率分母

调用状态不再用「非失败即成功」的二分，而是四类：

- **明确成功**：`success` / `succeeded` / `ok` / `done` / `completed` / `complete`
- **明确失败**：`fail*` / `error` / `cancel*` / `timeout`（沿用 `isFailedCallStatus`）
- **未结束**：`pending` / `running` / `in_progress` / `started` / `queued` / `executing`——有状态值但未达终态
- **未知**：`null` / 缺失 / 未识别值——完全无法判定

成功率 = 成功数 / (成功数 + 失败数)，**未结束与未知状态均排除出分母**，
避免跨框架状态缺失或未收尾的 Trace 被系统性高估。

### 无分（不适用）分支

- 无工具调用：返回**无分**（`score` 缺省），`summary` 说明不适用，不进实验均分；
- 全部调用状态未知：同样返回**无分**，`summary` 说明无法判定成功率。

两者均不返回 `100` 分——完全没有工具调用或状态不可判定不应因「工具成功率」得到满分。

### 失败判定边界（防幻觉）

Prompt 明确区分「工具调用失败」与「工具返回了失败信息」：

- 工具是否失败**只看轨迹里的状态标签**——标「失败」才算失败，标「成功」一律算成功；
- 工具成功执行后返回值里带有错误码/超时提示/异常信息（如 curl 返回 3 秒超时、接口返回 401），
  **不算工具调用失败**——工具本身成功运行并拿到了结果，只是结果在报告坏消息；
- 严禁仅凭「返回内容出现错误/超时字样」把该工具判为失败。

这条边界针对真实触发的幻觉：任务里「访问一个会超时的地址」是预期行为，Agent 如实报告超时
并改用备用地址，属于成功执行，却被 Judge 误判成 bash 调用失败。

### 交叉校验

Judge 返回的 `error_patterns` 会与真实轨迹做交叉校验：

- `tool_name` 必须来自真实调用轨迹中的工具名，否则判为幻觉、抛输出契约错误；
- 每条 `count` 不得超过该工具的真实失败次数，否则同样判为契约错误。

宁可重评，也不用幻觉结论打分。契约错误的 `errorMessage` 面向用户措辞（「评测模型把工具 X 误判为失败…已拦截本次结论，请重评」），
不再暴露「judge / error_patterns / count」这类内部术语。

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

只放一句话结论（与 `summary` 同文案），避免与评分点证据重复展示。
`isEvidenceRedundant` 会判重隐藏卡级证据，展开区只显示四张评分点的明细。

详细数据放在对应评分点的 `evidence.md`：

- 整体成功率：`score` = 成功率%，`evidence` 包含 `${successfulCalls}/${decisiveCalls} 成功` + 未结束/未知次数
- 按工具聚合失败率：每工具的失败率表（🔴/🟡/🟢 前缀标识）
- 错误模式分析：错误码聚合 + 模式描述；无错误时显示「本次执行未识别出错误模式信息」
- 失败影响评估：关键路径失败 / 重试恢复 / 失败所在回合 Token / 失败工具耗时 / 影响判定

> 旧实现曾把以上明细再写一遍到 `reason`，又同时塞 `evidence.json`，但 `EvidenceSchema` 是 `{md}` 或 `{json}` 二选一，`coerceEvidence` md 优先导致 json 字段实际被丢弃。改为单行 reason + 评分点证据后，证据完整且不重复。

## 8. 注册信息

| 字段 | 值 |
|---|---|
| `id` | `preset-agent-tool-success-rate` |
| `evaluatorType` | `LLM` |
| `source` | `preset` |
| `category` | `traj` |
| `requires` | `[]`（不依赖 Tool 目录） |
| `runtimeNote` | `agent-tool-success-rate-evaluator.ts` |
