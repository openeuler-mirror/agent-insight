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
 *   2. `aggregateTrajectoryScore` —— 轨迹分【加权 + 严重度封顶】的唯一真源（纯代码侧），
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
    comparisonMode?: 'trajectory' | 'skill_key_actions';
    evaluationFocus?: string;

    actualInteractions: any[];
    taskId?: string;
    executionId?: string;
}

export interface TrajectoryDimensionScores {
    completeness: number;
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
     * 偏差归属维度/因子，用于展示与封顶解释：
     * completeness | tool_choice | redundancy | error_recovery | grounding | other。
     * error_recovery / grounding 不是独立加权维度，只通过 severity 影响封顶。
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

export interface TrajectoryEvalOutput {
    trajectoryScore: number;
    dimensionScores: TrajectoryDimensionScores;
    deviationSteps: TrajectoryDeviationStep[];
    rootCauseStep?: string;
    reasonText: string;
    /** 封顶前的纯加权分（completeness/tool_choice/redundancy 加权和）。 */
    rawWeightedScore?: number;
    /** 严重度封顶信息：是否触发、上限、原因、封顶前后分数。 */
    cap?: TrajectoryCapInfo;
    rawAnalysis: any;
}

/**
 * 轨迹分加权权重（v2）。
 *  - attribution 不再计入（只用于根因定位展示）。
 *  - error_recovery / grounding 不作为独立加权维度，而是通过 deviation_steps 的 severity
 *    影响"严重度封顶"。
 */
export const TRAJECTORY_WEIGHTS = {
    completeness: 0.45,
    toolChoice: 0.35,
    redundancy: 0.20,
} as const;

export interface TrajectoryCapInfo {
    /** 是否触发了封顶规则（high≥1 或 medium≥3）。 */
    triggered: boolean;
    /** 触发后是否真的把分数压低了（rawWeighted 本就低于上限时为 false）。 */
    effective: boolean;
    /** 封顶上限；未触发为 null。 */
    ceiling: number | null;
    /** 触发原因（含 high/medium 计数）的中文说明。 */
    reason: string;
    /** 封顶前的加权分。 */
    rawWeightedScore: number;
    /** 封顶后的最终轨迹分。 */
    finalScore: number;
    highCount: number;
    mediumCount: number;
}

/**
 * 轨迹分聚合层（代码侧，唯一真源）。
 *
 * LLM 只负责输出 3 个维度分（completeness / tool_choice / redundancy）和带 severity 的
 * deviation_steps；最终轨迹分的【加权 + 严重度封顶】一律在这里算，保证 opencode 主路径与
 * direct fallback、以及未来 analyze-match 确定性对齐都走同一套口径。
 *
 * 封顶规则（min(加权分, 上限)）：
 *   - 存在 ≥1 个 high 偏差 → 上限 0.40（关键步骤缺失 / 方向性错误 / 不可逆后果）。
 *   - 无 high 但 ≥3 个 medium 偏差 → 上限 0.65（多处明显绕路 / 次优）。
 *   - 否则不封顶。
 */
export function aggregateTrajectoryScore(
    dims: { completeness: number; toolChoice: number; redundancy: number },
    deviations: TrajectoryDeviationStep[],
): { trajectoryScore: number; rawWeightedScore: number; cap: TrajectoryCapInfo } {
    const c = clamp01(dims.completeness);
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

    let ceiling: number | null = null;
    let reason = '';
    if (highCount >= 1) {
        ceiling = 0.4;
        reason = `存在 ${highCount} 个 high 严重度偏差（关键步骤缺失 / 方向性错误 / 不可逆后果 / 阻塞错误未恢复 / 基于幻觉行动），轨迹分封顶 0.40。`;
    } else if (mediumCount >= 3) {
        ceiling = 0.65;
        reason = `无 high 偏差，但存在 ${mediumCount} 个 medium 严重度偏差（≥3，多处明显绕路 / 次优），轨迹分封顶 0.65。`;
    } else {
        reason = `无 high 偏差且 medium 偏差仅 ${mediumCount} 个（<3），不触发封顶。`;
    }

    const finalScore = ceiling != null ? Math.min(rawWeightedScore, ceiling) : rawWeightedScore;
    const effective = ceiling != null && finalScore < rawWeightedScore;

    return {
        trajectoryScore: clamp01(finalScore),
        rawWeightedScore,
        cap: {
            triggered: ceiling != null,
            effective,
            ceiling,
            reason: effective
                ? reason
                : ceiling != null
                ? `${reason}（但加权分 ${rawWeightedScore.toFixed(3)} 本就不高于上限，最终分未被进一步压低。）`
                : reason,
            rawWeightedScore,
            finalScore: clamp01(finalScore),
            highCount,
            mediumCount,
        },
    };
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
