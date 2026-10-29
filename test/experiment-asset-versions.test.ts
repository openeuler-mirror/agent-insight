/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const isolated = createIsolatedDatabase();
const user = 'experiment-versions@example.test', key = 'wi_fixture_experiment_versions';
const datasetId = 'experiment-versions-dataset', evaluatorId = 'custom-experiment-versions';
let prisma: any, api: any, detailApi: any, runApi: any, caseRetryApi: any, resultRetryApi: any, assets: any, evaluatorStorage: any;
let datasetV1: any, datasetV2: any, agentV1: any, evaluatorV1: any;
const turns = [
  { id: 'remember', input: 'Remember ALPHA', expectedOutput: 'ACK', expectation: { contains: 'ACK' } },
  { id: 'recall', input: 'What was the value?', expectedOutput: 'ALPHA', expectation: { contains: 'ALPHA' } },
];
const card = (prompt: string) => ({ id: evaluatorId, name: 'Version judge', description: '', evaluatorType: 'LLM', source: 'custom', targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '0-100', popularity: 0, mappedMetrics: [], status: 'ready', llmConfig: { model: '', systemPrompt: prompt, skills: [] } });
function request(body: Record<string, unknown>, token: string | null = key) {
  return new Request('http://localhost/api/experiments', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-witty-api-key': token } : {}) }, body: JSON.stringify(body) });
}
function body(extra: Record<string, unknown> = {}) {
  return { user, name: 'Versioned experiment', agentName: 'build', evaluatorIds: [evaluatorId],
    datasetId, configSnapshot: { traceSource: 'existing', datasetId, caseIds: ['one'], executionTarget: { platform: 'opencode', agent: 'build' } },
    cases: [{ datasetId, datasetCaseId: 'one', input: `${turns[0].input} `, referenceOutput: 'untrusted answer', actualOutput: 'ALPHA', executionId: 'trace-one', taskId: 'trace-one' }], ...extra };
}
function refs(extra: Record<string, unknown> = {}) {
  return { agent: agentV1.id, dataset: datasetV1.id, evaluators: { [evaluatorId]: evaluatorV1.id }, ...extra };
}
test.before(async () => {
  prisma = (await import('@/lib/storage/prisma')).prismaRaw;
  api = await import('@/app/api/experiments/route');
  detailApi = await import('@/app/api/experiments/[id]/route');
  runApi = await import('@/app/api/experiments/[id]/run/route');
  caseRetryApi = await import('@/app/api/experiments/[id]/cases/[caseId]/retry/route');
  resultRetryApi = await import('@/app/api/experiments/[id]/results/[resultId]/retry/route');
  assets = await import('@/lib/evaluation-assets/service');
  evaluatorStorage = await import('@/server/user_evaluators_storage');
  await prisma.user.create({ data: { username: user, apiKey: key } });
  await prisma.user.create({ data: { username: 'other-versions', apiKey: 'wi_fixture_other_versions' } });
  await prisma.execution.create({ data: { id: 'trace-one', taskId: 'trace-one', user, query: `${turns[0].input} `, finalResult: 'ALPHA' } });
  await prisma.session.create({ data: { taskId: 'trace-one', user, query: turns[0].input } });
  await prisma.execution.create({ data: { id: 'foreign-trace', taskId: 'foreign-trace', user: 'other-versions' } });
  const sourceCase = { id: 'one', input: turns[0].input, expectedOutput: 'ALPHA', turns, tags: [], trajectory: '', evaluationFocus: '', values: { custom_field: 'keep old', fault_injection_type: 'timeout', input: turns[0].input, reference_output: 'ALPHA' } };
  await prisma.agentEvalDataset.create({ data: { id: datasetId, user, name: 'Versioned cases', casesJson: JSON.stringify([sourceCase]) } });
  datasetV1 = (await assets.assetVersionView(user, 'dataset', datasetId)).selectedVersion;
  await prisma.agentEvalDataset.update({ where: { id: datasetId }, data: { casesJson: JSON.stringify([{ ...sourceCase, input: 'latest only', expectedOutput: 'BETA', turns: undefined, values: { custom_field: 'latest', fault_injection_type: 'latest-mode' } }]) } });
  datasetV2 = (await assets.assetVersionView(user, 'dataset', datasetId)).selectedVersion;
  agentV1 = (await assets.mutateAsset(user, { action: 'agent-publish', platform: 'opencode', agentName: 'build', note: 'First external definition', requestId: 'agent-first' })).version;
  await assets.mutateAsset(user, { action: 'agent-publish', platform: 'opencode', agentName: 'build', note: 'Changed external definition', requestId: 'agent-second' });
  await evaluatorStorage.writeUserCustomEvaluators(user, [card('First {{output}}')]);
  evaluatorV1 = (await assets.assetVersionView(user, 'evaluator', evaluatorId)).selectedVersion;
  await evaluatorStorage.writeUserCustomEvaluators(user, [card('Latest {{output}}')]);
});
test.after(async () => { await prisma?.$disconnect(); isolated.dispose(); });

test('create freezes selected historical definitions and preserves all case values, turns and FI fields', async () => {
  const response = await api.POST(request(body({ assetVersions: refs() })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
  const snapshot = JSON.parse(saved.configSnapshotJson);
  assert.equal(snapshot.assetVersions?.schemaVersion, 1);
  assert.equal(snapshot.assetVersions.agent.versionId, agentV1.id);
  assert.equal(snapshot.assetVersions.agent.version, 1);
  assert.equal(snapshot.assetVersions.agent.definition.changeDescription, 'First external definition');
  assert.equal(snapshot.assetVersions.dataset.businessId, datasetId);
  assert.equal(snapshot.assetVersions.dataset.versionId, datasetV1.id);
  assert.equal(snapshot.assetVersions.dataset.contentHash, datasetV1.contentHash);
  assert.equal(snapshot.assetVersions.evaluators[evaluatorId].versionId, evaluatorV1.id);
  assert.equal(snapshot.customEvaluatorSnapshots.cards[evaluatorId].llmConfig.systemPrompt, 'First {{output}}');
  assert.deepEqual(JSON.parse(saved.evaluatorIdsJson), [evaluatorId]);
  const item = saved.cases[0], values = JSON.parse(item.caseValuesJson);
  assert.equal(item.input, `${turns[0].input} `);
  assert.equal(item.datasetInput, turns[0].input);
  assert.equal(item.referenceOutput, 'ALPHA');
  assert.equal(item.executionId, 'trace-one');
  assert.equal(item.faultInjectionType, 'timeout');
  assert.equal(values.custom_field, 'keep old');
  assert.equal(values.turns.length, 2);
  assert.equal(values.turns[1].expectation.contains, 'ALPHA');
  assert.deepEqual(values.__agentInsightDatasetCase, { datasetId, caseId: 'one' });
});

test('generated cases take inputs and turn rules from the historical dataset instead of client-supplied definitions', async () => {
  const response = await api.POST(request(body({ assetVersions: refs(), cases: [{ datasetId, datasetCaseId: 'one', input: 'wrong input', referenceOutput: 'wrong answer', turns: [{ id: 'tampered', input: 'tampered' }], values: { custom_field: 'tampered', fault_injection_type: 'tampered' } }] })));
  assert.equal(response.status, 200);
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
  const item = saved.cases[0], values = JSON.parse(item.caseValuesJson);
  assert.equal(item.input, turns[0].input);
  assert.equal(item.referenceOutput, 'ALPHA');
  assert.equal(item.faultInjectionType, 'timeout');
  assert.equal(values.turns[1].input, turns[1].input);
  assert.equal(values.custom_field, 'keep old');
});

test('version binding freezes the fault mode and Tool/Skill catalogs instead of accepting top-level or values overrides', async () => {
  const catalog = { available_tools: [{ name: 'baseline-tool', description: 'Versioned tool' }], available_skills: [{ name: 'baseline-skill' }], fault_injection_type: 'baseline-fault' };
  for (const [id, values, expectedContext, expectedFault] of [
    ['protected-catalog', catalog, { schemaVersion: 1, availableTools: catalog.available_tools, availableSkills: catalog.available_skills }, 'baseline-fault'],
    ['protected-no-catalog', { note: 'No catalog or fault was declared' }, null, null],
  ] as const) {
    await prisma.agentEvalDataset.create({ data: { id, user, name: id, casesJson: JSON.stringify([{ id: 'one', input: 'baseline input', expectedOutput: 'baseline output', values }]) } });
    const version = (await assets.assetVersionView(user, 'dataset', id)).selectedVersion;
    const response = await api.POST(request(body({ datasetId: id, assetVersions: refs({ dataset: version.id }), cases: [{ datasetId: id, datasetCaseId: 'one',
      input: 'client input', faultInjectionType: 'injected-fault', evaluatorContext: { schemaVersion: 1, availableTools: [{ name: 'injected-tool' }], availableSkills: [{ name: 'injected-skill' }] },
      values: { fault_injection_type: 'injected-fault', available_tools: [{ name: 'injected-tool' }], available_skills: [{ name: 'injected-skill' }] },
    }] })));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
    const item = saved.cases[0];
    assert.equal(item.faultInjectionType, expectedFault);
    assert.deepEqual(item.evaluatorContextJson ? JSON.parse(item.evaluatorContextJson) : null, expectedContext);
    const storedValues = JSON.parse(item.caseValuesJson);
    assert.equal(storedValues.fault_injection_type ?? null, expectedFault);
    assert.deepEqual(storedValues.available_tools ?? null, 'available_tools' in values ? values.available_tools : null);
    assert.deepEqual(storedValues.available_skills ?? null, 'available_skills' in values ? values.available_skills : null);
  }
});

test('detail exposes exact frozen dataset Case identity for reuse while keeping internal binding out of visible values', async () => {
  const response = await api.POST(request(body({ assetVersions: refs() })));
  const { id } = await response.json();
  const detail = await detailApi.GET(new Request(`http://localhost/api/experiments/${id}?user=${encodeURIComponent(user)}`, { headers: { 'x-witty-api-key': key } }), { params: Promise.resolve({ id }) });
  assert.equal(detail.status, 200);
  const value = await detail.json();
  assert.equal(value.reusableConfig.assetVersions.dataset.versionId, datasetV1.id);
  assert.equal(value.cases[0].datasetId, datasetId);
  assert.equal(value.cases[0].datasetCaseId, 'one');
  assert.equal(value.cases[0].caseValues.__agentInsightDatasetCase, undefined);
});

test('explicit experiment answer overrides preserve the selected version baseline and frozen turn rules', async () => {
  for (const value of ['Experiment-only answer', null]) {
    const response = await api.POST(request(body({ assetVersions: refs(), cases: [{ datasetId, datasetCaseId: 'one', input: `${turns[0].input} `, executionId: 'trace-one', taskId: 'trace-one', referenceOverride: { value, source: 'manual' } }] })));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
    const item = saved.cases[0], values = JSON.parse(item.caseValuesJson);
    assert.equal(item.referenceOutput, value);
    assert.deepEqual(values.__agentInsightReferenceOverride, { schemaVersion: 1, datasetId, caseId: 'one', baselineVersionId: datasetV1.id, baselineVersion: 1, baseExpectedOutput: 'ALPHA', newExpectedOutput: value, source: 'manual' });
    assert.equal(values.turns[1].expectedOutput, 'ALPHA');
    assert.equal(values.reference_output, 'ALPHA');
    const cloneResponse = await api.POST(request({ user, createMode: 'same-config', sourceExperimentId: saved.id }));
    assert.equal(cloneResponse.status, 201);
    const clone = await prisma.experiment.findUnique({ where: { id: (await cloneResponse.json()).id }, include: { cases: true } });
    assert.equal(clone.cases[0].caseValuesJson, item.caseValuesJson);
    assert.equal(clone.cases[0].referenceOutput, value);
  }
});

test('same answer creates no override record, and dataset-import provenance is separate from baseline binding', async () => {
  const imported = 'import-answer-dataset';
  await prisma.agentEvalDataset.create({ data: { id: imported, user, name: 'Import source', casesJson: JSON.stringify([{ id: 'external-case', input: 'external input', expectedOutput: 'Imported answer' }]) } });
  for (const referenceOverride of [{ value: 'ALPHA', source: 'manual' }, { value: 'Imported answer', source: 'dataset-import', sourceDatasetId: imported, sourceCaseId: 'external-case' }]) {
    const response = await api.POST(request(body({ assetVersions: refs(), cases: [{ datasetId, datasetCaseId: 'one', referenceOverride }] })));
    assert.equal(response.status, 200);
    const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
    const values = JSON.parse(saved.cases[0].caseValuesJson);
    assert.deepEqual(values.__agentInsightDatasetCase, { datasetId, caseId: 'one' });
    if (referenceOverride.source === 'manual') assert.equal(values.__agentInsightReferenceOverride, undefined);
    else {
      assert.equal(saved.cases[0].referenceOutput, 'Imported answer');
      assert.equal(values.__agentInsightReferenceOverride.sourceDatasetId, imported);
      assert.equal(values.__agentInsightReferenceOverride.sourceCaseId, 'external-case');
      assert.equal(values.__agentInsightReferenceOverride.baselineVersionId, datasetV1.id);
    }
  }
});

test('answer overrides cannot reference inaccessible import datasets or change turn rules through the override contract', async () => {
  await prisma.agentEvalDataset.create({ data: { id: 'private-import-source', user: 'other-versions', name: 'Private source', casesJson: '[]' } });
  for (const referenceOverride of [
    { value: 'answer', source: 'dataset-import', sourceDatasetId: 'private-import-source' },
    { value: 'answer', source: 'manual', turns: [{ input: 'tampered' }] },
    { value: {}, source: 'manual' },
  ]) {
    const response = await api.POST(request(body({ assetVersions: refs(), cases: [{ datasetId, datasetCaseId: 'one', referenceOverride }] })));
    assert.ok([400, 404].includes(response.status), JSON.stringify(await response.json()));
  }
});

test('version refs require a real Key actor and cannot impersonate body.user', async () => {
  const missing = await api.POST(request(body({ assetVersions: refs() }), null));
  assert.equal(missing.status, 401);
  const mismatch = await api.POST(request(body({ assetVersions: refs(), user: 'other-versions' })));
  assert.equal(mismatch.status, 403);
  const foreign = await api.POST(request(body({ assetVersions: refs(), user: 'other-versions' }), 'wi_fixture_other_versions'));
  assert.equal(foreign.status, 404);
});

test('version kind, dataset business identity, Agent platform and evaluator stable IDs are checked', async () => {
  for (const override of [
    { dataset: evaluatorV1.id }, { agent: datasetV1.id }, { evaluators: { [evaluatorId]: datasetV1.id } },
    { evaluators: { 'custom-not-selected': evaluatorV1.id } },
  ]) {
    const response = await api.POST(request(body({ assetVersions: refs(override) })));
    assert.ok([400, 404].includes(response.status), `invalid refs accepted: ${JSON.stringify(override)}`);
  }
  const wrongDataset = await api.POST(request(body({ datasetId: 'another-dataset', assetVersions: refs() })));
  assert.equal(wrongDataset.status, 404);
  const wrongPlatform = await api.POST(request(body({ assetVersions: refs(), configSnapshot: { executionTarget: { platform: 'pi', agent: 'build' } } })));
  assert.equal(wrongPlatform.status, 404);
});

test('historical dataset matching rejects cases absent from that version and conflicting per-case dataset IDs', async () => {
  for (const item of [{ datasetCaseId: 'missing', datasetId }, { datasetCaseId: 'one', datasetId: 'another-dataset' }]) {
    const response = await api.POST(request(body({ assetVersions: refs(), cases: [item] })));
    assert.equal(response.status, 422);
  }
});

test('same-config clone retains original versions, evaluator definitions and case values after new publication', async () => {
  const response = await api.POST(request(body({ assetVersions: refs() })));
  const id = (await response.json()).id;
  const original = await prisma.experiment.findUnique({ where: { id }, include: { cases: true } });
  await evaluatorStorage.writeUserCustomEvaluators(user, [card('Third {{output}}')]);
  const cloneResponse = await api.POST(request({ user, createMode: 'same-config', sourceExperimentId: id }));
  assert.equal(cloneResponse.status, 201);
  const clone = await prisma.experiment.findUnique({ where: { id: (await cloneResponse.json()).id }, include: { cases: true } });
  const snapshot = JSON.parse(clone.configSnapshotJson);
  assert.equal(snapshot.assetVersions?.dataset.versionId, datasetV1.id);
  assert.deepEqual(snapshot.assetVersions, JSON.parse(original.configSnapshotJson).assetVersions);
  assert.equal(snapshot.customEvaluatorSnapshots.cards[evaluatorId].llmConfig.systemPrompt, 'First {{output}}');
  assert.equal(clone.cases[0].caseValuesJson, original.cases[0].caseValuesJson);
  assert.equal(clone.cases[0].referenceOutput, 'ALPHA');
  const noKey = await api.POST(request({ user, createMode: 'same-config', sourceExperimentId: id }, null));
  assert.equal(noKey.status, 401);
});

test('legacy no-ref requests still work, while caller-supplied resolved snapshots cannot forge versions', async () => {
  const legacy = await api.POST(request(body({ configSnapshot: { traceSource: 'existing' } }), null));
  assert.equal(legacy.status, 200);
  const legacySaved = await prisma.experiment.findUnique({ where: { id: (await legacy.json()).id } });
  assert.equal(JSON.parse(legacySaved.configSnapshotJson).assetVersions, undefined);
  const forged = await api.POST(request(body({ configSnapshot: { assetVersions: { schemaVersion: 1, dataset: { versionId: 'forged', definition: { cases: [] } } } } })));
  assert.equal(forged.status, 200);
  const frozen = JSON.parse((await prisma.experiment.findUnique({ where: { id: (await forged.json()).id } })).configSnapshotJson);
  assert.equal(frozen.assetVersions?.dataset, undefined);
});

test('authenticated legacy creation accepts selected datasets without case bindings and preserves manual answers', async () => {
  const cases = [{ input: 'Manual trace input', actualOutput: 'Observed', referenceOutput: 'Experiment annotation' }];
  const response = await api.POST(request(body({ cases })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
  assert.equal(saved.cases[0].referenceOutput, 'Experiment annotation');
  assert.equal(saved.cases[0].input, 'Manual trace input');
  assert.equal(JSON.parse(saved.configSnapshotJson).assetVersions?.dataset, undefined);
});

test('authenticated no-ref creation records a current dataset version only for verifiable exact case bindings', async () => {
  const current = datasetV2.content.cases[0];
  const response = await api.POST(request(body({ cases: [{ datasetId, datasetCaseId: 'one', input: current.input, datasetInput: current.input, referenceOutput: current.expectedOutput, values: current.values }] })));
  assert.equal(response.status, 200);
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id } });
  assert.equal(JSON.parse(saved.configSnapshotJson).assetVersions.dataset.versionId, datasetV2.id);
});

test('explicit malformed refs and unsupported Benchmark requests fail instead of dropping refs', async () => {
  for (const assetVersions of [null, [], { agent: {} }, { dataset: '' }, { evaluators: [] }]) {
    const response = await api.POST(request(body({ assetVersions })));
    assert.equal(response.status, 400);
  }
  const response = await api.POST(request(body({ scope: 'benchmark', assetVersions: refs() })));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /[Bb]enchmark/);
});

test('original Trace-pair comparison refuses dataset version claims because it does not bind dataset cases', async () => {
  const response = await api.POST(request(body({ type: 'llm', assetVersions: refs(), groups: [{ key: 'A', value: 'model-a' }, { key: 'B', value: 'model-b' }] })));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /数据集版本/);
});

