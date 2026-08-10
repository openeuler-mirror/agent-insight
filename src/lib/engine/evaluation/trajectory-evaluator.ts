/**
 * 轨迹评估 —— 类型契约 + 代码侧分数聚合层。
 *
 * 历史：本模块曾内置一套 deepagents 实现（1 个主协调 agent + 3 个 subagent + 1 个规则工具，
 * 由主 agent 把聚合 JSON 写入虚拟文件 `final_result.json`）。该实现已被
 * `opencode-trajectory-evaluator.ts`（opencode 运行时，`evaluateTrajectoryViaOpencode`）取代，
 * deepagents 引擎为无人调用的死代码，已于 2026-06-04 移除。
 *
 * 现仅保留两类被外部复用的内容：
 *   1. 轨迹评测的输入/输出类型契约 —— 被 opencode 评测器 import 并 re-export；
 *   2. `aggregateTrajectoryScore` —— 轨迹分加权聚合的唯一真源（纯代码侧），
 *      opencode 主路径、direct fallback 与归因对齐都共用同一套口径。
 *
 * 输出口径：dimensionScores + trajectoryScore + deviationSteps + rootCauseStep + reasonText。
 */

export interface TrajectoryEvalInput {
    caseId: string;
    caseInput: string;
    referenceOutput?: string;
    referenceTrajectory?: string;
    referenceKeyActionsText?: string;
    actualExtractedStepsText?: string;
    referenceKeyActions?: unknown[];
    actualExtractedSteps?: unknown[];
    skillContext?: unknown;
    comparisonMode?: 'trajectory' | 'skill_key_actions' | 'trace_only';
    evaluationFocus?: string;

    actualInteractions: any[];
    taskId?: string;
    executionId?: string;
}

export interface TrajectoryDimensionScores {
    completeness: number | null;
    toolChoice: number;
    redundancy: number;
    /**
     * 归因维度。v2 起不再计入加权轨迹分（attribution 只表示"根因是否明确"，
     * 不代表轨迹质量），因此变为可选，仅用于展示历史数据 / 根因定位结果。
     * 新版评估器不再输出该字段。
     */
    attribution?: number;
}

export interface TrajectoryDeviationStep {
    stepIndex: number;
    kind: string;
    name?: string;
    deviation: string;
    severity: 'low' | 'medium' | 'high';
    /**
     * 偏差归属维度/因子，用于展示与诊断：
     * completeness | tool_choice | redundancy | error_recovery | grounding | other。
     * error_recovery / grounding 不是独立加权维度，仅作为偏差诊断信息保留。
     */
    factor?: 'completeness' | 'tool_choice' | 'redundancy' | 'error_recovery' | 'grounding' | 'other';
    /**
     * 该偏差是否归因到 SKILL.md 写得不够清楚。
     *  - true：SKILL 里缺规则/示例/约束，需要进 skill 优化点
     *  - false：偏差是 agent 自身能力问题，跟 SKILL 无关，不入优化点列表
     * 评估器子代理输出；缺省（旧数据 / parse 失败）按 true 兜底，避免漏报。
     */
    isSkillAttributable?: boolean;
    /**
     * 当 isSkillAttributable=true 时，给出"应当在 SKILL.md 哪段加什么约束"的具体建议。
     * 直接喂给 skill-opt agent 作为优化输入。
     */
    improvementSuggestion?: string;
}

export interface KeyActionTraceAnalysisResult {
    actionId: string;
    actionContent: string;
    coverage: 'covered' | 'partial' | 'missing' | 'not_applicable';
    severity: 'low' | 'medium' | 'high';
    matchedTraceSteps: number[];
    traceComparisonAnalysis: string;
    hasSkillImprovement: boolean;
    skillImprovementSuggestion: string;
    skillIssueSummary?: string;
    skillIssueEvidence?: string;
    confidence?: number;
}

