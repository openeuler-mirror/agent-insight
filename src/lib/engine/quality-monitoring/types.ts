// 质量监控（Quality Monitoring）领域引擎 — 内存数据契约（非持久化）。
// 字段形状对齐 docs/design/quality-monitoring/quality-monitoring-design.md §5.2。
// 引擎为纯聚合函数：collect → problem → score(错误维消费问题汇总) → trend。

import type { FailureItem, SkillImprovementItem } from '@/lib/engine/evaluation/judge';

/** 质量维度 / 综合状态：按绝对阈值判定（不含任何百分位/同类）。 */
export type QualityStatus = '达标' | '关注' | '异常';

/** 优先级分层：综合分按 P0/P1/P2 加权（BR-010）。 */
export type Priority = 'P0' | 'P1' | 'P2';

/** 问题归因标签：决定治理派单方向（DC-008）。 */
export type Attribution = 'agent逻辑' | '模型能力' | '工具&infra' | '外部输入';

/** 严重度。 */
export type Severity = 'high' | 'medium' | 'low';

/**
 * TraceLite —— collectTraces 产出、聚合函数共同消费的中心契约（投影 DTO）。
 * 缺失字段保持 undefined，不臆造（NFR-002）。
 */
export interface TraceLite {
    executionId: string;
    taskId?: string;
    ts: string | Date;
    agentName?: string;
    framework?: string;
    model?: string;
    query?: string;

    toolCallErrorCount?: number;
    failures?: FailureItem[];          // 解析自 Execution.failures(JSON)

    // 过程维（确定性 + join 轨迹）
    toolCallCount?: number;
    llmCallCount?: number;
    stepCount?: number;
    trajectory?: TrajectoryLite | null; // join TrajectoryEvalResult
    skillTriggerRate?: number | null;
    invokedSkills?: { name: string; version: number | null }[];

    // 成本维（原始量，必有）
    tokens?: number;
    cost?: number;
    latency?: number;

    // 问题来源
    skillIssues?: SkillImprovementItem[]; // 解析自 Execution.skillIssues(JSON)

    // 安全（命中即 0）
    safety?: 0 | 1;
}

export interface TrajectoryLite {
    score: number;                      // 0–1
    dims: {
        completeness?: number | null;   // 0–1
        toolChoice: number;             // 0–1
        redundancy: number;             // 0–1
        attribution?: number | null;    // 0–1（仅展示，不计权）
    };
}

/** 单维评分：附逐维覆盖率与有效样本量（NFR-002/006）。 */
export interface DimScore {
    score: number;            // 0–100
    status: QualityStatus;
    coverage: number;         // ∈[0,1] 有效样本 / 总样本
    n: number;                // 有效样本量
    signal?: string;          // 一句诊断
    /** 该维下细分指标（用于过程维子条 / 卡片明细）。 */
    metrics?: MetricScore[];
}

export interface MetricScore {
    key: string;
    label: string;
    priority: Priority;
    score: number | null;     // null = N/A（不计入分母，BR-005）
    coverage: number;
    n: number;
    /** 条件触发型指标（如 Skill 遵从）标注口径，例 "条件触发 · 32/265"。 */
    note?: string;
    confidence?: number;
    methodBreakdown?: Record<string, number>;
    naReason?: string;
    evidence?: Array<{
        executionId: string;
        reason: string;
        score?: number | null;
        confidence?: number;
        detail?: Record<string, unknown>;
    }>;
}

export interface CompositeScore {
    score: number;            // 0–100
    status: QualityStatus;
    p0: number | null;
    p1: number | null;
    p2: number | null;
    /** P0 硬阈值命中 → 封顶降级标红（BR-004/010）。 */
    capped: boolean;
    cappedReason?: string;
}

/** 趋势桶。二值取比率、连续量取分位（BR-009）。 */
export interface TrendBucket {
    bucket_ts: string;
    n_traces: number;
    ratios: Record<string, number | null>;                            // 0–100；null = 该桶无有效观测数据
    percentiles: Record<string, { p50: number; p90: number; p95: number }>;
    composite: number;
    errorCount: number;
    anomaly?: boolean;
    /** 样本不足 → 置灰标置信度不足（BR-007）。 */
    lowConfidence?: boolean;
}

export type TrendGranularity = 'hour' | 'day' | 'week';

/** 问题项关联的 Skill 资产（来自 SkillIssue 表，用于「去优化」路由到 skill-opt）。 */
export interface SkillRef {
    name: string;
    version: number | null;
}

