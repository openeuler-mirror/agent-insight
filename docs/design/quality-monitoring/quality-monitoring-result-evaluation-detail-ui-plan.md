# 质量监控结果评测详情展示方案

本文补充 `quality-monitoring-result-evaluation-plan.md` 的前端展示方案，聚焦质量监控页中单条 trace 的结果评测摘要、状态展示和评测详情表格。

## 1. 目标

结果维的四个指标必须清晰区分“评测中”“评测失败”“不适用”和“已完成”。前端不得把未完成评测显示为 `N/A`，避免用户误以为评测已经结束但没有结果。

四个结果指标的“评测详情”必须直接对应后端保存的结构化 `evidenceJson`，字段来源与新版 LLM 调用输出保持一致，不再按前端主观理解随意拼表。

## 2. 列表状态展示

质量监控结果维每个指标都应优先读取单条 trace 的 `TraceEvaluation.status`，再决定展示文案和详情入口。

| 后端状态 | 列表展示 | 得分展示 | 详情入口 |
|-|-|-|-|
| `pending` | 评测中 | 不显示 `N/A` | 禁用，文案为“评测中” |
| `running` | 评测中 | 不显示 `N/A` | 禁用，文案为“评测中” |
| `failed` | 评测失败 | 不显示 `N/A` | 可点击，展示失败阶段和已完成调用 |
| `done` 且 `score != null` | 已完成 | 显示分数 | 可点击，展示结构化详情 |
| `done` 且 `score == null` | 不适用 | 显示“不适用”及 `note` 或 `evidence.reason` | 可点击，展示 N/A 原因和已有 evidence |
| 无评测行 | 未评测 | 不显示 `N/A` | 不显示详情入口 |

指令遵循是例外：如果 `score=null` 且 `constraints=[]`、`verdicts=[]`，说明该 trace 没有明确输出约束，列表直接展示“不适用：本任务没有明确的输出约束”，不展示评测详情按钮，也不渲染空表。

答案质量已完成时，列表一行展示：

```text
ses_xxx  总分 82  相关性 100  完整性 60  连贯性 75  [评测详情]
```

答案质量评测中时，列表展示：

```text
ses_xxx  评测中
```

指令遵循已完成且有分数时，列表一行展示：

```text
ses_xxx  得分 100  约束 2/2 满足  [评测详情]
```

指令遵循不适用时，列表展示：

```text
ses_xxx  不适用：本任务没有明确的输出约束
```

忠实度已完成且有分数时，列表一行展示 trace 得分、现有原因总结和详情入口；现有总结不删除：

```text
ses_xxx  得分 75  14 条可验证主张中 8 条有工具证据支持，3 条与证据矛盾，3 条证据未覆盖。  [评测详情]
```

准确性已完成且有分数时，列表一行展示 trace 得分、现有原因总结和详情入口；现有总结不删除：

```text
ses_xxx  得分 35.7  实际输出对攻击类型、root账户目标、用户名枚举的描述大体正确，但时间范围缺失、攻击来源列表错误。  [评测详情]
```

## 3. 指令遵循详情

指令遵循对应两个 LLM 调用：

| 阶段 | stage | 输入 | 输出 |
|-|-|-|-|
| 输出约束提取 | `constraint-extraction` | `user_query + relevant_system_instructions` | `constraints[] + confidence` |
| 输出约束裁决 | `constraint-verdict` | `constraints + actual_output` | `verdicts[] + confidence` |

详情列表只展示一张“约束裁决表”。`constraints[]` 只作为 `constraintId` 的反查数据，不单独展示“约束提取表”，避免用户看到两张含义接近的表。

### 3.1 约束裁决表

该表对应 `evidence.verdicts[]`，并通过 `constraintId` 关联 `constraints[].id`。

| 表格字段 | 对应 LLM 输出字段 | 展示说明 |
|-|-|-|
| 约束ID | `verdicts[].constraintId` | 与 `constraints[].id` 关联 |
| 约束内容 | `constraints[].text` | 通过 `constraintId` 反查 |
| 裁决结果 | `verdicts[].status` | `met`=满足，`not_met`=未满足，`not_applicable`=不适用 |
| 裁决原因 | `verdicts[].reason` | LLM 输出原因 |

### 3.2 不适用展示

当 `score=null` 且 `constraints=[]`、`verdicts=[]` 时，不展示评测详情入口，也不展示空表。trace 行直接展示：

```text
ses_xxx  不适用：本任务没有明确的输出约束
```

字段来源：

| 展示字段 | 对应字段 |
|-|-|
| 不适用原因 | `evidence.reason` 或 `note` |

## 4. 答案质量详情

答案质量对应五个 LLM 调用和一个代码聚合步骤：

