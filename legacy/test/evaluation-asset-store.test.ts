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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { agentAssetBusinessId } from '@/lib/evaluation-assets/identity';
import { assetContentHash } from '@/lib/evaluation-assets/canonical';
import {
  createDatasetDraft, ensureAssetVersion, getAssetVersion, getDatasetDraft, listAssetVersions,
  publishDatasetDraft, revertDatasetDraftCase, saveDatasetDraftCase, withEvaluationAssetTransaction,
} from '@/lib/evaluation-assets/store';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-asset-ledger-'));
const database = path.join(directory, 'assets.db');
const client = new PrismaClient({ datasources: { db: { url: `file:${database}` } } });
const identity = () => ({ user: `asset-${randomUUID()}`, kind: 'dataset' as const, businessId: randomUUID() });
const dataset = (value: string) => ({ id: 'dataset', name: '数据集', cases: [{ id: 'one', input: value, expectedOutput: '结果' }, { id: 'two', input: '第二条', expectedOutput: '结果2' }] });

test.before(async () => {
  await client.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await client.$queryRawUnsafe('PRAGMA busy_timeout=100');
  await client.$executeRawUnsafe('CREATE TABLE EvaluationAssetHead (id TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, kind TEXT NOT NULL, businessId TEXT NOT NULL, publishedVersion INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, archived BOOLEAN NOT NULL DEFAULT false, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, UNIQUE(user,kind,businessId))');
  await client.$executeRawUnsafe('CREATE TABLE EvaluationAssetVersion (id TEXT PRIMARY KEY NOT NULL, assetId TEXT NOT NULL, version INTEGER NOT NULL, contentJson TEXT NOT NULL, contentHash TEXT NOT NULL, note TEXT NOT NULL DEFAULT "", source TEXT NOT NULL DEFAULT "manual", createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(assetId,version), FOREIGN KEY(assetId) REFERENCES EvaluationAssetHead(id) ON DELETE RESTRICT)');
  await client.$executeRawUnsafe('CREATE TABLE EvaluationAssetDraft (assetId TEXT PRIMARY KEY NOT NULL, baseVersion INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, contentJson TEXT NOT NULL, updatedAt DATETIME NOT NULL, FOREIGN KEY(assetId) REFERENCES EvaluationAssetHead(id) ON DELETE RESTRICT)');
});
test.after(async () => { await client.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }); });
const transact = <T>(work: Parameters<typeof withEvaluationAssetTransaction<T>>[0]) => withEvaluationAssetTransaction(work, client);

test('Agent identity includes platform but never machine, and respects existing aliases', () => {
  assert.notEqual(agentAssetBusinessId('opencode', 'build'), agentAssetBusinessId('pi', 'build'));
  assert.equal(agentAssetBusinessId('XIAOO', 'DefaultAgent'), agentAssetBusinessId('xiaoo', 'xiaoo'));
});

test('semantic hashes ignore cache/progress timestamps, preserve order and business argument names', () => {
  const original = { ...dataset('输入'), updatedAt: 'before', generationStatus: 'published' };
  const cached = { ...original, updatedAt: 'after', generationStatus: 'generating', cases: original.cases.map(c => ({ ...c, rootCauses: [{ name: 'derived' }], rootCauseMeta: { updatedAt: 'now' } })) };
  assert.equal(assetContentHash('dataset', original), assetContentHash('dataset', cached));
  assert.notEqual(assetContentHash('dataset', original), assetContentHash('dataset', { ...original, cases: [...original.cases].reverse() }));
  assert.notEqual(assetContentHash('dataset', { cases: [{ id: 'one', turns: [{ expectation: { requiredTools: [{ name: 'write', arguments: { updatedAt: 'one' } }] } }] }] }), assetContentHash('dataset', { cases: [{ id: 'one', turns: [{ expectation: { requiredTools: [{ name: 'write', arguments: { updatedAt: 'two' } }] } }] }] }));
});

test('legacy content is preserved as v1 before changing to v2, and identical writes deduplicate', async () => {
  const id = identity();
  const result = await transact(async tx => {
    const first = await ensureAssetVersion(tx, { ...id, content: dataset('旧内容'), source: 'legacy' });
    const second = await ensureAssetVersion(tx, { ...id, content: dataset('新内容') });
    const same = await ensureAssetVersion(tx, { ...id, content: { ...dataset('新内容'), updatedAt: 'later' } });
    return { first, second, same };
  });
  assert.equal(result.first.version.version, 1); assert.equal(result.second.version.version, 2);
  assert.equal(result.same.created, false); assert.equal(result.same.version.id, result.second.version.id);
  assert.equal((result.first.version.content as ReturnType<typeof dataset>).cases[0].input, '旧内容');
  assert.equal((await listAssetVersions(client, id)).versions.length, 2);
  const old = await getAssetVersion(client, { user: id.user, versionId: result.first.version.id });
  assert.equal((old.content as ReturnType<typeof dataset>).cases[0].input, '旧内容');
  await assert.rejects(getAssetVersion(client, { user: 'other-user', versionId: old.id }), /不存在|无权/);
  assert.equal((await listAssetVersions(client, { ...id, user: 'other-user' })).head, null);
});

