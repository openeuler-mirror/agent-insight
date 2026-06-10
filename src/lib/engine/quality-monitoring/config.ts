// 质量监控 — 设计标定参数（集中可配置常量）。
// 默认值取设计规格 §6.3 的 v3.1 参考值；标注「待标定」者由后续设计/实测校准。
// 严禁在此引入任何百分位/同类阈值（BR-006）。

import type { ScoringPolicy, Priority } from './types';

export const DEFAULT_POLICY: ScoringPolicy = {
    // 综合分加权（BR-010）；和为 1。
    weights: { P0: 0.55, P1: 0.30, P2: 0.15 },
    // 绝对状态阈值（BR-006/010，无百分位）：≥85 达标 / 70–85 关注 / <70 异常。
    status: { 达标: 85, 关注: 70 },
    // 样本不足降级阈值（BR-007）；待标定。
    thetaSample: 5,
    // 趋势桶数目标区间（BR-008）；自定义窗口用，1d/1w/1m 走固定粒度。
    bucket: { min: 20, max: 40 },
    // 重算响应时延目标（NFR-003）；待标定。
    slaRefreshMs: 3000,
    // judge/轨迹采样率与预算（NFR-001）；待标定。
    sample: { rate: 0.2, budget: 20 },
    // 成本归一基线（预算/SLO 固定上限）：超过即成本 0 分（"失控烧钱"）。待标定。
    costBudget: { latencyMs: 120_000, tokens: 200_000, steps: 60 },
};

/**
 * 指标 → 维度 + 优先级 映射。
 * - 综合分按 priority 分层加权（P0/P1/P2）；
 * - 四维卡片按 dim 分组（result/process/cost/error）。
 * MVP 落地：P0 全部可由确定性信号 + 已落库 judge 给分；P1（轨迹细分）依赖 join，覆盖率随之标注；
 * P2（用户挫败）第二阶段补全（§8.3）。
 */
export type MetricKey =
    | 'completion' | 'safety'            // result / P0
    | 'toolCorrectness'                  // process / P0
    | 'cost'                             // cost / P0
    | 'planEfficiency'                   // process / P1（轨迹冗余/完整性派生）
    | 'constraintAdherence'              // process / P1（System-prompt 全量 + Skill 条件触发）
    | 'toolGrounding';                   // process / P1（轨迹归因派生）

export const METRIC_REGISTRY: Record<MetricKey, {
    label: string; labelEn: string; dim: 'result' | 'process' | 'cost'; priority: Priority;
}> = {
    completion:          { label: '任务完成度', labelEn: 'Completion',           dim: 'result',  priority: 'P0' },
    safety:              { label: '安全',       labelEn: 'Safety',               dim: 'result',  priority: 'P0' },
    toolCorrectness:     { label: '工具选择与参数正确性', labelEn: 'Tool Selection + Args', dim: 'process', priority: 'P0' },
    cost:                { label: '成本',       labelEn: 'Cost',                 dim: 'cost',    priority: 'P0' },
    planEfficiency:      { label: '计划遵循与步骤效率', labelEn: 'Plan + Step Efficiency', dim: 'process', priority: 'P1' },
    constraintAdherence: { label: '约束遵循',   labelEn: 'Instruction & Skill Adherence', dim: 'process', priority: 'P1' },
    toolGrounding:       { label: '工具输出归因', labelEn: 'Tool Output Grounding', dim: 'process', priority: 'P1' },
};

/** 超大 T 上限：超过即对窗口内 records 采样并标注 truncated（§7.2，宁可标注也不超时）。 */
export const MAX_TRACES = 5000;
/** 问题汇总结构化错误重解析的 trace 上限（仅对含错误信号的样本解析交互，控成本）。 */
export const MAX_ERROR_PARSE_TRACES = 400;
/** /report 返回的问题项上限（按影响度取头部；动态 dedupKey 近乎逐条唯一，不封顶会把 payload 撑爆）。 */
export const MAX_PROBLEM_ITEMS = 100;
