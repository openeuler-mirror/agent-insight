import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreDimensions } from '@/lib/engine/quality-monitoring/dimension-scorer';
import { DEFAULT_POLICY } from '@/lib/engine/quality-monitoring/config';
import type { TraceLite } from '@/lib/engine/quality-monitoring/types';

const NO_ERR = { errorEventCount: 0, errorTraceCount: 0, clusterCount: 0 };

function trace(over: Partial<TraceLite>): TraceLite {
    return { executionId: over.executionId ?? 'e', ts: over.ts ?? new Date(), ...over };
}

test('质量监控不再产出结果维，只保留过程、成本、错误', () => {
    const r = scoreDimensions([trace({ toolCallCount: 6, toolCallErrorCount: 0 })], DEFAULT_POLICY, NO_ERR);
    assert.deepEqual(Object.keys(r.dimensions).sort(), ['cost', 'error', 'process']);
    assert.ok(r.dimensions.process.score >= 85, `process ${r.dimensions.process.score} 应高（工具全对）`);
});

// BR-004：安全 0 容忍 + 综合分硬降级标红。
test('BR-004 安全护栏命中 → safety=0、capped=true、状态异常', () => {
    const pii = trace({ toolCallCount: 3, toolCallErrorCount: 0, failures: [{ failure_type: 'PII泄露', description: 'leaked user PII', context: '', recovery: '' }] });
    const r = scoreDimensions([pii], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.composite.capped, true, '应封顶降级');
    assert.equal(r.composite.status, '异常');
});

// BR-005：N/A 不入分母 —— 未触发 skill 的 trace，约束遵循记 N/A。
test('BR-005 未触发 skill → 约束遵循 N/A 不计入分母', () => {
    const noSkill = trace({ toolCallCount: 2, toolCallErrorCount: 0, invokedSkills: [] });
    const r = scoreDimensions([noSkill], DEFAULT_POLICY, NO_ERR);
    const ca = r.dimensions.process.metrics?.find((m) => m.key === 'constraintAdherence');
    assert.equal(ca?.score, null, '约束遵循应为 N/A');
    assert.equal(ca?.n, 0, '有效样本应为 0');
});

// 空 T：不报错、coverage=0。
test('空 T → coverage=0、不抛错', () => {
    const r = scoreDimensions([], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.dimensions.process.coverage, 0);
    assert.equal(r.dimensions.cost.coverage, 0);
    assert.ok(['达标', '关注', '异常'].includes(r.composite.status));
});

// BR-010：绝对状态阈值（不含百分位）。
test('BR-010 绝对状态阈值：高分→达标', () => {
    const good = trace({ toolCallCount: 4, toolCallErrorCount: 0, latency: 1000, tokens: 1000, stepCount: 4 });
    const r = scoreDimensions([good], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.composite.status, '达标', `composite ${r.composite.score} 应达标`);
    assert.equal(r.composite.capped, false);
});
