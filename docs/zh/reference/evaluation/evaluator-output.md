---
title: "评估器运行与输出契约"
description: "输出字段、归一化、人工修正及运行状态的边界。"
---

本页适用于平台内置和自建评估器的单次结果。设计可信评分方法及工程接入见[评估器开发指南](../../how-to/evaluation/develop-evaluator.md)。

## 输出字段

定义在 `src/lib/evaluators/eval-output.ts`，五个字段**全可选**、任意组合合法：

```ts
EvaluatorOutput = {
  verdict?: 'pass' | 'warn' | 'fail'  // 结论判定 → 卡头 chip（达成/部分达成/未达成）
  summary?: string        // 一句话结论，≤200 字（提示词里要求 ≤80）→ 卡头正文
  score?: number          // 0-100，卡片总分。纯定性评估器可省
  points?: EvalPoint[]    // 评分点（最多 64）
  evidence?: {md} | {json} // 卡级证据
}

EvalPoint = {
  label: string           // 必填，≤120 字
  score?: number          // 0-100，该点得分
  status?: 'covered' | 'partial' | 'missing'  // 状态 chip
  evidence?: {md} | {json}
  skillAttributable?: boolean  // 可归因 skill → skill 优化闭环据此挑 finding
  suggestion?: string
  anchors?: string[]      // 'step-N'，可跳链路观测
}
```

`anchors` 最多 32 项，`evidence` 为 `{ md: 非空字符串 }` 或 `{ json: 任意 JSON 值 }`；`status` 仅使用 `covered/partial/missing`。

**`verdict` / `summary` 是呈现层的主信息，请务必上报。** Trace 评测详情是**两级折叠**：

```
卡片（默认）    结论 chip + 一句话结论 + 得分
  └ 展开卡片    完整判断依据（与结论重复则不渲染）+ 人工修正 + 评论
       └ 再展开  评分点明细表
```

也就是说，**大多数使用者只会看到 `summary` 那一句**。评分点写得再细，不点两次展不开。
不给结论，卡片就只剩一个孤零零的数字。

- `summary` 的要求是**说人话、讲具体问题**，让人看完不用再翻明细就知道发生了什么：
  不要用"覆盖率/维度/评分点/整体完成度偏低"这类评测术语，不要罗列各维度，只讲最要命的
  那一条，讲具体的东西（少了哪个数、答错成什么、漏了哪一步），≤80 字。
  反例：「关键观点覆盖率偏低，多个维度未达标。」正例：「攻击类型判对了，但没给出来源 IP，
  也漏了 root 爆破次数，运维拿着没法直接处置。」各预置评估器的提示词里都写了这条约束，
  新写评估器时照抄。
- `verdict` 不填时呈现层按 `deriveVerdict(score)` 派生（≥80 pass / ≥60 warn / 其余 fail）。
  派生值**不落库**，所以调整阈值口径不需要重刷历史数据。有比分数更准的达成判定时（例如
  任务完成度评估器的 `isCorrect`）应显式上报，别让它退化成分数分档。
- `summary` 不填时呈现层回退到 `evidence.md` 的首段（`displaySummary()`）——这是给存量数据
  留的兼容路径，新评估器别依赖它。
- 若 `evidence.md` 与 `summary` 逐字相同，展开区不再重复渲染证据（`isEvidenceRedundant()`）。
  想让展开后有额外信息可看，`evidence` 就要比 `summary` 多写点东西，而不是把同一句复制两遍。

> 已有评估器的结论字段来源：任务完成度 = `reason`（同时写进 `Execution.judgmentReason`）；
> 轨迹质量 = 专设的 `conclusion` 字段，**不是** `reason_text` —— 后者是「执行路径分析」绿框的
> 正文，有固定的完整性/工具选择/冗余分段结构，当结论读着费劲，故两者分开、取不到才回落。

**归一化 `normalizeEvaluatorOutput()` 的行为**（务必知道，否则会被"吞字段"坑到）：

- `score` 越界 clamp 到 [0,100]；非数值丢弃。
- **0-1 量纲自动放大**：`score ∈ (0,1]` 时 ×100，因此历史评估器输出 `0.85` 与 `1` 会分别归一化为 85 分与 100 分。
- `verdict` 容忍英文别名与中文说法（`passed`/`达成`/`partial`/`未通过`…），**未识别的值直接丢弃**而不报错。
- `summary` 压平换行并截断到 200 字（超出补 `…`）。
- 非法评分点逐条丢弃，不会让整次评估失败。

> **人工修正分不属于本输出契约。** 用户可以在详情页把某一行的分改掉，写的是平台侧的
> `ExperimentEvalResult.humanScore`（连同必填的 `humanReason`），机器分 `score` 原样只读留存，
> 聚合按**生效分 = `humanScore ?? score`** 算（`detail-agg.ts` 的 `effectiveScore`）。
> 评估器只管上报自己的判断，不需要、也不应该感知人工意见——两者的差值正是校准评估器的依据。
> 注意重评会清除该行的人工修正（`run-experiment.ts` 的 `RESET_RESULT_FIELDS`）。


## 运行参数与结果状态

运行配置与输出是两份契约：`attemptTimeoutSeconds` 控制单次评估尝试，`maxRetries` 为额外重试次数，不是总尝试次数。客户端提交的配置由 `evaluator-execution-config.ts` 校验；不能用模型连接测试超时替代。平台预设、统一覆盖与逐评估器覆盖的解析见该模块及[实验操作指南](../../how-to/evaluation/experiments.md)。

| 运行字段 | 校验与含义 |
| --- | --- |
| `attemptTimeoutSeconds` | 30～3600 的整数，单次尝试时限 |
| `maxRetries` | 0～3 的整数，额外重试次数 |
| `mode` | `system` 或 `uniform`，另可提供逐评估器 `overrides` |
| 统一配置初始值 | 600 秒、2 次重试；不代表每个系统预设都使用相同值 |

结果状态由平台记录，例如 `pending/running/done/failed/cancelled`。`status: failed` 表示没有完成有效评估，`verdict: fail` 则可以是一次成功执行后的未达标结论。超时、重试耗尽和取消不通过输出字段伪装成正常分数。

`evaluatorId` 与注册元数据决定历史结果归属；更换名称或类目应按开发指南评估迁移，不能靠每次结果上报修改。独立 Benchmark 的派发、原始结果和 Adapter 归一化见[独立评测协议](./benchmark-protocol.md)。

## 人工修正接口

`PATCH /api/experiments/:id/results/:resultId` 接受 `{ humanScore, humanReason }`。`humanScore` 为 0～100 的数，保存到一位小数；设置分数必须填写理由，理由去空白后最多保留 1000 字符。`humanScore: null` 撤销修正。仅 `status: done` 的结果行可修正；未完成为 `409`，目标不存在或归属不符为 `404`，参数或身份缺失为 `400`。成功返回该行更新后的机器分、人工分与修正信息，机器分不会被改写。

## 实现依据

- [输出 Schema 与归一化](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/evaluators/eval-output.ts)
- [运行配置](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/evaluators/evaluator-execution-config.ts)
- [结果聚合](https://gitcode.com/openeuler/agent-insight/blob/master/src/lib/engine/experiment/detail-agg.ts)

[English](../../../en/reference/evaluation/evaluator-output.md)
