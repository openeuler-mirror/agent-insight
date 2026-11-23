# 创造性评估器（preset-creativity-expression，独立成族）— 设计文档

> 阶段：Phase2 需求设计 ｜ 状态：✅ 已实现 ｜ 关联 issue：[#160](https://gitcode.com/openeuler/opensource-intern/issues/160)

## 1. 目标

评估 Agent 生成文本的创造性水平，输出 0-100 创造性评分。

## 2. 评估维度（5 维，每维 1-3 三档锚定）

| 维度 key | 中文标签 | 1 分典型表现 |
|---|---|---|
| `novelty` | 新颖性 | 完全来自常见模板或套话 |
| `perspective_uniqueness` | 视角独特性 | 仅从最显而易见的角度切入 |
| `non_template_expression` | 表达非模板化 | 高频固定句式，结构模板化 |
| `idea_diversity` | 构思差异度 | 全文围绕单一观点反复展开 |
| `rhetoric_quality` | 文采与修辞 | 语言平铺直叙、缺乏节奏感 |

## 3. 评分公式（三档锚定）

**单维度分**：`dimScore = (rating − 1) / 2 × 100`

| rating | 维度分 | status |
|---|---|---|
| 1 模板化 | 0 | missing |
| 2 一般 | 50 | partial |
| 3 有创意 | 100 | covered |

**总分**：`overallScore = (Σrating − 5) / 10 × 100`，等价于各维度分等权均值。

## 4. 方法论

- LLM 对每个维度给出 1-3 rating + comment
- 代码按固定线性映射汇总
- 错误处理：缺维度、rating 越界/缺失/非法、comment 空 → 抛 `ContentPresetParseError`，不兜底

## 5. 边界规则

- 重复常见名言作为核心创意 → 新颖性偏低

## 6. 注册信息

| 字段 | 值 |
|---|---|
| id | `preset-creativity-expression` |
| category | `res` |
| requires | `[]` |
| 关联文件 | `src/lib/engine/experiment/creativity-preset-evaluators.ts` |
| 分发入口 | `evaluateOnce()` `isCreativityPresetId` |
| CI 守卫 | `PRESET_RUNNERS` |

## 7. 测试覆盖

`test/creativity-preset-evaluators.test.ts` 12 条测试，judge 边界注入，破坏验证可执行。
