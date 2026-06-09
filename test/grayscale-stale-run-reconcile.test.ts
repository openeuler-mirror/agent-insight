import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileStaleGrayscaleRun, isStaleCrashArtifact, type StaleReconcilableRun } from '@/lib/grayscale/stale-run-reconcile';

// 看护"崩溃后启动回收不再把评测被打断的 run 误判成执行失败"——这是用户"重试还是失败、且看不到原因"的根因:
// 旧实现把 evaluating(执行已成功)的 run 标成 fail+agent_error → 挡住重评、显示成执行失败。

const REASON = '服务重启中断（启动回收）';

test('evaluating + 有 sessionId(执行完成、评测被打断)→ 回到 executed,可重评', () => {
    const run: StaleReconcilableRun = {
        status: 'evaluating', sessionId: 'ses_x', evaluationClaimId: 'c1', evaluatorRunId: 'trun_1',
        evaluations: [{ status: 'running' }, { status: 'done' }],
    };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'executed');
    assert.equal(run.failureType, undefined);
    assert.equal(run.evaluationClaimId, undefined);
    assert.equal(run.evaluatorRunId, undefined);
    assert.deepEqual(run.evaluations, [{ status: 'done' }]); // 只保留已完成的评估器
});

test('已是 fail + sessionId + 崩溃残骸消息 → 自愈回到 executed(用户卡死的就是这种)', () => {
    const run: StaleReconcilableRun = {
        status: 'fail', sessionId: 'ses_y', failureType: 'agent_error',
        output: '服务重启，评测中断（stale）',
        evaluations: [{ status: 'failed', errorMessage: '服务重启，评测中断（stale）' }],
    };
    assert.equal(isStaleCrashArtifact(run), true);
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'executed');
    assert.equal(run.failureType, undefined);
});

test('running(执行真没跑完,无 sessionId)→ 执行失败 agent_error', () => {
    const run: StaleReconcilableRun = { status: 'running' };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, 'agent_error');
});

test('pending → 执行失败', () => {
    const run: StaleReconcilableRun = { status: 'pending' };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
});

test('fail + sessionId 但是真实失败(非崩溃残骸)→ 不动', () => {
    const run: StaleReconcilableRun = {
        status: 'fail', sessionId: 'ses_z', failureType: 'agent_error',
        output: '评测器返回了非法 JSON',
    };
    assert.equal(isStaleCrashArtifact(run), false);
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), false);
    assert.equal(run.status, 'fail');
});

test('终态(done/pass)→ 不动', () => {
    for (const s of ['pass', 'executed'] as const) {
        const run: StaleReconcilableRun = { status: s, sessionId: 'ses_done' };
        assert.equal(reconcileStaleGrayscaleRun(run, REASON), false);
        assert.equal(run.status, s);
    }
});
