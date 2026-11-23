# 仪表盘可靠性与性能拆分

> 状态：开发完成，待 UI 验收
> 日期：2026-08-20
> 范围：仪表盘页签、舰队性能聚合、RAS 可靠性聚合、Trace 下钻

## 1. 目标

将仪表盘原「可靠性与性能」页签拆为两个独立页签：

- 「可靠性」基于根 Trace 与 `RasAnomalyEvent` 聚合故障检测和恢复情况，同时保留 Execution/Judge 失败分析作为补充。
- 「性能」承接原页签中的端到端时延、单次调用上下文峰值和慢 Trace 排行。

不修改侧边栏 `/quality` 对应的「可靠性与性能」模块名称，也不改变 Trace 详情既有可靠性状态展示。

## 2. 已确认口径

### 2.1 Trace 与故障

- 统计对象为当前用户、当前时间窗口内的根 `Execution`，SubAgent 行不单独进入分母。
- 同一根 Trace 通过 `taskId` 关联 RAS 事件；事件继续按 `taskId + deliveryId` 去重。
- 存在至少一条 `type=anomaly` 事件的 Trace 计为「有故障」。
- 不存在 anomaly 的 Trace 计为「无故障」，包括 Trace 列表当前标记为 `anomalyStatus=unknown` 的记录。
- 故障率 = 有故障根 Trace 数 / 全部根 Trace 数。

### 2.2 恢复结果

- `recoveryOutcome=success` 计为「已恢复」。
- 已检测到 anomaly、但恢复结果为 `failed`、`unknown` 或 `none`，统一计为「未恢复」。
- 恢复率 = 已恢复故障 Trace 数 / 全部故障 Trace 数。
- 不展示高保真示例中的「已阻断」，不从故障注入实验状态反推普通 Trace 的处置结果。

### 2.3 故障级别

- 保留「故障级别占比」图。
- 每条故障 Trace 取其 anomaly 的最高 `severity`；等级为 `critical/high/medium/low`。
- 没有 anomaly 的 Trace 进入「正常」。
- 有 anomaly 但 severity 缺失的 Trace 进入「未标注」，不伪造级别。
- 近期故障 Trace 表不展示严重度列。

### 2.4 不开发项

- 不展示「检测阶段」。
- 不展示 L1/L2/L3 检测层级，避免把 thinking-loop 的 evidence mode 与 RAS 架构层级混淆。
- 不新增「已阻断」状态。
- 不改 Prisma schema；使用现有 `Execution`、`RasAnomalyEvent` 和 RAS 汇总逻辑。

## 3. 页面结构

仪表盘页签顺序：

`系统趋势 → 可靠性 → 性能 → 模型监控 → 工具监控 → Agent 监控 → 多智能体编排`

### 3.1 可靠性

可靠性页提供时间窗口、平台和 Agent 作用域，展示：

1. KPI：总调用链、故障率、恢复率、未恢复故障。
2. 故障与恢复趋势：按桶统计首次检测到故障的 Trace 数与恢复成功 Trace 数。
3. 恢复结果分布：已恢复、未恢复。
4. 故障级别占比：严重、高危、中危、低危、正常、未标注。
5. 故障模式 Top：按 Trace 去重统计 anomaly kind，并区分已恢复/未恢复。
6. 各 Agent 可靠性：调用链数、故障率、恢复率。
7. 执行失败补充：保留「失败热点 · Agent」和「失败原因分类」，来源分别为 Execution 失败口径及工具硬错误/Judge 判定，不参与 RAS KPI。
8. 近期故障调用链：`Trace / Agent / 平台 / 故障模式 / 处置结果 / 时间 / 操作`，下钻 `/trace?taskId=...`。

平台优先使用 RAS event platform，缺失时回退根 Execution framework；Agent 使用根 Execution agentName。平台和 Agent 选项从当前窗口真实数据动态生成，不硬编码框架列表。

### 3.2 性能

性能页展示：

1. 端到端时延分布及 P50/P95 标线。
2. 单次调用上下文峰值分布。
3. 慢 Trace 排行，补充平台列，并保留现有模型调用数、模型调用均耗时和 Agent 数诊断列。

## 4. API 与模块边界

新增 `GET /api/fleet/reliability`，支持 `window`、`user`、可选 `platform` 与可选 `agent`。

新增纯聚合模块 `src/lib/fleet/reliability.ts`，负责把根 Trace、去重后的 RAS 事件和 callStats 汇总成稳定响应。路由只负责鉴权、查询和序列化。

原 `/api/fleet/breakdowns` 将旧 `reliability` 响应字段改为 `performance`，只保留时延、上下文峰值和慢 Trace。模型、工具、Agent、编排契约不变。

前端对可靠性接口独立懒加载和缓存。切换平台/Agent 只刷新可靠性数据，不重新计算其他页签；全局时间窗口变化时清空两个聚合缓存并重取当前页签数据。

## 5. 验收

1. 原「可靠性与性能」拆为相邻的「可靠性」「性能」页签，其他页签行为不回归。
2. 无 anomaly 的根 Trace（含 anomalyStatus unknown）进入无故障和正常统计。
3. 同一 Trace 多条事件不会重复放大总 Trace、故障 Trace或恢复 Trace。
4. 恢复 success 计已恢复，其余已故障 Trace 计未恢复；页面无「已阻断」。
5. 故障级别按 Trace 最高 severity 聚合，近期故障表不含严重度和检测阶段列。
6. 平台和 Agent 筛选同时作用于 RAS 主体与执行失败补充，且不越过当前用户作用域。
7. 失败热点与失败原因保留原数据源，并明确标注为执行失败补充，不进入 RAS KPI。
8. 性能页保持原时延、上下文峰值和慢 Trace 数据及下钻能力，并补充平台列。
9. 无 RAS 事件、只有 RAS 事件、恢复失败或缺结果、severity 缺失等边界均有稳定空态和单元测试。
