import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GET } from '../../src/app/api/experiments/[id]/route';
import { prisma } from '../../src/lib/storage/prisma';

const username = `case-comparison-${randomUUID()}@example.test`;
const apiKey = randomUUID();
let experimentId = '';

test.before(async () => {
  await prisma.user.create({ data: { username, apiKey } });
  const groups = ['A', 'B'].map(key => ({ id: randomUUID(), key, evaluatorIds: ['rules'], dataset: { assetKey: 'dataset' } }));
  const experiment = await prisma.experiment.create({ data: {
    user: username, name: 'Case 配对分页', type: 'skill', scope: 'evaluation-harness', status: 'done',
    evaluatorIdsJson: JSON.stringify(['rules']),
    configSnapshotJson: JSON.stringify({ kind: 'evaluation-harness-v1', comparison: { dimension: 'skill' }, groups }),
    groups: { create: groups.map(group => ({ id: group.id, key: group.key, variableValue: group.key })) },
  } });
  experimentId = experiment.id;
  for (const [groupIndex, group] of groups.entries()) {
    for (let index = 0; index < 13; index++) {
      await prisma.experimentCase.create({ data: {
        experimentId, groupId: group.id, input: `输入 ${index}`, actualOutput: `${group.key} 输出 ${index}`,
        caseValuesJson: JSON.stringify({ id: `case-${index}`, name: `Case ${index}`, turns: [{ input: `输入 ${index}`, expectedOutput: '完成' }] }),
        createdAt: new Date(1700000000000 + groupIndex * 100 + index),
        results: { create: { experimentId, evaluatorId: 'rules', status: 'done', score: groupIndex ? 90 : 50 } },
      } });
    }
  }
});

test.after(async () => {
  await prisma.experiment.deleteMany({ where: { user: username } });
  await prisma.user.deleteMany({ where: { username } });
});

async function detail(query = '') {
  const response = await GET(new Request(`http://localhost/api/experiments/${experimentId}?${query}`, {
    headers: { 'x-witty-api-key': apiKey },
  }), { params: Promise.resolve({ id: experimentId }) });
  assert.equal(response.status, 200);
  return response.json();
}

test('comparison pagination keeps both groups of each logical Case together across pages', async () => {
  const first = await detail('casePageSize=10');
  assert.equal(first.caseTotal, 26);
  assert.equal(first.casePairTotal, 13);
  assert.equal(first.cases.length, 20);
  assert.equal(first.results.length, 20);
  const firstKeys = new Set(first.cases.map((row: { comparisonKey: string }) => row.comparisonKey));
  assert.equal(firstKeys.size, 10);
  for (const key of firstKeys) {
    assert.deepEqual(first.cases.filter((row: { comparisonKey: string }) => row.comparisonKey === key).map((row: { groupKey: string }) => row.groupKey).sort(), ['A', 'B']);
  }
  const last = await detail('casePageSize=10&casePage=99');
  assert.equal(last.casePage, 2);
  assert.equal(last.cases.length, 6);
  assert(last.cases.every((row: { comparisonKey: string }) => !firstKeys.has(row.comparisonKey)));
  assert.equal(new Set([...first.cases, ...last.cases].map(row => row.id)).size, 26);
});

test('a direct Case detail keeps returning only the requested execution record', async () => {
  const row = await prisma.experimentCase.findFirstOrThrow({ where: { experimentId } });
  const body = await detail(`caseId=${encodeURIComponent(row.id)}&casePage=99&casePageSize=10`);
  assert.deepEqual(body.cases.map((item: { id: string }) => item.id), [row.id]);
  assert(body.results.every((result: { caseId: string }) => result.caseId === row.id));
});

test('a one-Case page still contains both execution groups and their evaluator results', async () => {
  const body = await detail('casePageSize=1&casePage=2');
  assert.equal(body.casePageSize, 1);
  assert.equal(body.cases.length, 2);
  assert.equal(body.results.length, 2);
  assert.equal(new Set(body.cases.map((item: { comparisonKey: string }) => item.comparisonKey)).size, 1);
  assert.deepEqual(body.cases.map((item: { groupKey: string }) => item.groupKey).sort(), ['A', 'B']);
});
