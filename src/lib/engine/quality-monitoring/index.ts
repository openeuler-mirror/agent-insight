// buildQualityReport — 报告编排入口。
// 调用序（设计 §6.2）：collectTraces → buildProblemSummary（先于错误维）
//   → scoreDimensions（消费问题汇总产出错误维）→ bucketTrends → 组装 QualityReport。
// 请求路径只读，绝不触发采样/回填（解耦，见 sampling.ts）。

import { prisma } from '@/lib/storage/prisma';
import type { QualityReport, QualityReportInput, WindowKind, ScoringPolicy, DimScore } from './types';
import { DEFAULT_POLICY, MAX_ERROR_PARSE_TRACES } from './config';
import { collectTraces } from './trace-collector';
import { scoreDimensions, isSuccessDeterministic } from './dimension-scorer';
import { bucketTrends } from './trend-bucketer';
import { buildProblemSummary, lowScoreProblems, rankProblems } from './problem-summary';

const EMPTY_DIM: DimScore = { score: 0, status: '异常', coverage: 0, n: 0 };

function emptyReport(input: QualityReportInput): QualityReport {
    return {
        composite: { score: 0, status: '异常', p0: 0, p1: 0, p2: null, capped: false },
        dimensions: { result: EMPTY_DIM, process: EMPTY_DIM, cost: EMPTY_DIM, error: EMPTY_DIM },
        trend: { granularity: input.window === '1d' ? 'hour' : 'day', buckets: [] },
        problems: [],
        errorNodeDistribution: [],
        coverage: { judged: 0, total: 0, perDimension: {} },
        meta: {
            n: 0, passRate: 0, empty: true, lowSample: true, window: input.window,
            from: input.from.toISOString(), to: input.to.toISOString(),
            agent: input.agent, filters: input.filters,
        },
    };
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

    // 2. 按需加载交互（仅含错误信号的 trace，且封顶），用于结构化错误重解析
    const errorish = traces
        .filter((t) => (t.toolCallErrorCount ?? 0) > 0 || (t.failures?.length ?? 0) > 0)
        .slice(0, MAX_ERROR_PARSE_TRACES);
    const interactionsByTrace = await loadInteractions(
        errorish.map((t) => t.taskId).filter((x): x is string => Boolean(x)),
    );

    // 3. 统一问题汇总（先于错误维）
    const summary = buildProblemSummary({ traces, interactionsByTrace });

    // 4. 四维 + 综合（错误维由问题汇总反哺）
    const scored = scoreDimensions(traces, policy, summary.errorSummary);

    // 5. 追加低分维度问题 → 统一排序 + 帕累托
    const lowDim = lowScoreProblems(scored.dimensions, policy.status.关注);
    const problems = rankProblems([...summary.problems, ...lowDim]);

    // 6. 趋势分桶
    const trend = bucketTrends({ traces, window: input.window, from: input.from, to: input.to, policy });

    const n = traces.length;
    const passRate = n ? Math.round((traces.filter(isSuccessDeterministic).length / n) * 1000) / 10 : 0;
    return {
        composite: scored.composite,
        dimensions: scored.dimensions,
        trend,
        problems,
        errorNodeDistribution: summary.errorNodeDistribution,
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
