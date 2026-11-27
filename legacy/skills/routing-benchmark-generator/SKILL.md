---
name: routing-benchmark-generator
description: 当需要针对某个具体 skill 自动生成路由命中测试集时使用。负责从目标 skill 定义中生成应命中该 skill 的 query、语义意图和语义锚点，不负责结果质量评测。
---

# Routing Benchmark Generator

这是一个面向 `routing evaluation` 的专用生成 skill。
它通常作为 `skill-benchmark-generator` 的内部组成部分出现，用于补齐整套 benchmark 中的 routing 部分。

## 何时使用

当你需要为某个具体 skill 自动生成“应该命中这个 skill”的路由测试集时使用，典型场景包括：

- 新 skill 刚导入，需要快速补齐 routing benchmark
- 某个 skill 的 routing hit rate 数据不足
- 需要为 skill optimizer 提供更系统的路由命中样本

## 输入

至少具备以下输入：

- 目标 skill 名称
- 目标 skill 版本
- 目标版本的 `SKILL.md`
- 可选：skill 描述、change log、辅助文件摘要、已有 routing queries

## 输出

输出为 routing dataset item 列表。每条数据必须包含：

- `query`
- `expectedSkills`
- `routingIntent`
- `routingAnchors`

## 核心约束

- 路由标准答案只回答“应该命中哪个 skill”，不要混入 outcome 层的完成质量判断
- 生成的是 query，不是执行报告，不是标准答案，不是优化建议
- 每条 query 都必须真实落在目标 skill 的职责边界内
- 不要通过简单改写重复生成同一语义
- 不要发明 skill 定义之外的能力

## 工作流程

1. 读取目标 skill 的 `SKILL.md`，提取它真正负责的任务边界
2. 识别该 skill 的能力面，而不是抄写原文
3. 生成一组语义上有区分度的用户 query，覆盖不同职责切面
4. 为每条 query 绑定目标 `expectedSkills`
5. 再从 query 提取 `routingIntent` 与 `routingAnchors`
6. 检查与现有 routing 数据是否重复后再入库

## 验收标准

- 看 routing dataset 时，能明确回答“这个 query 是否应该命中该 skill”
- 不依赖完整 prompt 逐字匹配
- 不混入结果对错、标准答案、关键动作等 outcome 信息
