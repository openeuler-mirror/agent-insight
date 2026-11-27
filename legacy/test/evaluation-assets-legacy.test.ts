/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-assets-legacy-'));
const filename = path.join(home, 'assets.db'); fs.closeSync(fs.openSync(filename, 'a'));
process.env.AGENT_INSIGHT_HOME = home; delete process.env.AGENT_INSIGHT_DATA_DIR; delete process.env.DB_HOST;
process.env.DATABASE_URL = `file:${filename}`;
execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });

let client: any, datasets: any, evaluators: any, ledger: any, service: any, skills: any, trace: any;
const user = 'legacy-assets@example.test';
const fullCase = (input: string) => ({ id: 'one', input, expectedOutput: 'answer', evaluationFocus: '', tags: [], trajectory: '', values: { input, reference_output: 'answer' } });
const card = (id: string, prompt = 'Judge {{output}}') => ({ id, name: id.replace('custom-', ''), description: '', evaluatorType: 'LLM', source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '0-100', popularity: 0, mappedMetrics: [], status: 'ready', llmConfig: { model: '', systemPrompt: prompt, skills: [] } });
test.before(async () => {
  client = (await import('@/lib/storage/prisma')).prismaRaw;
  datasets = await import('@/server/agent_datasets_storage');
  evaluators = await import('@/server/user_evaluators_storage');
  ledger = await import('@/lib/evaluation-assets/store');
  service = await import('@/lib/evaluation-assets/service');
  skills = await import('@/lib/evaluators/evaluator-skill-service');
  trace = await import('@/lib/trace-datasets/contracts');
});
test.after(async () => { await client?.$disconnect(); fs.rmSync(home, { recursive: true, force: true }); });

test('旧数据集更新在同事务保存真实旧版和新版，缓存变化不增加版本', async () => {
  const id = 'legacy-dataset';
  await client.agentEvalDataset.create({ data: { id, user, name: 'Dataset', casesJson: JSON.stringify([fullCase('old')]) } });
  const current = await datasets.findAgentDataset(user, id);
  await datasets.updateAgentDatasetRecord({ ...current, cases: [fullCase('new')], updatedAt: new Date().toISOString() });
  const versions = await ledger.listAssetVersions(client, { user, kind: 'dataset', businessId: id });
  assert.equal(versions.versions.length, 2);
  const old = await ledger.getAssetVersion(client, { user, versionId: versions.versions.find((v: any) => v.version === 1).id });
  assert.equal(old.content.cases[0].input, 'old');
  await datasets.updateAgentDatasetRecord({ ...await datasets.findAgentDataset(user, id), cases: [{ ...fullCase('new'), rootCauses: [{ text: 'derived' }] }], updatedAt: new Date().toISOString() });
  assert.equal((await ledger.listAssetVersions(client, { user, kind: 'dataset', businessId: id })).versions.length, 2);
});

test('旧评估器列表写入仅给变化的卡片增版，并归档删除项', async () => {
  const a = card('custom-old-a'), b = card('custom-old-b');
  await client.customEvaluatorList.create({ data: { user, itemsJson: JSON.stringify([a, b]) } });
  await evaluators.writeUserCustomEvaluators(user, [{ ...a, description: 'new' }, b]);
  const identity = { user, kind: 'evaluator', businessId: a.id };
  const state = await ledger.listAssetVersions(client, identity);
  assert.equal(state.versions.length, 2);
  assert.equal((await ledger.listAssetVersions(client, { ...identity, businessId: b.id })).versions.length, 1);
  await evaluators.writeUserCustomEvaluators(user, [b]);
  const deleted = await ledger.listAssetVersions(client, identity);
  assert.equal(deleted.head.archived, true);
  assert.equal((await ledger.getAssetVersion(client, { user, versionId: deleted.versions[0].id })).content.description, 'new');
});

