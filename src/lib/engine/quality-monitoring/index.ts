// buildQualityReport — 报告编排入口。
// 调用序（设计 §6.2）：collectTraces → buildProblemSummary（先于错误维）
//   → scoreDimensions（消费问题汇总产出错误维）→ bucketTrends → 组装 QualityReport。
// 请求路径只读，绝不触发采样/回填（解耦，见 sampling.ts）。

import { prisma } from '@/lib/storage/prisma';
import type { QualityReport, QualityReportInput, WindowKind, ScoringPolicy, DimScore } from './types';
import { DEFAULT_POLICY, MAX_ERROR_PARSE_TRACES, MAX_PROBLEM_ITEMS } from './config';
import { collectTraces } from './trace-collector';
import { scoreDimensions } from './dimension-scorer';
import { bucketTrends } from './trend-bucketer';
import {
    buildProblemSummary, lowScoreProblems, rankProblems, buildSkillDrag, summarizeDiagnoses,
    type SkillIssueRowLite,
} from './problem-summary';
import type { DiagnosisLite } from './types';

const EMPTY_DIM: DimScore = { score: 0, status: '异常', coverage: 0, n: 0 };

function emptyReport(input: QualityReportInput): QualityReport {
    return {
        composite: { score: 0, status: '异常', p0: 0, p1: 0, p2: null, capped: false },
        dimensions: { result: EMPTY_DIM, process: EMPTY_DIM, cost: EMPTY_DIM, error: EMPTY_DIM },
        trend: { granularity: input.window === '1d' ? 'hour' : 'day', buckets: [] },
        problems: [],
        errorNodeDistribution: [],
        skillDrag: [],
        problemCounts: { error: 0, eval: 0, total: 0, errorEvents: 0 },
        moduleFingerprint: [],
        diagnosisCoverage: { diagnosed: 0, errorish: 0 },
        coverage: { judged: 0, total: 0, perDimension: {} },
        meta: {
            n: 0, passRate: 0, empty: true, lowSample: true, window: input.window,
            from: input.from.toISOString(), to: input.to.toISOString(),
            agent: input.agent, filters: input.filters,
        },
    };
}

/** 加载 T 范围内的未解决 SkillIssue（经 Evaluation.executionId 关联；失败降级为空，不影响读路径）。 */
async function loadSkillIssueRows(executionIds: string[]): Promise<SkillIssueRowLite[]> {
    if (!executionIds.length) return [];
    try {
        const rows = await prisma.skillIssue.findMany({
            where: { resolvedAt: null, Evaluation: { executionId: { in: executionIds } } },
            select: {
                dedupKey: true, severity: true, summary: true, suggestedFix: true,
                category: true, version: true,
                Skill: { select: { name: true } },
                Evaluation: { select: { executionId: true } },
            },
        });
        type Row = {
            dedupKey: string; severity: string; summary: string; suggestedFix: string | null;
            category: string | null; version: number | null;
            Skill: { name: string } | null; Evaluation: { executionId: string | null } | null;
        };
        return (rows as Row[]).map((r) => ({
            dedupKey: r.dedupKey,
            severity: r.severity,
            summary: r.summary,
            suggestedFix: r.suggestedFix,
            category: r.category,
            version: typeof r.version === 'number' ? r.version : null,
            skillName: r.Skill?.name ?? '',
            executionId: r.Evaluation?.executionId ?? null,
        })).filter((r) => r.skillName);
    } catch (e) {
        console.warn('[quality] skillIssue join failed, falling back to JSON snapshot only:', e);
        return [];
    }
}

/**
 * 加载 T 范围内已完成的智能诊断报告（join AgentDebugReport，status=done），
 * 解析 reportJson 为 DiagnosisLite。失败/表缺失降级为空 Map，不影响读路径。
 */
async function loadDiagnoses(executionIds: string[]): Promise<Map<string, DiagnosisLite>> {
    const map = new Map<string, DiagnosisLite>();
    if (!executionIds.length) return map;
    try {
        const rows = await prisma.agentDebugReport.findMany({
            where: { executionId: { in: executionIds }, status: 'done' },
            select: { executionId: true, reportJson: true },
        });
        for (const r of rows) {
            if (!r.reportJson) continue;
            try {
                const p = JSON.parse(r.reportJson);
                const rc = p?.rootCause;
                const fatal = p?.triage?.fatalDiagnosis;
                if (!rc && !fatal) continue;
                map.set(r.executionId, {
                    module: rc?.criticalModule ?? 'system',
                    category: p?.triage?.category,
                    errorType: rc?.criticalErrorType ?? fatal?.errorType,
                    summary: rc?.summary ?? fatal?.summary,
                    guidance: rc?.correctionGuidance ?? fatal?.recommendation,
                    confidence: typeof rc?.confidence === 'number' ? rc.confidence : undefined,
                });
            } catch { /* 单条解析失败跳过 */ }
        }
    } catch (e) {
        console.warn('[quality] agentDebugReport join failed, diagnosis enrichment skipped:', e);
    }
    return map;
}

