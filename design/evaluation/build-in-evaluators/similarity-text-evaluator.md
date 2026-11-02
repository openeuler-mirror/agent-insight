# 文本相似度评估器

评估器 ID `preset-similarity-text`，执行入口 `runTextSimilarity`，源码 `similarity-text-evaluator.ts`。

## 目标与输入

从语义层面判断 Agent 生成文本与参考文本是否表达相同含义，覆盖同义改写、语序变换、细节增减等不影响核心含义的差异。评分对象是 `actualOutput`（生成文本），对照 `referenceOutput`（参考文本）；`caseInput` 不参与。判据明确要求只有词汇重叠而核心语义不同不得判为相似（如「苹果很好吃」与「苹果手机很好用」），本评估器判「是否同义」，不判事实正确性。

两个文本都必须非空：任一为空时在调用 Judge 前返回不计分结果——只展示原因，不进综合分与类目均分，不产生 0 分。

## 判定与输出

Judge 只输出 `{level, reason}` 一个 JSON 对象，`level` 限定五档，`reason` 为引用关键差异点的中文说明；代码把 `level` 映射为固定分，不采信模型给出的分数。模型调用沿用实验 Judge 直连传输（`temperature=0`、`seed=42`），同一文本的分数波动只可能来自档位判定本身。

| level | 含义 | score | 评分点 status |
|---|---|---:|---|
| `semantically_same` | 完全同义 | 100 | covered |
| `mostly_similar` | 高度相似（同义改写 / 语序变化 / 细节微调） | 85 | covered |
| `partially_similar` | 部分相似 | 65 | covered |
| `slightly_similar` | 略微相似 | 30 | partial |
| `not_similar` | 完全不同 | 0 | missing |

卡片输出 `score`、`summary`、一个卡级 `evidence` 和两个评分点：语义相似度（label 带档位名，score 为档位分，status 按上表）与阈值判定。卡级证据写明档位、分值与阈值判定结论。模型自创档位、JSON 解析失败时抛 `SimilarityJudgeParseError`（继承 `JudgeOutputParseError`，属可重试行级失败），不静默压到某一档。JSON 允许被 Markdown 围栏包裹。

## 阈值判定与运行配置

合格阈值由实验级运行配置 `SimilarityTextRunConfig` 提供，与「完全精确匹配 / 实体 F1」共用同一套运行配置契约、校验与持久化（见 [text-evaluator-run-config](../text-evaluator-run-config/)）；创建实验时在文本评估器配置对话框设置，默认 80，取 0–100 的整数（小数四舍五入），非法值在配置校验阶段抛错，不静默回退。

阈值只影响 `verdict` 与阈值判定评分点，不改变 `score`：

```text
passed   = score >= threshold
verdict  = passed ? 'pass' : 'fail'
阈值评分点 = passed ? 100/covered : 0/missing     # 证据写明 相似度 ≥/< 阈值，偏差 score-threshold
```

summary 同步说明档位、相似度、阈值与偏差方向。因此 `mostly_similar`（85）在默认 80 下 PASS、阈值调到 90 时 FAIL，差异来自实验配置而非模型判断。

## 边界与测试

空生成文本 / 空参考文本均不记分且不调 Judge；未达阈值只是 fail 判定，不是评估失败。专项测试在 judge 边界注入固定档位，覆盖五档映射与 status、阈值默认与可配置（60 使 65 分档 PASS、90 使 85 分档 FAIL）、阈值取值校验、空文本短路、未知档位报错与围栏 JSON 解析等契约。
