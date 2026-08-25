import assert from 'node:assert/strict';
import test from 'node:test';

import { saveExecutionRecord } from '@/lib/storage/data-service';
import { prismaRaw } from '@/lib/storage/prisma';

test('Pi complete snapshot replaces smaller historical Generic tool pollution', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskId = `test-pi-complete-snapshot-${suffix}`;
  const user = `test-pi-snapshot-${suffix}`;
  const timestamp = new Date().toISOString();

  const historicalGenericInteractions = [
    { role: 'user', agent: 'pi-agent', content: 'read the fixture', timestamp },
    {
      role: 'assistant',
      agent: 'pi-agent',
      content: '',
      timestamp,
      tool_calls: [{
        id: `${taskId}-generic-tool`,
        type: 'function',
        function: { name: 'agent.pi', arguments: '{}' },
      }],
    },
  ];
  const canonicalPiInteractions = [
    { role: 'user', agent: 'pi-agent', content: 'read the fixture', timestamp },
    {
      role: 'assistant',
      agent: 'pi-agent',
      content: 'fixture read',
      timestamp,
      tool_calls: [{
        id: `${taskId}-read-tool`,
        type: 'function',
        function: { name: 'read', arguments: '{"path":"fixture.json"}' },
      }],
    },
  ];

  try {
    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'pi-agent',
      user,
      query: 'read the fixture',
      interactions: historicalGenericInteractions,
      session_merge_strategy: 'monotonic',
    });

    await saveExecutionRecord({
      upload_id: taskId,
      task_id: taskId,
      framework: 'pi-agent',
      user,
      query: 'read the fixture',
      interactions: canonicalPiInteractions,
      session_merge_strategy: 'snapshot-replace',
      complete_session_snapshot: true,
    });

    const session = await prismaRaw.session.findUnique({
      where: { taskId },
      select: { interactions: true },
    });
    const interactions = JSON.parse(session?.interactions || '[]');
    const serialized = JSON.stringify(interactions);

    assert.deepEqual(interactions, canonicalPiInteractions);
    assert.equal(serialized.includes('agent.pi'), false);
    assert.equal(serialized.includes('"read"'), true);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { taskId } });
    await prismaRaw.session.deleteMany({ where: { taskId } });
    await prismaRaw.registeredAgent.deleteMany({ where: { user, platform: 'pi-agent' } });
  }
});
