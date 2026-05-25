/**
 * 评估详情共享类型。来源于 GET /api/evaluation/[id]。
 * 同时被 /evaluation/[id] 详情页 与 /skill-eval?view=static 复用。
 */

export type Severity = 'high' | 'medium' | 'low';

export interface IssueRow {
    id: string;
    evaluationId?: string;
    source?: string;
    skillId?: string;
    version?: number;
    user?: string | null;
    dedupKey?: string;
    severity: Severity;
    summary: string;
    evidence?: string | null;
    reasoning?: string | null;
    suggestedFix?: string | null;
    ruleId?: string | null;
    dimension?: string | null;
    category?: string | null;
    createdAt?: string;
}

export interface EvaluationDetail {
    evaluation: {
        id: string;
        type: 'static' | 'dynamic' | string;
        skillId?: string;
        skillName?: string | null;
        version: number;
        user?: string | null;
        executionId?: string | null;
        contentHash?: string | null;
        ranAt: string;
        status: string;
        errorMessage?: string | null;
        durationMs?: number | null;
        generator?: string | null;
        l2Scores?: {
            scores?: Record<string, number>;
            comments?: { meta?: string; code?: string };
        } | null;
    };
    execution?: {
        id: string;
        taskId: string | null;
        query: string | null;
        model: string | null;
        framework: string | null;
        timestamp: string;
    } | null;
    issues: IssueRow[];
    histogram: Record<Severity, number>;
}

export interface StaticStandard {
    key: string;
    title: string;
    desc: string;
    /** 兼容 L2 中文维度名、L1 英文枚举、历史遗留名 */
    dimensionAliases: string[];
}
