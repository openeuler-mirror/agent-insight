import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as listExperimentAgents } from '@/app/api/experiments/agents/route';
import { canonicalExperimentAgentName } from '@/lib/engine/experiment/agent-identity';
import { prisma } from '@/lib/storage/prisma';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TEST_USER = `experiment-xiaoo-${RUN_ID}`;
const CLIENT_ID = `xiaoo-client-${RUN_ID}`;

test('xiaoo display identity keeps the native CLI agent id on executable targets', async (t) => {
  assert.equal(canonicalExperimentAgentName('xiaoo', 'defaultagent'), 'xiaoo');
  assert.equal(canonicalExperimentAgentName('opencode', 'build'), 'build');

  const execution = await prisma.execution.create({
    data: {
      taskId: `xiaoo-task-${RUN_ID}`,
      framework: 'xiaoo',
      agentName: 'xiaoo',
      user: TEST_USER,
    },
  });
  await prisma.reliabilityClient.create({
    data: {
      clientId: CLIENT_ID,
      user: TEST_USER,
      name: 'xiaoo test host',
      hostname: 'xiaoo-host',
      status: 'online',
      serviceHealth: 'healthy',
      lastSeenAt: new Date(),
      capabilitiesJson: JSON.stringify({
        actions: ['RUN_EXPERIMENT_CASE'],
        platforms: [{
          id: 'xiaoo',
          agents: ['defaultagent'],
          models: ['provider/model'],
          actions: ['RUN_EXPERIMENT_CASE'],
          runExperimentCase: { version: 2, returnsTraceId: true },
        }],
      }),
    },
  });

  t.after(async () => {
    await prisma.reliabilityClient.deleteMany({ where: { clientId: CLIENT_ID } });
    await prisma.execution.deleteMany({ where: { id: execution.id } });
  });

  const response = await listExperimentAgents(
    new Request(`http://localhost/api/experiments/agents?user=${encodeURIComponent(TEST_USER)}`),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agents.some((agent: { name: string }) => agent.name === 'defaultagent'), false);
  const xiaoo = body.agents.find((agent: { name: string }) => agent.name === 'xiaoo');
  assert.ok(xiaoo);
  assert.equal(xiaoo.traces, 1);
  assert.deepEqual(xiaoo.frameworks, ['xiaoo']);
  assert.equal(xiaoo.executable, true);
  assert.equal(xiaoo.targets.length, 1);
  assert.equal(xiaoo.targets[0].platform, 'xiaoo');
  assert.equal(xiaoo.targets[0].agent, 'defaultagent');
  assert.equal(xiaoo.targets[0].supportsGenericTrace, true);
});
