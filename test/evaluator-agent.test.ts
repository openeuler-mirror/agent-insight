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
  assert.match(source, /关键动作轨迹分析器/);
  assert.match(source, /只输出严格 JSON/);
  assert.match(source, /不要输出 deviation_steps/);
  assert.match(source, /key_action_results/);
  assert.match(source, /dimension_scores\.completeness 为 null/);
  assert.match(source, /dimension_details\.completeness\.score 为 null/);
  assert.doesNotMatch(source, /raw_subagent_outputs/);
  assert.doesNotMatch(source, /const COMPLETENESS_CHECKER_PROMPT =/);
  assert.doesNotMatch(source, /const TOOL_CHOICE_JUDGE_PROMPT =/);
  assert.doesNotMatch(source, /const ATTRIBUTION_LOCATOR_PROMPT =/);
  assert.doesNotMatch(source, /name:\s*'completeness-checker'/);
  assert.doesNotMatch(source, /name:\s*'tool-choice-judge'/);
  assert.doesNotMatch(source, /name:\s*'attribution-locator'/);
  assert.match(source, /new AgentInsight\(\{[\s\S]*?directory:\s*'\/tmp'/);
  assert.match(source, /createSession\(\{[\s\S]*?directory:\s*'\/tmp'/);
});

test('OpenCode 评估器创建 Session 时都绑定确定的工作目录', () => {
  const fixedDirectoryEvaluators = [
    'src/lib/engine/experiment/judge-llm.ts',
    'src/lib/engine/evaluation/custom-llm-evaluator.ts',
    'src/lib/engine/evaluation/opencode-task-completion-evaluator.ts',
    'src/lib/engine/evaluation/opencode-trajectory-evaluator.ts',
  ];
  for (const relativePath of fixedDirectoryEvaluators) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    assert.match(source, /createSession\(\{[\s\S]*?directory:\s*'\/tmp'/, relativePath);
  }

  const suggestionAgent = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/engine/evaluation/skill-suggestion-agent.ts'),
    'utf8',
  );
  assert.match(
    suggestionAgent,
    /createSession\(\{[\s\S]*?directory:\s*args\.workspaceDir/,
  );
});
