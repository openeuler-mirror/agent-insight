---
title: "Positioning"
description: "介绍 Agent Insight 的项目定位、目标用户、核心能力和成熟度，帮助开发者理解平台适用范围。"
keywords: ["Agent Insight", "智能体工程", "可观测性", "Skill 优化"]
changefreq: monthly
---

# Positioning

> Agent-Insight 是一个开源、自托管的工程平台，让任意 Agent 变得可观测、可评测、可自我改进——并将 Skill 作为一等的、可优化的资产。

## What & why
随着 Agent 在各领域部署，开发者会反复遇到三个问题（摘自 README）：
1. Agent 运行是黑盒——难以定位失败的根因。
2. Skill 质量参差不齐——缺乏系统化的方式来评测和迭代 Skill。
3. Agent 经验无法积累——每次优化都从零开始。

Agent-Insight 通过为 Agent 完整生命周期提供一个**框架无关的工程底座**来解决这些问题：*运行数据采集 → trace 跟踪 → 评测/分析 → 经验积累 → 决策支持*。与同类工具不同，它将 **Skill（Agent 能力）视为一等公民**，提供从生成、A/B 测试到优化的闭环。

核心能力（摘自 README）：
- **Agent 可观测性与自进化**——采集运行数据，跟踪 Agent 调用链，评测，并将结果反馈到迭代中。
- **Skill 开发与自进化**——完整生命周期：*生成 → 调试 → 观测 → 评测 → 优化*。
- **智能 A/B 评测**——结构化的 *Config → Execution → Decision* 工作流，一键运行并自动对比/决策。
- **智能诊断**——从 trace 和失败模式中自动定位异常调用与根因。
- **框架无关接入**——通过 OpenTelemetry 标准、原生插件或日志旁路，兼容 OpenCode、Claude Code、OpenClaw、LangChain 等。
- **完全自托管**——一条命令安装，仅本地部署，完全掌控数据所有权。

## Who it's for
- **Agent / Skill 开发者**：需要调试、评测和迭代 Agent 与 Skill。
- **运行 Agent 的团队**：在 OpenCode / Claude Code / OpenClaw / LangChain 上运行 Agent，希望获得可观测性和质量监控，又不想将数据发送到机器之外。
- **LLM 编码 Agent**：在本仓库内工作（本指南也是为它们编写的）。

## Domain & key concepts
所属领域是 **Agent 可观测性 + Skill 评测/优化**。核心名词：Skill（带版本的能力）、Execution/trace（一次接入的 Agent 运行）、Config（标准答案数据集条目）、Evaluation（静态 / 动态 / 触发式）、Skill issue（优化点）、Trajectory evaluation（轨迹评测）、Outcome vs Routing evaluation（结果评测 vs 路由评测）、Grayscale A/B（灰度 A/B）、General agent（内部 deepagents 运行时）。参见 [developer-index.md](./developer-index.md) 中的术语表以及 `src/lib/glossary.ts`。

## Maturity
- **Package**：`agent-insight`；版本以 [package.json](https://gitcode.com/openeuler/agent-insight/blob/master/package.json) 为准（本次核对为 `0.9.0`）；项目许可证为 [Apache-2.0](https://gitcode.com/openeuler/agent-insight/blob/master/LICENSE)。安装要求见[快速开始](../../tutorial/platform/01-quick-start.md)，当前要求 Node.js `>= 20.9.0`。
- **Tests**：`npm run test` 执行采集器类型检查和 `test/**/*.test.ts`（Node test runner + tsx）。用例数量和通过情况以对应代码版本的实际运行结果为准，不能由文件数量推断功能覆盖率。
- **Docs**：公开文档入口为 [docs/README.md](https://gitcode.com/openeuler/agent-insight/blob/master/docs/README.md)，按语言、教程、操作指南、参考和解释组织；内部需求、设计及历史计划见 [design/README.md](https://gitcode.com/openeuler/agent-insight/blob/master/design/README.md)。架构说明见 [architecture.md](./architecture.md)。
- **Repository**：当前协作上游为 [openeuler/agent-insight](https://gitcode.com/openeuler/agent-insight)。设计稿记录方案与演进过程，是否已经实现需结合源码与对应操作指南确认。
- **兼容性**：旧入口和历史记录仍有兼容实现；升级前应核对所用版本的配置、数据与接口约定，不能仅凭目录中的 `legacy` 字样判断功能已废弃。
