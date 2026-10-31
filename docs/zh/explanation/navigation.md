---
title: "概念与原理"
---

理解概念、架构、数据流与职责边界。

现有文档已按主要用途迁入；内容拆分和时效问题见[迁移审查清单](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)。疑似过期文件仍保留，未因迁移删除正文。

## 平台公共

- [Agent-Insight 架构设计文档](./platform/architecture.md)
- [核心概念](./platform/core-concepts.md)
- [数据与控制流](./platform/data-control-flow.md)
- [Agent-Insight — 开发者指南](./platform/developer-index.md)
- [Frontend](./platform/frontend.md)
- [Modules](./platform/modules.md)
- [Positioning](./platform/positioning.md)
- [Agent Insight](./platform/product-overview.md)
- [平台用量统计（usage-analytics）](./platform/usage-analytics.md)

## 观测

- [跨 Session 协作 Trace](./observability/cross-session-collaboration.md)
- [Goal Plus Pi 主从 Trace 接入](./observability/goal-plus.md)
- [Trace 落盘机制与 Hermes 文件膨胀历史分析](./observability/hermes-storage-analysis.md)
- [运行观测](./observability/overview.md)
- [TRAE Collector 架构说明](./observability/trae-collector.md)

## 评测

- [Benchmark 文档关系与开发指南](./evaluation/benchmarks/navigation.md)
- [评估与实验](./evaluation/overview.md)
- [Skill 评估与实验](./evaluation/skills/overview.md)
- [静态评估器](./evaluation/skills/static-evaluator.mdx)

## 诊断

- [AgentDebug 轨迹诊断现状与历史循环漏检分析](./diagnosis/agent-debug/diagnosis-loop-analysis.md)

## 优化

- [Skill 生成：工作原理、流水线与能力边界](./optimization/skills/generation-pipeline.md)
- [Skill 优化：工作原理、闭环验证机制与能力边界](./optimization/skills/optimization-loop.md)
- [Skill 工作台](./optimization/skills/workbench-overview.md)

## 可靠性

- [Agent Fault Injection 文档](./reliability/agent-fault-injection/navigation.md)
- [Agent Fault Injection — 架构](./reliability/agent-fault-injection/architecture.md)
- [OpenCode 平台适配方案](./reliability/agent-fault-injection/modules/opencode-platform-adaptation.md)
- [Agent Insight · RAS · FI 关系设计说明](./reliability/agent-fault-injection/modules/ras-fi-insight-relationship.md)
- [xiaoO 平台适配方案](./reliability/agent-fault-injection/modules/xiaoo-platform-adaptation.md)
- [Agent RAS 文档](./reliability/agent-ras/navigation.md)
- [Agent RAS 整体架构](./reliability/agent-ras/architecture.md)
- [Detectors 模块](./reliability/agent-ras/modules/detectors.md)
- [Monitor 模块](./reliability/agent-ras/modules/monitor.md)
- [Platform adapter 模块](./reliability/agent-ras/modules/platform-adapter.md)
- [ras-runtime 模块](./reliability/agent-ras/modules/ras-runtime.md)
- [Recovery 模块](./reliability/agent-ras/modules/recovery.md)
- [Review 模块](./reliability/agent-ras/modules/review.md)

[中文总览](https://gitcode.com/openeuler/agent-insight/blob/master/docs/zh/README.md) · [English documentation](../../en/explanation/navigation.md)
