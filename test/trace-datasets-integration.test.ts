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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, writeFile, mkdir, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { traceTurn } from './helpers/trace-dataset-source';
import { createRequire } from 'node:module';

function requestId() { const t = Date.now().toString(16).padStart(12, '0'); return `${t.slice(0, 8)}-${t.slice(8)}-7${randomUUID().slice(0, 3)}-8${randomUUID().slice(0, 3)}-${randomUUID().replace(/-/g, '').slice(0, 12)}`; }
async function waitUntil<T>(read: () => Promise<T>, predicate: (x: T) => boolean, timeout = 30000) { const start = Date.now(); for (;;) { const result = await read(); if (predicate(result)) return result; if (Date.now() - start > timeout) throw new Error(`timeout: ${JSON.stringify(result)}`); await new Promise(r => setTimeout(r, 100)); } }

test('real SQLite + Worker: publish, idempotency, isolation, failure, deletion and replay', { timeout: 180000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-dataset-integration-'));
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  process.env.AGENT_INSIGHT_HOME = dir;
  await writeFile(path.join(dir, 'test.db'), '');
  execFileSync('node', ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
  execFileSync('node', ['scripts/build-trace-dataset-worker.cjs'], { stdio: 'pipe' });
  const { TraceDatasetManager } = await import('../src/server/trace-datasets/manager');
  const { generationOptions } = await import('../src/server/trace-datasets/catalog');
  const db = new PrismaClient();
  let manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), process.env.DATABASE_URL, path.resolve('generated/trace-datasets/worker.cjs'));
  try {
    const timestamp = new Date(Date.now() - 10000);
    for (let i = 0; i < 8; i++) {
      const taskId = `task-${i}`, query = i < 3 ? 'Write code for adding numbers' : `Explain item ${i}`, answer = ` Answer ${i % 2} \n`;
      await db.execution.create({ data: { id: `e-${i}`, taskId, query, finalResult: answer, framework: i % 2 ? 'codex' : 'opencode', agentName: 'Test Agent', user: 'alice', timestamp, lastIngestedAt: timestamp } });
      await db.session.create({ data: { taskId, user: 'alice', endTime: i === 7 ? null : timestamp, interactions: JSON.stringify([{ role: 'user', content: query }, { role: 'assistant', content: answer }]) } });
    }
    await db.execution.create({ data: { id: 'old', framework: 'claude', agentName: 'Old Agent', user: 'alice', timestamp: new Date(Date.now() - 40 * 86400000) } });
    const to = new Date().toISOString(), from = new Date(Date.parse(to) - 7 * 86400000).toISOString();
    const options = await generationOptions(db, 'alice', from, to, 'codex');
    assert.ok(options.platforms.some(p => p.id === 'claude'));
    assert.equal(options.agents[0].traceCount, 4);
    assert.deepEqual((await generationOptions(db, 'bob', from, to, 'codex')).platforms, []);
    const config = { name: 'Test', platform: 'codex', agentKey: options.agents[0].agentKey, from, to, limit: 20, requestId: requestId() };
    const created = await manager.create('alice', config);
    assert.deepEqual(await manager.create('alice', config), created);
    await assert.rejects(manager.create('alice', { ...config, name: 'Changed' }), /不同配置/);
    await assert.rejects(manager.progress('bob', created.datasetId), /未找到/);
    const done = await waitUntil(() => manager.progress('alice', created.datasetId), p => p.status !== 'generating');
    assert.equal(done.status, 'published', JSON.stringify(done));
    assert.equal(done.generatedCount, 3);
    assert.equal(done.summary?.sourceTraces, 4);
    assert.equal(done.summary?.exclusions[0].code, 'EXECUTION_NOT_SUCCESSFUL');
    const dataset = await db.agentEvalDataset.findUniqueOrThrow({ where: { id: created.datasetId } });
    assert.equal(dataset.caseCount, 3); assert.equal(dataset.projectionReady, true);
    const cases = JSON.parse(dataset.casesJson); assert.equal(cases[0].expectedOutput.startsWith(' '), true);
    assert.deepEqual(cases[0].values, { input: cases[0].input, reference_output: cases[0].expectedOutput });
    await waitUntil(() => db.traceDatasetGenerationJob.findUnique({ where: { id: created.jobId } }), j => j === null);
    await assert.rejects(access(manager.dir('alice', created.jobId)));
    assert.deepEqual(await manager.create('alice', config), created);
    await assert.rejects(manager.create('alice', { ...config, name: 'Changed after retirement' }), /不同配置/);
    assert.equal((await manager.progress('alice', created.datasetId)).generatedCount, 3);
    const { COVERAGE_POLICY } = await import('../src/lib/trace-datasets/sampling');
    const { PRODUCTION_POLICY: POLICY } = await import('../src/lib/trace-datasets/sampling/production');
    const pausedTick = t.mock.method(manager, 'tick', async () => {});
    const candidateJob = await manager.create('alice', { ...config, name: 'Explicit v5 worker validation', requestId: requestId(), limit: 2 });
    const frozen = await db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: candidateJob.jobId } });
    const frozenConfig = JSON.parse(frozen.configJson);
    assert.equal(frozenConfig.policy.version, POLICY.version);
    assert.equal(frozenConfig.policy.version, 'trace-coverage-v6.35');
    const productionJob = await manager.create('alice', { ...config, name: 'Production v6.35 exact selection', requestId: requestId(), limit: 2 });
    const productionFrozen = JSON.parse((await db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: productionJob.jobId } })).configJson);
    const { captureSources: captureProductionSources } = await import('../src/server/trace-datasets/source-reader');
    const sourceDir = manager.dir('alice', productionJob.jobId);
    await captureProductionSources(db, 'alice', productionFrozen, sourceDir, async () => {});
    const { hash: pairHash, signature, lexicalFeatures } = await import('../src/lib/trace-datasets/sampling');
    const { evidenceSample, EVIDENCE_POLICIES } = await import('../src/lib/trace-datasets/sampling/budgeted-evidence');
    const candidates = new Map<string, import('../src/lib/trace-datasets/sampling').Candidate>(), answers = new Map<string, string>();
    for (const file of await readdir(path.join(sourceDir, 'sources'))) {
      const body = JSON.parse(await readFile(path.join(sourceDir, 'sources', file), 'utf8'));
      for (const [index, unit] of body.units.entries()) {
        const key = pairHash([unit.input, unit.reference_output]);
        const sourcePath = { key: pairHash([body.sourceId, body.revision, index]), cells: unit.cells, knownDimensions: unit.knownDimensions };
        const previous = candidates.get(key);
        if (previous) previous.paths.push(sourcePath);
        else candidates.set(key, { key, inputKey: pairHash([unit.input]), task: unit.task, signature: signature(unit.input), lexical: lexicalFeatures(unit.input), paths: [sourcePath] });
        answers.set(key, unit.reference_output);
      }
    }
    const expected = evidenceSample([...candidates.values()], answers, 2, EVIDENCE_POLICIES.V635).selected.map(p => p.key);
    await db.traceDatasetGenerationJob.update({ where: { id: candidateJob.jobId }, data: { configJson: JSON.stringify({ ...frozenConfig, policy: COVERAGE_POLICY }) } });
    pausedTick.mock.restore();
    await manager.tick();
    const productionDone = await waitUntil(() => manager.progress('alice', productionJob.datasetId), p => p.status !== 'generating');
    assert.equal(productionDone.status, 'published', JSON.stringify(productionDone));
    const productionDataset = await db.agentEvalDataset.findUniqueOrThrow({ where: { id: productionJob.datasetId } });
    assert.deepEqual(JSON.parse(productionDataset.casesJson).map((c: { id: string }) => c.id), expected);
    await manager.remove('alice', productionJob.datasetId);
    const candidateDone = await waitUntil(() => manager.progress('alice', candidateJob.datasetId), p => p.status !== 'generating');
    assert.equal(candidateDone.status, 'published', JSON.stringify(candidateDone));
    assert.equal(candidateDone.generatedCount, 2);
    await manager.remove('alice', candidateJob.datasetId);
    const { db: storageDb } = await import('../src/lib/storage/prisma');
    const storageClient = t.mock.method(storageDb, 'getClient', () => db);
    const { findAgentDataset, updateAgentDatasetRecord } = await import('../src/server/agent_datasets_storage');
    const editable = (await findAgentDataset('alice', created.datasetId))!;
    editable.name = 'Edited after retirement';
    editable.cases[0].expectedOutput = 'Updated answer';
    assert.ok(editable.cases[0].values);
    editable.cases[0].values.reference_output = 'Updated answer';
    assert.equal(await updateAgentDatasetRecord(editable), true);
    const edited = await db.agentEvalDataset.findUniqueOrThrow({ where: { id: created.datasetId } });
    assert.equal(edited.name, editable.name);
    assert.equal(JSON.parse(edited.casesJson)[0].expectedOutput, 'Updated answer');
    assert.equal(JSON.parse(edited.referenceCasesJson)[0].expectedOutput, 'Updated answer');
    assert.equal(edited.caseCount, 3);
    assert.equal(await updateAgentDatasetRecord({ ...editable, user: 'bob' }), false);
    await db.agentEvalDataset.update({ where: { id: created.datasetId }, data: { generationStatus: 'generating' } });
    assert.equal(await updateAgentDatasetRecord(editable), false);
    await db.agentEvalDataset.update({ where: { id: created.datasetId }, data: { generationStatus: 'published' } });
    storageClient.mock.restore();
    await assert.rejects(manager.remove('bob', created.datasetId), /未找到/);
    await assert.rejects(manager.remove('alice', created.datasetId, true), /已生成完成/);
    const removal = await manager.remove('alice', created.datasetId);
    assert.equal((await manager.deletion('alice', removal!.deletionId)).status, 'deleted');
    assert.equal(await db.agentEvalDataset.findUnique({ where: { id: created.datasetId } }), null);
    await assert.rejects(manager.create('alice', config), /已结束/);
    assert.equal(await manager.remove('alice', created.datasetId), null);
    await assert.rejects(manager.deletion('bob', removal!.deletionId), /未找到/);
    assert.equal(await db.execution.count(), 9);
    const many: Awaited<ReturnType<typeof manager.create>>[] = [];
    for (let i = 0; i < 5; i++) many.push(await manager.create('alice', { ...config, name: `Parallel ${i}`, requestId: requestId() }));
    const snapshots: number[] = [];
    const monitor = setInterval(() => { void db.traceDatasetGenerationJob.count({ where: { status: 'running' } }).then(n => snapshots.push(n)); }, 10);
    await manager.remove('alice', many[0].datasetId);
    for (const item of many.slice(1)) {
      const p = await waitUntil(() => manager.progress('alice', item.datasetId), p => p.status !== 'generating');
      assert.equal(p.status, 'published', JSON.stringify(p));
    }
    clearInterval(monitor);
    assert.ok(snapshots.every(n => n <= 4));
    await waitUntil(() => db.agentEvalDataset.findUnique({ where: { id: many[0].datasetId } }), item => item === null);
    for (const item of many.slice(1)) await manager.remove('alice', item.datasetId);
    const largeInput = '完整任务 a'.repeat(160000), largeOutput = '完整回答 b'.repeat(160000);
    const largeEvents = [{ role: 'user', content: largeInput }, ...Array.from({ length: 10001 }, (_, i) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: i % 2 ? 'search' : 'read' } }] })), { role: 'tool', content: 'x'.repeat(9 * 1024 * 1024), extra: JSON.parse('['.repeat(80) + '1' + ']'.repeat(80)) }, { role: 'assistant', content: largeOutput }];
    await db.execution.create({ data: { id: 'large', taskId: 'large', query: largeInput, finalResult: largeOutput, framework: 'codex', agentName: 'Large Agent', user: 'alice', timestamp, lastIngestedAt: timestamp } });
    await db.session.create({ data: { taskId: 'large', user: 'alice', endTime: timestamp, interactions: JSON.stringify(largeEvents) } });
    const largeAgent = (await generationOptions(db, 'alice', from, to, 'codex')).agents.find(a => a.name === 'Large Agent')!;
    const largeJob = await manager.create('alice', { ...config, agentKey: largeAgent.agentKey, requestId: requestId() });
    const largeDone = await waitUntil(() => manager.progress('alice', largeJob.datasetId), p => p.status !== 'generating', 90000);
    assert.equal(largeDone.status, 'published', JSON.stringify(largeDone));
    const largeCases = JSON.parse((await db.agentEvalDataset.findUniqueOrThrow({ where: { id: largeJob.datasetId } })).casesJson);
    assert.equal(largeCases[0].input, largeInput); assert.equal(largeCases[0].expectedOutput, largeOutput);
    await manager.remove('alice', largeJob.datasetId);
    const { captureSources } = await import('../src/server/trace-datasets/source-reader');
    const { hash } = await import('../src/lib/trace-datasets/sampling');
    await db.execution.create({ data: { id: 'changing', taskId: 'changing', query: 'before', finalResult: 'answer', framework: 'codex', agentName: 'Changing Agent', user: 'alice', timestamp } });
    await db.session.create({ data: { taskId: 'changing', user: 'alice', endTime: timestamp, interactions: JSON.stringify([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'answer' }]) } });
    const captureDir = path.join(dir, 'capture-test');
    await captureSources(db, 'alice', { from, to, platform: 'codex', identities: [{ framework: 'codex', agentId: null, agentName: 'Changing Agent', clientId: null }] }, captureDir, async () => {
      await db.execution.update({ where: { id: 'changing' }, data: { query: 'after' } });
    });
    assert.equal(JSON.parse(await readFile(path.join(captureDir, 'sources', `${hash('changing')}.json`), 'utf8')).reason, 'SOURCE_CHANGED');
    const turns = [traceTurn('a', '计算 2 + 3', '5'), traceTurn('b', '再乘以 2', '10', 'history'), traceTurn('c', '计算 8 + 1', '9')];
    const duplicate = traceTurn('d', '计算 2 + 3', '5');
    const mixed = turns.flatMap(t => t.events);
    const unknown = [{ role: 'user', content: '问题' }, { role: 'assistant', content: '分析', channel: 'analysis' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '分析', channel: 'analysis' }];
    const sourceFiles = [];
    for (const [id, events, spans] of [['mixed', mixed, turns.flatMap(t => t.spans)], ['duplicate', duplicate.events, duplicate.spans], ['unknown', unknown, []]] as const) {
      await db.execution.create({ data: { id, taskId: id, query: events[0].content, finalResult: events.at(-1)!.content, framework: 'workbuddy', agentName: 'Boundary Agent', user: 'alice', timestamp, lastIngestedAt: timestamp } });
      await db.session.create({ data: { taskId: id, user: 'alice', endTime: timestamp, interactions: JSON.stringify(events) } });
      const folder = path.join(dir, 'otel_data', 'traces', '2026-09-06', 'sessions', id);
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, 'traces.jsonl');
      const body = spans.map(span => JSON.stringify({ ...span, sessionId: id, user: 'alice', framework: 'workbuddy' })).join('\n');
      await writeFile(file, body); sourceFiles.push({ file, body });
    }
    const boundaryAgent = (await generationOptions(db, 'alice', from, to, 'workbuddy')).agents[0];
    const boundaryConfig = { ...config, platform: 'workbuddy', agentKey: boundaryAgent.agentKey, limit: 1, requestId: requestId() };
    const boundaryJob = await manager.create('alice', boundaryConfig);
    const boundaryDone = await waitUntil(() => manager.progress('alice', boundaryJob.datasetId), p => p.status !== 'generating');
    assert.equal(boundaryDone.status, 'published', JSON.stringify(boundaryDone));
    assert.equal(boundaryDone.generatedCount, 1);
    assert.deepEqual(boundaryDone.summary, { version: 1, sourceTraces: 3, retainedTraces: 2, candidateCount: 4, duplicateCount: 1, sampledOutCount: 2, exclusions: [
      { code: 'ANSWER_UNATTRIBUTED', traceCount: 1, turnCount: 2 },
    ] });
    await waitUntil(() => db.traceDatasetGenerationJob.findUnique({ where: { id: boundaryJob.jobId } }), j => j === null);
    await assert.rejects(access(manager.dir('alice', boundaryJob.jobId)));
    assert.deepEqual((await manager.progress('alice', boundaryJob.datasetId)).summary, boundaryDone.summary);
    await assert.rejects(manager.progress('bob', boundaryJob.datasetId), /未找到/);
    await assert.rejects(manager.releaseSummary('bob', boundaryJob.datasetId), /未找到/);
    assert.deepEqual((await manager.progress('alice', boundaryJob.datasetId)).summary, boundaryDone.summary);
    await manager.releaseSummary('alice', boundaryJob.datasetId);
    await manager.releaseSummary('alice', boundaryJob.datasetId);
    assert.equal((await manager.progress('alice', boundaryJob.datasetId)).summary, null);
    assert.equal((await db.agentEvalDataset.findUniqueOrThrow({ where: { id: boundaryJob.datasetId } })).caseCount, 1);
    assert.deepEqual(await manager.create('alice', boundaryConfig), boundaryJob);
    assert.equal((await manager.progress('alice', boundaryJob.datasetId)).summary, null);
    const dismissedJob = await manager.create('alice', { ...boundaryConfig, requestId: requestId() });
    await manager.releaseSummary('alice', dismissedJob.datasetId);
    const dismissedDone = await waitUntil(() => manager.progress('alice', dismissedJob.datasetId), p => p.status !== 'generating');
    assert.equal(dismissedDone.status, 'published');
    assert.equal(dismissedDone.generatedCount, 1);
    assert.equal(dismissedDone.summary, null);
    await manager.remove('alice', dismissedJob.datasetId);
    await writeFile(path.join(dir, 'published-progress.json'), JSON.stringify(boundaryDone));
    for (const { file, body } of sourceFiles) assert.equal(await readFile(file, 'utf8'), body);
    const columns = await db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info(TraceDatasetGenerationJob)');
    assert.ok(!columns.some(c => c.name === 'summaryJson'));
    const originalRows = await db.session.findMany({ where: { taskId: { in: ['mixed', 'duplicate'] } } });
    assert.ok(originalRows.every(r => !r.interactions?.includes('traceDatasetBoundary')));
    await manager.close();
    manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), process.env.DATABASE_URL!, path.resolve('generated/trace-datasets/worker.cjs'));
    await manager.start();
    assert.equal((await manager.progress('alice', boundaryJob.datasetId)).summary, null);
    assert.deepEqual(await manager.create('alice', boundaryConfig), boundaryJob);
    assert.equal((await manager.progress('alice', boundaryJob.datasetId)).status, 'published');
    await manager.remove('alice', boundaryJob.datasetId);
    for (const taskId of ['mixed', 'duplicate', 'unknown']) {
      await db.session.updateMany({ where: { taskId }, data: { interactions: JSON.stringify(unknown) } });
      await db.execution.updateMany({ where: { taskId }, data: { query: unknown[0].content, finalResult: unknown.at(-1)!.content } });
    }
    const unknownJob = await manager.create('alice', { ...boundaryConfig, requestId: requestId() });
    const unknownDone = await waitUntil(() => manager.progress('alice', unknownJob.datasetId), p => p.status !== 'generating');
    assert.equal(unknownDone.error?.code, 'NO_VALID_SAMPLES');
    await waitUntil(() => db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: unknownJob.jobId } }), j => !j.cleanupPending);
    assert.equal((await db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: unknownJob.jobId } })).status, 'failed');
    assert.deepEqual(unknownDone.summary, { version: 1, sourceTraces: 3, retainedTraces: 0, candidateCount: 0, duplicateCount: 0, sampledOutCount: null, exclusions: [{ code: 'ANSWER_UNATTRIBUTED', traceCount: 3, turnCount: 6 }] });
    await writeFile(path.join(dir, 'failed-progress.json'), JSON.stringify(unknownDone));
    await manager.remove('alice', unknownJob.datasetId);
    await db.session.updateMany({ data: { endTime: null } });
    const failed = await manager.create('alice', { ...config, requestId: requestId() });
    const failure = await waitUntil(() => manager.progress('alice', failed.datasetId), p => p.status === 'failed');
    assert.equal(failure.error?.code, 'NO_VALID_SAMPLES'); assert.equal(failure.canReturn, true);
    await manager.remove('alice', failed.datasetId, true);
    await waitUntil(() => db.traceDatasetGenerationJob.count(), count => count === 0);
  } finally { await manager.close(); await db.$disconnect(); }
});


