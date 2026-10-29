/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const isolated = createIsolatedDatabase();
const user = 'versioned-append@example.test', key = 'wi_fixture_versioned_append';
const datasetId = 'frozen-append-dataset';
let prisma: any, api: any, detail: any, retry: any, assets: any, traceGeneration: any, version: any;
let serial = 0;
const turns = [{ id: 'remember', input: 'remember ALPHA', expectedOutput: 'ACK', expectation: { contains: 'ACK' } },
  { id: 'recall', input: 'what was the value', expectedOutput: 'ALPHA', expectation: { contains: 'ALPHA' } }];
const sourceCases = [
  { id: 'single', input: 'same input', expectedOutput: 'frozen answer', values: { note: 'keep frozen', fault_injection_type: 'frozen-fault', available_tools: [{ name: 'frozen-tool' }], available_skills: [{ name: 'frozen-skill' }] } },
  { id: 'multi', input: turns[0].input, expectedOutput: 'ALPHA', turns, values: { note: 'multi frozen' } },
  { id: 'duplicate-a', input: 'duplicate input', expectedOutput: 'answer A' },
  { id: 'duplicate-b', input: 'duplicate input', expectedOutput: 'answer B' },
];
async function makeExperiment(options: { legacy?: boolean; generate?: boolean; agentOnly?: boolean; status?: string } = {}) {
  const assetVersions = { schemaVersion: 1, agent: { businessId: '["opencode","build"]', versionId: 'declared-agent-v1', version: 1 },
    ...(!options.agentOnly ? { dataset: { businessId: datasetId, versionId: version.id, version: version.version, contentHash: version.contentHash, definition: version.content } } : {}) };
  return prisma.experiment.create({ data: { user, name: `Append ${++serial}`, agentName: 'build', status: options.status || 'done',
    evaluatorIdsJson: '["preset-conversation-rules"]', configSnapshotJson: options.legacy ? '{}' : JSON.stringify({ schemaVersion: 1, traceSource: options.generate ? 'generate' : 'existing',
      datasetId, executionTarget: { workerId: 'original-worker', platform: 'opencode', agent: 'build', model: 'declared-model' }, assetVersions, customEvaluatorSnapshots: { schemaVersion: 1, cards: {} } }),
  } });
}
async function makeTrace(input: string, options: { user?: string; agent?: string; platform?: string; complete?: boolean; subagent?: boolean; output?: string; multi?: boolean } = {}) {
  const id = `append-trace-${++serial}`, taskId = `task-${id}`, owner = options.user || user;
  const output = options.output || 'real Trace output';
  const messages = options.multi ? [{ role: 'user', content: input }, { role: 'assistant', content: 'ACK' }, { role: 'user', content: turns[1].input }, { role: 'assistant', content: output }]
    : [{ role: 'user', content: input }, { role: 'assistant', content: output }];
  await prisma.session.create({ data: { user: owner, taskId, query: input, endTime: options.complete === false ? null : new Date(), interactions: JSON.stringify(messages) } });
  await prisma.execution.create({ data: { id, taskId, user: owner, query: input, finalResult: output, agentName: options.agent || 'build', framework: options.platform || 'opencode', isSubagent: options.subagent || false } });
  return { executionId: id, taskId };
}
function request(id: string, cases: unknown[], options: { token?: string | null; body?: Record<string, unknown> } = {}) {
  const token = options.token === undefined ? key : options.token;
  return new Request(`http://localhost/api/experiments/${id}/cases`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-witty-api-key': token } : {}) },
    body: JSON.stringify({ user, autoRun: false, cases, ...options.body }) });
}
async function append(id: string, cases: unknown[], options?: Parameters<typeof request>[2]) {
  return api.POST(request(id, cases, options), { params: Promise.resolve({ id }) });
}
async function rows(id: string) { return prisma.experimentCase.findMany({ where: { experimentId: id }, orderBy: { createdAt: 'asc' }, include: { results: true } }); }
async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Evaluation did not settle');
}
test.before(async () => {
  prisma = (await import('@/lib/storage/prisma')).prismaRaw;
  api = await import('@/app/api/experiments/[id]/cases/route');
  detail = await import('@/app/api/experiments/[id]/route');
  retry = await import('@/app/api/experiments/[id]/results/[resultId]/retry/route');
  assets = await import('@/lib/evaluation-assets/service');
  traceGeneration = await import('@/lib/engine/experiment/trace-generation');
  await prisma.user.create({ data: { username: user, apiKey: key } });
  await prisma.user.create({ data: { username: 'append-other', apiKey: 'wi_fixture_append_other' } });
  await prisma.agentEvalDataset.create({ data: { id: datasetId, user, name: 'Frozen append cases', casesJson: JSON.stringify(sourceCases) } });
  version = (await assets.assetVersionView(user, 'dataset', datasetId)).selectedVersion;
  await prisma.agentEvalDataset.update({ where: { id: datasetId }, data: { casesJson: JSON.stringify([...sourceCases, { id: 'latest-only', input: 'latest input', expectedOutput: 'latest answer' }]) } });
  await assets.assetVersionView(user, 'dataset', datasetId);
  const { draft } = await assets.mutateAsset(user, { action: 'draft-create', businessId: datasetId });
  await assets.mutateAsset(user, { action: 'case-save', businessId: datasetId, caseId: 'draft-only', revision: draft.revision, case: { id: 'draft-only', input: 'draft input', expectedOutput: 'draft answer' } });
});
test.after(async () => { await prisma?.$disconnect(); isolated.dispose(); });