test('saving and reverting one draft Case preserve other changes and do not update publication', async () => {
  const id = identity();
  await transact(tx => ensureAssetVersion(tx, { ...id, content: dataset('旧内容') }));
  const draft = await transact(tx => createDatasetDraft(tx, id));
  const one = await transact(tx => saveDatasetDraftCase(tx, { ...id, caseId: 'one', expectedRevision: draft.revision, case: { id: 'one', input: '改一', expectedOutput: '结果' } }));
  await assert.rejects(transact(tx => saveDatasetDraftCase(tx, { ...id, caseId: 'two', expectedRevision: draft.revision, case: { id: 'two', input: 'stale' } })), /草稿.*变化|冲突/);
  const two = await transact(tx => saveDatasetDraftCase(tx, { ...id, caseId: 'two', expectedRevision: one.revision, case: { id: 'two', input: '改二', expectedOutput: '结果2' } }));
  const reverted = await transact(tx => revertDatasetDraftCase(tx, { ...id, caseId: 'one', expectedRevision: two.revision }));
  assert.equal((reverted.content as ReturnType<typeof dataset>).cases[0].input, '旧内容');
  assert.equal((reverted.content as ReturnType<typeof dataset>).cases[1].input, '改二');
  const versions = await listAssetVersions(client, id);
  assert.equal(versions.head?.publishedVersion, 1);
  await assert.rejects(transact(tx => saveDatasetDraftCase(tx, { ...id, user: 'other-user', caseId: 'one', expectedRevision: reverted.revision, case: { id: 'one', input: 'bad' } })), /不存在|无权/);
});

test('draft publish rejects a changed base and retains the draft', async () => {
  const id = identity(); await transact(tx => ensureAssetVersion(tx, { ...id, content: dataset('旧') }));
  const draft = await transact(tx => createDatasetDraft(tx, id));
  await transact(tx => ensureAssetVersion(tx, { ...id, content: dataset('外部更新') }));
  await assert.rejects(transact(tx => publishDatasetDraft(tx, { ...id, expectedRevision: draft.revision })), /发布版本.*变化|基线|冲突/);
  assert.equal((await getDatasetDraft(client, id))?.baseVersion, 1);
});

test('projection and immutable publication share a transaction and roll back together', async () => {
  const id = identity(); await transact(tx => ensureAssetVersion(tx, { ...id, content: dataset('旧') }));
  const draft = await transact(tx => createDatasetDraft(tx, id));
  const changed = await transact(tx => saveDatasetDraftCase(tx, { ...id, caseId: 'one', expectedRevision: draft.revision, case: { id: 'one', input: '新' } }));
  await assert.rejects(transact(tx => publishDatasetDraft(tx, { ...id, expectedRevision: changed.revision, project: async () => { throw new Error('projection failed'); } })), /projection failed/);
  assert.equal((await listAssetVersions(client, id)).head?.publishedVersion, 1);
  assert.equal((await getDatasetDraft(client, id))?.revision, changed.revision);
  const result = await transact(tx => publishDatasetDraft(tx, { ...id, expectedRevision: changed.revision, project: async (tx, content, published) => {
    assert.equal(published.version.version, 2);
    assert.equal((content as ReturnType<typeof dataset>).cases[0].input, '新');
    assert.equal(await tx.evaluationAssetVersion.count({ where: { assetId: published.head.id } }), 2);
  } }));
  assert.equal(result.version.version, 2); assert.equal(await getDatasetDraft(client, id), null);
});

test('concurrent writers produce unique sequential versions without overwriting history', async () => {
  const id = identity(); await transact(tx => ensureAssetVersion(tx, { ...id, content: dataset('原始') }));
  await Promise.all(['并发一', '并发二', '并发三'].map(input => transact(tx => ensureAssetVersion(tx, { ...id, content: dataset(input) }))));
  const rows = await listAssetVersions(client, id);
  assert.deepEqual(rows.versions.map(v => v.version).sort((a, b) => a - b), [1, 2, 3, 4]);
});
