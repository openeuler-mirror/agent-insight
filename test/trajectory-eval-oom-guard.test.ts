import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isRetryableResultEvaluationFailure,
    createSimpleAsyncLimiter,
    shouldRetryGrayscaleEval,
} from '@/lib/engine/evaluation/eval-run-guards';

// 看护 119 上"并行跑多个评测任务 → next-server 堆 OOM 崩溃"的两个修复:
//   A) 确定性的"不允许派发子代理"错误不再被当作可重试 —— 否则每行重试 5 次,
//      每次重跑一个 ~900MB 的 opencode agent + 堆累积,是堆 OOM 的主放大器。
//   C) 全局评测行并发硬上限 limiter —— 把堆内驻留量与并行任务数解耦。

test('retry-gate: "不允许派发子代理" 是确定性失败 → 不重试(掐掉 5× 放大)', () => {
    assert.equal(
        isRetryableResultEvaluationFailure(new Error('任务完成度评估器不允许派发子代理，但实际派发了：ses_abc')),
        false,
    );
});

test('retry-gate: 已知的确定性配置/数据错误 → 不重试', () => {
    assert.equal(isRetryableResultEvaluationFailure(new Error('缺少预期结果')), false);
    assert.equal(isRetryableResultEvaluationFailure(new Error('Session 不存在或 interactions 为空')), false);
    assert.equal(isRetryableResultEvaluationFailure(new Error('')), false);
});

test('retry-gate: 瞬时/未知错误 → 仍可重试', () => {
    assert.equal(isRetryableResultEvaluationFailure(new Error('ECONNRESET socket hang up')), true);
});

test('limiter: 并发不超过 cap、无泄漏、按 FIFO 放行排队者', async () => {
    const lim = createSimpleAsyncLimiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = async (i: number) => {
        await lim.acquire();
        active++; peak = Math.max(peak, active); order.push(i);
        await new Promise(r => setTimeout(r, 10));
        active--; lim.release();
    };
    await Promise.all([1, 2, 3, 4, 5].map(task));
    assert.equal(peak, 2, '峰值并发必须 = cap(2),不能超');
    assert.equal(active, 0, '全部释放后无泄漏');
    assert.deepEqual(order.slice(0, 2).sort(), [1, 2], '前两个立即获得 slot');
});

test('limiter: 多余的 release 不会把计数压成负(健壮性)', async () => {
    const lim = createSimpleAsyncLimiter(1);
    lim.release(); lim.release(); // 没 acquire 就 release —— 不崩、不变负
    // cap 仍完整,acquire 应立即成功
    await lim.acquire();
    assert.ok(true);
});

// C+D: 灰度评测"失败=终态"——重试期间显示评测中,只有最终确切失败才标失败、且此后不变。
test('shouldRetryGrayscaleEval: 可重试失败 且 未超重试数 → 重试(期间保持评测中)', () => {
    assert.equal(shouldRetryGrayscaleEval(new Error('服务重启，评测中断（stale）'), 1, 2), true);
    assert.equal(shouldRetryGrayscaleEval(new Error('网络抖动'), 2, 2), true);
});

test('shouldRetryGrayscaleEval: 重试次数用尽 → 不再重试(进终态失败)', () => {
    assert.equal(shouldRetryGrayscaleEval(new Error('网络抖动'), 3, 2), false);
});

test('shouldRetryGrayscaleEval: 不可重试失败 → 一次即终态(即便还有次数)', () => {
    assert.equal(shouldRetryGrayscaleEval(new Error('任务完成度评估器不允许派发子代理'), 1, 2), false);
    assert.equal(shouldRetryGrayscaleEval(new Error('aborted: user terminated'), 1, 2), false);
});
