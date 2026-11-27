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
import { ensureTestApiUsers, testRequest } from './helpers/api-auth';
import { createIsolatedDatabase } from './helpers/isolated-database';

const database = createIsolatedDatabase();

let PATCH: typeof import('@/app/api/experiments/[id]/route').PATCH;
let prisma: typeof import('@/lib/storage/prisma').prisma;

test.before(async () => {
  ({ PATCH } = await import('@/app/api/experiments/[id]/route'));
  ({ prisma } = await import('@/lib/storage/prisma'));
  await ensureTestApiUsers('rename-owner', 'other-user');
});

test.after(async () => {
  try {
    await prisma?.$disconnect();
  } finally {
    database.dispose();
  }
});

function patchRequest(id: string, user: string, body: Record<string, unknown>): Request {
  return testRequest(`http://localhost/api/experiments/${id}`, user, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, ...body }),
  });
}

test('重命名拒绝空名称、超长名称、非字符串名称及混合更新', async () => {
  for (const body of [{ name: '   ' }, { name: 'x'.repeat(121) }, { name: null }, { name: 123 }, { name: '新名称', watchMode: false }]) {
    const response = await PATCH(
      patchRequest('exp-rename', 'rename-owner', body),
      { params: Promise.resolve({ id: 'exp-rename' }) },
    );
    assert.equal(response.status, 400);
  }
});

test('普通与 Skill 实验只允许所属用户重命名', async () => {
  for (const scope of ['', 'skill-workbench']) {
    const id = `rename-${scope || 'global'}`;
    await prisma.experiment.create({ data: { id, user: 'rename-owner', name: '原名称', scope } });
    const context = { params: Promise.resolve({ id }) };
    const denied = await PATCH(patchRequest(id, 'other-user', { name: '无权修改' }), context);
    assert.equal(denied.status, 404);

    const response = await PATCH(patchRequest(id, 'rename-owner', { name: '  新名称  ' }), context);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, name: '新名称' });
    assert.equal((await prisma.experiment.findUnique({ where: { id }, select: { name: true } }))?.name, '新名称');
  }

  const deletedId = 'rename-deleted';
  await prisma.experiment.create({
    data: { id: deletedId, user: 'rename-owner', name: '已删除', deletedAt: new Date() },
  });
  const deletedResponse = await PATCH(
    patchRequest(deletedId, 'rename-owner', { name: '不应改名' }),
    { params: Promise.resolve({ id: deletedId }) },
  );
  assert.equal(deletedResponse.status, 404);
});