export interface TrajectoryEvalOutput {
    trajectoryScore: number;
    dimensionScores: TrajectoryDimensionScores;
    deviationSteps: TrajectoryDeviationStep[];
    keyActionResults?: KeyActionTraceAnalysisResult[];
    rootCauseStep?: string;
    reasonText: string;
    /**
     * 一句话结论（说人话、讲具体问题）——实验详情卡头默认只展示它。
     * 与 reasonText 分开：后者是「执行路径分析」绿框的正文，有固定的
     * 完整性/工具选择/冗余分段结构，不适合当结论。取不到时回落 reasonText。
     */
    conclusionText?: string;
    /** 纯加权分（completeness/tool_choice/redundancy 加权和）。 */
    rawWeightedScore?: number;
    /** 代码侧分数聚合信息：权重、严重度计数、最终分。 */
    scoreAggregation?: TrajectoryScoreAggregationInfo;
    rawAnalysis: any;
}

/**
 * 轨迹分加权权重（v2）。
 *  - attribution 不再计入（只用于根因定位展示）。
 *  - error_recovery / grounding 不作为独立加权维度，仅保留在 deviation_steps 中用于诊断。
 */
export const TRAJECTORY_WEIGHTS = {
    completeness: 0.45,
    toolChoice: 0.35,
    redundancy: 0.20,
} as const;

export interface TrajectoryScoreAggregationInfo {
    /** 聚合口径：有 Skill 时使用三维加权；无 Skill 时只使用工具选择和冗余。 */
    mode?: 'skill_key_actions' | 'trace_only' | 'trajectory';
    /** 计分说明（含 high/medium 计数）。 */
    reason: string;
    /** 维度加权分。 */
    rawWeightedScore: number;
    /** 最终轨迹分；当前等于 rawWeightedScore。 */
    finalScore: number;
    highCount: number;
    mediumCount: number;
}

type JsonRecord = Record<string, unknown>;

type TraceCallStat = {
    call: string;
    count: number;
    firstIndex: number | null;
    lastIndex: number | null;
};

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function getTraceStepCallName(step: JsonRecord): string {
    return String(
        step.name
        ?? step.call
        ?? step.toolName
        ?? step.tool
        ?? step.functionName
        ?? '',
    ).trim();
}