test('manager admission, FIFO, restart, stale messages, clock rollback and orphan cleanup', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-dataset-lifecycle-'));
  const url = `file:${dir}/test.db`;
  await writeFile(path.join(dir, 'test.db'), '');
  execFileSync('node', ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const workerFile = path.join(dir, 'worker.cjs');
  await writeFile(workerFile, `const {parentPort: p, workerData: w} = require('node:worker_threads');
    p.on('message', m => { if (m.type === 'cancel') p.postMessage({...m, type:'done'}); });
    p.postMessage({type:'ready', incarnationId:w.incarnationId});`);
  const { TraceDatasetManager } = await import('../src/server/trace-datasets/manager');
  const { generationOptions } = await import('../src/server/trace-datasets/catalog');
  const { hash } = await import('../src/lib/trace-datasets/sampling');
  const db = new PrismaClient({ datasources: { db: { url } } });
  let manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), url, workerFile);
  try {
    const to = new Date().toISOString(), from = new Date(Date.parse(to) - 86400000).toISOString();
    await db.execution.create({ data: { id: 'source', user: 'alice', framework: 'codex', agentName: 'Queue Agent', timestamp: new Date(Date.now() - 1000) } });
    const agent = (await generationOptions(db, 'alice', from, to, 'codex')).agents[0];
    const config = { name: 'Queue test', platform: 'codex', agentKey: agent.agentKey, from, to, limit: 20 };
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(await manager.create('alice', { ...config, requestId: requestId() }));
    await waitUntil(() => db.traceDatasetGenerationJob.count({ where: { status: 'running' } }), n => n === 4);
    assert.equal(await db.traceDatasetGenerationJob.count({ where: { status: 'queued' } }), 16);
    await assert.rejects(manager.create('alice', { ...config, requestId: requestId() }), e => (e as {code: string}).code === 'QUEUE_LIMIT');
    const running = await db.traceDatasetGenerationJob.findMany({ where: { status: 'running' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const next = await db.traceDatasetGenerationJob.findFirstOrThrow({ where: { status: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    await manager.remove('alice', running[0].datasetId, true);
    await manager.tick();
    await waitUntil(() => db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: next.id } }), j => j.status === 'running');
    const before = await db.traceDatasetGenerationJob.findMany({ where: { status: 'running' } });
    await manager.close();
    const orphan = manager.dir('alice', randomUUID());
    await mkdir(orphan, { recursive: true }); await writeFile(path.join(orphan, 'body'), 'private source');
    manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), url, workerFile);
    await manager.start();
    await assert.rejects(access(orphan));
    for (const old of before) {
      const recovered = await db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: old.id } });
      assert.ok(recovered.leaseEpoch > old.leaseEpoch);
      assert.equal((await db.traceDatasetGenerationJob.updateMany({ where: { id: old.id, leaseEpoch: old.leaseEpoch, status: 'running' }, data: { stage: 'late-write' } })).count, 0);
    }
    const slots = (manager as unknown as { slots: { worker: { terminate(): Promise<number> }; jobId?: string; incarnationId: string }[] }).slots;
    const crashed = slots.find(s => s.jobId)!;
    const crashedId = crashed.jobId!, incarnation = crashed.incarnationId;
    await crashed.worker.terminate();
    await waitUntil(() => db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: crashedId } }), j => j.status === 'queued' && j.attemptCount > 0);
    await waitUntil(async () => slots.some(s => s.incarnationId === incarnation), exists => !exists);
    for (const job of await db.traceDatasetGenerationJob.findMany()) await manager.remove('alice', job.datasetId);
    await waitUntil(() => db.traceDatasetGenerationJob.count(), count => count === 0);
    assert.equal(await db.agentEvalDataset.count(), 0);
    const unsafe = await manager.create('alice', { ...config, requestId: requestId() });
    const protectedPath = path.join(dir, 'protected');
    await mkdir(protectedPath); await writeFile(path.join(protectedPath, 'body'), 'keep');
    await symlink(protectedPath, manager.dir('alice', unsafe.jobId));
    const cleanup = await manager.remove('alice', unsafe.datasetId);
    assert.equal((await manager.deletion('alice', cleanup!.deletionId)).status, 'cleanup_failed');
    assert.equal(await readFile(path.join(protectedPath, 'body'), 'utf8'), 'keep');
    await unlink(manager.dir('alice', unsafe.jobId));
    await manager.remove('alice', unsafe.datasetId);
    assert.equal((await manager.deletion('alice', cleanup!.deletionId)).status, 'deleted');
    await manager.close();
    const retired: (Awaited<ReturnType<typeof manager.create>> & { replayConfig: typeof config & { description: string } })[] = [];
    const { validateConfig } = await import('../src/lib/trace-datasets/contracts');
    for (const kind of ['filesystem', 'transaction']) {
      const replayConfig = { ...config, description: '', name: `Retire ${kind}`, requestId: requestId() };
      const { requestId: rid, ...request } = validateConfig(replayConfig);
      const datasetId = randomUUID(), jobId = randomUUID();
      await db.agentEvalDataset.create({ data: { id: datasetId, user: 'alice', name: replayConfig.name, generationSource: 'trace', generationStatus: 'published', caseCount: 1, casesJson: '[{"input":"q","expectedOutput":"a"}]' } });
      await db.traceDatasetGenerationJob.create({ data: { id: jobId, datasetId, owner: 'alice', configJson: JSON.stringify(replayConfig), requestId: rid, requestHash: hash(request), status: 'succeeded', stage: 'complete', stageIndex: 6, generatedCount: 1, cleanupPending: false } });
      const folder = manager.dir('alice', jobId);
      if (kind === 'filesystem') await symlink(protectedPath, folder);
      else {
        await mkdir(folder); await writeFile(path.join(folder, 'result.json'), 'temporary');
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_retirement BEFORE DELETE ON TraceDatasetGenerationJob WHEN OLD.id='${jobId}' BEGIN SELECT RAISE(ABORT, 'simulate interrupted retirement'); END`);
      }
      retired.push({ datasetId, jobId, replayConfig });
    }
    manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), url, workerFile);
    await manager.start();
    await waitUntil(async () => {
      try { await access(manager.dir('alice', retired[1].jobId)); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    }, removed => removed);
    assert.equal(await db.traceDatasetGenerationJob.count({ where: { status: 'succeeded' } }), 2);
    assert.equal(await db.traceDatasetOperationReceipt.count({ where: { outcome: 'succeeded' } }), 0);
    assert.equal(await readFile(path.join(protectedPath, 'body'), 'utf8'), 'keep');
    await assert.rejects(access(manager.dir('alice', retired[1].jobId)));
    await manager.close();
    await unlink(manager.dir('alice', retired[0].jobId));
    await db.$executeRawUnsafe('DROP TRIGGER fail_retirement');
    manager = new TraceDatasetManager(db, path.join(dir, 'jobs'), url, workerFile);
    await manager.start();
    await waitUntil(() => db.traceDatasetGenerationJob.count({ where: { status: 'succeeded' } }), count => count === 0);
    for (const item of retired) {
      assert.deepEqual(await manager.create('alice', item.replayConfig), { datasetId: item.datasetId, jobId: item.jobId });
      const progress = await manager.progress('alice', item.datasetId);
      assert.equal(progress.status, 'published'); assert.equal(progress.generatedCount, 1);
      await assert.rejects(manager.progress('bob', item.datasetId), /未找到/);
      await assert.rejects(manager.releaseSummary('bob', item.datasetId), /未找到/);
      await manager.releaseSummary('alice', item.datasetId);
      await assert.rejects(manager.remove('alice', item.datasetId, true), /已生成完成/);
    }
    const expiredKey = requestId();
    await db.traceDatasetOperationReceipt.update({ where: { ownerKey_kind_operationKey: { ownerKey: '__system__', kind: 'clock', operationKey: 'clock-high-water' } }, data: { clockHighWaterMs: BigInt(Date.now() + 2 * 86400000) } });
    await assert.rejects(manager.create('alice', { ...config, requestId: expiredKey }), e => (e as {code: string}).code === 'REQUEST_EXPIRED');
    await waitUntil(async () => { await manager.tick(); return db.traceDatasetOperationReceipt.count({ where: { outcome: 'succeeded' } }); }, count => count === 0);
    for (const item of retired) {
      await assert.rejects(manager.create('alice', item.replayConfig), e => (e as { code: string }).code === 'REQUEST_EXPIRED');
      const progress = await manager.progress('alice', item.datasetId);
      assert.equal(progress.status, 'published'); assert.equal(progress.jobId, null);
      const deleted = await manager.remove('alice', item.datasetId);
      assert.equal((await manager.deletion('alice', deleted!.deletionId)).status, 'deleted');
      assert.equal(await manager.remove('alice', item.datasetId), null);
      assert.equal(await db.agentEvalDataset.findUnique({ where: { id: item.datasetId } }), null);
    }
    assert.ok(await db.traceDatasetOperationReceipt.count({ where: { ownerKey: hash('alice'), kind: 'delete' } }));
  } finally { await manager.close(); await db.$disconnect(); }
});

test('offline legacy summary removal preserves interrupted jobs and is idempotent', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trace-summary-removal-'));
  const url = `file:${dir}/test.db`;
  await writeFile(path.join(dir, 'test.db'), '');
  execFileSync('node', ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const { removeLegacySummary } = createRequire(import.meta.url)('../scripts/trace-datasets/remove-legacy-summary.cjs');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$executeRawUnsafe('ALTER TABLE TraceDatasetGenerationJob ADD COLUMN summaryJson TEXT');
    await db.$executeRawUnsafe(`INSERT INTO AgentEvalDataset (id,name,user,updatedAt) VALUES ('dataset','Existing','alice',CURRENT_TIMESTAMP)`);
    await db.$executeRawUnsafe(`INSERT INTO TraceDatasetGenerationJob (id,datasetId,owner,configJson,requestId,requestHash,status,summaryJson,updatedAt) VALUES ('job','dataset','alice','{}','old-request','hash','running','old summary',CURRENT_TIMESTAMP)`);
    assert.equal(await removeLegacySummary(url), true);
    assert.equal(await removeLegacySummary(url), false);
    const columns = await db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info(TraceDatasetGenerationJob)');
    assert.ok(!columns.some(c => c.name === 'summaryJson'));
    const job = await db.traceDatasetGenerationJob.findUniqueOrThrow({ where: { id: 'job' } });
    assert.equal(job.owner, 'alice'); assert.equal(job.requestId, 'old-request'); assert.equal(job.status, 'running');
    assert.equal(await db.agentEvalDataset.count(), 1);
  } finally { await db.$disconnect(); }
});
