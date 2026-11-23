import assert from 'node:assert/strict';
import test from 'node:test';
import { startIsolatedControlCore } from './helpers/isolated-control-core';
import { bootstrapCoreControlUser } from '@/lib/storage-core/control-auth';
import { withCoreControlRequest } from '@/lib/storage-core/control-context';
import { prisma } from '@/lib/storage/prisma';
import { cleanupBuiltinDemoData, DEMO_AGENT_NAME, DEMO_AGENT_DESCRIPTION } from '@/server/builtin-example/cleanup-demo';

test('startup demo cleanup uses verified Core owners, preserves user records, and is idempotent', async () => {
  const core = await startIsolatedControlCore(['fixture-owner']);
  try {
    const user = await bootstrapCoreControlUser('cleanup-owner');
    const scoped = <T>(action: () => Promise<T>) => withCoreControlRequest(new Request('http://localhost/internal/test', {
      headers: { authorization: 'Bearer ' + user.apiKey },
    }), action);
    await scoped(async () => {
      await prisma.registeredAgent.create({ data: { name: DEMO_AGENT_NAME, description: DEMO_AGENT_DESCRIPTION, user: user.username, platform: 'opencode' } });
      await prisma.registeredAgent.create({ data: { name: 'user-agent', user: user.username, platform: 'opencode' } });
    });
    assert.deepEqual(await cleanupBuiltinDemoData(), { executions: 0, sessions: 0, agents: 1, datasets: 0, skills: 0 });
    assert.deepEqual(await cleanupBuiltinDemoData(), { executions: 0, sessions: 0, agents: 0, datasets: 0, skills: 0 });
    assert.deepEqual(await scoped(() => prisma.registeredAgent.findMany({ select: { name: true } })), [{ name: 'user-agent' }]);
  } finally { await core.dispose(); }
});
