# Agent RAS 文档

Agent RAS（Reliability / Anomaly / Stewardship）相关文档的**统一入口**。源码仍在仓根 [`agent_ras/`](../../agent_ras/)。

## 文档布局

```text
docs/agent-ras/
  architecture/   # 运行时架构、能力矩阵、多平台挂载分析
  design/         # 需求设计 phase1～3（包级基线 + 功能需求）
  guides/         # 实现指南与专题；历史文档在 guides/archive/
  contracts/      # 宿主挂载与 abort/steering 契约
  examples/       # 配置示例
```

源码旁仅保留安装/配置说明：[`agent_ras/README.md`](../../agent_ras/README.md)、[`agent_ras/config/README.md`](../../agent_ras/config/README.md)、[`agent_ras/platform_adapter/*/INSTALL.md`](../../agent_ras/platform_adapter/)。

## 架构（运行时）

| 文档 | 说明 |
|------|------|
| [architecture/ras_architecture.md](architecture/ras_architecture.md) | 四层同进程架构 |
| [architecture/capability_matrix.md](architecture/capability_matrix.md) | 多平台能力矩阵 |
| [architecture/multi_platform_mount_analysis.md](architecture/multi_platform_mount_analysis.md) | 多平台挂载分析 |

## 需求设计

完整清单见 [design/README.md](design/README.md)。摘要：

| 需求 | 目录 |
|------|------|
| 包级需求与开发计划 | [design/package-baseline/](design/package-baseline/) |
| 同进程迁入与环内监控 | [design/inproc-package-migration/](design/inproc-package-migration/) |
| AgentRAS 可靠性独立页面 | [design/reliability-standalone-ui/](design/reliability-standalone-ui/) |
| 可靠性开源生态调研 | [design/open-source-ecosystem-survey/](design/open-source-ecosystem-survey/) |
| 过度思考（Analysis Paralysis）检测 | [design/detector-analysis-paralysis/](design/detector-analysis-paralysis/) |
| 规划错误（Planning Error）检测 | [design/detector-planning-error/](design/detector-planning-error/) |
| 领域认知偏差（Domain Cognitive Bias） | [design/detector-domain-cognitive-bias/](design/detector-domain-cognitive-bias/) |

## 指南 / 契约 / 示例

| 分区 | 入口 |
|------|------|
| 实现指南 | [guides/](guides/)（权威状态：[implementation_status.md](guides/implementation_status.md)；历史文档：[guides/archive/](guides/archive/)） |
| 契约 | [contracts/](contracts/) |
| 配置示例 | [examples/](examples/) |