test('frozen append accepts only source-version Case IDs and rejects the entire invalid batch before writing', async () => {
  const exp = await makeExperiment(), valid = await makeTrace('same input');
  for (const [caseId, input] of [['outside-case', 'outside input'], ['latest-only', 'latest input'], ['draft-only', 'draft input']]) {
    const invalid = await makeTrace(input);
    const response = await append(exp.id, [{ ...valid, datasetCaseId: 'single' }, { ...invalid, datasetCaseId: caseId }]);
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
    assert.equal((await rows(exp.id)).length, 0);
    assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: exp.id } }), 0);
  }
});

test('versioned append requires the actual actor and completed root Trace matching Agent/platform and identity', async () => {
  const exp = await makeExperiment(), valid = await makeTrace('same input');
  assert.equal((await append(exp.id, [{ ...valid, datasetCaseId: 'single' }], { token: null })).status, 401);
  assert.equal((await append(exp.id, [{ ...valid, datasetCaseId: 'single' }], { token: 'wi_fixture_append_other' })).status, 403);
  for (const option of [{ user: 'append-other' }, { agent: 'other-agent' }, { platform: 'pi-agent' }, { complete: false }, { subagent: true }]) {
    const invalid = await makeTrace('same input', option);
    const response = await append(exp.id, [{ ...invalid, datasetCaseId: 'single' }]);
    assert.ok([404, 409, 422].includes(response.status), JSON.stringify(await response.json()));
  }
  const wrongIdentity = await append(exp.id, [{ ...valid, taskId: 'wrong-task', datasetCaseId: 'single' }]);
  assert.equal(wrongIdentity.status, 422);
  assert.equal((await rows(exp.id)).length, 0);
});

test('server uses real Trace facts and frozen Case contract instead of caller input/output, fault and catalogs', async () => {
  const exp = await makeExperiment(), trace = await makeTrace('  same\n input  ');
  const response = await append(exp.id, [{ ...trace, datasetCaseId: 'single', input: 'forged input', actualOutput: 'forged output', referenceOutput: 'forged answer',
    faultInjectionType: 'forged-fault', values: { note: 'forged' }, evaluatorContext: { schemaVersion: 1, availableTools: [{ name: 'forged-tool' }] } }]);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added, 1); assert.equal(result.reused, 0); assert.equal(result.evaluating, false);
  const [saved] = await rows(exp.id), values = JSON.parse(saved.caseValuesJson);
  assert.equal(saved.input, '  same\n input  '); assert.equal(saved.actualOutput, 'real Trace output');
  assert.equal(saved.datasetInput, 'same input'); assert.equal(saved.referenceOutput, 'frozen answer');
  assert.equal(saved.faultInjectionType, 'frozen-fault'); assert.equal(values.note, 'keep frozen');
  assert.deepEqual(values.__agentInsightDatasetCase, { datasetId, caseId: 'single' });
  assert.equal(JSON.parse(saved.evaluatorContextJson).availableTools[0].name, 'frozen-tool');
  assert.equal(saved.results.length, 0);
});

