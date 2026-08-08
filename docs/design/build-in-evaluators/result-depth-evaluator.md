# 回答深度性预置评估器

> 归档目标：`docs/design/build-in-evaluators/result-depth-evaluator.md`
> 关联需求：openEuler Issue #163
> 更新时间：2026-08-04

## 1. 定位与边界

`preset-depth-result` 是结果类预置评估器，用于判断最终回答是否达到了题目所需的分析深度。它只评价解释、推理和洞察的充分程度，不评价事实是否正确，也不评价 Agent 是否正确使用工具；后两类问题由结果质量和轨迹类评估器负责。

任务表中的深度场景只是基础验证集，不是生产规则。生产 Prompt 不包含固定题目、编号或验收区间，也不按某个输入做特判。

## 2. 输入与输出

评估器读取：

- `caseInput`：用户问题及表达约束，必须传入。问题决定每个维度所需的深度；例如“只用一句话回答”不能按开放分析题要求。
- `actualOutput`：Agent 的最终回答。

不要求参考答案或 Tool/Skill 目录。空回答仍是可评估结果，应在相应维度保留 0 分，而不是改成 N/A。

Judge 返回固定顺序的五个维度：

```json
{
  "dimensions": [
    {
      "dimension": "causal_depth",
      "requiredDepth": "light",
      "requiredDepthReason": "题目是简单事实问答，只需直接说明结论。",
      "verdict": "met",
      "reason": "回答直接给出结论，满足题目要求。",
      "suggestion": ""
    }
  ],
  "summary": "回答满足题目所需的分析深度。"
}
```

`verdict` 只允许 `met`、`partial`、`missing`；Judge 不输出总分、权重或连续分数。`summary` 是卡片顶部的一句话总结，`reason` 是评分点证据，`suggestion` 只在未完全满足时填写。

## 3. 评价维度与判定

| 维度 | 权重 | 判定重点 |
|---|---:|---|
| `causal_depth` | 25% | 是否解释原因层次、因果链、根因和反馈，而非只列表面现象 |
| `structured_reasoning` | 25% | 推理是否有组织，论据是否支撑结论，诊断是否经过必要中间步骤 |
| `multi_perspective_tradeoff` | 20% | 是否覆盖相关视角、条件、利弊和局限；不要求每题都强行列优缺点 |
| `context_provision` | 15% | 是否补足理解结论所需的背景、概念、来源或适用范围 |
| `insight_synthesis` | 15% | 是否从事实归纳模式、趋势、联系或可执行洞察 |

Judge 对每个维度先判断所需深度：

- `none`：该问题或用户约束不需要这一维度。代码将其作为 N/A 排除分母，并将展示状态规范为 `met`，避免“无需评价”和“评价为缺失”混淆。
- `light`：直接解释或少量组织即可满足。
- `full`：题目要求诊断、比较、选型、开放分析或策略权衡，需要完整展开。

然后再判断实际回答：

- `met`：达到所需深度，映射 100 分；
- `partial`：有相关内容但链路或覆盖不完整，映射 50 分；
- `missing`：没有可核验内容，映射 0 分。

篇幅、标题、编号和术语数量不能单独证明深度。简单事实题或明确要求简短时，满足 `light` 即可满分。

## 4. 确定性聚合

设五个维度的基础分为 `s_i ∈ {0, 50, 100}`，原始权重为 `w_i`。对 `requiredDepth=none` 的维度不计入有效集合 `A`：

```text
score = round( Σ(i∈A) w_i × s_i / Σ(i∈A) w_i )
```

如果全部维度都是 `none`，返回“不适用”而不伪造分数。其余情况下总分始终为平台统一的 0–100 整数；0 分必须保留。

代码负责校验维度枚举、补齐 Judge 漏掉的维度为 `missing`、映射分数和聚合。模型只负责离散判定和证据，不得自由改权重。

## 5. 结果证据与界面契约

卡级 evidence 保存：

- `rubricVersion: "1.0.0"`；
- 五维的 `requiredDepth`、`verdict`、分数、`requiredDepthReason` 和 `reason`；
- 未达标维度的改进建议；
- 由 `summary` 生成的一句话卡片摘要。

评分点映射为项目通用的 `covered`、`partial`、`missing` 状态，展开后展示人类可读的“判断—依据—建议”，不直接把原始 JSON 倾倒到页面。

## 6. 实现位置与测试边界

- Judge Prompt：`src/prompts/result-depth-prompt.ts`
- 评估器与聚合：`src/lib/engine/experiment/depth-preset-evaluators.ts`
- 通用结果契约：`src/lib/engine/experiment/specialized-evaluator-common.ts`
- 评估器注册与卡片元数据：`src/lib/evaluators/registry.ts`、`src/lib/evaluators/preset-evaluators.ts`
- 单元测试：`test/depth-preset-evaluators.test.ts`、`test/eval-output-contract.test.ts`

测试覆盖权重聚合、`none/light/full` 判定、0 分保留、Judge 漏维度和全部 N/A。测试输入验证通用 rubric，不把 12 条示例题硬编码到生产逻辑。

## 7. 兼容与非目标

评估器不修改现有 `preset-agent-trace-quality` 的 prompt、版本或分数；历史 Trace 没有新增上下文也能继续运行结果类评估。自动获取模型网关工具清单、事实核验和参考答案匹配不属于本卡范围。
