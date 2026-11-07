---
title: "参考文档"
description: "汇总接口、配置、协议与数据字段文档，便于核对平台接入和开发契约。"
keywords: ["Agent Insight", "接口参考", "运行配置", "数据协议"]
changefreq: "monthly"
---

查找 API、配置、协议和数据字段。

现有文档已按主要用途迁入；内容拆分和时效问题见[迁移审查清单](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)。疑似过期文件仍保留，未因迁移删除正文。

## 平台公共

- [HTTP 接口与用户身份](./platform/http-api.md)
- [模型连接测试](./platform/model-connection-test.md)
- [运行配置参考](./platform/configuration.md)
- [API & Contracts](./platform/api-and-contracts.md)
- [Design System & Frontend Style](./platform/design-system.md)
- [内置示例走查的成本参考](./platform/example-cost.md)
- [File Map](./platform/file-map.md)

## 观测

- [Trace HTTP 接入](./observability/trace-ingestion.md)
- [客户端兼容性](./observability/client-compatibility.md)
- [OTLP 属性契约 (FR-011)](./observability/otlp-attribute-contract.md)

## 评测

- [数据集 HTTP 接口](./evaluation/datasets-api.md)
- [实验 HTTP 接口](./evaluation/experiments-api.md)
- [执行环境准备](./evaluation/execution-environment.md)
- [评估器运行与输出契约](./evaluation/evaluator-output.md)
- [独立 Benchmark 评测协议](./evaluation/benchmark-protocol.md)

## 持续优化

- [Skill 管理 HTTP 接口](./optimization/skills-api.md)

## 可靠性

- [可靠性客户端与控制接口](./reliability/client-control-api.md)

- [内置故障覆盖矩阵](./reliability/agent-fault-injection/fault-catalog.md)

[中文总览](https://gitcode.com/openeuler/agent-insight/blob/master/docs/zh/README.md) · [English documentation](../../en/reference/navigation.md)
