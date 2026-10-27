---
title: "Agent RAS 文档"
description: "汇总 Agent RAS 的架构、模块和使用指南，帮助读者定位异常检测与自动恢复相关文档。"
keywords: ["Agent RAS", "异常检测", "自动恢复", "文档导航"]
changefreq: monthly
---

# Agent RAS 文档

环内可靠性包 [`agent_ras/`](../../../../../agent_ras/)：异常检测 + 自动恢复。本页串联现行架构、操作教程与内部设计；正文分别位于四类文档的 reliability 专题中，内部设计位于仓根 `design/reliability/agent-ras/`。

## 先读什么

| 目的 | 打开 |
|------|------|
| 理解四层同进程与主流程 | [architecture.md](architecture.md) |
| **与 Insight / FI 的边界** | [ras-fi-insight-relationship.md](../agent-fault-injection/modules/ras-fi-insight-relationship.md) |
| **curl / install-ras 本机过程** | [local-install-process.md](../../../how-to/reliability/agent-ras/local-install-process.md) |
| 改 Monitor / 检测 / 恢复 / 适配代码 | [modules](modules/) 对应篇 |
| 装上并跑起来 | [01-getting-started.md](../../../tutorial/reliability/agent-ras/01-getting-started.md) |

---

## designs/ — 设计

原 designs 目录已按用途归位：当前架构与模块解释见本专题，内部需求方案见仓根 design/reliability。标题保留供历史锚点引用。

实现状态见下方特性表「状态」列；架构与模块正文在对应文件。

### 架构

| 文档 | 内容 |
|------|------|
| [architecture.md](architecture.md) | 目标与边界、L0–L3、双路径、inproc / IPC、Insight·FI 通道、主流程、能力摘要 |

### 模块（改哪里）

| 文档 | 内容 |
|------|------|
| [monitor.md](modules/monitor.md) | Monitor 编排、与 Rail / Detector / Recovery / L3 Reviewer 协作 |
| [detectors.md](modules/detectors.md) | 检测器接入、扩展点、已有检测器摘要 |
| [review.md](modules/review.md) | L3 语义评审 skill（`role=review`）与 REVIEW_PLUGIN |
| [recovery.md](modules/recovery.md) | anomaly → wire actions → Host 投递 |
| [ras-runtime.md](modules/ras-runtime.md) | L1 门面、旁路 push 边界、trace/delivery 锚点 |
| [platform-adapter.md](modules/platform-adapter.md) | L2/L3 挂载、多平台能力矩阵、HostControl、加平台 checklist |

### 特性

| 文档 | 内容 | 状态 |
|------|------|------|
| [repeat-tool.md](../../../../../design/reliability/agent-ras/repeat-tool.md) | 工具重复死循环检测与恢复 | 已落地 |
| [thinking-loop.md](../../../../../design/reliability/agent-ras/thinking-loop.md) | LLM 思考/文本死循环检测与恢复 | 已落地 |
| [stream-abort.md](../../../../../design/reliability/agent-ras/stream-abort.md) | 环内打断 `llm.stream` | 已落地 |
| [provider-disconnect.md](../../../../../design/reliability/agent-ras/provider-disconnect.md) | Provider 断连停推理能力调研 | 已完成 |
| [analysis-paralysis.md](../../../../../design/reliability/agent-ras/analysis-paralysis.md) | 分析瘫痪二阶段检测 | 已落地 |
| [planning-error.md](../../../../../design/reliability/agent-ras/planning-error.md) | 策略层规划错误检测 | 规划中 |
| [opencode-xiaoo-integration.md](../../../../../design/reliability/agent-ras/opencode-xiaoo-integration.md) | OpenCode / xiaoO 平台接入：共享骨架、采点/Host、⓪ Trace、机制差异与 FI 边界 | 已落地 |
| [capability-config.md](../../../../../design/reliability/agent-ras/capability-config.md) | 能力配置：目录解耦（PLUGIN presentation + catalog API）+ 多平台可选同步；模板 `agent_ras_config.default.yaml` | 已落地 |
| [reliability-client-interaction.md](../../../../../design/reliability/agent-ras/reliability-client-interaction.md) | 可靠性闭环：常驻客户端、configRef 控制面、Trace 异常维度、可靠性数据集与评估器 | 部分落地（评测集/IF-N16/FI 外挂/Trace anomaly/ExperimentCase FI 独立列） |
| [reliability-client-control-plane.md](../../../../../design/reliability/agent-ras/reliability-client-control-plane.md) | 客户端控制面：统一安装、systemd/launchd 保活、配置下发、WSS 双向通信；新客户端吸收 FI Worker | 开发中 |
| [fault-domain-plugins.md](../../../../../design/reliability/agent-ras/fault-domain-plugins.md) | 故障域插件化：`detectors`/`review`/`recovery` 三平级扫描 PLUGIN；P3 共同文件只留 yaml | **已落地（P0–P3）** |
| [ras-reliability-evaluator-split.md](../../../../../design/reliability/agent-ras/ras-reliability-evaluator-split.md) | 可靠性检测恢复评估器：故障发生前置门控、未发生时无分、历史评估器兼容 | 代码与自动化验证完成，浏览器验收待确认 |
| [dashboard-reliability-performance.md](../../../../../design/reliability/agent-ras/dashboard-reliability-performance.md) | 仪表盘拆分可靠性与性能页签；RAS 故障恢复聚合、执行失败补充与 Trace 下钻 | 开发完成，待 UI 验收 |

---

## guides/ — 使用

使用文档已迁入 tutorial/reliability 与 how-to/reliability，下列链接指向新位置。

| 文档 | 内容 |
|------|------|
| [01-getting-started.md](../../../tutorial/reliability/agent-ras/01-getting-started.md) | 选平台、安装、配置目录与常用开关、Insight 同步 |
| [local-install-process.md](../../../how-to/reliability/agent-ras/local-install-process.md) | **curl / install-ras 时本机逐步发生了什么**（数据源、目录树、预检、排障） |
| [platform-openjiuwen.md](../../../how-to/reliability/agent-ras/platform-openjiuwen.md) | openjiuwen / jiuwenclaw 深挂载与 YAML 片段 |
| [platform-opencode.md](../../../how-to/reliability/agent-ras/platform-opencode.md) | OpenCode `install-ras` 同进程接入 |
| [platform-xiaoo.md](../../../how-to/reliability/agent-ras/platform-xiaoo.md) | xiaoO hooks + Daemon SSE 闭环验收 |

---

## 本仓其它（非本树）

| 主题 | 入口 |
|------|------|
| Insight「AgentRAS 可靠性」UI | [design/reliability/reliability-standalone-ui](../../../../../design/reliability/reliability-standalone-ui/) |
| RAS 旁路 ingest API 契约 | [developer-guide/09-otlp-attribute-contract.md](../../../reference/observability/otlp-attribute-contract.md) |
| **故障注入 / 与 Insight·RAS 关系** | [docs/zh/explanation/reliability/agent-fault-injection/](../agent-fault-injection/) · [关系设计说明](../agent-fault-injection/modules/ras-fi-insight-relationship.md) |
| 源码与安装 | [`agent_ras/README.md`](../../../../../agent_ras/README.md) |
