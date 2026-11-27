/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
            traces.push(trace(new Date(now.getTime() - d * 86_400_000 - k * 3_600_000), { latency: 1000, tokens: 500, stepCount: 5 }));
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
    const traces = Array.from({ length: 20 }, (_, i) => trace(new Date(now.getTime() - 1_000_000), {
        latency: (i + 1) * 1000,
        tokens: 100,
        stepCount: 2,
        toolCallErrorCount: i % 2,
    }));
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

// ── 异常桶判定的中位数口径（1d → 按小时桶，锚定 to=12:00 整点）──────────
// 成本预算 latencyMs=120_000：latency 48_000 → 成本分 60 → 综合分 80；
// latency 96_000 → 成本分 20 → 综合分 60；latency 12_000 → 成本分 90 → 综合分 95。
function latBucket(now: Date, minutesAgo: number, latency: number): TraceLite[] {
    return [0, 1, 2, 3, 4].map((i) => trace(
        new Date(now.getTime() - (minutesAgo + i * 5) * 60_000),
        { latency, tokens: 100, stepCount: 2 },
    ));
}

test('异常桶判定：偶数个非空桶按中位数取阈值，20 分差不标异常', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 86_400_000);
    // 11:00–12:00 桶综合分 80，10:00–11:00 桶综合分 60，其余 22 个桶为空。
    const traces = [...latBucket(now, 30, 48_000), ...latBucket(now, 90, 96_000)];
    const { buckets } = bucketTrends({ traces, window: '1d', from, to: now, policy: DEFAULT_POLICY });
    const nonEmpty = buckets.filter((b) => b.n_traces > 0);
    assert.equal(nonEmpty.length, 2, `应恰好 2 个非空桶，实际 ${nonEmpty.length}`);
    const comps = nonEmpty.map((b) => b.composite).sort((a, b) => a - b);
    assert.deepEqual(comps, [60, 80], `样本应给出 60/80 两桶，实际 ${comps}`);
    // 中位数 = (60+80)/2 = 70 → 阈值 55；60 未跌破，不应有任何桶被标异常。
    // 若误取上中位 80 → 阈值 65，60 分桶会被 QualityTrendChart 染成异常柱。
    assert.deepEqual(buckets.filter((b) => b.anomaly).map((b) => b.composite), [],
        '两桶相差 20，未跌破 中位−15，不应标出异常桶');
});

test('异常桶判定：奇数个非空桶的中位口径不变（跌破 中位−15 仍标异常）', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const from = new Date(now.getTime() - 86_400_000);
    // 三个非空桶：80 / 60 / 95 → 中位 80 → 阈值 65 → 仅 60 分桶为异常。
    const traces = [...latBucket(now, 30, 48_000), ...latBucket(now, 90, 96_000), ...latBucket(now, 150, 12_000)];
    const { buckets } = bucketTrends({ traces, window: '1d', from, to: now, policy: DEFAULT_POLICY });
    const nonEmpty = buckets.filter((b) => b.n_traces > 0);
    assert.equal(nonEmpty.length, 3, `应恰好 3 个非空桶，实际 ${nonEmpty.length}`);
    const anomalous = buckets.filter((b) => b.anomaly).map((b) => b.composite);
    assert.deepEqual(anomalous, [60], `仅 60 分桶应标异常，实际 ${anomalous}`);
});
