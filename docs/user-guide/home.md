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
   先把你的 Agent 纳入平台管理，通过客户端安装拿到 API Key 和基础配置。
2. **观察真实运行**
   通过 Agent 概览、链路追踪和推理基础设施，看清 Agent 是如何完成任务的；异常再进入诊断分析。
3. **离线评测质量**
   把线上问题沉淀为数据集，用评估器跑批量评测，获得可比较的结果。
4. **让 Skills 进入迭代周期**
   把 Skills 放进从开发、运行，到评测和优化的闭环里，让 Skills 越用越好。

> **Tip**
> 如果你是第一次使用，建议按
> [5 分钟上手](./quickstart) → [核心概念](./concepts) →
> 目标模块文档 的顺序阅读。

## 主要模块

### 仪表盘

仪表盘快速汇总最近运行情况、核心指标和后续模块入口。

### 快速开始

快速开始按照 **快速接入 → 运行观测 → 评估与实验 → 诊断分析 → 持续优化** 五个阶段组织推荐路径。每个能力卡片都跳转到当前已开放的真实页面，适合首次使用时逐步走通平台闭环。

### 运行观测

运行观测聚焦线上真实执行，是排障和理解行为的第一入口：

- **链路追踪**：按一次完整任务执行查看全链路 Trace
- **Agent 概览**：查看和管理平台已识别的 Agent
- **推理基础设施**：关联推理服务指标与执行时段

### 评估与实验

评估与实验负责把“感觉好不好”变成“可重复、可比较”的结论：

- **实验**：组合 Agent、数据集、评估器和 Trace 并运行评估
- **评测数据集**：维护输入、参考答案和样本结构
- **评估器**：定义如何给结果打分，可以是规则、脚本或 LLM Judge

### 诊断分析

诊断分析直接复用既有智能诊断页面，对失败或异常 Trace 做归因并展示证据。

### 持续优化

持续优化下统一保留 **Skill** 入口，顶部页签承载四类既有能力：

- **SkillHub**：查看 Skill 列表、版本和状态
- **生成**：通过需求描述自动生成 SKILL.md 与配套材料
- **评测**：从 A/B 测试、触发分析、静态合规等角度分析 Skill
- **优化**：根据评测与运行证据迭代 Skill 版本

### 配置

配置模块用于统一管理平台运行依赖：

- **模型注册**：接入 OpenAI、DeepSeek 等模型供应商
- **联网搜索**：配置外部搜索能力，供部分生成或分析流程使用
- **客户端安装**：为现有 Agent 生成接入平台所需的安装和配置说明

## 适合谁使用

### Agent 开发者

如果你希望先看到真实链路、尽快定位错误，优先阅读：

- [5 分钟上手](./quickstart)
- [客户端安装](./settings/access-control)
- [运行观测](./observability/index)
- [核心概念](./concepts)

### 评测与质量负责人

如果你更关注版本对比、离线回归和质量门禁，优先阅读：

- [评估与实验](./evaluation/index)
- [评测快速开始](./evaluation/quickstart)
- [评估器](./evaluation/evaluators)

### Skill 设计与优化人员

如果你要沉淀 Prompt / 工具编排经验并做持续优化，优先阅读：

- [持续优化 · Skill](./skills/index)
- [Skills 生成](./skills/generate)
- [Skills 优化](./skills/optimize)

## 典型工作流

下面是一条最常见的落地路径：

1. 进入 **快速开始**，按五阶段推荐路径确认接入顺序
2. 在 **模型注册** 中配置模型供应商
3. 在 **运行观测 → Agent 概览** 中创建或登记目标 Agent
4. 按 **配置 → 客户端安装** 完成接入，让 Agent 开始上报数据
5. 在 **链路追踪** 中确认第一条真实执行链路
6. 对失败样本使用 **诊断分析** 找根因
7. 把典型问题沉淀为 **评测数据集**，建立回归评测
8. 将稳定经验抽象成 **Skill**，持续生成、分析和优化

## 下一步

- 第一次接入平台： [5 分钟上手](./quickstart)
- 先完成平台基础配置： [模型注册](./settings/model-registry)
- 想直接复制接入命令： [客户端安装](./settings/access-control)
- 先理解名词和关系： [核心概念](./concepts)
- 想从 Agent 资产开始： [Agent 概览](./agent-management)
- 想先看运行数据： [运行观测](./observability/index)
- 想建立离线评测： [评估与实验](./evaluation/index)
- 想沉淀 Agent 能力： [持续优化 · Skill](./skills/index)
