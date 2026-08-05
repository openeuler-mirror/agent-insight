import assert from 'node:assert/strict';
import test from 'node:test';

import { saveExecutionRecord } from '@/lib/storage/data-service';
import { prismaRaw } from '@/lib/storage/prisma';

test('Pi persists delegated work under the Pi Agent identity', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = `test-agent-identity-${suffix}`;
  const rootId = `test-pi-agent-identity-${suffix}`;
  const childSessionId = `${rootId}-worker`;
  const timestamp = new Date().toISOString();

  try {
    await prismaRaw.registeredAgent.create({
      data: { platform: 'pi-agent', name: 'worker', user, agentType: 'subagent', agentOwnership: 'user' },
    });
    await saveExecutionRecord({
      upload_id: rootId,
      task_id: rootId,
      framework: 'pi-agent',
      user,
      agentName: 'worker',
      interactions: [
        { role: 'user', agent: 'pi-agent', content: 'delegate', timestamp },
        {
          role: 'assistant',
          agent: 'pi-agent',
          content: '',
          timestamp,
          tool_calls: [{
            id: `${rootId}-task`,
            type: 'function',
            function: {
              name: 'task',
              arguments: JSON.stringify({ subagent_type: 'worker', session_id: childSessionId }),
            },
          }],
        },
        {
          role: 'subagent',
          agent: 'worker',
          subagent_name: 'worker',
          subagent_session_id: childSessionId,
          content: 'completed',
          timestamp,
        },
      ],
    });

    const root = await prismaRaw.execution.findUnique({
      where: { id: rootId },
      select: { agentName: true, observedAgents: true },
    });
    const child = await prismaRaw.execution.findFirst({
      where: { parentExecutionId: rootId },
      select: { agentName: true, observedAgents: true, subagentName: true },
    });
    const registrations = await prismaRaw.registeredAgent.findMany({
      where: { platform: 'pi-agent', user },
      select: { name: true, agentType: true },
    });

    assert.deepEqual(root, { agentName: 'pi-agent', observedAgents: '["pi-agent"]' });
    assert.deepEqual(child, {
      agentName: 'pi-agent', observedAgents: '["pi-agent"]', subagentName: 'worker',
    });
    assert.deepEqual(registrations, [{ name: 'pi-agent', agentType: 'main' }]);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { user, framework: 'pi-agent' } });
    await prismaRaw.registeredAgent.deleteMany({ where: { user, platform: 'pi-agent' } });
  }
});