| 阶段 | stage | 输入 | 输出 |
|-|-|-|-|
| A. 答案陈述提取 | `statement-extraction` | `actual_output` | `statements[] + confidence` |
| B. 用户要点提取 | `requirement-extraction` | `user_query` | `requirements[] + confidence` |
| C. 相关性裁决 | `relevance-verdict` | `user_query + statements` | `verdicts[] + noncommittal + confidence` |
| D. 完整性裁决 | `completeness-verdict` | `requirements + actual_output` | `verdicts[] + confidence` |
| E. 连贯性评分 | `coherence-rubric` | `user_query + actual_output` | `rating + checks + reason + confidence` |
| F. 代码聚合 | 无 LLM stage | C、D、E 输出 | `subScores + score + reason` |

详情展示按三个子维度组织，只保留三张表：相关性评测表、完整性评测表、连贯性评测表。`statements[]` 和 `requirements[]` 只作为裁决表的反查数据，不单独展示提取表。

### 4.1 相关性评测表

该表对应 `evidence.relevance.verdicts[]`，并通过 `statementId` 关联 `statements[].id`。

| 表格字段 | 对应 LLM 输出字段 | 展示说明 |
|-|-|-|
| 陈述ID | `verdicts[].statementId` | 与 `statements[].id` 关联 |
| 陈述内容 | `statements[].text` | 通过 `statementId` 反查 |
| 原文引用 | `statements[].sourceQuote` | 通过 `statementId` 反查 |
| 相关性判定 | `verdicts[].verdict` | `relevant`=相关，`supporting`=支撑性内容，`irrelevant`=不相关 |
| 判定原因 | `verdicts[].reason` | LLM 输出原因 |

### 4.2 完整性评测表

该表对应 `evidence.completeness.verdicts[]`，并通过 `requirementId` 关联 `requirements[].id`。

| 表格字段 | 对应 LLM 输出字段 | 展示说明 |
|-|-|-|
| 要点ID | `verdicts[].requirementId` | 与 `requirements[].id` 关联 |
| 任务要点 | `requirements[].text` | 通过 `requirementId` 反查 |
| 覆盖状态 | `verdicts[].status` | `covered`=已覆盖，`partial`=部分覆盖，`missing`=缺失 |
| 裁决原因 | `verdicts[].reason` | LLM 输出原因 |
| 结果证据 | `verdicts[].evidenceQuote` | LLM 提供的结果证据片段；`missing` 可为空，不做逐字命中硬校验 |

### 4.3 连贯性评测表

该表对应 `evidence.coherence`。

| 表格字段 | 对应 LLM 输出字段 | 展示说明 |
|-|-|-|
| 连贯性评级 | `coherence.rating` | 0 到 4 的整数 rubric 分 |
| 连贯性子分 | `evidence.subScores.coherence` | `rating * 25` |
| 主结论是否清晰 | `coherence.checks.mainConclusionClear` | 是 / 否 |
| 结构顺序是否合理 | `coherence.checks.logicalOrder` | 是 / 否 |
| 指代是否一致 | `coherence.checks.referenceConsistency` | 是 / 否 |
| 矛盾问题 | `coherence.checks.contradictions[]` | 数组为空展示“无”；非空时展示 `quote + reason` 摘要 |
| 重复问题 | `coherence.checks.repetitions[]` | 数组为空展示“无”；非空时展示 `quote + reason` 摘要 |
| 跳跃问题 | `coherence.checks.abruptTransitions[]` | 数组为空展示“无”；非空时展示 `quote + reason` 摘要 |
| 总体原因 | `coherence.reason` | LLM 输出原因 |
| 置信度 | `coherence.confidence` 或 `calls[stage=coherence-rubric].response.confidence` | LLM 输出置信度 |

## 5. 忠实度详情

忠实度详情对应 `evidence.claims[]`。列表中保留 `evidence.reason` 作为该 trace 的一句话总结；详情只展示结构化主张裁决明细。

### 5.1 主张裁决表

该表对应 `evidence.claims[]`。每行是一条从最终回答中提取出的可验证主张，以及该主张是否被工具证据支持。

| 表格字段 | 对应字段 | 展示说明 |
|-|-|-|
| 主张ID | `claims[].claimId` | 例如 `C-1` |
| 主张内容 | `claims[].claim` | 从最终回答中提取出的关键事实主张 |
| 裁决结果 | `claims[].status` | `supported`=有证据支持，`contradicted`=与证据矛盾，`not_covered`=证据未覆盖 |
| 裁决原因 | `claims[].reason` | LLM 输出原因 |
| 证据与来源 | `claims[].citations[]` | 合并展示 `contextId + evidenceQuote + toolName + toolCallId + interactionIndex`；无引用时展示“无” |

状态中文映射：

| status | 中文 |
|-|-|
| `supported` | 有证据支持 |
| `contradicted` | 与证据矛盾 |
| `not_covered` | 证据未覆盖 |

### 5.2 忠实度不适用展示

当 `score=null` 且没有可展示 claims 时，列表只展示不适用原因，不展示空表：

```text
ses_xxx  不适用：本次 trace 没有可用工具证据
```

字段来源：

| 展示字段 | 对应字段 |
|-|-|
| 不适用原因 | `evidence.reason` 或 `note` |

