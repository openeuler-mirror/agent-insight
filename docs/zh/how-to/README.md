---
title: "操作指南"
description: "按部署、观测、评测、诊断和优化任务组织操作步骤，帮助用户查找所需指南。"
keywords: ["Agent Insight", "操作指南", "平台部署", "运行观测", "评测优化"]
changefreq: "monthly"
---

# 操作指南

正文与导航已迁至 [操作指南](./navigation.md)。保留本入口，供仓库目录浏览和旧链接继续使用。OpenShift 的镜像、PVC/SCC、Route 和验收步骤见 [OpenShift 部署指南](./platform/deploy-openshift.md)。

评测与优化闭环：[评测输入](./evaluation/experiments.md) → [智能诊断](./diagnosis/agent-debug/diagnosis.md) → [诊断优化计划与复测](./optimization/skills/optimize.md#根据智能诊断优化)。升级前先执行[数据库迁移与备份检查](./platform/upgrade-and-rollback.md)。

平台评估器缺模型时提供 **去模型注册** 入口，配置并设为默认后可复用已有输出和 Trace 重评。操作见[实验](./evaluation/experiments.md#查看单条-case-详情)与[模型注册](./platform/settings/model-registry.md)。

自定义评估器不再按 `ready` / `draft` 筛选或展示状态，保存后可用于 Skill 用例与 A/B 实验；前置条件和内置规则不变，见[评估器指南](./evaluation/evaluators.md)。

Skill 用例分析、A/B 和触发分析可设置“执行并发”（默认 1），复用及重新执行沿用冻结值；A/B 每侧各占一个名额。并发大于 1 需更新并重启执行客户端，执行期间仍可处理环境预检和取消指令。详见[Skill 实验执行说明](../explanation/evaluation/skills/overview.md)。

Skill 实验记录列表与普通实验共用自动刷新：有运行中记录时每 5 秒更新状态，全部结束后停止；进入创建向导或结果详情时暂停列表刷新。刷新失败时保留最近记录并自动重试。

Benchmark 执行 Profile 支持显式 `backend/options`：按后端配置和探测，旧 xGovernor 配置继续兼容；本地方式不承担 Docker 探测。配置、绑定冲突及使用条件见 [服务部署指南](evaluation/benchmarks/deploy-services.md#执行-profile-的后端配置)。

[链路追踪时间筛选](./observability/view-traces.md#2-筛选区)支持快捷范围及精确到秒的自定义起止时间。

[JiuwenSwarm 接入升级](../reference/observability/client-compatibility.md#jiuwenswarm)说明扩展更新、容器地址配置及完整 Trace 验收要求。

[模型转发与推理分析接入](./observability/inference-gateway.md)：采集安装后，由用户显式备份并接管模型地址。

管理员全局查看、Trace 列表“用户”列、按用户筛选及全量仪表盘的使用说明，见[Trace 查看范围](./observability/view-traces.md#列表页总览)。
