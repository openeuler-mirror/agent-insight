---
title: "Agent Insight"
description: "面向智能体应用的可观测、评测与 Skills 优化平台"
---

# Agent Insight

![Agent Insight](/brand/logo-horizontal-light.svg)

让每一个 Agent 都可被观测、可被评估、可自我进化。

> **Note**
> Agent Insight 是一个面向 Agent 全生命周期的工程平台，围绕
> **运行观测、评测分析、Skills 管理与优化** 建立统一工作台。

## 你可以用它做什么

- 把运行中的 Agent 接入平台，采集真实调用链路
- 从一次执行看到完整 Trace、Span、Token、工具调用和失败节点
- 针对失败执行做智能诊断，快速定位问题根因
- 建立评测数据集、配置评估器、批量运行离线评测
- 把 Skill 当成版本化资产，完成生成、分析、A/B 测试和优化迭代

<p align="center">
  <img src="../images/home.png" alt="Agent Insight 首页概览" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

## 平台结构

Agent Insight 的用户工作流可以理解为 4 个连续阶段：

1. **接入 Agent**
   先把你的 Agent 纳入平台管理，拿到安装指导、API Key 和基础配置。
2. **观察真实运行**
   通过链路追踪、质量监控和智能诊断，看清 Agent 是如何完成任务的。
3. **离线评测质量**
   把线上问题沉淀为数据集，用评估器跑批量评测，获得可比较的结果。
4. **让 Skills 进入迭代周期**
   把 Skills 放进从开发、运行，到评测和优化的闭环里，让 Skills 越用越好。

> **Tip**
> 如果你是第一次使用，建议按
> [5 分钟上手](./quickstart) → [核心概念](./concepts) →
> 目标模块文档 的顺序阅读。

## 主要模块

### Agent Workspace

这里是面向业务 Agent 的主工作区，包含以下能力：

- **概览面板**：快速查看最近运行情况、核心指标和入口导航
- **Agent 管理**：登记 Agent、区分主 Agent / 子 Agent、查看接入状态
- **运行观测**：查看 Trace、Span、Token、工具调用与异常链路
- **评测中心**：围绕数据集、评估器、评测执行建立离线评测体系
- **Skills 能力**：沉淀和管理可复用的 Agent 能力资产

### 运行观测

运行观测聚焦线上真实执行，是排障和理解行为的第一入口：

- **链路追踪**：按一次完整任务执行查看全链路 Trace
- **智能诊断**：对失败执行进行 AI 归因，给出问题类型与证据
- **质量监控**：从成功率、时延、错误率等角度持续观察质量趋势

### 评测中心

评测中心负责把“感觉好不好”变成“可重复、可比较”的结论：

- **评测数据集**：维护输入、参考答案和样本结构
- **评估器**：定义如何给结果打分，可以是规则、脚本或 LLM Judge
- **评测执行**：批量运行评测任务，回看结果、轨迹和综合结论

### Skills 能力

Skills 是平台里的核心资产，不只是提示词片段，而是一整套可调用能力：

- **Skills Hub**：查看 Skill 列表、版本和状态
- **Skills 生成**：通过需求描述自动生成 SKILL.md 与配套材料
- **Skills 评测**：从 A/B 测试、触发分析、静态合规等角度分析 Skill
- **Skills 优化**：基于分析结果迭代 Skill 内容，发布新版本

### 配置

配置模块用于统一管理平台运行依赖：

- **模型注册**：接入 OpenAI、DeepSeek 等模型供应商
- **联网搜索**：配置外部搜索能力，供部分生成或分析流程使用
- **安装指导**：为现有 Agent 生成接入平台所需的安装和配置说明

## 适合谁使用

### Agent 开发者

如果你希望先看到真实链路、尽快定位错误，优先阅读：

- [5 分钟上手](./quickstart)
- [安装指导](./settings/access-control)
- [运行观测](./observability/index)
- [核心概念](./concepts)

### 评测与质量负责人

如果你更关注版本对比、离线回归和质量门禁，优先阅读：

- [评测中心](./evaluation/index)
- [评测快速开始](./evaluation/quickstart)
- [评估器](./evaluation/evaluators)

### Skill 设计与优化人员

如果你要沉淀 Prompt / 工具编排经验并做持续优化，优先阅读：

- [Skills 能力](./skills/index)
- [Skills 生成](./skills/generate)
- [Skills 优化](./skills/optimize)

## 典型工作流

下面是一条最常见的落地路径：

1. 在 **模型注册** 中配置模型供应商
2. 在 **Agent 管理** 中创建或登记目标 Agent
3. 按 **安装指导** 完成接入，让 Agent 开始上报数据
4. 在 **链路追踪** 中确认第一条真实执行链路
5. 对失败样本使用 **智能诊断** 找根因
6. 把典型问题沉淀为 **评测数据集**，建立回归评测
7. 将稳定经验抽象成 **Skill**，持续生成、分析和优化

## 下一步

- 第一次接入平台： [5 分钟上手](./quickstart)
- 先完成平台基础配置： [模型注册](./settings/model-registry)
- 想直接复制接入命令： [安装指导](./settings/access-control)
- 先理解名词和关系： [核心概念](./concepts)
- 想从 Agent 资产开始： [Agent 管理](./agent-management)
- 想先看运行数据： [运行观测](./observability/index)
- 想建立离线评测： [评测中心](./evaluation/index)
- 想沉淀 Agent 能力： [Skills 能力](./skills/index)
