import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import {
  buildDirectEvaluatorInteractions,
  shouldForceOpencodeEvalTransport,
} from '@/lib/engine/evaluation/evaluator-execution-recorder';

const TS = '2026-06-10T00:00:00.000Z';

test('synthesizes user + assistant interactions for a single-shot LLM judge', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    query: 'case-input-short',
    userMessage: '# Key Action Trace Analysis Input\n{...big payload...}',
    assistantOutput: '{"dimension_scores":{"tool_choice":0.8,"redundancy":0.6}}',
    usage: { input: 1200, output: 300 },
    modelID: 'deepseek-chat',
    timestampISO: TS,
  });

  assert.equal(interactions.length, 2);
  assert.equal(interactions[0]?.role, 'user');
  // user content prefers the real prompt (userMessage), not the short display query
  assert.match(interactions[0]?.content ?? '', /Key Action Trace Analysis Input/);
  assert.equal(interactions[1]?.role, 'assistant');
  assert.equal(interactions[1]?.agent, 'trace-quality-evaluator');
  assert.equal(interactions[1]?.modelID, 'deepseek-chat');
  // total is derived from input+output when not supplied
  assert.equal(interactions[1]?.usage?.total, 1500);
});

test('renders as a 1-LLM-call / 0-tool-call trace (matches what a judge actually is)', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'task-completion-evaluator',
    userMessage: 'judge this',
    assistantOutput: '{"score":0.9,"is_correct":true,"key_point_findings":[]}',
    usage: { input: 10, output: 5, total: 15 },
    timestampISO: TS,
  });

  const tree = buildAgentCallTree(
    interactions as unknown as Parameters<typeof buildAgentCallTree>[0],
  );
  assert.ok(tree);
  assert.equal(tree?.stats.llmCalls, 1);
  assert.equal(tree?.stats.toolCalls, 0);
});

test('explicit usage.total wins over input+output sum', () => {
  const interactions = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    userMessage: 'u',
    assistantOutput: 'a',
    usage: { input: 100, output: 50, total: 999 },
    timestampISO: TS,
  });
  assert.equal(interactions[1]?.usage?.total, 999);
});

test('falls back to display query when userMessage is absent; drops empty content', () => {
  const onlyUser = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    query: 'just the case input',
    assistantOutput: '',
    timestampISO: TS,
  });
  assert.equal(onlyUser.length, 1);
  assert.equal(onlyUser[0]?.role, 'user');
  assert.equal(onlyUser[0]?.content, 'just the case input');

  const empty = buildDirectEvaluatorInteractions({
    agentName: 'trace-quality-evaluator',
    timestampISO: TS,
  });
  assert.deepEqual(empty, []);
});

test('transport flag defaults to direct LLM, opt back into opencode with env=1', () => {
  const prev = process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  delete process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  assert.equal(shouldForceOpencodeEvalTransport(), false);
  process.env.EVAL_FORCE_OPENCODE_TRANSPORT = '1';
  assert.equal(shouldForceOpencodeEvalTransport(), true);
  if (prev === undefined) delete process.env.EVAL_FORCE_OPENCODE_TRANSPORT;
  else process.env.EVAL_FORCE_OPENCODE_TRANSPORT = prev;
});
