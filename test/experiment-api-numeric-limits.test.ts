import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as listExperiments } from '@/app/api/experiments/route';
import { GET as getExperimentDetail } from '@/app/api/experiments/[id]/route';
import { GET as listEvalRuns } from '@/app/api/experiments/eval-runs/route';
import { GET as listEvalResults } from '@/app/api/experiments/eval-results/route';
import { GET as listExperimentAgents } from '@/app/api/experiments/agents/route';
import { GET as listExperimentTraces } from '@/app/api/experiments/traces/route';
import {
  GET as listComments,
  POST as postComment,
} from '@/app/api/experiments/[id]/comments/route';
import { PATCH as patchResult } from '@/app/api/experiments/[id]/results/[resultId]/route';
import { prisma } from '@/lib/storage/prisma';

const TEST_USER = `experiment-api-limits-${Date.now()}`;
let primaryExperimentId = '';
let resultId = '';

test.before(async () => {
  const primary = await prisma.experiment.create({
    data: {
      user: TEST_USER,
      name: '数值边界主实验',
      type: 'single',
      scope: 'numeric-limit',
      evaluatorIdsJson: JSON.stringify(['numeric-limit-evaluator']),
      status: 'done',
    },
    select: { id: true },
  });
  primaryExperimentId = primary.id;

  await prisma.experiment.createMany({
    data: Array.from({ length: 119 }, (_, index) => ({
      user: TEST_USER,
      name: `数值边界实验 ${index + 1}`,
      type: 'single',
      scope: 'numeric-limit',
      evaluatorIdsJson: '[]',
      status: 'draft',
    })),
  });

  await prisma.experimentCase.createMany({
    data: Array.from({ length: 501 }, (_, index) => ({
      experimentId: primaryExperimentId,
      taskId: `numeric-limit-trace-${index + 1}`,
      input: `输入 ${index + 1}`,
      actualOutput: `输出 ${index + 1}`,
    })),
  });
  const firstCase = await prisma.experimentCase.findFirstOrThrow({
    where: { experimentId: primaryExperimentId },
    select: { id: true },
  });
  const result = await prisma.experimentEvalResult.create({
    data: {
      experimentId: primaryExperimentId,
      caseId: firstCase.id,
      evaluatorId: 'numeric-limit-evaluator',
      status: 'done',
      score: 80,
    },
    select: { id: true },
  });
  resultId = result.id;

  await prisma.experimentEvalComment.createMany({
    data: Array.from({ length: 501 }, (_, index) => ({
      experimentId: primaryExperimentId,
      user: TEST_USER,
      body: `评论 ${index + 1}`,
    })),
  });

  await prisma.execution.createMany({
    data: [
      ...Array.from({ length: 55 }, (_, index) => ({
        taskId: `numeric-limit-agent-task-${index + 1}`,
        user: TEST_USER,
        agentName: `numeric-limit-agent-${index + 1}`,
        isSubagent: false,
      })),
      ...Array.from({ length: 101 }, (_, index) => ({
        taskId: `numeric-limit-page-task-${index + 1}`,
        user: TEST_USER,
        agentName: 'numeric-limit-page-agent',
        isSubagent: false,
      })),
    ],
  });
});

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
  await prisma.execution.deleteMany({ where: { user: TEST_USER } });
});

test('实验列表 limit 最大 100', async () => {
  const response = await listExperiments(new Request(
    `http://localhost/api/experiments?user=${encodeURIComponent(TEST_USER)}&limit=999`,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.limit, 100);
  assert.equal(body.items.length, 100);
  assert.equal(body.total, 120);
});

test('实验详情 casePageSize 最大 100', async () => {
  const response = await getExperimentDetail(
    new Request(`http://localhost/api/experiments/${primaryExperimentId}?user=${encodeURIComponent(TEST_USER)}&casePageSize=999`),
    { params: Promise.resolve({ id: primaryExperimentId }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.casePageSize, 100);
  assert.equal(body.cases.length, 100);
  assert.equal(body.caseTotal, 501);
});

test('评估运行 limit 最大 50', async () => {
  const response = await listEvalRuns(new Request(
    `http://localhost/api/experiments/eval-runs?user=${encodeURIComponent(TEST_USER)}&limit=999`,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.runs.length, 50);
  assert.equal(body.hasMore, true);
});

test('评估结果 limit 最大 500', async () => {
  const response = await listEvalResults(new Request(
    `http://localhost/api/experiments/eval-results?user=${encodeURIComponent(TEST_USER)}&runId=${primaryExperimentId}&limit=999`,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results.length, 500);
});

test('候选 Agent 最多返回 50 个', async () => {
  const response = await listExperimentAgents(new Request(
    `http://localhost/api/experiments/agents?user=${encodeURIComponent(TEST_USER)}`,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.agents.length, 50);
});

test('Trace 查询 pageSize 最大 100', async () => {
  const response = await listExperimentTraces(new Request(
    `http://localhost/api/experiments/traces?user=${encodeURIComponent(TEST_USER)}&agent=numeric-limit-page-agent&pageSize=999`,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.pageSize, 100);
  assert.equal(body.items.length, 100);
  assert.equal(body.total, 101);
});

test('评论单次查询最多返回 500 条', async () => {
  const response = await listComments(
    new Request(`http://localhost/api/experiments/${primaryExperimentId}/comments?user=${encodeURIComponent(TEST_USER)}&scope=all`),
    { params: Promise.resolve({ id: primaryExperimentId }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 500);
});

test('评论正文截断到 2000 字符', async () => {
  const response = await postComment(
    new Request(`http://localhost/api/experiments/${primaryExperimentId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: TEST_USER, body: '评'.repeat(2001) }),
    }),
    { params: Promise.resolve({ id: primaryExperimentId }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.body.length, 2000);
});

test('人工评分保留 1 位小数，理由截断到 1000 字符', async () => {
  const response = await patchResult(
    new Request(`http://localhost/api/experiments/${primaryExperimentId}/results/${resultId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: TEST_USER, humanScore: 88.86, humanReason: '理'.repeat(1001) }),
    }),
    { params: Promise.resolve({ id: primaryExperimentId, resultId }) },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.humanScore, 88.9);
  assert.equal(body.humanReason.length, 1000);
});