test('versioned create rejects foreign traces and mismatched execution/session IDs', async () => {
  for (const item of [{ executionId: 'foreign-trace', taskId: 'foreign-trace' }, { executionId: 'trace-one', taskId: 'foreign-trace' }, { taskId: 'foreign-trace' }]) {
    const response = await api.POST(request(body({ assetVersions: refs(), cases: [{ datasetId, datasetCaseId: 'one', ...item }] })));
    assert.ok([404, 422].includes(response.status), JSON.stringify(await response.json()));
  }
});

test('versioned run requires the real actor before the already-running shortcut; legacy runs remain compatible', async () => {
  const versioned = await prisma.experiment.create({ data: { user, name: 'Versioned running', status: 'running', configSnapshotJson: JSON.stringify({ assetVersions: { schemaVersion: 1, agent: { versionId: agentV1.id } } }) } });
  const runRequest = (token: string | null) => new Request(`http://localhost/api/experiments/${versioned.id}/run?user=${encodeURIComponent(user)}`, { method: 'POST', headers: token ? { 'x-witty-api-key': token } : {} });
  assert.equal((await runApi.POST(runRequest(null), { params: Promise.resolve({ id: versioned.id }) })).status, 401);
  assert.equal((await runApi.POST(runRequest('wi_fixture_other_versions'), { params: Promise.resolve({ id: versioned.id }) })).status, 403);
  const authorized = await runApi.POST(runRequest(key), { params: Promise.resolve({ id: versioned.id }) });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).alreadyRunning, true);
  const legacy = await prisma.experiment.create({ data: { user, name: 'Legacy running', status: 'running' } });
  assert.equal((await runApi.POST(new Request(`http://localhost/api/experiments/${legacy.id}/run?user=${encodeURIComponent(user)}`, { method: 'POST' }), { params: Promise.resolve({ id: legacy.id }) })).status, 200);
});

