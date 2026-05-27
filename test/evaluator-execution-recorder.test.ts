import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { normalizeEvaluatorExecutionInteractions } from '@/lib/engine/evaluation/evaluator-execution-recorder';

test('normalizes evaluator raw messages into trace interactions', () => {
  const rawMessages = [
    {
      info: {
        role: 'user',
        time: { created: 1000, completed: 1000 },
        agent: 'trace-quality-evaluator',
      },
      parts: [{ type: 'text', text: '请评估这条轨迹' }],
    },
    {
      info: {
        role: 'assistant',
        time: { created: 2000, completed: 3500 },
        agent: 'trace-quality-evaluator',
        modelID: 'deepseek-chat',
        providerID: 'deepseek-official',
        tokens: {
          input: 12,
          output: 8,
        },
      },
      parts: [
        {
          type: 'tool',
          id: 'tool-1',
          tool: 'bash',
          state: {
            status: 'success',
            input: { command: 'pwd' },
            output: '/tmp',
          },
        },
        {
          type: 'text',
          text: '{"trajectory_score":0.9}',
        },
      ],
    },
  ];

  const interactions = normalizeEvaluatorExecutionInteractions(rawMessages);
  assert.equal(interactions.length, 2);
  assert.equal(interactions[0]?.role, 'user');
  assert.equal(interactions[1]?.role, 'assistant');
  assert.equal(interactions[1]?.tool_calls?.length, 1);
  assert.equal(interactions[1]?.usage?.total, 20);

  const tree = buildAgentCallTree(interactions as any[]);
  assert.ok(tree);
  assert.equal(tree?.stats.llmCalls, 1);
  assert.equal(tree?.stats.toolCalls, 1);
});

test('ignores non-opencode records during normalization', () => {
  const interactions = normalizeEvaluatorExecutionInteractions([
    { foo: 'bar' },
    null,
    undefined,
  ] as any[]);
  assert.deepEqual(interactions, []);
});
