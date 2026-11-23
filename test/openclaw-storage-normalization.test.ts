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

import { openclawAdapter } from '@/lib/ingest/adapters/openclaw';

test('OpenClaw storage normalization is idempotent and does not mutate its input', () => {
  const source: any[] = [{
    role: 'assistant',
    name: 'invoke_agent',
    attributes: {
      'gen_ai.span.kind': 'agent',
      'witty.agent.name': 'planner',
      'witty.agent.id': 'planner-1',
      'witty.session.id': 'session-1',
    },
    tool_calls: [{
      id: 'skill-1',
      type: 'function',
      function: {
        name: 'skill',
        arguments: JSON.stringify({ skill: 'otel-debug', version: 2 }),
      },
    }],
  }];

  const once = openclawAdapter.normalizeForStorage!(source);
  const twice = openclawAdapter.normalizeForStorage!(once);
  const thrice = openclawAdapter.normalizeForStorage!(twice);
  const content = thrice[0].responseMessage.content.filter((block: any) => block.type === 'toolCall');

  assert.deepEqual(content.map((block: any) => block.name).sort(), ['skill', 'task']);
  assert.equal(source[0].tool_calls.length, 1);
  assert.deepEqual(twice, thrice);
});
