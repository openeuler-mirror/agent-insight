# RAS Trace 异常展示（已落地）

可靠性观测详情页（`/agent-ras/trace/[taskId]`）用可折叠摘要条展示环内 anomaly，避免挤占完整链路首屏。

> 状态：已落地 · 原型 [`features/ras-trace-anomaly-display/prototype.html`](../../../features/ras-trace-anomaly-display/prototype.html)（方案 A）  
> 实现：[`src/components/agent-ras/RasAnomalyStrip.tsx`](../../../src/components/agent-ras/RasAnomalyStrip.tsx)  
> 用户指南：[view-traces.md](../../../user-guide/observability/view-traces.md) 可靠性观测段

## 行为摘要

| 点 | 约定 |
|----|------|
| 默认 | 摘要条**收起**，保证链路树在首屏 |
| 粒度 | **一次 anomaly 检测 = 一行**（类型、严重度、摘要、操作标签、恢复结果） |
| 合并 | 同一次故障的恢复 / 中断等操作并入该行，不拆多卡 |
| 联动 | 点选行 → 定位链路树 RAS 节点；右侧展示完整摘要与动作详情 |
| 无 Execution | 仅有 RAS 事件时不展示链路树，仍可看摘要条 |

## 非目标

- 不替代「故障诊断 / Fault」（事后 AgentDebug）
- 不在普通「链路追踪」`/trace` 列表/详情展示 RAS 徽章

## 关联

- 独立可靠性 UI 总设计：[reliability-standalone-ui](../../../design/reliability-standalone-ui/)
- RAS ingest 契约：[09-otlp-attribute-contract.md](../../../developer-guide/09-otlp-attribute-contract.md)