test('Case and evaluator retries authenticate versioned experiments while retaining legacy behavior', async () => {
  for (const versioned of [true, false]) {
    const exp = await prisma.experiment.create({ data: { user, name: 'Retry identity', evaluatorIdsJson: '["preset-conversation-rules"]',
      configSnapshotJson: versioned ? JSON.stringify({ assetVersions: { schemaVersion: 1, agent: { versionId: agentV1.id } } }) : null,
      cases: { create: { input: 'local rule-only result', actualOutput: 'no model calls' } },
    }, include: { cases: true } });
    const caseId = exp.cases[0].id;
    const result = await prisma.experimentEvalResult.create({ data: { experimentId: exp.id, caseId, evaluatorId: 'preset-conversation-rules', status: 'done' } });
    const caseParams = { params: Promise.resolve({ id: exp.id, caseId }) };
    const resultParams = { params: Promise.resolve({ id: exp.id, resultId: result.id }) };
    const retryRequest = (suffix: string, token: string | null) => new Request(`http://localhost/api/experiments/${exp.id}/${suffix}?user=${encodeURIComponent(user)}`, { method: 'POST', headers: token ? { 'x-witty-api-key': token } : {} });
    const before = (await prisma.experimentEvalResult.findUnique({ where: { id: result.id } })).updatedAt;
    if (versioned) {
      for (const [token, status] of [[null, 401], ['wi_fixture_other_versions', 403]] as const) {
        assert.equal((await caseRetryApi.POST(retryRequest(`cases/${caseId}/retry`, token), caseParams)).status, status);
        assert.equal((await resultRetryApi.POST(retryRequest(`results/${result.id}/retry`, token), resultParams)).status, status);
      }
      assert.deepEqual((await prisma.experimentEvalResult.findUnique({ where: { id: result.id } })).updatedAt, before);
    }
    const token = versioned ? key : null;
    assert.equal((await caseRetryApi.POST(retryRequest(`cases/${caseId}/retry`, token), caseParams)).status, 409);
    assert.equal((await resultRetryApi.POST(retryRequest(`results/${result.id}/retry`, token), resultParams)).status, 200);
  }
});

