---
title: "入门教程"
---

按步骤完成一次完整任务。

现有文档已按主要用途迁入；内容拆分和时效问题见[迁移审查清单](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)。疑似过期文件仍保留，未因迁移删除正文。

## 平台公共

- [5 分钟上手](./platform/01-quick-start.md)（含 OpenCode 1.x / 2.x 接入与 Skill 实验准备）
- [内置示例端到端走查](./platform/02-example-walkthrough.md)

## 观测

- [查看调用树与工具详情](../how-to/observability/view-traces.md#详情页总览)：有明确关联证据的普通 Tool Call 会缩进到对应 LLM 下；Skill、TASK 和子 Agent 保持原有层级。

- 自建 Dify 可在「客户端安装」的 Dify 配置区复制原生 OTLP 配置，并按 [Dify 原生 OTLP 接入](../how-to/observability/develop-trace-collector.md#dify-原生-otlp-接入)运行 Workflow；Agent 运行服务启用独立 trajectory 管线后，可逐步查看模型请求、工具参数与结果、已上报的 reasoning 和 Token。Workflow 详情可按节点执行 ID 关联内部 Agent，点击“立即刷新”查看晚到轨迹。已通过原生 Workflow 内两名 Agent v2 的真实 DeepSeek 运行及浏览器验证（7 次模型调用、4 次工具调用）；并发、重试等场景仍待真实验证。

## 评测

- [跑通第一次评测](./evaluation/01-first-experiment.md)

## 优化

Skill 优化期间可以向上滚动查看前文，新输出不会打断阅读；回到底部后恢复跟随。操作步骤见 [Skill 优化](../how-to/optimization/skills/optimize.md)。

## 可靠性

- [快速开始](./reliability/agent-fault-injection/01-getting-started.md)
- [快速开始](./reliability/agent-ras/01-getting-started.md)

[中文总览](https://gitcode.com/openeuler/agent-insight/blob/master/docs/zh/README.md) · [English status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/tutorial/README.md)