## 6. 准确性详情

准确性详情对应 `evidence.keyPointFindings[]` 和 `evidence.additionalErrors[]`。列表中保留 `evidence.reason` 作为该 trace 的一句话总结；详情展示“关键观点裁决表”和“额外错误表”。

### 6.1 关键观点裁决表

该表对应 `evidence.keyPointFindings[]`。每行是一条标准答案关键观点的裁决结果。

| 表格字段 | 对应字段 | 展示说明 |
|-|-|-|
| 观点ID | `keyPointFindings[].keyPointId` | 例如 `K1` |
| 标准关键观点 | `keyPointFindings[].content` | 从标准答案或关键观点缓存中得到的 GT 观点 |
| 判定结果 | `keyPointFindings[].status` | `correct`=正确，`partially_correct`=部分正确，`wrong`=错误，`not_mentioned`=未提及 |
| 裁决原因 | `keyPointFindings[].reason` | LLM 输出原因 |
| 实际答案证据 | `keyPointFindings[].actualEvidence` | LLM 提供的实际输出证据片段；`not_mentioned` 时通常为空 |

状态中文映射：

| status | 中文 |
|-|-|
| `correct` | 正确 |
| `partially_correct` | 部分正确 |
| `wrong` | 错误 |
| `not_mentioned` | 未提及 |

### 6.2 额外错误表

该表对应 `evidence.additionalErrors[]`。用于展示关键观点之外的事实错误或额外编造内容；如果数组为空，表格展示“暂无明细”。

| 表格字段 | 对应字段 | 展示说明 |
|-|-|-|
| 错误类型 | `additionalErrors[].kind` | `incorrect_fact`=事实错误，`extra_content`=额外编造/不应出现的内容 |
| 严重度 | `additionalErrors[].severity` | `low`=低，`medium`=中，`high`=高 |
| 实际答案证据 | `additionalErrors[].actual_evidence` | LLM 提供的实际输出证据片段 |
| 错误原因 | `additionalErrors[].reason` | LLM 输出原因 |

### 6.3 准确性不适用展示

当 `score=null` 且没有可评测关键观点时，列表只展示不适用原因，不展示空表：

```text
ses_xxx  不适用：实际输出没有涉及可评测关键观点
```

字段来源：

| 展示字段 | 对应字段 |
|-|-|
| 不适用原因 | `evidence.reason` 或 `note` |

## 7. 失败详情

当指标 `status=failed` 时，详情不展示空评测表，而展示调用诊断表，对应 `evidence.calls[]`。

| 表格字段 | 对应字段 | 展示说明 |
|-|-|-|
| 调用阶段 | `calls[].stage` | 中文化展示，如陈述提取、完整性裁决 |
| 调用状态 | `calls[].status` | 成功 / 失败 |
| 耗时 | `calls[].durationMs` | 单位 ms |
| 错误信息 | `calls[].error` | 失败时展示 |
| 响应摘要 | `calls[].response` | 默认折叠，不整段铺开 |

stage 中文映射：

| stage | 中文 |
|-|-|
| `constraint-extraction` | 输出约束提取 |
| `constraint-verdict` | 输出约束裁决 |
| `statement-extraction` | 答案陈述提取 |
| `requirement-extraction` | 用户要点提取 |
| `relevance-verdict` | 相关性裁决 |
| `completeness-verdict` | 完整性裁决 |
| `coherence-rubric` | 连贯性评分 |

## 8. 评测中展示

当指标 `status=pending` 或 `status=running` 时，详情区只展示：

```text
评测中，暂未生成详情。
```

不得展示空表，也不得把分数显示为 `N/A`。

## 9. 数据兼容

历史 `1.0.0` evidence 不满足新版详情表所需结构时，前端不得显示空表。应展示兼容提示：

```text
该 trace 使用旧版评测结构，暂无新版详情表。请重新评测后查看结构化详情。
```

如果旧版 evidence 中存在 `requirements[]` 或 `verdicts[]`，可以作为“旧版评测摘要”展示，但不应伪装成新版五阶段详情。

## 10. 验收点

1. `running` 和 `pending` 不再显示 `N/A`。
2. `done + score=null` 显示“不适用”及原因。
3. `failed` 显示“评测失败”，详情中能看到失败 stage 和错误。
4. 指令遵循详情只展示约束裁决表，字段来自 `constraint-verdict`，并通过 `constraintId` 反查 `constraint-extraction` 的约束内容。
5. 答案质量详情只展示相关性、完整性、连贯性三张表；相关性和完整性表通过 ID 反查提取阶段对象，不再单独展示提取表。
6. 忠实度列表展示 trace 得分、保留现有原因总结，并提供评测详情按钮；详情展示主张裁决表。
7. 准确性列表展示 trace 得分、保留现有原因总结，并提供评测详情按钮；详情展示关键观点裁决表和额外错误表。
8. 旧版 `1.0.0` evidence 不再展示空表，而是提示重新评测。
