import assert from 'node:assert/strict';
import test from 'node:test';

import {
    reconcileStaleGrayscaleRun,
    isStaleCrashArtifact,
    EVAL_INTERRUPTED_MESSAGE,
    type StaleReconcilableRun,
} from '@/lib/grayscale/stale-run-reconcile';

// 看护"崩溃后启动解卡"的处置(2026-06「解卡但不自动重评」语义):
//  - 评测被打断的 run(执行已成功)→ 解卡成「执行完成 + 评测失败(中断)」,前端显示「重评」按钮,
//    等用户点;failureType 必须留空,否则前端会当"执行失败"显示「重跑」(重新执行)。
//  - 其实早已评完、只是被误标的 → 直接恢复分数(pass),连重评都不用。
//  - 执行真没跑完 → 执行失败 agent_error。

const REASON = '服务重启中断（启动回收）';

test('评测被打断(执行完成、有 sessionId)→ 评测失败(中断)态, 保留 sessionId, failureType 留空, 可重评', () => {
    const run: StaleReconcilableRun = {
        status: 'evaluating', sessionId: 'ses_x', evaluationClaimId: 'c1', evaluatorRunId: 'trun_1',
        evaluations: [{ status: 'running', evaluatorId: 'e1' }, { status: 'done', evaluatorId: 'e2' }],
    };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, undefined);            // 关键: 不是执行失败 → 前端显示「重评」而非「重跑」
    assert.equal(run.sessionId, 'ses_x');                // 执行成功的痕迹保留
    assert.equal(run.evaluatorRunId, undefined);
    assert.equal(run.evaluationClaimId, undefined);
    assert.equal(run.output, EVAL_INTERRUPTED_MESSAGE);
    // running 的评估器被标 failed(带可读原因),done 的保留 → 前端 hasEvaluationFailed=true → 显示「重评」
    assert.deepEqual(run.evaluations, [
        { status: 'failed', evaluatorId: 'e1', errorMessage: EVAL_INTERRUPTED_MESSAGE },
        { status: 'done', evaluatorId: 'e2' },
    ]);
});

test('其实早已评完(所有评估器 done + 有分)但被崩溃误标 → 直接恢复成 pass, 保留分数, 不重评', () => {
    const run: StaleReconcilableRun = {
        status: 'evaluating', sessionId: 'ses_x', score: 75, evaluatorRunId: 'trun_1',
        evaluations: [{ status: 'done', evaluatorId: 'e1' }],
    };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'pass');
    assert.equal(run.score, 75);
    assert.equal(run.failureType, undefined);
    assert.deepEqual(run.evaluations, [{ status: 'done', evaluatorId: 'e1' }]);
});

test('已是 fail + sessionId + 崩溃残骸消息(单评估器, 无分)→ 解卡成评测失败(中断), failureType 清空', () => {
    const run: StaleReconcilableRun = {
        status: 'fail', sessionId: 'ses_y', failureType: 'agent_error',
        output: '服务重启，评测中断（stale）',
        evaluations: [{ status: 'failed', errorMessage: '服务重启，评测中断（stale）' }],
    };
    assert.equal(isStaleCrashArtifact(run), true);
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, undefined);            // 清掉 agent_error → 前端不再显示"执行失败/重跑"
    assert.equal(run.sessionId, 'ses_y');
    assert.equal(run.evaluatorRunId, undefined);
    // 仍有一条 failed 评估 → 前端 evaluation tone='评测失败' → 显示「重评」
    assert.ok((run.evaluations || []).some(e => e.status === 'failed'));
});

test('评测被打断但 evaluations 为空 → 补一条 failed, 保证前端显示评测失败 + 「重评」', () => {
    const run: StaleReconcilableRun = { status: 'evaluating', sessionId: 'ses_x', evaluations: [] };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, undefined);
    assert.deepEqual(run.evaluations, [{ status: 'failed', errorMessage: EVAL_INTERRUPTED_MESSAGE }]);
});

test('running(执行真没跑完, 无 sessionId)→ 执行失败 agent_error(显示「重跑」)', () => {
    const run: StaleReconcilableRun = { status: 'running' };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, 'agent_error');
});

test('pending → 执行失败', () => {
    const run: StaleReconcilableRun = { status: 'pending' };
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), true);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, 'agent_error');
});

test('fail + sessionId 但是真实失败(非崩溃残骸)→ 不动', () => {
    const run: StaleReconcilableRun = {
        status: 'fail', sessionId: 'ses_z', failureType: 'agent_error',
        output: '评测器返回了非法 JSON',
    };
    assert.equal(isStaleCrashArtifact(run), false);
    assert.equal(reconcileStaleGrayscaleRun(run, REASON), false);
    assert.equal(run.status, 'fail');
    assert.equal(run.failureType, 'agent_error');
});

test('终态(pass/executed)→ 不动', () => {
    for (const s of ['pass', 'executed'] as const) {
        const run: StaleReconcilableRun = { status: s, sessionId: 'ses_done' };
        assert.equal(reconcileStaleGrayscaleRun(run, REASON), false);
        assert.equal(run.status, s);
    }
});
