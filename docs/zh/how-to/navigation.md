---
title: "操作指南"
---

针对安装、配置、使用与扩展目标查找操作步骤。

现有文档已按主要用途迁入；内容拆分和时效问题见[迁移审查清单](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)。疑似过期文件仍保留，未因迁移删除正文。

## 平台公共

- [用 Docker 部署服务端](./platform/deploy-docker.md)
- [升级与回滚](./platform/upgrade-and-rollback.md)
- [备份与恢复](./platform/backup-and-restore.md)
- [Conventions & Extension](./platform/conventions-and-extension.md)
- [Agent-insight 共享账户接入说明](./platform/deploy-shared-account.md)
- [Docker 测试构建](./platform/docker-testing.md)
- [常见问题](./platform/faq.md)
- [Agent 概览](./platform/manage-agents.md)
- [Q&A](./platform/qa.md)
- [Docker 镜像发布](./platform/release-docker-image.md)
- [客户端安装](./platform/settings/access-control.md)
- [模型注册](./platform/settings/model-registry.md)
- [用量统计](./platform/settings/usage-analytics.md)
- [联网搜索](./platform/settings/web-search.md)
- [概览面板](./platform/workspace-overview.md)

## 观测

- [新增第三方Agent框架Trace采集开发方案](./observability/develop-trace-collector.md)
- [Goal Plus 观测接入](./observability/goal-plus.md)
- [LlamaIndex Trace Collector](./observability/llamaindex-trace-collector.md)
- [MCTS xGovernor Trace 非侵入式接入](./observability/mcts-xgovernor.md)
- [质量监控](./observability/quality-monitoring.md)
- [QwenPaw Trace Collector](./observability/qwenpaw-trace-collector.md)
- [Trae IDE 接入指南](./observability/trae-integration.md)
- [链路追踪](./observability/view-traces.md)
- [WorkBuddy Trace Collector](./observability/workbuddy-trace-collector.md)

## 评测

- [Benchmark 通用服务部署指南](./evaluation/benchmarks/deploy-services.md)
- [SWE-bench 部署指南](./evaluation/benchmarks/deploy-swe-bench.md)
- [ZSoft 部署指南](./evaluation/benchmarks/deploy-zsoft.md)
- [Benchmark 接入开发规范](./evaluation/benchmarks/develop-benchmark.md)
- [自定义 Benchmark 接入指南](./evaluation/benchmarks/onboard-custom-benchmark.md)
- [ZSoft 评测资产发布指南](./evaluation/benchmarks/release-zsoft-assets.md)
- [评测数据集](./evaluation/datasets.md)
- [评估器开发指南](./evaluation/develop-evaluator.md)
- [评估器](./evaluation/evaluators.md)
- [实验](./evaluation/experiments.md)
- [MCTS 实验用户使用说明书](./evaluation/mcts-experiments.md)
- [A/B 测试](./evaluation/skills/ab-test.md)
- [Skill 评估](./evaluation/skills/static-compliance.md)
- [触发分析](./evaluation/skills/trigger-analysis.md)
- [用例分析](./evaluation/skills/use-case-analysis.md)（含 OpenCode 1.x / 2.x 执行能力要求与 Trace 入库排障）

## 诊断

- [智能诊断](./diagnosis/agent-debug/diagnosis.md)

## 优化

- [Skill 生成](./optimization/skills/generate.md)
- [Skills 管理](./optimization/skills/manage.md)
- [Skill 优化](./optimization/skills/optimize.md)（含执行期间查看前文与恢复输出跟随）
- [Skill 生成、评估与优化使用指南](./optimization/skills/skill-workflow.md)

## 可靠性

- [Agent FI：本机安装过程详解](./reliability/agent-fault-injection/local-install-process.md)
- [故障注入与评测](./reliability/agent-fault-injection/run-injection.md)
- [Agent RAS：本机安装过程详解](./reliability/agent-ras/local-install-process.md)
- [OpenCode 接入](./reliability/agent-ras/platform-opencode.md)
- [openjiuwen / jiuwenclaw 接入](./reliability/agent-ras/platform-openjiuwen.md)
- [xiaoO 平台接入](./reliability/agent-ras/platform-xiaoo.md)

[中文总览](https://gitcode.com/openeuler/agent-insight/blob/master/docs/zh/README.md) · [English documentation](../../en/how-to/navigation.md)
