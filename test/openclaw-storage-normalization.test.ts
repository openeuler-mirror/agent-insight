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