test('input matching is exact after whitespace normalization and duplicate inputs require explicit Case identity', async () => {
  const exp = await makeExperiment(), wrong = await makeTrace('prefix same input');
  assert.equal((await append(exp.id, [{ ...wrong, datasetCaseId: 'single' }])).status, 422);
  const duplicate = await makeTrace('duplicate input');
  assert.equal((await append(exp.id, [duplicate])).status, 422);
  const response = await append(exp.id, [{ ...duplicate, datasetCaseId: 'duplicate-b' }]);
  assert.equal(response.status, 200);
  assert.equal((await rows(exp.id))[0].referenceOutput, 'answer B');
  const unique = await makeTrace('same input');
  assert.equal((await append(exp.id, [unique])).status, 200);
});

test('multi-turn append freezes all turns and permits only explicit experiment-answer overrides', async () => {
  const exp = await makeExperiment(), trace = await makeTrace(turns[0].input, { multi: true, output: 'ALPHA' });
  const response = await append(exp.id, [{ ...trace, datasetCaseId: 'multi', turns: [{ input: 'forged' }], referenceOverride: { value: 'experiment answer', source: 'manual' } }]);
  assert.equal(response.status, 200);
  const [saved] = await rows(exp.id), values = JSON.parse(saved.caseValuesJson);
  assert.equal(saved.referenceOutput, 'experiment answer');
  assert.equal(values.turns.length, 2); assert.equal(values.turns[1].expectedOutput, 'ALPHA');
  assert.equal(values.__agentInsightReferenceOverride.baselineVersionId, version.id);
  assert.equal(values.__agentInsightReferenceOverride.baseExpectedOutput, 'ALPHA');
  assert.equal(values.__agentInsightReferenceOverride.newExpectedOutput, 'experiment answer');
});

