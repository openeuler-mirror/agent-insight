import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGrayscaleRetryMode, shouldAutoRetryGrayscaleExecution } from '@/lib/grayscale/retry-policy';
import { isTraceGenerationFailureRetryable } from '@/lib/engine/experiment/trace-retry-policy';
import { readFileSync } from 'node:fs';

test('模型确定性错误共享不可重试规则，远端链路不叠加外层执行预算', () => {
  for (const code of ['MODEL_START_TIMEOUT', 'MODEL_ERROR', 'MODEL_NO_RESPONSE', 'MODEL_UNAVAILABLE', 'MODEL_MISMATCH', 'AGENT_NO_OUTPUT', 'EXECUTION_CANCELLED']) {
    const run = { status: 'fail', failureType: 'agent_error', failureCode: code };
    assert.equal(isTraceGenerationFailureRetryable(code), false);
    assert.equal(shouldAutoRetryGrayscaleExecution(run, false), false);
    assert.equal(shouldAutoRetryGrayscaleExecution(run, true), false);
  }
  const transient = { status: 'fail', failureType: 'agent_error', failureCode: 'CASE_RUN_FAILED' };
  assert.equal(shouldAutoRetryGrayscaleExecution(transient, false), true);
  assert.equal(shouldAutoRetryGrayscaleExecution(transient, true), false);
  for (const failureType of ['agent_timeout', 'permission_blocked', 'question_blocked']) {
    assert.equal(shouldAutoRetryGrayscaleExecution({ ...transient, failureType }, false), false);
  }
  const source = readFileSync('src/app/api/debug/grayscale-tasks/[taskId]/route.ts', 'utf8');
  assert.match(source, /shouldAutoRetryGrayscaleExecution\(item.run, Boolean\(config.requiresClientExecution \|\| config.executionTarget\)\)/);
});

test('Agent 执行失败时重新执行', () => {
  assert.equal(resolveGrayscaleRetryMode({
    status: 'fail',
    sessionId: 'trace-1',
    failureType: 'agent_error',
  }), 'execution');
});

test('评估器失败且 Trace 可复用时仅重新评测', () => {
  assert.equal(resolveGrayscaleRetryMode({
    status: 'fail',
    sessionId: 'trace-1',
    evaluations: [{ status: 'done' }, { status: 'failed' }],
  }), 'evaluation');
});

test('Agent 已执行但评测未完成时仅重新评测', () => {
  assert.equal(resolveGrayscaleRetryMode({
    status: 'executed',
    sessionId: 'trace-1',
  }), 'evaluation');
});

test('Trace 缺失时重新执行 Agent', () => {
  assert.equal(resolveGrayscaleRetryMode({
    status: 'fail',
    evaluations: [{ status: 'failed' }],
  }), 'execution');
});

test('已成功运行的主动重试仍重新执行 Agent', () => {
  assert.equal(resolveGrayscaleRetryMode({
    status: 'pass',
    sessionId: 'trace-1',
    evaluations: [{ status: 'done' }],
  }), 'execution');
});
