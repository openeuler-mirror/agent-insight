/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const database = createIsolatedDatabase();
const { prisma } = require('../src/lib/storage/prisma') as typeof import('../src/lib/storage/prisma');
const { GET } = require('../src/app/api/experiments/[id]/route') as typeof import('../src/app/api/experiments/[id]/route');

test.after(async () => { await prisma.$disconnect(); database.dispose(); });

async function createExperiment(id: string, count = 53) {
  const ids = Array.from({ length: count }, (_, index) => `${id}-case-${String(index).padStart(3, '0')}`);
  await prisma.experiment.create({ data: { id, user: 'case-navigation-user', name: id, status: 'done',
    cases: { create: ids.slice().reverse().map(caseId => ({ id: caseId, input: caseId, createdAt: new Date('2026-10-16T00:00:00Z') })) },
  } });
  return ids;
}
async function read(id: string, query = '') {
  const response = await GET(new Request(`http://fixture.invalid/api/experiments/${id}?user=case-navigation-user&${query}`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return response.json();
}

test('Case detail and list location share a stable order when timestamps are identical', async () => {
  const id = 'stable-case-order';
  const ids = await createExperiment(id);
  const first = await read(id, 'casePage=1&casePageSize=20');
  assert.deepEqual(first.cases.map((row: { id: string }) => row.id), ids.slice(0, 20));
  const single = await read(id, `caseId=${ids[42]}&casePageSize=20`);
  assert.equal(single.casePage, 3);
  assert.equal(single.cases.length, 1);
  assert.equal(single.cases[0].id, ids[42]);
  const returned = await read(id, `casePage=1&casePageSize=20&locateCaseId=${ids[42]}`);
  assert.equal(returned.casePage, 3);
  assert.equal(returned.locatedCaseId, ids[42]);
  assert.deepEqual(returned.cases.map((row: { id: string }) => row.id), ids.slice(40));
  for (const size of [10, 20, 50, 100]) {
    const page = await read(id, `casePageSize=${size}&locateCaseId=${ids[42]}`);
    assert.equal(page.casePage, Math.floor(42 / size) + 1);
    assert.equal(page.casePageSize, size);
    assert.ok(page.cases.some((row: { id: string }) => row.id === ids[42]));
  }
});

test('deleted Cases change the destination page, while missing or foreign targets return a valid page', async () => {
  const id = 'deleted-case-order';
  const ids = await createExperiment(id);
  await prisma.experimentCase.updateMany({ where: { id: { in: ids.slice(0, 5) } }, data: { deletedAt: new Date() } });
  const shifted = await read(id, `casePage=3&casePageSize=20&locateCaseId=${ids[42]}`);
  assert.equal(shifted.casePage, 2);
  assert.equal(shifted.caseTotal, 48);
  assert.ok(shifted.cases.some((row: { id: string }) => row.id === ids[42]));
  const removed = await read(id, `casePage=99&casePageSize=20&locateCaseId=${ids[0]}`);
  assert.equal(removed.casePage, 3);
  assert.equal(removed.locatedCaseId, null);
  const foreignIds = await createExperiment('foreign-case-owner', 1);
  const foreign = await read(id, `casePage=2&casePageSize=20&locateCaseId=${foreignIds[0]}`);
  assert.equal(foreign.casePage, 2);
  assert.equal(foreign.locatedCaseId, null);
  assert.ok(!foreign.cases.some((row: { id: string }) => row.id === foreignIds[0]));
});

test('empty experiments and invalid page arguments return valid pagination without querying fractional offsets', async () => {
  const ids = await createExperiment('invalid-page-args', 2);
  const result = await read('invalid-page-args', 'casePage=1.5&casePageSize=Infinity');
  assert.equal(result.casePage, 1);
  assert.equal(result.casePageSize, 20);
  assert.deepEqual(result.cases.map((row: { id: string }) => row.id), ids);
  const capped = await read('invalid-page-args', 'casePage=99&casePageSize=1000');
  assert.equal(capped.casePage, 1);
  assert.equal(capped.casePageSize, 100);
  await createExperiment('empty-case-list', 0);
  const empty = await read('empty-case-list', 'casePage=99&locateCaseId=missing');
  assert.equal(empty.casePage, 1);
  assert.equal(empty.caseTotal, 0);
  assert.deepEqual(empty.cases, []);
  assert.equal(empty.locatedCaseId, null);
});