test('duplicate Trace skips all writes, preserves answers and unfinished scores, and does not schedule reevaluation', async () => {
  const exp = await makeExperiment(), trace = await makeTrace('same input');
  await append(exp.id, [{ ...trace, datasetCaseId: 'single', referenceOverride: { value: 'keep override', source: 'manual' } }]);
  const [saved] = await rows(exp.id);
  await prisma.experimentEvalResult.create({ data: { experimentId: exp.id, caseId: saved.id, evaluatorId: 'preset-conversation-rules', status: 'running', score: 73, attempts: 4 } });
  const before = await rows(exp.id);
  const response = await append(exp.id, [{ ...trace, datasetCaseId: 'single', referenceOverride: { value: 'do not overwrite', source: 'manual' } }], { body: { autoRun: true } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added, 0); assert.equal(result.reused, 1); assert.equal(result.evaluating, false);
  assert.deepEqual(await rows(exp.id), before);
});

test('duplicates within a batch and concurrent requests create only one Case with accurate added/reused counts', async () => {
  const exp = await makeExperiment(), trace = await makeTrace('same input');
  const sameBatch = await append(exp.id, [{ ...trace, datasetCaseId: 'single' }, { ...trace, datasetCaseId: 'single' }]);
  assert.equal(sameBatch.status, 200);
  const first = await sameBatch.json(); assert.equal(first.added, 1); assert.equal(first.reused, 1);
  const exp2 = await makeExperiment(), trace2 = await makeTrace('same input');
  const responses = await Promise.all([append(exp2.id, [{ ...trace2, datasetCaseId: 'single' }]), append(exp2.id, [{ ...trace2, datasetCaseId: 'single' }])]);
  for (const response of responses) assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const outcomes = await Promise.all(responses.map(response => response.json()));
  assert.equal(outcomes.reduce((sum, item) => sum + item.added, 0), 1);
  assert.equal(outcomes.reduce((sum, item) => sum + item.reused, 0), 1);
  assert.equal((await rows(exp2.id)).length, 1);
});

test('deleted or cancelled experiments reject the whole append without inserting or reevaluating', async () => {
  const trace = await makeTrace('same input');
  for (const state of ['cancelled', 'deleted', 'intent']) {
    const exp = await makeExperiment();
    if (state === 'cancelled') await prisma.experiment.update({ where: { id: exp.id }, data: { status: 'cancelled' } });
    if (state === 'deleted') await prisma.experiment.update({ where: { id: exp.id }, data: { deletedAt: new Date() } });
    if (state === 'intent') await prisma.experimentCancellation.create({ data: { id: `cancel-${exp.id}`, experimentId: exp.id, caseKey: '', user } });
    const response = await append(exp.id, [{ ...trace, datasetCaseId: 'single' }]);
    assert.ok([404, 409].includes(response.status)); assert.equal((await rows(exp.id)).length, 0);
  }
});

test('appended source Trace is ready in a generated parent, executes frozen rules through the real engine, and never redispatches Agent', async () => {
  const exp = await makeExperiment({ generate: true }), trace = await makeTrace(turns[0].input, { multi: true, output: 'ALPHA' });
  const commands = await prisma.reliabilityCommand.count({ where: { user } });
  const response = await append(exp.id, [{ ...trace, datasetCaseId: 'multi' }], { body: { autoRun: true } });
  assert.equal(response.status, 200); assert.equal((await response.json()).evaluating, true);
  await waitUntil(async () => { const current = await rows(exp.id); return current.length === 1 && current[0].results[0]?.status === 'done'; });
  const [saved] = await rows(exp.id); assert.equal(saved.results[0].score, 100);
  const detailResponse = await detail.GET(new Request(`http://localhost/api/experiments/${exp.id}?user=${encodeURIComponent(user)}`), { params: Promise.resolve({ id: exp.id }) });
  assert.equal(detailResponse.status, 200);
  const value = await detailResponse.json(); assert.equal(value.cases[0].traceStatus, 'ready');
  assert.ok(value.cases[0].executionProgress.stage >= 3);
  assert.deepEqual(await traceGeneration.collectTraceGenerationCases(exp.id), []);
  const retryResponse = await retry.POST(new Request(`http://localhost/api/experiments/${exp.id}/results/${saved.results[0].id}/retry?user=${encodeURIComponent(user)}`, { method: 'POST', headers: { 'x-witty-api-key': key } }), { params: Promise.resolve({ id: exp.id, resultId: saved.results[0].id }) });
  assert.equal(retryResponse.status, 200); assert.equal((await rows(exp.id))[0].results[0].score, 100);
  assert.equal(await prisma.reliabilityCommand.count({ where: { user } }), commands);
});

test('existing parents keep existing-Trace display and frozen snapshots remain usable after the dataset is deleted', async () => {
  const exp = await makeExperiment(), trace = await makeTrace('same input');
  await prisma.agentEvalDataset.delete({ where: { id: datasetId } });
  assert.equal((await append(exp.id, [{ ...trace, datasetCaseId: 'single' }])).status, 200);
  const response = await detail.GET(new Request(`http://localhost/api/experiments/${exp.id}?user=${encodeURIComponent(user)}`), { params: Promise.resolve({ id: exp.id }) });
  const value = await response.json(); assert.equal(value.cases[0].traceStatus, null); assert.equal(value.traceProgress, null);
});

test('legacy append remains available without a version ref, while agent-only frozen refs require authentication', async () => {
  const legacy = await makeExperiment({ legacy: true });
  assert.equal((await append(legacy.id, [{ input: 'legacy manual', actualOutput: 'legacy answer' }], { token: null })).status, 200);
  const agentOnly = await makeExperiment({ agentOnly: true });
  assert.equal((await append(agentOnly.id, [{ input: 'manual', actualOutput: 'answer' }], { token: null })).status, 401);
  assert.equal((await append(agentOnly.id, [{ input: 'manual', actualOutput: 'answer' }])).status, 200);
});

test('corrupt frozen dataset references fail closed rather than falling back to legacy append', async () => {
  const trace = await makeTrace('same input');
  for (const change of [
    { dataset: {} }, { dataset: [] }, { dataset: 'broken' }, { schemaVersion: 2 },
    { field: 'businessId', value: '' }, { field: 'versionId', value: '' }, { field: 'version', value: 0 },
    { field: 'definition', value: [] }, { field: 'definition', value: { cases: [{ id: '', input: 'same input' }] } },
    { field: 'definition', value: { cases: [{ id: 'single', input: null }] } },
  ]) {
    const exp = await makeExperiment(), snapshot = JSON.parse(exp.configSnapshotJson);
    if (typeof change.field === 'string') snapshot.assetVersions.dataset[change.field] = change.value;
    else Object.assign(snapshot.assetVersions, change);
    await prisma.experiment.update({ where: { id: exp.id }, data: { configSnapshotJson: JSON.stringify(snapshot) } });
    const response = await append(exp.id, [{ ...trace, datasetCaseId: 'single' }]);
    assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
    assert.equal((await rows(exp.id)).length, 0);
  }
});

test('watch only appends uniquely matching frozen Cases and preserves their full baseline', async () => {
  const exp = await makeExperiment();
  await prisma.experiment.update({ where: { id: exp.id }, data: { watchMode: true, watchEnabledAt: new Date(Date.now() + 60_000) } });
  const valid = await makeTrace(turns[0].input, { multi: true, output: 'ALPHA' });
  const outside = await makeTrace('outside input');
  const ambiguous = await makeTrace('duplicate input');
  const wrongPlatform = await makeTrace('same input', { platform: 'actrail' });
  await prisma.session.updateMany({ where: { taskId: { in: [valid, outside, ambiguous, wrongPlatform].map(trace => trace.taskId) } }, data: { startTime: new Date(Date.now() + 120_000) } });
  const calls: string[] = [];
  const { createExperimentWatcher } = await import('@/lib/engine/experiment/experiment-watch');
  const watcher = createExperimentWatcher({ evaluate: async (_id, caseId) => { calls.push(caseId); return []; } });
  try {
    await watcher.scan(); await watcher.waitForIdle();
    const saved = await rows(exp.id);
    assert.equal(saved.length, 1); assert.equal(saved[0].executionId, valid.executionId);
    assert.equal(saved[0].referenceOutput, 'ALPHA'); assert.equal(JSON.parse(saved[0].caseValuesJson).turns.length, 2);
    assert.equal(JSON.parse(saved[0].caseValuesJson).__agentInsightDatasetCase.caseId, 'multi');
    assert.equal(calls.length, 1);
    await watcher.scan(); await watcher.waitForIdle();
    assert.equal((await rows(exp.id)).length, 1); assert.equal(calls.length, 1);
  } finally { await prisma.experiment.update({ where: { id: exp.id }, data: { watchMode: false } }); }
});

test('shared backing-container insertion cannot mutate a dataset-version experiment', async () => {
  const { addEvalExperimentCase } = await import('@/lib/engine/experiment/run-experiment');
  for (const malformed of [false, true]) {
    const exp = await makeExperiment();
    if (malformed) {
      const snapshot = JSON.parse(exp.configSnapshotJson); snapshot.assetVersions.dataset = {};
      await prisma.experiment.update({ where: { id: exp.id }, data: { configSnapshotJson: JSON.stringify(snapshot) } });
    }
    await assert.rejects(addEvalExperimentCase(exp.id, { taskId: 'backing-forged', input: 'outside', actualOutput: 'forged' }), /详情|版本/);
    assert.equal((await rows(exp.id)).length, 0);
  }
});