test('dispatch cannot substitute another Agent platform while retaining the frozen Agent version label', async () => {
  const exp = await prisma.experiment.create({ data: { user, name: 'Agent version dispatch', agentName: 'build', configSnapshotJson: JSON.stringify({ traceSource: 'generate', executionTarget: { workerId: 'not-dispatched', platform: 'opencode', agent: 'build' }, assetVersions: { schemaVersion: 1, agent: { businessId: '["opencode","build"]', versionId: agentV1.id } } }), cases: { create: { input: 'Do not execute', actualOutput: '' } } } });
  const response = await runApi.POST(new Request(`http://localhost/api/experiments/${exp.id}/run?user=${encodeURIComponent(user)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': key }, body: JSON.stringify({ generateTrace: { workerId: 'not-dispatched', platform: 'pi', agent: 'build' } }) }), { params: Promise.resolve({ id: exp.id }) });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /Agent.*版本|版本.*Agent/);
  assert.equal((await prisma.experiment.findUnique({ where: { id: exp.id } })).status, 'draft');
});

test('versioned FI dispatch refuses an unrecorded model override before creating any task', async () => {
  const exp = await prisma.experiment.create({ data: { user, name: 'FI conditions', agentName: 'build', configSnapshotJson: JSON.stringify({ traceSource: 'generate', fiOrchestrate: true, executionTarget: { workerId: 'not-dispatched', platform: 'opencode', agent: 'build', model: 'model-frozen', timeoutSeconds: 300 }, assetVersions: { schemaVersion: 1, agent: { businessId: '["opencode","build"]', versionId: agentV1.id } } }), cases: { create: { input: 'Do not execute', faultInjectionType: 'timeout' } } } });
  const response = await runApi.POST(new Request(`http://localhost/api/experiments/${exp.id}/run?user=${encodeURIComponent(user)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': key }, body: JSON.stringify({ fiOrchestrate: true, generateTrace: { workerId: 'not-dispatched', platform: 'opencode', agent: 'build', model: 'model-changed', timeoutSeconds: 300 } }) }), { params: Promise.resolve({ id: exp.id }) });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /配置.*复用|复用.*配置/);
  assert.equal((await prisma.experiment.findUnique({ where: { id: exp.id } })).status, 'draft');
});

test('FI generation refuses frozen multi-turn cases instead of executing only their first input', async () => {
  const exp = await prisma.experiment.create({ data: { user, name: 'FI multi-turn boundary', agentName: 'build', configSnapshotJson: JSON.stringify({ traceSource: 'generate', fiOrchestrate: true,
    executionTarget: { workerId: 'not-dispatched', platform: 'opencode', agent: 'build', model: null, timeoutSeconds: 300 }, assetVersions: { schemaVersion: 1, agent: { businessId: '["opencode","build"]', versionId: agentV1.id } } }),
    cases: { create: { input: turns[0].input, faultInjectionType: 'timeout', caseValuesJson: JSON.stringify({ turns }) } },
  } });
  const before = await prisma.faultInjectionTask.count({ where: { user } });
  const response = await runApi.POST(new Request(`http://localhost/api/experiments/${exp.id}/run?user=${encodeURIComponent(user)}`, { method: 'POST', headers: { 'x-witty-api-key': key } }), { params: Promise.resolve({ id: exp.id }) });
  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.code, 'MULTI_TURN_UNSUPPORTED');
  assert.match(error.error, /故障注入.*多轮|多轮.*故障注入/);
  assert.equal((await prisma.experiment.findUnique({ where: { id: exp.id } })).status, 'draft');
  assert.equal(await prisma.faultInjectionTask.count({ where: { user } }), before);
});

test('original LLM pairing can freeze agent and evaluator definitions without claiming a dataset version', async () => {
  for (const [id, model] of [['pair-a', 'model-a'], ['pair-b', 'model-b']]) await prisma.execution.create({ data: { id, taskId: id, user, agentName: 'build', model, query: 'same pair input' } });
  const response = await api.POST(request(body({ datasetId: undefined, type: 'llm', assetVersions: { agent: agentV1.id, evaluators: { [evaluatorId]: evaluatorV1.id } }, groups: [{ key: 'A', value: 'model-a' }, { key: 'B', value: 'model-b' }] })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
  const snapshot = JSON.parse(saved.configSnapshotJson);
  assert.equal(saved.cases.length, 2);
  assert.equal(snapshot.assetVersions.agent.versionId, agentV1.id);
  assert.equal(snapshot.assetVersions.dataset, undefined);
  assert.equal(snapshot.customEvaluatorSnapshots.cards[evaluatorId].llmConfig.systemPrompt, 'First {{output}}');
  const detailResponse=await detailApi.GET(new Request('http://localhost/api/experiments/'+saved.id,{headers:{'x-witty-api-key':key}}),{params:Promise.resolve({id:saved.id})});
  const detail=await detailResponse.json();
  assert.equal(detail.configSnapshot?.assetVersions?.agent?.versionId,agentV1.id);
  assert.equal(detail.reusableConfig?.assetVersions?.evaluators?.[evaluatorId]?.versionId,evaluatorV1.id);
});

test('LLM pairing never selects another user newer traces with identical agent, model and input', async () => {
  for (const [suffix, model] of [['a', 'model-a'], ['b', 'model-b']]) {
    await prisma.execution.create({ data: { id: `isolation-own-${suffix}`, user, agentName: 'build', model, query: 'isolated pair', timestamp: new Date('2025-01-01') } });
    await prisma.execution.create({ data: { id: `isolation-foreign-${suffix}`, user: 'other-versions', agentName: 'build', model, query: 'isolated pair', timestamp: new Date('2026-01-01') } });
  }
  const response = await api.POST(request(body({ datasetId: undefined, type: 'llm', assetVersions: { agent: agentV1.id, evaluators: { [evaluatorId]: evaluatorV1.id } }, groups: [{ key: 'A', value: 'model-a' }, { key: 'B', value: 'model-b' }] })));
  assert.equal(response.status, 200);
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id }, include: { cases: true } });
  assert.ok(saved.cases.some((item: any) => item.executionId === 'isolation-own-a'));
  assert.equal(saved.cases.filter((item: any) => String(item.executionId).startsWith('isolation-foreign-')).length, 0);
});

test('unsupported version backend returns an explicit capability error without creating an experiment', async () => {
  const previous = process.env.DB_HOST;
  const count = await prisma.experiment.count({ where: { user } });
  try {
    process.env.DB_HOST = 'fixture-backend-capability-only';
    const response = await api.POST(request(body({ assetVersions: refs() })));
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, 'ASSET_BACKEND_UNSUPPORTED');
  } finally {
    if (previous === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = previous;
  }
  assert.equal(await prisma.experiment.count({ where: { user } }), count);
});

test('an evaluator historical version remains selectable with execution policy after deletion from the current catalog', async () => {
  await evaluatorStorage.writeUserCustomEvaluators(user, []);
  const response = await api.POST(request(body({ assetVersions: refs(), evaluatorExecutionConfig: { mode: 'system' } })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = await prisma.experiment.findUnique({ where: { id: (await response.json()).id } });
  assert.equal(JSON.parse(saved.configSnapshotJson).customEvaluatorSnapshots.cards[evaluatorId].llmConfig.systemPrompt, 'First {{output}}');
});