test('发布一个评估器不会覆盖其他卡，旧版本可冻结，过期基线拒绝', async () => {
  const a = card('custom-publish-a'), b = card('custom-publish-b');
  await evaluators.writeUserCustomEvaluators(user, [a, b]);
  const initial = await service.assetVersionView(user, 'evaluator', a.id);
  const published = await service.mutateAsset(user, { action: 'evaluator-publish', businessId: a.id, baseVersion: initial.head.publishedVersion, revision: initial.head.revision, card: { ...a, llmConfig: { ...a.llmConfig, systemPrompt: 'New {{output}}' } } });
  assert.equal(published.version.version, 2);
  assert.equal((await evaluators.readUserCustomEvaluators(user)).find((c: any) => c.id === b.id).name, b.name);
  const frozen = await skills.freezeCustomEvaluators(user, [a.id], { [a.id]: initial.selectedVersion.id });
  assert.equal(frozen.cards[a.id].llmConfig.systemPrompt, a.llmConfig.systemPrompt);
  await assert.rejects(service.mutateAsset(user, { action: 'evaluator-publish', businessId: a.id, baseVersion: initial.head.publishedVersion, revision: initial.head.revision, card: a }), /变化|冲突/);
  await assert.rejects(skills.freezeCustomEvaluators('other-user', [a.id], { [a.id]: initial.selectedVersion.id }), /不存在|无权/);
});

test('单轮与Trace数据集保留合法turns并投影首末轮，非法turns不降级', async () => {
  const turns = [{ id: 't1', input: 'first', expectedOutput: 'mid' }, { id: 't2', input: 'second', expectedOutput: 'final' }];
  const normalized = datasets.normalizeCases([{ ...fullCase('stale'), turns }])[0];
  assert.equal(normalized.turns.length, 2); assert.equal(normalized.input, 'first'); assert.equal(normalized.expectedOutput, 'final');
  assert.equal(normalized.values.input, 'first'); assert.equal(normalized.values.reference_output, 'final');
  const fromTrace = trace.normalizeTraceCases([{ ...fullCase('stale'), turns }])[0];
  assert.equal(fromTrace.turns.length, 2); assert.equal(fromTrace.input, 'first'); assert.equal(fromTrace.expectedOutput, 'final');
  assert.throws(() => datasets.normalizeCases([{ ...fullCase('ok'), turns: [] }]));
  assert.throws(() => trace.normalizeTraceCases([{ ...fullCase('ok'), turns: [{ input: '' }] }]));
});

test('丢弃草稿仅删除匹配revision，系统集只读且可靠性非法Case被拒绝', async () => {
  const id = 'discard-dataset';
  await client.agentEvalDataset.create({ data: { id, user, name: 'Discard dataset', casesJson: JSON.stringify([fullCase('published')]) } });
  let { draft } = await service.mutateAsset(user, { action: 'draft-create', businessId: id });
  ({ draft } = await service.mutateAsset(user, { action: 'case-save', businessId: id, caseId: 'one', revision: draft.revision, case: fullCase('draft') }));
  await assert.rejects(service.mutateAsset(user, { action: 'draft-discard', businessId: id, revision: draft.revision - 1 }), /变化|冲突/);
  assert.equal((await service.mutateAsset(user, { action: 'draft-discard', businessId: id, revision: draft.revision })).discarded, true);
  assert.equal(JSON.parse((await client.agentEvalDataset.findUnique({ where: { id } })).casesJson)[0].input, 'published');
  const reliability = 'custom-reliability';
  await client.agentEvalDataset.create({ data: { id: reliability, user, name: 'Custom reliability', datasetKind: 'reliability', casesJson: JSON.stringify([{ ...fullCase('input'), values: { fault_injection_type: 'existing-mode' } }]) } });
  ({ draft } = await service.mutateAsset(user, { action: 'draft-create', businessId: reliability }));
  await assert.rejects(service.mutateAsset(user, { action: 'case-save', businessId: reliability, caseId: 'one', revision: draft.revision, case: fullCase('invalid') }), /fault_injection_type/);
  await client.agentEvalDataset.create({ data: { id: 'builtin-reliability', user, name: '可靠性故障注入评测集（内置）', datasetKind: 'reliability' } });
  assert.equal((await service.assetVersionView(user, 'dataset', 'builtin-reliability')).readOnly, true);
});
