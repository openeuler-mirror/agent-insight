import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { triggerExperimentWatchForTask } from '@/lib/engine/experiment/experiment-watch';
import { setFaithfulPresetRunnerForTest } from '@/lib/engine/experiment/faithful-preset-evaluators';
import { prisma } from '@/lib/storage/prisma';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TEST_USER = `experiment-watch-${RUN_ID}`;
const AGENT_NAME = `watch-agent-${RUN_ID}`;
const FRAMEWORK = `watch-framework-${RUN_ID}`;

async function createCompletedExecution(taskId: string, agentId: string) {
  const execution = await prisma.execution.create({
    data: {
      taskId,
      framework: FRAMEWORK,
      agentName: AGENT_NAME,
      agentId,
      user: TEST_USER,
      timestamp: new Date(),
      query: `输入 ${taskId}`,
      finalResult: `输出 ${taskId}`,
    },
  });
  await prisma.session.create({
    data: { taskId, user: TEST_USER, endTime: new Date() },
  });
  return execution;
}

test('自动监听：匹配且已结束的 Trace 自动加入，停止监听后不再加入', async (t) => {
  setFaithfulPresetRunnerForTest(async () => ({
    score: 86,
    points: [],
    evidence: { md: '自动监听测试' },
  }));
  const registration = await prisma.registeredAgent.create({
    data: {
      platform: FRAMEWORK,
      name: AGENT_NAME,
      user: TEST_USER,
      agentOwnership: 'user',
    },
  });
  const experiment = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: '自动监听实测',
      agentName: AGENT_NAME,
      evaluatorIdsJson: JSON.stringify(['preset-agent-task-completion']),
      status: 'draft',
      watchMode: true,
      watchEnabledAt: new Date(0),
    },
  });
  const firstTaskId = `watch-first-${RUN_ID}`;
  const secondTaskId = `watch-second-${RUN_ID}`;
  const firstExecution = await createCompletedExecution(firstTaskId, registration.id);

  t.after(async () => {
    setFaithfulPresetRunnerForTest(null);
    await prisma.experiment.deleteMany({ where: { id: experiment.id } });
    await prisma.session.deleteMany({ where: { taskId: { in: [firstTaskId, secondTaskId] } } });
    await prisma.execution.deleteMany({ where: { id: { in: [firstExecution.id] } } });
    await prisma.execution.deleteMany({ where: { taskId: secondTaskId } });
    await prisma.registeredAgent.deleteMany({ where: { id: registration.id } });
  });

  await triggerExperimentWatchForTask(TEST_USER, firstTaskId);
  const firstCase = await prisma.experimentCase.findFirst({
    where: { experimentId: experiment.id, taskId: firstTaskId },
  });
  assert.ok(firstCase);
  const firstResult = await prisma.experimentEvalResult.findFirst({
    where: { experimentId: experiment.id, caseId: firstCase.id },
  });
  assert.equal(firstResult?.status, 'done');
  assert.equal(firstResult?.score, 86);

  await prisma.experiment.update({
    where: { id: experiment.id },
    data: { watchMode: false },
  });
  await createCompletedExecution(secondTaskId, registration.id);
  await triggerExperimentWatchForTask(TEST_USER, secondTaskId);
  assert.equal(
    await prisma.experimentCase.count({
      where: { experimentId: experiment.id, taskId: secondTaskId },
    }),
    0,
  );
});
