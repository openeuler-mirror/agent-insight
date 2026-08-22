import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as getExperiment } from '@/app/api/experiments/[id]/route';
import { prisma } from '@/lib/storage/prisma';

test('Skill 工作台实验使用冻结工作量，done 与 pending 不会同时出现', async (t) => {
  const stamp = Date.now();
  const user = `workbench-progress-${stamp}`;
  const task = await prisma.grayscaleTask.create({
    data: {
      user,
      skillId: `skill-${stamp}`,
      skillName: 'progress-skill',
      skillVersion: 1,
      skillVersionId: `version-${stamp}`,
      taskName: '固定进度测试',
      caseStatesJson: JSON.stringify({
        'dataset-case-1': { b: { runs: [{ status: 'pass', sessionId: 'session-1' }] } },
        'dataset-case-2': { b: { runs: [{ status: 'evaluating', sessionId: 'session-2' }] } },
      }),
    },
  });
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
    await prisma.grayscaleTask.deleteMany({ where: { id: task.id } });
  });
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: '固定进度测试',
      status: 'done',
      scope: 'skill-workbench',
      preset: 'use-case',
      evaluatorIdsJson: JSON.stringify(['preset-agent-task-completion', 'preset-agent-trace-quality']),
      configSnapshotJson: JSON.stringify({
        caseIds: ['dataset-case-1', 'dataset-case-2'],
        executionSides: ['b'],
        repeatRounds: 1,
        grayscaleTaskId: task.id,
      }),
    },
  });
  const experimentCase = await prisma.experimentCase.create({
    data: { experimentId: experiment.id, taskId: 'session-1' },
  });
  await prisma.experimentEvalResult.createMany({
    data: [
      { experimentId: experiment.id, caseId: experimentCase.id, evaluatorId: 'preset-agent-task-completion', status: 'done', score: 78 },
      { experimentId: experiment.id, caseId: experimentCase.id, evaluatorId: 'preset-agent-trace-quality', status: 'done', score: 86 },
    ],
  });

  const load = async () => {
    const response = await getExperiment(
      new Request(`http://localhost/api/experiments/${experiment.id}?user=${user}`),
      { params: Promise.resolve({ id: experiment.id }) },
    );
    return response.json();
  };
  const running = await load();
  assert.equal(running.status, 'running');
  assert.deepEqual(running.progress, { total: 4, done: 2, failed: 0, pending: 2 });

  await prisma.grayscaleTask.update({
    where: { id: task.id },
    data: {
      caseStatesJson: JSON.stringify({
        'dataset-case-1': { b: { runs: [{ status: 'pass', sessionId: 'session-1' }] } },
        'dataset-case-2': { b: { runs: [{ status: 'fail', failureType: 'agent_error' }] } },
      }),
    },
  });
  const completed = await load();
  assert.equal(completed.status, 'done');
  assert.deepEqual(completed.progress, { total: 4, done: 2, failed: 2, pending: 0 });
});
