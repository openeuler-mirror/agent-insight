import assert from 'node:assert/strict';
import test from 'node:test';

import {
    markUserTerminated,
    isTaskTerminated,
    getUserTerminatedAt,
} from '@/server/user_termination_registry';
import {
    registerTrajectoryEvalRun,
    getTrajectoryEvalRunSignal,
    abortTrajectoryEvalRun,
    abortTrajectoryEvalRunsForUser,
    unregisterTrajectoryEvalRun,
} from '@/server/trajectory_eval_run_registry';

// 看护「终止全部」的两块纯逻辑(registry 挂 globalThis,故用随机 user 避免跨用例串扰)。
const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2)}`;

test('user-termination: 只中止"终止时刻之前入队"的任务,不误伤之后发起的新任务', () => {
    const u = uniq('u');
    assert.equal(isTaskTerminated(u, 1000), false, '未终止 → 不中止');
    markUserTerminated(u, 2000);
    assert.equal(isTaskTerminated(u, 1000), true, '终止前入队 → 中止');
    assert.equal(isTaskTerminated(u, 2000), true, '同刻入队 → 也中止(保守)');
    assert.equal(isTaskTerminated(u, 3000), false, '终止后入队的新任务 → 不受影响');
    assert.equal(getUserTerminatedAt(u), 2000);
    // 空 user 安全
    assert.equal(isTaskTerminated('', 1), false);
    assert.equal(isTaskTerminated(undefined, 1), false);
});

test('trajectory-eval registry: 按 user 终止只 abort 该用户全部 run,严格隔离别的用户', () => {
    const ua = uniq('a');
    const ub = uniq('b');
    const ca = registerTrajectoryEvalRun('run-a1', ua);
    registerTrajectoryEvalRun('run-a2', ua);
    const cb = registerTrajectoryEvalRun('run-b1', ub);

    assert.equal(getTrajectoryEvalRunSignal('run-a1')?.aborted, false);

    const n = abortTrajectoryEvalRunsForUser(ua);
    assert.equal(n, 2, 'abort 了 ua 的 2 个 run');
    assert.equal(ca.signal.aborted, true);
    assert.equal(getTrajectoryEvalRunSignal('run-a2')?.aborted, true);
    assert.equal(cb.signal.aborted, false, 'ub 的 run 不受影响');

    assert.equal(abortTrajectoryEvalRun('run-b1'), true);
    assert.equal(cb.signal.aborted, true);

    unregisterTrajectoryEvalRun('run-a1');
    unregisterTrajectoryEvalRun('run-a2');
    unregisterTrajectoryEvalRun('run-b1');
    assert.equal(getTrajectoryEvalRunSignal('run-a1'), undefined);
    assert.equal(abortTrajectoryEvalRun('run-a1'), false, '注销后找不到 → false(由 DB 兜底)');
});
