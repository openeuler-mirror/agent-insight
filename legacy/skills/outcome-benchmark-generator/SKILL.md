---
name: outcome-benchmark-generator
description: 当需要针对某个具体 skill 自动生成效果评测测试集时使用。负责从目标 skill 定义生成标准答案、关键观点和关键动作，不负责路由命中样本生成。
---

# Outcome Benchmark Generator

这是一个面向 `outcome evaluation` 的专用生成 skill。
它通常作为 `skill-benchmark-generator` 的内部组成部分出现，用于补齐整套 benchmark 中的 outcome 部分。

## 何时使用

当你需要为某个具体 skill 自动生成“成功执行后应该产出什么”的效果评测数据时使用，典型场景包括：

- 某个 skill 没有 outcome benchmark
- 需要为准确率和执行效果提供标准答案
- 需要补齐 `root_causes` 与 `key_actions`

## 输入

至少具备以下输入：

- 目标 skill 名称
- 目标 skill 版本
- 目标版本的 `SKILL.md`
- 可选：skill 描述、change log、辅助文件摘要

## 输出

输出为一个 skill-bound outcome dataset item，包含：

- `skill`
- `skillVersion`
- `standardAnswer`
- `rootCauses`
- `keyActions`
- 可选：`sourceScenario`

## 核心约束

- outcome 标准答案评测的是“这个 skill 执行成功后应交付什么”
- 不要把 routing 是否命中混进 outcome 层
- `standardAnswer` 必须足够具体，后续才能稳定抽出 `rootCauses` 和 `keyActions`
- `sourceScenario` 只是来源场景，不是 outcome 的主键
- 不要生成 skill 定义之外的交付物

## 工作流程

1. 读取目标 skill 的 `SKILL.md`，识别它负责的最终交付物
2. 生成一个代表性成功场景或来源场景
3. 为该场景生成可复核的 `standardAnswer`
4. 再从 `standardAnswer` 抽取 `rootCauses`
5. 从同一份 `standardAnswer` 抽取 `keyActions`
6. 绑定到目标 skill 与目标版本，形成 outcome dataset

## 验收标准

- 看 outcome dataset 时，能明确回答“这个 skill 成功执行后应该产出什么”
- `rootCauses` 表达回答中必须出现的关键信息
- `keyActions` 表达执行中必须发生的关键动作
- 不依赖 query 场景逐字匹配
