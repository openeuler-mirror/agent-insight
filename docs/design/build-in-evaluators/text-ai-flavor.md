# 文本 AI 味检查评估器

## 目标

面向 Agent 最终输出检测模板化、机械化和空洞的表达信号，分数越高表示越接近自然人类写作。评估对象是 `actualOutput`，用户问题仅作为可选语境。

## 维度与计分

`template_opening`、`template_closing`、`mechanical_transitions`、`generic_names`、`empty_summary`、`politeness_overuse` 六个维度均返回 `safe/minor/moderate/severe`。代码固定扣分 `0/20/50/80`，总分为 `max(0, 100-所有维度扣分之和)`；评分点使用 100/75/40/0 展示。

## 边界

客服场景的适度礼貌、技术文档、自然俗语引用和短回复不因关键词自动扣分。该评估器只评风格模板信号，不评价观点新颖性（由创造性评估器负责）。
