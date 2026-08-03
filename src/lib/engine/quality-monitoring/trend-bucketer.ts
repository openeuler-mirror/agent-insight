// trend-bucketer — 趋势自适应分桶 + 桶内聚合（BR-008/009 / FR-010/014）。
// 把「一条 trace = 某时刻一个分数向量」聚成可连线的趋势：二值取比率、连续量取分位（p50/p90/p95）。
// 纯函数；不直接连线单条 trace；空桶保留 n=0 不臆造。

import type { TraceLite, ScoringPolicy, TrendBucket, TrendGranularity, WindowKind } from './types';

function clamp01(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

/** 手写分位（对齐 dashboard/stats:p95 写法）。 */
function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function successRate(traces: TraceLite[]): number {
    if (!traces.length) return 0;
    const ok = traces.filter((t) =>
        (t.toolCallErrorCount ?? 0) === 0 && (t.failures?.length ?? 0) === 0,
    ).length;
    return round1((ok / traces.length) * 100);
}

function costScore(t: TraceLite, policy: ScoringPolicy): number | null {
    const b = policy.costBudget;
    const ratios: number[] = [];
    if (t.latency != null) ratios.push(t.latency / b.latencyMs);
    if (t.tokens != null) ratios.push(t.tokens / b.tokens);
    if (t.stepCount != null) ratios.push(t.stepCount / b.steps);
    if (!ratios.length) return null;
    return clamp01(1 - Math.max(...ratios)) * 100;
}

/** 桶级综合分（自身趋势用，确定性可算）：无错误完成率 × 成本 的简化合成。 */
function bucketComposite(traces: TraceLite[], policy: ScoringPolicy): number {
    if (!traces.length) return 0;
    const completion = successRate(traces);
    const costs = traces.map((t) => costScore(t, policy)).filter((v): v is number => v != null);
    if (!costs.length) return completion;
    return round1((completion + costs.reduce((a, b) => a + b, 0) / costs.length) / 2);
}

function errorCountOf(traces: TraceLite[]): number {
    // 错误「事件」计 failures 条数（toolCallErrorCount 仅作命中标记，不重复计入条数）。
    return traces.reduce((n, t) => n + (t.failures?.length ?? 0), 0);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

interface BucketPlan { granularity: TrendGranularity; count: number; stepMs: number; }

/**
 * 1d→hour(恰 24)、1w→day(恰 7)、1m→day(恰 30)；custom→在 [min,max] 内自适应（AC-006）。
 * 桶锚定在 `to`，向前回溯固定桶数（对齐 dashboard/stats 的「最近 N 天」口径）。
 */
export function bucketPlan(window: WindowKind, from: Date, to: Date, policy: ScoringPolicy): BucketPlan {
    if (window === '1d') return { granularity: 'hour', count: 24, stepMs: HOUR_MS };
    if (window === '1w') return { granularity: 'day', count: 7, stepMs: DAY_MS };
    if (window === '1m') return { granularity: 'day', count: 30, stepMs: DAY_MS };
    // custom：按跨度选粒度，使桶数落入 [min,max]
    const span = Math.max(1, to.getTime() - from.getTime());
    const { min, max } = policy.bucket;
    const candidates: [TrendGranularity, number][] = [['hour', HOUR_MS], ['day', DAY_MS], ['week', WEEK_MS]];
    for (const [g, step] of candidates) {
        const c = Math.ceil(span / step);
        if (c >= min && c <= max) return { granularity: g, count: c, stepMs: step };
    }
    // 落不进区间：取最接近 max 的天粒度并钳制
    const c = Math.min(max, Math.max(min, Math.ceil(span / DAY_MS)));
    return { granularity: 'day', count: c, stepMs: DAY_MS };
}

export function pickGranularity(window: WindowKind, from: Date, to: Date, policy: ScoringPolicy): TrendGranularity {
    return bucketPlan(window, from, to, policy).granularity;
}

/** 生成锚定在 `to`、回溯 count 个桶的起点（hour 对齐整点，day/week 对齐到日）。 */
function bucketStarts(plan: BucketPlan, to: Date): Date[] {
    const anchor = new Date(to);
    if (plan.granularity === 'hour') anchor.setMinutes(0, 0, 0);
    else anchor.setHours(0, 0, 0, 0);
    const starts: Date[] = [];
    for (let i = plan.count - 1; i >= 0; i--) {
        starts.push(new Date(anchor.getTime() - i * plan.stepMs));
    }
    return starts;
}

export interface BucketTrendsInput {
    traces: TraceLite[];
    window: WindowKind;
    from: Date;
    to: Date;
    policy: ScoringPolicy;
}

export function bucketTrends(input: BucketTrendsInput): { granularity: TrendGranularity; buckets: TrendBucket[] } {
    const { traces, window, from, to, policy } = input;
    const plan = bucketPlan(window, from, to, policy);
    const starts = bucketStarts(plan, to);

    const buckets: TrendBucket[] = starts.map((start) => {
        const end = start.getTime() + plan.stepMs;
        const inBucket = traces.filter((t) => {
            const ts = new Date(t.ts).getTime();
            return ts >= start.getTime() && ts < end;
        });

        const steps = inBucket.map((t) => t.stepCount).filter((v): v is number => v != null);
        const tokens = inBucket.map((t) => t.tokens).filter((v): v is number => v != null);
        const latency = inBucket.map((t) => t.latency).filter((v): v is number => v != null);
        const toolTraces = inBucket.filter((t) => (t.toolCallCount ?? 0) > 0);
        const toolCorrect = toolTraces.length
            ? round1((toolTraces.reduce((s, t) => s + (1 - (t.toolCallErrorCount ?? 0) / (t.toolCallCount as number)), 0) / toolTraces.length) * 100)
            : 0;
        const safeRate = inBucket.length
            ? round1((inBucket.filter((t) => t.safety !== 0).length / inBucket.length) * 100)
            : 0;
        const costScores = inBucket.map((t) => costScore(t, policy)).filter((v): v is number => v != null);
        const costRatio = costScores.length ? round1(costScores.reduce((a, b) => a + b, 0) / costScores.length) : 0;
        const mkPct = (vals: number[]) => ({ p50: round1(percentile(vals, 0.5)), p90: round1(percentile(vals, 0.9)), p95: round1(percentile(vals, 0.95)) });

        return {
            bucket_ts: start.toISOString(),
            n_traces: inBucket.length,
            ratios: {
                completion: successRate(inBucket),
                safety: safeRate,
                toolCorrect,
                cost: costRatio,
            },
            percentiles: {
                steps: mkPct(steps),
                tokens: mkPct(tokens),
                latency: mkPct(latency),
            },
            composite: bucketComposite(inBucket, policy),
            errorCount: errorCountOf(inBucket),
            lowConfidence: inBucket.length > 0 && inBucket.length < policy.thetaSample,
        };
    });

    // 异常桶标记：综合分骤降（< 非空桶中位 - 15）或错误尖峰（> 非空桶均值×2 且 ≥3）。
    const nonEmpty = buckets.filter((b) => b.n_traces > 0);
    if (nonEmpty.length >= 2) {
        const comps = nonEmpty.map((b) => b.composite).sort((a, b) => a - b);
        const medComp = comps[Math.floor(comps.length / 2)];
        const meanErr = nonEmpty.reduce((s, b) => s + b.errorCount, 0) / nonEmpty.length;
        for (const b of buckets) {
            if (b.n_traces === 0) continue;
            if (b.composite < medComp - 15 || (b.errorCount >= 3 && b.errorCount > meanErr * 2)) {
                b.anomaly = true;
            }
        }
    }

    return { granularity: plan.granularity, buckets };
}
