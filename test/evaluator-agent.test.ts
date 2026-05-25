import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPrimaryExecutionAgentName,
  isEvaluatorAgent,
  isEvaluatorTraceRecord,
} from '@/lib/evaluator-agent';

test('recognizes registered evaluator agents by explicit agent tag', () => {
  assert.equal(isEvaluatorAgent({ name: 'trace-quality-evaluator' }), true);
  assert.equal(isEvaluatorAgent({ name: 'worker', parentAgent: 'task-completion-evaluator' }), true);
});

test('filters evaluator trace records by explicit agentName first', () => {
  assert.equal(
    isEvaluatorTraceRecord({
      agentName: 'task-completion-evaluator',
      query: '普通用户问题',
    }),
    true,
  );
});

test('keeps legacy marker fallback for old untagged evaluator traces', () => {
  assert.equal(
    isEvaluatorTraceRecord({
      query: '你是「轨迹评估器」的总协调者',
    }),
    true,
  );
});

test('prefers the real execution agent and skips evaluator agents', () => {
  assert.equal(
    getPrimaryExecutionAgentName({
      agentName: 'task-completion-evaluator',
      agents: ['build', 'fault-diagnosis-agent'],
    }),
    'build',
  );
});
