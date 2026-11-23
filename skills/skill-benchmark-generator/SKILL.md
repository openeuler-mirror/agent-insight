---
name: skill-benchmark-generator
description: 当需要针对某个具体 skill 一次性生成 routing 和 outcome 两类测试集时使用。默认必须同时补齐这两类测试集；它负责编排 routing-benchmark-generator 与 outcome-benchmark-generator，并将结果整理成可入库的数据项。
---

# Skill Benchmark Generator

这是 benchmark generation 的总编排 skill。
对单个目标 skill，它的默认职责不是二选一，而是同时补齐：

- routing benchmark
- outcome benchmark

## 何时使用

当用户表达以下意图时使用：

- “给这个 skill 自动生成测试集”
- “补齐这个 skill 的 routing 和 outcome benchmark”
- “把 benchmark generation 沉淀成 skill”

## 依赖的子 skill

- `routing-benchmark-generator`
- `outcome-benchmark-generator`

## 输入

- 目标 skill 标识或名称
- 目标 skill 版本
- 目标版本 `SKILL.md`
- 当前已有 configs
- 可选：本次希望生成的 routing 条数

## 输出

输出一个完整的 benchmark generation 结果，至少包含：

- 新生成的 routing dataset items
- 新生成的 outcome dataset items
- 重复项跳过情况
- 当前 skill 的 routing / outcome benchmark 库存统计

## 编排原则

- 对单个目标 skill，默认必须同时生成 routing 与 outcome 两类测试集
- routing 与 outcome 必须分开生成，不能混成一个 combined 语义
- routing 只关心“该不该命中这个 skill”
- outcome 只关心“这个 skill 成功执行后应交付什么”
- 入库前必须去重
- 版本必须绑定到目标 skill version，不能悄悄丢成无版本

只有在内部调试、回填或局部修复时，才允许单独生成其中一类；这不是默认产品语义。

## 工作流程

1. 解析目标 skill 与目标版本
2. 读取 `SKILL.md` 和辅助文件摘要
3. 调用 `routing-benchmark-generator` 生成 routing benchmarks
4. 调用 `outcome-benchmark-generator` 生成 outcome benchmark
5. 对现有 config 做去重与版本绑定检查
6. 输出可直接入库的 benchmark generation 结果

## 验收标准

- 用户能针对单个 skill 一键补齐两类 benchmark
- 生成结果能直接进入项目的数据集管理链路
- 最终可以清楚说明“哪些是 routing benchmark，哪些是 outcome benchmark”
