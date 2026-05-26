import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('task completion evaluator stays single-agent and forbids subagents', () => {
  const file = path.join(process.cwd(), 'src/lib/engine/evaluation/opencode-task-completion-evaluator.ts');
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /禁止派发、调用或生成任何 subagent \/ task/);
  assert.doesNotMatch(source, /raw_subagent_outputs/);
  assert.doesNotMatch(source, /const KEY_POINTS_CHECKER_PROMPT =/);
  assert.doesNotMatch(source, /name:\s*'key-points-checker'/);
});

test('trajectory evaluator stays single-agent and forbids subagents', () => {
  const file = path.join(process.cwd(), 'src/lib/engine/evaluation/opencode-trajectory-evaluator.ts');
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /禁止派发、调用或生成任何 subagent \/ task/);
  assert.match(source, /dimension_details/);
  assert.match(source, /Step 1：冗余分析/);
  assert.match(source, /Step 5：聚合输出/);
  assert.match(source, /最终只输出 JSON/);
  assert.match(source, /不要输出步骤过程/);
  assert.match(source, /dimension_scores\.completeness.*dimension_details\.completeness\.score/);
  assert.doesNotMatch(source, /raw_subagent_outputs/);
  assert.doesNotMatch(source, /const COMPLETENESS_CHECKER_PROMPT =/);
  assert.doesNotMatch(source, /const TOOL_CHOICE_JUDGE_PROMPT =/);
  assert.doesNotMatch(source, /const ATTRIBUTION_LOCATOR_PROMPT =/);
  assert.doesNotMatch(source, /name:\s*'completeness-checker'/);
  assert.doesNotMatch(source, /name:\s*'tool-choice-judge'/);
  assert.doesNotMatch(source, /name:\s*'attribution-locator'/);
});
