import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketTrends, pickGranularity } from '@/lib/engine/quality-monitoring/trend-bucketer';
import { DEFAULT_POLICY } from '@/lib/engine/quality-monitoring/config';
import type { TraceLite } from '@/lib/engine/quality-monitoring/types';

function trace(ts: Date, over: Partial<TraceLite> = {}): TraceLite {
    return { executionId: `e-${ts.getTime()}-${Math.round(over.latency ?? 0)}`, ts, ...over };
}

// AC-006：最近一周 → 恰 7 个按天桶。
test('AC-006 1w → 恰 7 个按天桶', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const traces: TraceLite[] = [];
    for (let d = 0; d < 7; d++) {
        for (let k = 0; k < 3; k++) {
            traces.push(trace(new Date(now.getTime() - d * 86_400_000 - k * 3_600_000), { latency: 1000, tokens: 500, stepCount: 5, isAnswerCorrect: true }));
        }
    }
    const { granularity, buckets } = bucketTrends({ traces, window: '1w', from, to: now, policy: DEFAULT_POLICY });
    assert.equal(granularity, 'day');
    assert.equal(buckets.length, 7, `应恰 7 桶，实际 ${buckets.length}`);
    assert.ok(buckets.every((b) => 'n_traces' in b), '每桶含 n_traces');
});

// AC-006：最近一天 → 恰 24 个按小时桶。
test('AC-006 1d → 恰 24 个按小时桶', () => {
    const now = new Date('2026-06-09T12:30:00Z');
    const from = new Date(now.getTime() - 86_400_000);
    const traces = Array.from({ length: 48 }, (_, i) => trace(new Date(now.getTime() - i * 1_800_000), { latency: 800, tokens: 300, stepCount: 3 }));
    const { granularity, buckets } = bucketTrends({ traces, window: '1d', from, to: now, policy: DEFAULT_POLICY });
    assert.equal(granularity, 'hour');
    assert.equal(buckets.length, 24, `应恰 24 桶，实际 ${buckets.length}`);
});

// BR-009：连续量出 p50/p90/p95。
test('BR-009 连续量含 p50/p90/p95，二值含比率', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 86_400_000);
    const traces = Array.from({ length: 20 }, (_, i) => trace(new Date(now.getTime() - 1_000_000), { latency: (i + 1) * 1000, tokens: 100, stepCount: 2, isAnswerCorrect: i % 2 === 0 }));
    const { buckets } = bucketTrends({ traces, window: '1d', from, to: now, policy: DEFAULT_POLICY });
    const hit = buckets.find((b) => b.n_traces > 0);
    assert.ok(hit, '应有非空桶');
    assert.ok(hit!.percentiles.latency.p50 <= hit!.percentiles.latency.p95, 'p50 ≤ p95');
    const completion = hit!.ratios.completion;
    assert.ok(completion != null && completion >= 0 && completion <= 100, '完成率 0–100');
});

// 稀疏桶：n < thetaSample → lowConfidence。
test('BR-007 稀疏桶标 lowConfidence', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 86_400_000);
    const traces = [trace(new Date(now.getTime() - 1_000_000), { latency: 500, tokens: 50, stepCount: 1 })];
    const { buckets } = bucketTrends({ traces, window: '1d', from, to: now, policy: DEFAULT_POLICY });
    const hit = buckets.find((b) => b.n_traces > 0 && b.n_traces < DEFAULT_POLICY.thetaSample);
    assert.ok(hit?.lowConfidence, '稀疏桶应标 lowConfidence');
});

test('pickGranularity custom 落入 [min,max]', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 25 * 86_400_000);
    const g = pickGranularity('custom', from, now, DEFAULT_POLICY);
    assert.ok(['hour', 'day', 'week'].includes(g));
});
