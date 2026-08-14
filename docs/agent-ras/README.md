# Agent RAS 文档

环内可靠性包 [`agent_ras/`](../../agent_ras/)：异常检测 + 自动恢复。本目录只有 **设计**（`designs/`）与 **使用**（`guides/`）。

## 先读什么

| 目的 | 打开 |
|------|------|
| 理解四层同进程与主流程 | [designs/architecture.md](designs/architecture.md) |
| **与 Insight / FI 的边界** | [../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md](../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md) |
| **curl / install-ras 本机过程** | [guides/local-install-process.md](guides/local-install-process.md) |
| 改 Monitor / 检测 / 恢复 / 适配代码 | [designs/modules/](designs/modules/) 对应篇 |
| 装上并跑起来 | [guides/getting-started.md](guides/getting-started.md) |

---

## designs/ — 设计

实现状态见下方特性表「状态」列；架构与模块正文在对应文件。

### 架构

| 文档 | 内容 |
|------|------|
| [architecture.md](designs/architecture.md) | 目标与边界、L0–L3、双路径、inproc / IPC、Insight·FI 通道、主流程、能力摘要 |

### 模块（改哪里）

| 文档 | 内容 |
|------|------|
| [monitor.md](designs/modules/monitor.md) | Monitor 编排、与 Rail / Detector / Recovery / L3 Reviewer 协作 |
| [detectors.md](designs/modules/detectors.md) | 检测器接入、扩展点、已有检测器摘要 |
| [review.md](designs/modules/review.md) | L3 语义评审 skill（`role=review`）与 REVIEW_PLUGIN |
| [recovery.md](designs/modules/recovery.md) | anomaly → wire actions → Host 投递 |
| [ras-runtime.md](designs/modules/ras-runtime.md) | L1 门面、旁路 push 边界、trace/delivery 锚点 |
| [platform-adapter.md](designs/modules/platform-adapter.md) | L2/L3 挂载、多平台能力矩阵、HostControl、加平台 checklist |

### 特性

| 文档 | 内容 | 状态 |
|------|------|------|
| [repeat-tool.md](designs/features/repeat-tool.md) | 工具重复死循环检测与恢复 | 已落地 |
| [thinking-loop.md](designs/features/thinking-loop.md) | LLM 思考/文本死循环检测与恢复 | 已落地 |
| [stream-abort.md](designs/features/stream-abort.md) | 环内打断 `llm.stream` | 已落地 |
| [provider-disconnect.md](designs/features/provider-disconnect.md) | Provider 断连停推理能力调研 | 已完成 |
| [analysis-paralysis.md](designs/features/analysis-paralysis.md) | 分析瘫痪二阶段检测 | 规划中 |
| [planning-error.md](designs/features/planning-error.md) | 策略层规划错误检测 | 规划中 |
| [opencode-xiaoo-integration.md](designs/features/opencode-xiaoo-integration.md) | OpenCode / xiaoO 平台接入：共享骨架、采点/Host、⓪ Trace、机制差异与 FI 边界 | 已落地 |
| [capability-config.md](designs/features/capability-config.md) | 能力配置：目录解耦（PLUGIN presentation + catalog API）+ 多平台可选同步；模板 `agent_ras_config.default.yaml` | 已落地 |
| [Agent RAS 可靠性闭环-服务端与客户端交互设计.md](designs/features/Agent%20RAS%20可靠性闭环-服务端与客户端交互设计.md) | 可靠性闭环：常驻客户端、configRef 控制面、Trace 异常维度、可靠性数据集与评估器 | 部分落地（评测集/IF-N16/FI 外挂/Trace anomaly/ExperimentCase FI 独立列） |
| [reliability-client-control-plane.md](designs/features/reliability-client-control-plane.md) | 客户端控制面：统一安装、systemd/launchd 保活、配置下发、WSS 双向通信；新客户端吸收 FI Worker | 开发中 |
| [fault-domain-plugins.md](designs/features/fault-domain-plugins.md) | 故障域插件化：`detectors`/`review`/`recovery` 三平级扫描 PLUGIN；P3 共同文件只留 yaml | **已落地（P0–P3）** |
| [ras-reliability-evaluator-split.md](designs/features/ras-reliability-evaluator-split.md) | 可靠性评估器拆分：故障注入与故障检测恢复独立选择、评估器总分平均与历史兼容 | 代码与自动化验证完成，浏览器验收待确认 |

---

## guides/ — 使用

| 文档 | 内容 |
|------|------|
| [getting-started.md](guides/getting-started.md) | 选平台、安装、配置目录与常用开关、Insight 同步 |
| [local-install-process.md](guides/local-install-process.md) | **curl / install-ras 时本机逐步发生了什么**（数据源、目录树、预检、排障） |
| [platform-openjiuwen.md](guides/platform-openjiuwen.md) | openjiuwen / jiuwenclaw 深挂载与 YAML 片段 |
| [platform-opencode.md](guides/platform-opencode.md) | OpenCode `install-ras` 同进程接入 |
| [platform-xiaoo.md](guides/platform-xiaoo.md) | xiaoO hooks + Daemon SSE 闭环验收 |

---

## 本仓其它（非本树）

| 主题 | 入口 |
|------|------|
| Insight「AgentRAS 可靠性」UI | [docs/design/reliability-standalone-ui](../design/reliability-standalone-ui/) |
| RAS 旁路 ingest API 契约 | [developer-guide/09-otlp-attribute-contract.md](../developer-guide/09-otlp-attribute-contract.md) |
| **故障注入 / 与 Insight·RAS 关系** | [docs/agent-fault-injection/](../agent-fault-injection/) · [关系设计说明](../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md) |
| 源码与安装 | [`agent_ras/README.md`](../../agent_ras/README.md) |
