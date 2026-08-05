# Agent RAS 文档

环内可靠性包 [`agent_ras/`](../../agent_ras/)：异常检测 + 自动恢复。本目录只有 **设计**（`designs/`）与 **使用**（`guides/`）。

## 先读什么

| 目的 | 打开 |
|------|------|
| 理解四层同进程与主流程 | [designs/architecture.md](designs/architecture.md) |
| **与 Insight / FI 的边界** | [../agent-fault-injection/designs/ras-fi-insight-relationship.md](../agent-fault-injection/designs/ras-fi-insight-relationship.md) |
| 改 Monitor / 检测 / 恢复 / 适配代码 | [designs/modules/](designs/modules/) 对应篇 |
| 装上并跑起来 | [guides/getting-started.md](guides/getting-started.md) |

---

## designs/ — 设计

实现状态见下方特性表「状态」列；架构与模块正文在对应文件。

### 架构

| 文档 | 内容 |
|------|------|
| [architecture.md](designs/architecture.md) | 目标与边界、L0–L3、双路径、**inproc 的 libpython 加载与文件级调用**、主流程、能力摘要 |

### 模块（改哪里）

| 文档 | 内容 |
|------|------|
| [monitor.md](designs/modules/monitor.md) | Monitor 编排、与 Rail / Detector / Recovery / L3 Reviewer 协作 |
| [detectors.md](designs/modules/detectors.md) | 检测器接入、扩展点、已有检测器摘要 |
| [recovery.md](designs/modules/recovery.md) | anomaly → wire actions → Host 投递 |
| [ras-embed.md](designs/modules/ras-embed.md) | L1 门面、旁路 push 边界、trace/delivery 锚点 |
| [platform-adapter.md](designs/modules/platform-adapter.md) | L2/L3 挂载、多平台能力矩阵、HostControl、加平台 checklist |

### 特性

| 文档 | 内容 | 状态 |
|------|------|------|
| [thinking-loop.md](designs/features/thinking-loop.md) | LLM 思考/文本死循环检测与恢复 | 已落地 |
| [stream-abort.md](designs/features/stream-abort.md) | 环内打断 `llm.stream` | 已落地 |
| [provider-disconnect.md](designs/features/provider-disconnect.md) | Provider 断连停推理能力调研 | 已完成 |
| [ecosystem-survey.md](designs/features/ecosystem-survey.md) | 开源检测/恢复生态对照 | 已完成 |
| [analysis-paralysis.md](designs/features/analysis-paralysis.md) | 分析瘫痪二阶段检测 | 规划中 |
| [planning-error.md](designs/features/planning-error.md) | 策略层规划错误检测 | 规划中 |
| [domain-cognitive-bias.md](designs/features/domain-cognitive-bias.md) | 领域认知偏差六类场景 | 规划中 |
| [xiaoo-adapter.md](designs/features/xiaoo-adapter.md) | xiaoO 协议 inproc / 入口无关（无 HTTP/SSE） | 已落地（inproc E2E） |
| [xiaoo-observe-ingest.md](designs/features/xiaoo-observe-ingest.md) | xiaoO OTel 观测（现网 OTLP + RAS join；Insight 最小侵入） | 已落地 |

---

## guides/ — 使用

| 文档 | 内容 |
|------|------|
| [getting-started.md](guides/getting-started.md) | 选平台与最短启用路径 |
| [configuration.md](guides/configuration.md) | inproc / 宿主配置目录与常用开关 |
| [platform-openjiuwen.md](guides/platform-openjiuwen.md) | openjiuwen / jiuwenclaw 深挂载与 YAML 片段 |
| [platform-opencode.md](guides/platform-opencode.md) | OpenCode `install-ras` 同进程接入 |
| [platform-xiaoo.md](guides/platform-xiaoo.md) | xiaoO 任意入口启用；daemon 可选旁路 |

---

## 本仓其它（非本树）

| 主题 | 入口 |
|------|------|
| Insight「AgentRAS 可靠性」UI | [docs/design/reliability-standalone-ui](../design/reliability-standalone-ui/) |
| RAS 旁路 ingest API 契约 | [developer-guide/09-otlp-attribute-contract.md](../developer-guide/09-otlp-attribute-contract.md) |
| **故障注入 / 与 Insight·RAS 关系** | [docs/agent-fault-injection/](../agent-fault-injection/) · [关系设计说明](../agent-fault-injection/designs/ras-fi-insight-relationship.md) |
| 源码与安装 | [`agent_ras/README.md`](../../agent_ras/README.md) |