/** 为含错误信号的 trace 批量加载原始 interactions（按需，控成本）。 */
async function loadInteractions(taskIds: string[]): Promise<Map<string, unknown[]>> {
    const map = new Map<string, unknown[]>();
    if (!taskIds.length) return map;
    try {
        const sessions = await prisma.session.findMany({
            where: { taskId: { in: taskIds } },
            select: { taskId: true, interactions: true },
        });
        for (const s of sessions) {
            if (!s.taskId || !s.interactions) continue;
            try {
                const arr = JSON.parse(s.interactions);
                if (Array.isArray(arr)) map.set(s.taskId, arr);
            } catch { /* skip malformed */ }
        }
    } catch (e) {
        console.warn('[quality] interactions load failed, structured errors degraded:', e);
    }
    return map;
}

export async function buildQualityReport(
    input: QualityReportInput,
    policy: ScoringPolicy = DEFAULT_POLICY,
): Promise<QualityReport> {
    // 1. 圈定 T
    const { traces, truncated } = await collectTraces({
        user: input.user, agent: input.agent, from: input.from, to: input.to, filters: input.filters,
    });
    if (!traces.length) return emptyReport(input);

    // 2. 按需加载交互（仅含错误信号的 trace，且封顶）+ SkillIssue 表行（并行）
    const errorish = traces
        .filter((t) => (t.toolCallErrorCount ?? 0) > 0 || (t.failures?.length ?? 0) > 0)
        .slice(0, MAX_ERROR_PARSE_TRACES);
    const [interactionsByTrace, skillIssueRows, diagnosesByTrace] = await Promise.all([
        loadInteractions(errorish.map((t) => t.taskId).filter((x): x is string => Boolean(x))),
        loadSkillIssueRows(traces.map((t) => t.executionId)),
        loadDiagnoses(traces.map((t) => t.executionId)),
    ]);

    // 3. 统一问题汇总（先于错误维）+ 诊断增强 + Skill 拖累榜
    const summary = buildProblemSummary({ traces, interactionsByTrace, skillIssueRows, diagnosesByTrace });
    const skillDrag = buildSkillDrag(skillIssueRows, traces);
    const { moduleFingerprint, diagnosisCoverage } = summarizeDiagnoses(traces, diagnosesByTrace);

    // 4. 四维 + 综合（错误维由问题汇总反哺）
    const scored = scoreDimensions(traces, policy, summary.errorSummary);

    // 5. 追加低分维度问题 → 统一排序 + 帕累托；按影响度封顶返回，全量计数单独带回
    const lowDim = lowScoreProblems(scored.dimensions, policy.status.关注);
    const ranked = rankProblems([...summary.problems, ...lowDim]);
    const problemCounts = {
        error: ranked.filter((p) => p.source === '错误').length,
        eval: ranked.filter((p) => p.source === '评测').length,
        total: ranked.length,
        errorEvents: summary.errorSummary.errorEventCount,
    };
    const problems = ranked.slice(0, MAX_PROBLEM_ITEMS);

    // 6. 趋势分桶
    const trend = bucketTrends({ traces, window: input.window, from: input.from, to: input.to, policy });

    const n = traces.length;
    const perTraceResultScores = traces.map((trace) => {
        const values = Object.values(trace.resultMetrics ?? {})
            .filter((metric) => metric?.status === 'done' && metric.score != null)
            .map((metric) => metric!.score as number);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }).filter((score): score is number => score != null);
    const passRate = perTraceResultScores.length
        ? Math.round((perTraceResultScores.filter((score) => score >= policy.status.达标).length / perTraceResultScores.length) * 1000) / 10
        : 0;
    return {
        composite: scored.composite,
        dimensions: scored.dimensions,
        trend,
        problems,
        errorNodeDistribution: summary.errorNodeDistribution,
        skillDrag,
        problemCounts,
        moduleFingerprint,
        diagnosisCoverage,
        coverage: scored.coverage,
        meta: {
            n,
            passRate,
            empty: false,
            lowSample: n < policy.thetaSample,
            window: input.window,
            from: input.from.toISOString(),
            to: input.to.toISOString(),
            agent: input.agent,
            filters: input.filters,
            truncated,
        },
    };
}

/** 由 window + now 解析 [from,to]；custom 用显式 from/to。 */
export function resolveWindowRange(
    window: WindowKind, now: Date, fromISO?: string | null, toISO?: string | null,
): { from: Date; to: Date } {
    const to = new Date(now);
    if (window === 'custom') {
        const from = fromISO ? new Date(fromISO) : new Date(now.getTime() - 7 * 86_400_000);
        const t = toISO ? new Date(toISO) : to;
        return { from, to: t };
    }
    const days = window === '1d' ? 1 : window === '1w' ? 7 : 30;
    const from = new Date(now.getTime() - days * 86_400_000);
    return { from, to };
}

export { DEFAULT_POLICY } from './config';
export type { QualityReport, QualityReportInput, WindowKind } from './types';
