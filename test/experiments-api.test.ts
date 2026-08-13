// 实验 API 冒烟：POST 创建 → GET 列表 → GET 详情（落在仓库 data/witty_insight.db）。
// 显式钉住 DATABASE_URL：loadAgentInsightEnv 不覆盖已存在的 env，避免测试写到 ~/.agent-insight。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as listExperiments, POST as createExperiment } from '@/app/api/experiments/route';
import { GET as getExperiment } from '@/app/api/experiments/[id]/route';
import { prisma } from '@/lib/storage/prisma';

const TEST_USER = `exp-smoke-${Date.now()}`;

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/experiments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('experiments API: POST create -> GET list -> GET detail', async (t) => {
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user: TEST_USER } });
  });

  // 创建
  const createRes = await createExperiment(postReq({
    user: TEST_USER,
    name: '冒烟实验',
    agentName: 'smoke-agent',
    cases: [
      {
        executionId: 'exec-1', taskId: 'task-1', input: 'q1', actualOutput: 'a1', referenceOutput: 'ref1',
        evaluatorContext: {
          schemaVersion: 1,
          availableTools: [{ name: 'search', description: '搜索' }],
          availableSkills: [{ name: 'research_playbook', description: '检索后归纳资料' }],
        },
      },
      {
        executionId: 'exec-2', taskId: 'task-2', input: 'q2', actualOutput: 'a2',
      },
    ],
    evaluatorIds: ['preset-agent-trace-quality', 'preset-agent-task-completion'],
  }));
  assert.equal(createRes.status, 200);
  const { id } = await createRes.json();
  assert.ok(typeof id === 'string' && id.length > 0);

  // 列表
  const listRes = await listExperiments(
    new Request(`http://localhost/api/experiments?user=${TEST_USER}`),
  );
  assert.equal(listRes.status, 200);
  const { items } = await listRes.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  assert.equal(items[0].name, '冒烟实验');
  assert.equal(items[0].type, 'single');
  assert.equal(items[0].status, 'draft');
  assert.equal(items[0].caseCount, 2);
  assert.equal(items[0].evaluatorCount, 2);
  assert.equal(items[0].overallScore, null);

  // 详情
  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${TEST_USER}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.name, '冒烟实验');
  assert.equal(detail.agentName, 'smoke-agent');
  assert.deepEqual(detail.evaluatorIds, ['preset-agent-trace-quality', 'preset-agent-task-completion']);
  assert.equal(detail.cases.length, 2);
  assert.equal(detail.cases[0].referenceOutput, 'ref1');
  assert.equal(detail.cases[1].referenceOutput, null);
  assert.deepEqual(detail.cases[0].evaluatorContext, {
    schemaVersion: 1,
    availableTools: [{ name: 'search', description: '搜索' }],
    availableSkills: [{ name: 'research_playbook', description: '检索后归纳资料' }],
  });
  assert.equal(detail.cases[1].evaluatorContext, null);
  assert.deepEqual(detail.results, []);
});

test('experiments API: reliability FI fields stay off evaluatorContextJson', async (t) => {
  const user = `exp-fi-${Date.now()}`;
  t.after(async () => {
    await prisma.experiment.deleteMany({ where: { user } });
  });

  const createRes = await createExperiment(postReq({
    user,
    name: '可靠性 FI 分离',
    agentName: 'fi-agent',
    cases: [
      {
        input: 'inject me',
        faultInjectionType: 'analysis-paralysis',
        values: { fault_injection_type: 'analysis-paralysis', scene: 'e2e' },
      },
      {
        input: 'with tools + fi',
        faultInjectionType: 'tool-failure',
        evaluatorContext: {
          schemaVersion: 1,
          availableTools: [{ name: 'bash' }],
        },
      },
    ],
    evaluatorIds: ['preset-ras-reliability'],
  }));
  assert.equal(createRes.status, 200);
  const { id } = await createRes.json();

  const rows = await prisma.experimentCase.findMany({
    where: { experimentId: id },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].faultInjectionType, 'analysis-paralysis');
  assert.equal(rows[0].evaluatorContextJson, null);
  assert.match(String(rows[0].caseValuesJson), /analysis-paralysis/);
  assert.equal(rows[1].faultInjectionType, 'tool-failure');
  assert.deepEqual(JSON.parse(String(rows[1].evaluatorContextJson)), {
    schemaVersion: 1,
    availableTools: [{ name: 'bash' }],
  });

  const detailRes = await getExperiment(
    new Request(`http://localhost/api/experiments/${id}?user=${user}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.cases[0].faultInjectionType, 'analysis-paralysis');
  assert.equal(detail.cases[0].evaluatorContext, null);
  assert.equal(detail.cases[0].evaluatorContextError, null);
  assert.equal(detail.cases[1].faultInjectionType, 'tool-failure');
  assert.deepEqual(detail.cases[1].evaluatorContext, {
    schemaVersion: 1,
    availableTools: [{ name: 'bash' }],
  });
});

test('experiments API: POST validation rejects empty payloads', async () => {
  const noName = await createExperiment(postReq({
    user: TEST_USER, name: '', agentName: 'a',
    cases: [{ input: 'q', actualOutput: 'a' }], evaluatorIds: ['x'],
  }));
  assert.equal(noName.status, 400);

  const noCases = await createExperiment(postReq({
    user: TEST_USER, name: 'n', agentName: 'a', cases: [], evaluatorIds: ['x'],
  }));
  assert.equal(noCases.status, 400);

  const noEvaluators = await createExperiment(postReq({
    user: TEST_USER, name: 'n', agentName: 'a',
    cases: [{ input: 'q', actualOutput: 'a' }], evaluatorIds: [],
  }));
  assert.equal(noEvaluators.status, 400);

  const invalidContext = await createExperiment(postReq({
    user: TEST_USER, name: 'n', agentName: 'a',
    cases: [{ input: 'q', actualOutput: 'a', evaluatorContext: { schemaVersion: 1 } }],
    evaluatorIds: ['x'],
  }));
  assert.equal(invalidContext.status, 400);
  assert.match(String((await invalidContext.json()).error), /availableTools/);
});

test('experiments API: detail 404 for missing experiment', async () => {
  const res = await getExperiment(
    new Request(`http://localhost/api/experiments/nope?user=${TEST_USER}`),
    { params: Promise.resolve({ id: 'nope' }) },
  );
  assert.equal(res.status, 404);
});
