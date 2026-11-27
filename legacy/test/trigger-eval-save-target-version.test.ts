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
import { createRequire } from 'node:module';
import { createIsolatedDatabase } from './helpers/isolated-database';

const require = createRequire(import.meta.url);
const database = createIsolatedDatabase();
const { prismaRaw: store } = require('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
const storage = require('../src/server/skill_trigger_eval_storage') as typeof import('@/server/skill_trigger_eval_storage');
const { POST } = require('../src/app/api/skill-eval/trigger/[skillName]/route') as typeof import('@/app/api/skill-eval/trigger/[skillName]/route');

test.after(async () => { await store.$disconnect(); database.dispose(); });

const user = 'trigger-save-target-test';
const skillName = 'save-target-skill';

const items = (query: string) => [{ id: query, query, shouldTrigger: true, source: 'user-added' as const }];

async function save(payload: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/skill-eval/trigger/${encodeURIComponent(skillName)}`, {
      method: 'POST',
      body: JSON.stringify({ user, ...payload }),
    }),
    { params: Promise.resolve({ skillName }) },
  );
}

test('failed 占位居顶时，保存最新 ready 版本成功且不写占位行', async () => {
  const v1 = await storage.createTriggerEvalSetVersion({ user, skillName, items: items('old'), versionSource: 'manual' });
  const placeholder = await storage.createTriggerEvalSetVersion({ user, skillName, items: [], versionSource: 'llm-draft', status: 'failed' });

  for (const versionId of [v1.id, undefined]) {
    const response = await save(versionId ? { versionId, items: items('edited') } : { items: items('edited') });
    assert.equal(response.status, 200, String(versionId));
    assert.equal((await response.json()).set.id, v1.id);
  }

  assert.deepEqual((await storage.findTriggerEvalSetById(v1.id))?.items.map(i => i.query), ['edited']);
  const untouched = await storage.findTriggerEvalSetById(placeholder.id);
  assert.equal(untouched?.status, 'failed');
  assert.deepEqual(untouched?.items, []);
});

test('新的 ready 版本出现后，旧页面保存返回 409 且历史内容不变', async () => {
  const latestReady = (await storage.listTriggerEvalSetVersions(user, skillName)).find(v => v.status === 'ready')!;
  const v2 = await storage.createTriggerEvalSetVersion({ user, skillName, items: items('fresh'), versionSource: 'user-upload' });

  const response = await save({ versionId: latestReady.id, items: items('stale-edit') });
  assert.equal(response.status, 409);
  assert.deepEqual((await storage.findTriggerEvalSetById(latestReady.id))?.items.map(i => i.query), ['edited']);

  const overwrite = await save({ versionId: v2.id, items: items('fresh-edit') });
  assert.equal(overwrite.status, 200);
  assert.deepEqual((await storage.findTriggerEvalSetById(v2.id))?.items.map(i => i.query), ['fresh-edit']);
});

test('只有占位行、没有任何 ready 版本时，保存新建 manual 版本', async () => {
  const orphanUser = 'trigger-save-empty-skill-user';
  const orphan = await storage.createTriggerEvalSetVersion({
    user: orphanUser, skillName, items: [], versionSource: 'llm-draft', status: 'failed',
  });
  const response = await POST(
    new Request(`http://localhost/api/skill-eval/trigger/${encodeURIComponent(skillName)}`, {
      method: 'POST',
      body: JSON.stringify({ user: orphanUser, versionId: orphan.id, items: items('manual') }),
    }),
    { params: Promise.resolve({ skillName }) },
  );
  assert.equal(response.status, 200);
  const created = (await response.json()).set as { id: string; versionSource: string; items: { query: string }[] };
  assert.notEqual(created.id, orphan.id);
  assert.equal(created.versionSource, 'manual');
  assert.deepEqual(created.items.map(i => i.query), ['manual']);
  assert.deepEqual((await storage.findTriggerEvalSetById(orphan.id))?.items, []);
});
