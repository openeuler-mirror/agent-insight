---
title: "运行观测"
description: "链路追踪、智能诊断与质量监控总览"
---

# 运行观测

运行观测用于还原 Agent 在真实环境中的执行事实，并支撑问题定位、样本筛选与后续分析。其核心关注点包括：一次执行具体发生了什么、异常更可能出在哪里、哪些样本值得继续沉淀。

> **Note**
> 如果 Agent 管理回答的是“有哪些资产”，那么运行观测回答的是“这些资产最近实际运行得如何”。

## 核心作用

- 确认真实执行是否已进入平台并生成 Trace
- 回看失败、变慢或结果偏差的完整执行链路
- 判断问题更接近模型、工具、Skill 还是流程编排
- 从线上执行中筛选高价值样本，沉淀为后续评测与优化输入

## 页面构成

### 链路追踪

链路追踪是运行观测的主入口，用于查看一次执行从入口到结束的完整 Trace。适合完成样本筛选、过程还原与关键节点定位，是多数分析动作的起点。

对应文档： [链路追踪](./view-traces)

### 智能诊断

智能诊断基于 Trace 上下文对失败、异常或效果偏差样本做归因分析，输出问题类型、证据节点与建议方向。它更适合作为 Trace 阅读之后的辅助判断层，而不是替代原始执行事实。

对应文档： [智能诊断](./diagnosis)

### 质量监控

质量监控面向趋势观察与持续巡检，但当前页面暂未开放使用。现阶段如需查看执行细节或定位异常，仍以链路追踪和智能诊断为主要路径。

对应文档： [质量监控](./quality-monitoring)

## 推荐使用顺序

大多数问题可按以下顺序处理：

1. 先在链路追踪里找到异常执行
2. 进入详情看 Trace、Span 和上下文
3. 对失败或偏差样本使用智能诊断
4. 对重复出现或高价值样本沉淀为评测数据集或优化输入

## 运行观测和评测中心有什么区别

这两个模块经常配合使用，但职责边界不同：

- **运行观测**：看真实线上执行发生了什么
- **评测中心**：把问题转成可重复、可回归的离线验证

前者偏向发现与还原问题，后者偏向验证与回归问题。

## 下一步

- 查看单次执行细节： [链路追踪](./view-traces)
- 查看异常样本归因： [智能诊断](./diagnosis)
- 了解趋势能力当前状态： [质量监控](./quality-monitoring)
- 将线上问题沉淀为回归验证： [评测中心](../evaluation/index)

## Hermes 接入

安装指导页下发的普通交互版 setup 和 auto setup 都支持选择 Hermes。选择后脚本会安装并启用 `briancaffey/hermes-otel` 插件、向 Hermes 运行环境安装 OTel 依赖，并写入 `$HERMES_HOME/plugins/hermes_otel/config.yaml`（未设置 `HERMES_HOME` 时默认为 `~/.hermes`）。Hermes venv 会优先从 `$HERMES_HOME/hermes-agent/venv` 探测，再 fallback 到 `~/git/hermes-agent/venv` / `~/agent/hermes-agent/venv`。

Hermes 的 OTLP trace 会直接上报到平台 `/api/ingest/otel/v1/traces`。当前平台会按 Hermes span tree 生成用户输入、工具步骤、中间 LLM 回复和最终回复；同一 session 的后续 OTel batch 会按最新 snapshot 覆盖旧 interactions，避免 partial batch 造成步骤重复或顺序污染。跨 session 的 subagent 归并仍依赖 Hermes 侧提供 parent/root session 关联字段，暂未自动合并。
