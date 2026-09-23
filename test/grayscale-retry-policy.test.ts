import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGrayscaleRetryMode } from '@/lib/grayscale/retry-policy';

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
