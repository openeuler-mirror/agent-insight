/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import {
  ensureEvaluatorExecutionInteractions,
  normalizeEvaluatorExecutionInteractions,
} from '@/lib/engine/evaluation/evaluator-execution-recorder';

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

test('falls back to query and final output when opencode messages are empty', () => {
  const interactions = ensureEvaluatorExecutionInteractions([], {
    taskId: 'ses_empty',
    agentName: 'grayscale-baseline-agent',
    user: 'tester',
    query: 'diagnose high cpu',
    fallbackOutput: 'top process is rg',
  });

  assert.equal(interactions.length, 2);
  assert.equal(interactions[0]?.role, 'user');
  assert.equal(interactions[0]?.content, 'diagnose high cpu');
  assert.equal(interactions[1]?.role, 'assistant');
  assert.equal(interactions[1]?.content, 'top process is rg');
  assert.equal(interactions[1]?.agent, 'grayscale-baseline-agent');
});

test('appends fallback output when messages lack assistant content', () => {
  const interactions = ensureEvaluatorExecutionInteractions([
    { role: 'user', content: 'diagnose high cpu' },
  ], {
    taskId: 'ses_user_only',
    agentName: 'grayscale-baseline-agent',
    query: 'diagnose high cpu',
    fallbackOutput: 'answer from chat result',
  });

  assert.equal(interactions.length, 2);
  assert.equal(interactions[1]?.role, 'assistant');
  assert.equal(interactions[1]?.content, 'answer from chat result');
});