/** 已诊断 trace 的根因摘要（join AgentDebugReport.reportJson 的精简投影）。 */
export interface DiagnosisLite {
    /** 根因认知模块：memory | reflection | planning | action | system | others。 */
    module: string;
    /** triage 分类（infra/tool_systemic 等，归因投票时优先于模块映射）。 */
    category?: string;
    errorType?: string;
    summary?: string;
    /** 修复指引（rootCause.correctionGuidance 或 fatalDiagnosis.recommendation）。 */
    guidance?: string;
    confidence?: number;
}

/** 统一问题汇总项（DC-009 / §4.3）。 */
export interface ProblemItem {
    key: string;
    desc: string;
    source: '错误' | '评测';
    affectedDimensions: string[];
    frequency: number;
    severity: Severity;
    attribution: Attribution;
    relatedTraces: string[];          // executionId[]
    impact: number;                   // 排序键 = 频次×严重度/受影响维度
    cumulativePct?: number;           // 帕累托累计占比（0–100）
    /** 节点类型（错误来源，BR-012：节点×错误码×对象）。 */
    node?: string;
    suggestedFix?: string;
    /** 来自 SkillIssue 表的问题带 skill 归属 → 问题卡可一键「去优化」。 */
    skillRef?: SkillRef;
    /** 簇内已诊断 trace 的多数根因模块（来自 AgentDebugReport 投票）。 */
    rootCauseModule?: string;
    /** 簇内已诊断 trace 数（>0 时问题卡显示「已诊断」徽章）。 */
    diagnosedTraces?: number;
}

/** Skill 拖累榜行：「哪个 skill 在拖累这个 Agent」（复用 SkillIssue 表聚合）。 */
export interface SkillDragItem {
    name: string;
    version: number | null;
    /** 窗口内关联到 T 的未解决问题数（按 dedupKey 去重）。 */
    unresolved: number;
    topSeverity: Severity;
    /** T 中调用该 skill（或其评测覆盖）的 trace 数与占比。 */
    affectedTraces: number;
    affectedPct: number;              // 0–100
    /** 排序键：未解决问题的严重度加权和。 */
    dragScore: number;
}

/** /report 返回体。 */
export interface QualityReport {
    composite: CompositeScore;
    dimensions: {
        process: DimScore;
        cost: DimScore;
        error: DimScore;
    };
    trend: { granularity: TrendGranularity; buckets: TrendBucket[] };
    problems: ProblemItem[];          // 已按影响度排序
    /** 错误聚类的节点分布（FR-009）。 */
    errorNodeDistribution: { node: string; count: number; pct: number }[];
    /** Skill 拖累榜（按 dragScore 降序）；窗口内无 skill 问题时为空数组。 */
    skillDrag: SkillDragItem[];
    /** 问题全量计数（problems 数组按影响度封顶返回，计数用此处全量值，防徽章失真）。 */
    problemCounts: { error: number; eval: number; total: number; errorEvents: number };
    /** 根因模块分布（已诊断 trace 的 rootCause.criticalModule 聚合；诊断覆盖 0 时为空）。 */
    moduleFingerprint: { module: string; count: number; pct: number }[];
    /** 诊断覆盖：T 中已诊断 trace 数 / 含错误信号的 trace 数。 */
    diagnosisCoverage: { diagnosed: number; errorish: number };
    meta: {
        n: number;
        empty: boolean;
        lowSample: boolean;
        window: string;
        from: string;
        to: string;
        agent: string;
        filters?: Record<string, unknown>;
        truncated?: boolean;          // 超大 T 采样降级（§7.2）
    };
}

export interface QualityReportInput {
    user: string | null;
    agent: string;
    window: WindowKind;
    from: Date;
    to: Date;
    filters?: { skill?: string };
}

export type WindowKind = '1d' | '1w' | '1m' | 'custom';

/** 评分策略（设计标定参数，集中于 config.ts）。 */
export interface ScoringPolicy {
    weights: { P0: number; P1: number; P2: number };
    status: { 达标: number; 关注: number };   // 绝对阈值：≥达标→达标；≥关注→关注；否则异常
    thetaSample: number;
    bucket: { min: number; max: number };
    slaRefreshMs: number;
    /** 成本归一基线（预算/SLO 上限），超过即 0 分（"是否失控烧钱"）。 */
    costBudget: { latencyMs: number; tokens: number; steps: number };
}

export interface QualityAgentInfo {
    name: string;
    platform?: string | null;
    ownership?: string | null;
    traceCount?: number;
    lastSeen?: string | null;
}
