import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as retryExperimentCase } from '@/app/api/experiments/[id]/cases/[caseId]/retry/route';
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

test('自动监听：仅绑定 taskId 的 Case 在评估失败后可整体重试', async (t) => {
  const taskId = `watch-retry-${RUN_ID}`;
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
      name: '自动监听重试实测',
      agentName: AGENT_NAME,
      evaluatorIdsJson: JSON.stringify(['preset-agent-trace-quality']),
      status: 'draft',
      watchMode: true,
      watchEnabledAt: new Date(0),
    },
  });
  const execution = await createCompletedExecution(taskId, registration.id);

  t.after(async () => {
    setFaithfulPresetRunnerForTest(null);
    await prisma.experiment.deleteMany({ where: { id: experiment.id } });
    await prisma.session.deleteMany({ where: { taskId } });
    await prisma.execution.deleteMany({ where: { id: execution.id } });
    await prisma.registeredAgent.deleteMany({ where: { id: registration.id } });
  });

  setFaithfulPresetRunnerForTest(async () => {
    throw new Error('模拟轨迹质量评估失败');
  });
  await triggerExperimentWatchForTask(TEST_USER, taskId);

  const caseRow = await prisma.experimentCase.findFirstOrThrow({
    where: { experimentId: experiment.id, taskId },
  });
  assert.equal(caseRow.executionId, null);
  assert.equal(
    await prisma.experimentEvalResult.findFirst({
      where: { experimentId: experiment.id, caseId: caseRow.id },
      select: { status: true },
    }).then((row: { status: string } | null) => row?.status),
    'failed',
  );

  setFaithfulPresetRunnerForTest(async () => ({
    score: 91,
    points: [],
    evidence: { md: '重试成功' },
  }));
  const response = await retryExperimentCase(
    new Request(
      `http://localhost/api/experiments/${experiment.id}/cases/${caseRow.id}/retry?user=${TEST_USER}`,
      { method: 'POST' },
    ),
    { params: Promise.resolve({ id: experiment.id, caseId: caseRow.id }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'evaluation', status: 'done' });
  const retried = await prisma.experimentEvalResult.findFirst({
    where: { experimentId: experiment.id, caseId: caseRow.id },
    select: { status: true, score: true },
  });
  assert.equal(retried?.status, 'done');
  assert.equal(retried?.score, 91);
});
