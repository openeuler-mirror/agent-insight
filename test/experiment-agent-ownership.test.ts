import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as listExperimentAgents } from '@/app/api/experiments/agents/route';
import { GET as listExperimentTraces } from '@/app/api/experiments/traces/route';
import { triggerExperimentWatchForTask } from '@/lib/engine/experiment/experiment-watch';
import { prisma } from '@/lib/storage/prisma';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TEST_USER = `experiment-owner-${RUN_ID}`;
const USER_AGENT = `user-agent-${RUN_ID}`;
const SYSTEM_AGENT = `system-agent-${RUN_ID}`;
const FRAMEWORK = `test-framework-${RUN_ID}`;
const USER_TASK = `user-task-${RUN_ID}`;
const SYSTEM_TASK = `system-task-${RUN_ID}`;

test('experiment candidates, traces, and watch mode exclude system-owned agents', async (t) => {
  const userRegistration = await prisma.registeredAgent.create({
    data: {
      platform: FRAMEWORK,
      name: USER_AGENT,
      user: TEST_USER,
      agentOwnership: 'user',
    },
  });
  const systemRegistration = await prisma.registeredAgent.create({
    data: {
      platform: FRAMEWORK,
      name: SYSTEM_AGENT,
      user: null,
      agentOwnership: 'system',
    },
  });
  const userExecution = await prisma.execution.create({
    data: {
      taskId: USER_TASK,
      framework: FRAMEWORK,
      agentName: USER_AGENT,
      agentId: userRegistration.id,
      user: TEST_USER,
    },
  });
  const systemExecution = await prisma.execution.create({
    data: {
      taskId: SYSTEM_TASK,
      framework: FRAMEWORK,
      agentName: SYSTEM_AGENT,
      agentId: systemRegistration.id,
      user: TEST_USER,
    },
  });
  await prisma.session.create({
    data: {
      taskId: SYSTEM_TASK,
      user: TEST_USER,
      endTime: new Date(),
    },
  });
  const watchExperiment = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: `watch-${RUN_ID}`,
      agentName: SYSTEM_AGENT,
      evaluatorIdsJson: '[]',
      watchMode: true,
      watchEnabledAt: new Date(0),
    },
  });

  t.after(async () => {
    await prisma.experimentCase.deleteMany({ where: { experimentId: watchExperiment.id } });
    await prisma.experiment.deleteMany({ where: { id: watchExperiment.id } });
    await prisma.session.deleteMany({ where: { taskId: SYSTEM_TASK } });
    await prisma.execution.deleteMany({ where: { id: { in: [userExecution.id, systemExecution.id] } } });
    await prisma.registeredAgent.deleteMany({
      where: { id: { in: [userRegistration.id, systemRegistration.id] } },
    });
  });

  const agentsResponse = await listExperimentAgents(
    new Request(`http://localhost/api/experiments/agents?user=${encodeURIComponent(TEST_USER)}`),
  );
  assert.equal(agentsResponse.status, 200);
  assert.deepEqual((await agentsResponse.json()).agents, [{ name: USER_AGENT, traces: 1 }]);

  const userTracesResponse = await listExperimentTraces(
    new Request(
      `http://localhost/api/experiments/traces?user=${encodeURIComponent(TEST_USER)}&agent=${encodeURIComponent(USER_AGENT)}`,
    ),
  );
  assert.equal(userTracesResponse.status, 200);
  assert.equal((await userTracesResponse.json()).total, 1);

  const systemTracesResponse = await listExperimentTraces(
    new Request(
      `http://localhost/api/experiments/traces?user=${encodeURIComponent(TEST_USER)}&agent=${encodeURIComponent(SYSTEM_AGENT)}`,
    ),
  );
  assert.equal(systemTracesResponse.status, 200);
  assert.equal((await systemTracesResponse.json()).total, 0);

  await triggerExperimentWatchForTask(TEST_USER, SYSTEM_TASK);
  assert.equal(
    await prisma.experimentCase.count({ where: { experimentId: watchExperiment.id } }),
    0,
  );
});
