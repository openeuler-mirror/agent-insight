// sampling — 采样异步回填（NFR-001）。与请求路径完全解耦：选未评测子集 → 限流后台评测 → 写回 DB。
// 评测器可注入（便于单测 mock）；默认评测器对 judge/轨迹做最小可用回填，失败隔离、不抛到调用方。

import { prisma } from '@/lib/storage/prisma';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import type { ScoringPolicy, TraceLite, WindowKind } from './types';
import { DEFAULT_POLICY } from './config';
import { collectTraces } from './trace-collector';
import { resolveWindowRange } from './index';
import {
    evaluateResultQuality,
    RESULT_METRIC_KEYS,
    RESULT_METRIC_VERSIONS,
} from '@/lib/engine/evaluation/result-quality-evaluator';
import {
    hashAgentDatasetScope,
    loadUserAgentDatasets,
} from '@/lib/engine/evaluation/dataset-case-match';

export interface BackfillResult {
    accepted: boolean;
    selected: number;
    evaluated: number;
    failed: number;
    coverageDelta: number; // 评测覆盖率提升估计（0–1）
    metricRecords: number;
}

/** 单条 trace 的回填评测结果；返回 null 表示本条跳过（不写回）。 */
export interface TraceEvalResult {
    answerScore?: number | null; // 0–1
    metricRecords?: number;
    metricFailures?: number;
}

export type TraceEvaluator = (trace: { executionId: string; taskId?: string; query?: string; user: string | null }) => Promise<TraceEvalResult | null>;

export interface BackfillInput {
    user: string | null;
    agent: string;
    window: WindowKind;
    from?: string | null;
    to?: string | null;
    budget?: number;
    /** 注入评测器（单测用 mock）；缺省走 defaultEvaluator。 */
    evaluator?: TraceEvaluator;
    signal?: AbortSignal;
    /** 当前时间（注入以便测试；默认 new Date()）。 */
    now?: Date;
}

/** 默认评测器：复用结果质量评测器，单指标失败隔离在 evaluateResultQuality 内完成。 */
const defaultEvaluator: TraceEvaluator = async (trace) => {
    const run = await evaluateResultQuality(trace.executionId);
    return {
        answerScore: run.metrics.accuracy.score == null ? null : run.metrics.accuracy.score / 100,
        metricRecords: run.reused ? 0 : RESULT_METRIC_KEYS.length,
        metricFailures: Object.values(run.metrics).filter((metric) => metric.failed).length,
    };
};

export function needsResultEvaluationBackfill(
    trace: TraceLite,
    accuracyDatasetScopeHash: string,
): boolean {
    const rows = Object.values(trace.resultMetrics ?? {});
    if (rows.some(row => row?.status === 'running' || row?.status === 'pending')) return false;
    return RESULT_METRIC_KEYS.some((key) => {
        const camel = key === 'instruction-adherence' ? 'instructionAdherence' : key === 'answer-quality' ? 'answerQuality' : key;
        const row = trace.resultMetrics?.[camel as keyof typeof trace.resultMetrics];
        if (!row) return true;
        if (row.status === 'failed') return true;
        if (row.evaluatorVersion !== RESULT_METRIC_VERSIONS[key]) return true;
        if (key === 'accuracy') {
            return row.evidence?.datasetScopeHash !== accuracyDatasetScopeHash;
        }
        return false;
    });
}

export async function sampleAndBackfill(input: BackfillInput): Promise<BackfillResult> {
    const policy: ScoringPolicy = DEFAULT_POLICY;
    const now = input.now ?? new Date();
    const { from, to } = resolveWindowRange(input.window, now, input.from, input.to);
    const evaluator = input.evaluator ?? defaultEvaluator;
    const budget = input.budget ?? policy.sample.budget;

    const { traces } = await collectTraces({ user: input.user, agent: input.agent, from, to });
    const accuracyDatasetScopeHash = hashAgentDatasetScope(
        input.user ? await loadUserAgentDatasets(input.user) : [],
    );

    // 选缺失、失败、版本过期或准确性 GT 数据集已变化的 trace。
    const unevaluated = traces.filter(trace => needsResultEvaluationBackfill(trace, accuracyDatasetScopeHash));
    const byRate = Math.ceil(traces.length * policy.sample.rate);
    const limit = Math.min(budget, byRate || budget, unevaluated.length);
    const sample = unevaluated.slice(0, limit);

    let evaluated = 0;
    let failed = 0;
    let metricRecords = 0;

    await Promise.all(sample.map((t) =>
        withBackgroundOpencodeSlot(
            async () => {
                try {
                    const res = await evaluator({ executionId: t.executionId, taskId: t.taskId, query: t.query, user: input.user });
                    if (res && res.answerScore != null) {
                        await prisma.execution.update({
                            where: { id: t.executionId },
                            data: { answerScore: res.answerScore },
                        });
                        evaluated++;
                        metricRecords += res.metricRecords ?? 0;
                        failed += res.metricFailures ?? 0;
                    } else if (res?.metricRecords) {
                        evaluated++;
                        metricRecords += res.metricRecords;
                        failed += res.metricFailures ?? 0;
                    }
                } catch (e) {
                    failed++;
                    console.warn(`[quality/backfill] eval failed for ${t.executionId}:`, e);
                }
            },
            { label: `quality-backfill:${input.agent}`, taskType: 'evaluation', user: input.user ?? undefined, signal: input.signal },
        ).catch((e) => {
            failed++;
            console.warn('[quality/backfill] slot error:', e);
        }),
    ));

    return {
        accepted: true,
        selected: sample.length,
        evaluated,
        failed,
        coverageDelta: traces.length ? Math.round((evaluated / traces.length) * 1000) / 1000 : 0,
        metricRecords,
    };
}
