---
title: "入门教程"
description: "汇集首次接入、运行示例和首次评测的分步教程，帮助用户完成平台入门。"
keywords: ["Agent Insight", "入门教程", "智能体接入", "首次评测"]
changefreq: "monthly"
---

# 入门教程

正文与导航已迁至 [入门教程](./navigation.md)。保留本入口，供仓库目录浏览和旧链接继续使用。

使用 Benchmark 前先确认客户端支持链路跟踪的 Agent/模型，再按官方环境要求选择执行 Profile；本地工作区与 xGovernor 分别检查，不能根据客户端在线推断本次就绪。配置示例见 [部署指南](../how-to/evaluation/benchmarks/deploy-services.md#执行-profile-的后端配置)。

完成评测后，可继续[将评测结果送入诊断并生成 Skill 优化计划](../how-to/diagnosis/agent-debug/diagnosis.md#将诊断发现用于-skill-优化)。

平台评测提示缺少模型时，可从提示中的 **去模型注册** 入口添加模型、测试连接并设为默认，再返回重评已有输出。详见[跑通第一次评测](./evaluation/01-first-experiment.md)。

Skill 用例分析和 A/B 实验可选择已保存的自定义评估器，无需从草稿转为就绪；说明见[评估器指南](../how-to/evaluation/evaluators.md)。

Skill 用例分析、A/B 和触发分析可设置“执行并发”（默认 1），复用及重新执行沿用冻结值；A/B 每侧各占一个名额。并发大于 1 需更新并重启执行客户端，执行期间仍可处理环境预检和取消指令。详见[Skill 实验执行说明](../explanation/evaluation/skills/overview.md)。

Skill 实验记录列表与普通实验共用自动刷新：有运行中记录时每 5 秒更新状态，全部结束后停止；进入创建向导或结果详情时暂停列表刷新。刷新失败时保留最近记录并自动重试。


在链路追踪列表中，可通过“时间 → 自定义时间范围”定位指定时段；参见[首条 Trace 教程](./platform/01-quick-start.md#步骤五验证生成的-trace)。

JiuwenSwarm 升级后，请更新观测扩展并重启 AgentServer，再检查输入、回答、模型调用、工具结果及 Token 是否完整；见[新旧契约兼容说明](../reference/observability/client-compatibility.md#jiuwenswarm)。

关联外部推理分析时，完成采集安装后再按[显式模型转发指南](../how-to/observability/inference-gateway.md)配置。
