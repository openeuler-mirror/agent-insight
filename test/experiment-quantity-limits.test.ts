import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as appendExperimentCases } from '@/app/api/experiments/[id]/cases/route';
import { prisma } from '@/lib/storage/prisma';

const TEST_USER = `experiment-quantity-${Date.now()}`;

async function createExperiment(): Promise<string> {
  const experiment = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: '实验数量边界测试',
      type: 'single',
      evaluatorIdsJson: JSON.stringify(['preset-agent-task-completion']),
      status: 'draft',
    },
    select: { id: true },
  });
  return experiment.id;
}

function appendRequest(experimentId: string, count: number): Promise<Response> {
  const cases = Array.from({ length: count }, (_, index) => ({
    taskId: `${experimentId}-trace-${index + 1}`,
    input: `输入 ${index + 1}`,
    actualOutput: `输出 ${index + 1}`,
  }));
  return appendExperimentCases(
    new Request(`http://localhost/api/experiments/${experimentId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: TEST_USER, cases, autoRun: false }),
    }),
    { params: Promise.resolve({ id: experimentId }) },
  );
}

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
});

test('case 追加数量边界：200 条成功，201 条拒绝且不产生部分写入', async () => {
  const acceptedExperimentId = await createExperiment();
  const accepted = await appendRequest(acceptedExperimentId, 200);
  const acceptedBody = await accepted.json();

  assert.equal(accepted.status, 200);
  assert.equal(acceptedBody.added, 200);
  assert.equal(acceptedBody.reused, 0);
  assert.equal(acceptedBody.evaluating, false);
  assert.equal(
    await prisma.experimentCase.count({ where: { experimentId: acceptedExperimentId } }),
    200,
  );

  const rejectedExperimentId = await createExperiment();
  const rejected = await appendRequest(rejectedExperimentId, 201);
  const rejectedBody = await rejected.json();

  assert.equal(rejected.status, 400);
  assert.match(rejectedBody.error, /一次最多追加 200 条 case/);
  assert.equal(
    await prisma.experimentCase.count({ where: { experimentId: rejectedExperimentId } }),
    0,
  );
});