function getTraceStepIndex(step: JsonRecord, fallback: number): number {
    const raw = step.step_index ?? step.stepIndex ?? step.index;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function getTraceCallStats(actualSteps: unknown[]): TraceCallStat[] {
    const byCall = new Map<string, TraceCallStat>();
    for (const [fallbackIndex, raw] of actualSteps.entries()) {
        const step = asRecord(raw);
        const kind = String(step.kind || '').toLowerCase();
        if (kind !== 'tool' && kind !== 'skill' && kind !== 'task') continue;
        const call = getTraceStepCallName(step);
        if (!call) continue;
        const idx = getTraceStepIndex(step, fallbackIndex);
        const current = byCall.get(call) || { call, count: 0, firstIndex: null, lastIndex: null };
        current.count += 1;
        current.firstIndex = current.firstIndex == null ? idx : Math.min(current.firstIndex, idx);
        current.lastIndex = current.lastIndex == null ? idx : Math.max(current.lastIndex, idx);
        byCall.set(call, current);
    }
    return Array.from(byCall.values()).sort((a, b) => {
        const byCount = b.count - a.count;
        if (byCount !== 0) return byCount;
        return (a.firstIndex ?? Number.MAX_SAFE_INTEGER) - (b.firstIndex ?? Number.MAX_SAFE_INTEGER);
    });
}

function pickCallForCount(stats: TraceCallStat[], countRaw: unknown, used: Set<string>): string {
    const count = typeof countRaw === 'number' ? countRaw : Number(countRaw);
    const candidates = stats.filter(stat => !used.has(stat.call));
    const exact = Number.isFinite(count)
        ? candidates.find(stat => stat.count === count)
        : null;
    const picked = exact || candidates[0] || stats[0];
    if (!picked) return '';
    used.add(picked.call);
    return picked.call;
}

export function normalizeTrajectoryRedundancyDetails(
    parsed: JsonRecord,
    actualSteps: unknown[],
): JsonRecord {
    const details = asRecord(parsed.dimension_details ?? parsed.dimensionDetails);
    const redundancy = asRecord(details.redundancy);
    const stats = getTraceCallStats(Array.isArray(actualSteps) ? actualSteps : []);
    if (Object.keys(redundancy).length === 0 || stats.length === 0) return parsed;

    const usedHeavyCalls = new Set<string>();
    const heavy = Array.isArray(redundancy.heavy_repeated_calls)
        ? redundancy.heavy_repeated_calls.map(item => {
            const row = asRecord(item);
            const existing = getTraceStepCallName(row);
            const call = existing || pickCallForCount(stats, row.count, usedHeavyCalls);
            return call ? { ...row, call } : row;
        })
        : redundancy.heavy_repeated_calls;

    const usedRunCalls = new Set<string>();
    const consecutive = Array.isArray(redundancy.consecutive_same_runs)
        ? redundancy.consecutive_same_runs.map(item => {
            const row = asRecord(item);
            const existing = getTraceStepCallName(row);
            const call = existing || pickCallForCount(stats, row.count, usedRunCalls);
            const stat = stats.find(s => s.call === call);
            return call
                ? {
                    ...row,
                    name: call,
                    from: row.from ?? stat?.firstIndex,
                    to: row.to ?? stat?.lastIndex,
                }
                : row;
        })
        : redundancy.consecutive_same_runs;

    const nextRedundancy = {
        ...redundancy,
        ...(Array.isArray(heavy) ? { heavy_repeated_calls: heavy } : {}),
        ...(Array.isArray(consecutive) ? { consecutive_same_runs: consecutive } : {}),
    };
    const nextDetails = { ...details, redundancy: nextRedundancy };
    return {
        ...parsed,
        dimension_details: nextDetails,
    };
}

/**
 * 轨迹分聚合层（代码侧，唯一真源）。
 *
 * LLM 只负责输出 3 个维度分（completeness / tool_choice / redundancy）和带 severity 的
 * deviation_steps；最终轨迹分的加权聚合一律在这里算，保证 opencode 主路径与
 * direct fallback、以及未来 analyze-match 确定性对齐都走同一套口径。
 */
export function aggregateTrajectoryScore(
    dims: { completeness: number | null | undefined; toolChoice: number; redundancy: number },
    deviations: TrajectoryDeviationStep[],
): { trajectoryScore: number; rawWeightedScore: number; scoreAggregation: TrajectoryScoreAggregationInfo } {
    const c = clamp01(typeof dims.completeness === 'number' ? dims.completeness : 0);
    const t = clamp01(dims.toolChoice);
    const r = clamp01(dims.redundancy);
    const weighted =
        TRAJECTORY_WEIGHTS.completeness * c +
        TRAJECTORY_WEIGHTS.toolChoice * t +
        TRAJECTORY_WEIGHTS.redundancy * r;
    const rawWeightedScore = Math.round(weighted * 1000) / 1000;

    const list = Array.isArray(deviations) ? deviations : [];
    const highCount = list.filter(d => d?.severity === 'high').length;
    const mediumCount = list.filter(d => d?.severity === 'medium').length;

    const reason = `轨迹分按完整性/工具选择/冗余加权计算；严重度仅用于诊断展示（high ${highCount}，medium ${mediumCount}），不调整最终分。`;

    return {
        trajectoryScore: clamp01(rawWeightedScore),
        rawWeightedScore,
        scoreAggregation: {
            mode: 'trajectory',
            reason,
            rawWeightedScore,
            finalScore: clamp01(rawWeightedScore),
            highCount,
            mediumCount,
        },
    };
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
