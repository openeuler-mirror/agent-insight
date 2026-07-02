import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreDimensions } from '@/lib/engine/quality-monitoring/dimension-scorer';
import { DEFAULT_POLICY } from '@/lib/engine/quality-monitoring/config';
import type { TraceLite } from '@/lib/engine/quality-monitoring/types';

const NO_ERR = { errorEventCount: 0, errorTraceCount: 0, clusterCount: 0 };

function trace(over: Partial<TraceLite>): TraceLite {
    return { executionId: over.executionId ?? 'e', ts: over.ts ?? new Date(), ...over };
}

// BR-001：结果与过程分开评 —— "蒙对"（结果好/过程差）与"白忙"（过程好/结果差）不得相互抵消。
test('BR-001 蒙对：结果高、过程低，二者不相互抵消', () => {
    const guessedRight = trace({ resultMetrics: {
        faithfulness: { key: 'faithfulness', status: 'done', score: 95, method: 'grounding', confidence: 0.9 },
        answerQuality: { key: 'answerQuality', status: 'done', score: 90, method: 'self-rubric', confidence: 0.8 },
    }, toolCallCount: 10, toolCallErrorCount: 8 });
    const r = scoreDimensions([guessedRight], DEFAULT_POLICY, NO_ERR);
    assert.ok(r.dimensions.result.score >= 85, `result ${r.dimensions.result.score} 应高`);
    assert.ok(r.dimensions.process.score < 60, `process ${r.dimensions.process.score} 应低`);
    assert.ok(r.dimensions.result.score - r.dimensions.process.score > 25, '结果显著高于过程');
});

test('BR-001 白忙：过程高、结果低', () => {
    const busyWrong = trace({ resultMetrics: {
        accuracy: { key: 'accuracy', status: 'done', score: 0, method: 'gt-rubric', confidence: 0.95 },
    }, toolCallCount: 6, toolCallErrorCount: 0 });
    const r = scoreDimensions([busyWrong], DEFAULT_POLICY, NO_ERR);
    const accuracy = r.dimensions.result.metrics?.find((m) => m.key === 'accuracy');
    assert.equal(accuracy?.score, 0, '准确性应为 0');
    assert.ok(r.dimensions.process.score >= 85, `process ${r.dimensions.process.score} 应高（工具全对）`);
    assert.ok(r.dimensions.process.score - r.dimensions.result.score > 25, '过程显著高于结果');
});

// BR-004：安全 0 容忍 + 综合分硬降级标红。
test('BR-004 安全护栏命中 → safety=0、capped=true、状态异常', () => {
    const pii = trace({ resultMetrics: { answerQuality: { key: 'answerQuality', status: 'done', score: 99, method: 'self-rubric', confidence: 0.9 } }, toolCallCount: 3, toolCallErrorCount: 0, failures: [{ failure_type: 'PII泄露', description: 'leaked user PII', context: '', recovery: '' }] });
    const r = scoreDimensions([pii], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.composite.capped, true, '应封顶降级');
    assert.equal(r.composite.status, '异常');
    assert.equal(r.dimensions.result.score, 99, '安全只做硬降级，不应冒充第五个结果指标');
});

// BR-005：N/A 不入分母 —— 未触发 skill 的 trace，约束遵循记 N/A。
test('BR-005 未触发 skill → 约束遵循 N/A 不计入分母', () => {
    const noSkill = trace({ isAnswerCorrect: true, toolCallCount: 2, toolCallErrorCount: 0, invokedSkills: [] });
    const r = scoreDimensions([noSkill], DEFAULT_POLICY, NO_ERR);
    const ca = r.dimensions.process.metrics?.find((m) => m.key === 'constraintAdherence');
    assert.equal(ca?.score, null, '约束遵循应为 N/A');
    assert.equal(ca?.n, 0, '有效样本应为 0');
});

test('结果四指标 N/A 不进分母，coverage 按四项平均', () => {
    const one = trace({ resultMetrics: {
        answerQuality: { key: 'answerQuality', status: 'done', score: 80, method: 'self-rubric', confidence: 0.8 },
        accuracy: { key: 'accuracy', status: 'done', score: null, method: 'gt-rubric', confidence: 0, note: '无 GT' },
    } });
    const r = scoreDimensions([one], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.dimensions.result.score, 80);
    assert.equal(r.dimensions.result.coverage, 0.3);
    assert.equal(r.dimensions.result.metrics?.find((m) => m.key === 'accuracy')?.score, null);
});

// 空 T：不报错、coverage=0。
test('空 T → coverage=0、不抛错', () => {
    const r = scoreDimensions([], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.coverage.total, 0);
    assert.equal(r.dimensions.result.coverage, 0);
    assert.ok(['达标', '关注', '异常'].includes(r.composite.status));
});

// BR-010：绝对状态阈值（不含百分位）。
test('BR-010 绝对状态阈值：高分→达标', () => {
    const good = trace({ resultMetrics: { answerQuality: { key: 'answerQuality', status: 'done', score: 95, method: 'self-rubric', confidence: 0.9 } }, toolCallCount: 4, toolCallErrorCount: 0, latency: 1000, tokens: 1000, stepCount: 4 });
    const r = scoreDimensions([good], DEFAULT_POLICY, NO_ERR);
    assert.equal(r.composite.status, '达标', `composite ${r.composite.score} 应达标`);
    assert.equal(r.composite.capped, false);
});
