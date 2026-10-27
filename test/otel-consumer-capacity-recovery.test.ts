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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getFileCursor, toCheckpointRelPath } from '@/lib/ingest/otel-consumer/checkpoint';
import { getOtelSpoolConsumerForTest, runOtelSpoolConsumerTick, startOtelSpoolConsumer, stopOtelSpoolConsumer } from '@/lib/ingest/otel-consumer/consumer';
import type { SpoolSource } from '@/lib/ingest/otel-consumer/sources';
import { acquireSpoolUse } from '@/lib/runtime-cleanup/spool-state';

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
}

function fixture(t: TestContext) {
  stopOtelSpoolConsumer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-capacity-recovery-'));
  t.after(() => {
    stopOtelSpoolConsumer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const files: string[] = [];
  const add = (sessionId: string) => {
    const file = path.join(root, '2026-09-28', 'sessions', sessionId, 'traces.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ sessionId })}\n`);
    files.push(file);
    return file;
  };
  const source: SpoolSource = {
    id: 'otel-traces',
    spoolDir: () => root,
    listFiles: () => files,
    aggregate: sessionId => ({
      sessionId,
      eventCount: 1,
      record: { task_id: sessionId, user: 'test-user', query: 'recovery', framework: 'test', final_result: 'done' },
      disposition: 'persisted',
    }),
    defaultSkipEvaluation: () => true,
  };
  return { root, add, source };
}

const options = {
  seedOnStart: false,
  shortMs: 5,
  longMs: 10,
  maxWaitMs: 15,
  tickMs: 5,
  parkedRetryMs: 20,
  aggCooldownFactor: 0,
  aggGlobalFactor: 0,
  log: () => {},
  warn: () => {},
};

test('OTel consumer resumes unchanged pending files after maintenance releases its lock', async t => {
  const { root, add, source } = fixture(t);
  const file = add('maintenance-delayed');
  acquireSpoolUse(root)!();
  const lock = path.join(root, '.retention-v1', 'maintenance.lock');
  fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: process.pid, token: 'active-maintenance' }));
  let saved = 0;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    saveExecution: async data => { saved += 1; return { success: true, record: data }; },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(saved, 0);
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, 0);
  fs.unlinkSync(lock);
  assert.ok(await waitUntil(() => saved > 0 && getOtelSpoolConsumerForTest()?.pendingFiles.size === 0),
    'a completed maintenance window must not leave an unchanged spool file permanently unscheduled');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, fs.statSync(file).size);
});

test('OTel consumer retries persistence failures below the parking threshold without new input', async t => {
  const { root, add, source } = fixture(t);
  const file = add('transient-save');
  let attempts = 0;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    parkAfter: 3,
    saveExecution: async data => {
      attempts += 1;
      if (attempts <= 2) throw new Error('temporarily unavailable');
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => attempts >= 3 && getOtelSpoolConsumerForTest()?.pendingFiles.size === 0),
    'two failures must not consume the only fast/evaluated due times and strand the pending file');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, fs.statSync(file).size);
});

test('OTel consumer does not let retry-later sessions permanently exhaust admission capacity', async t => {
  const { root, add, source } = fixture(t);
  const pending = add('a-pending');
  const ready = add('b-ready');
  const aggregate = source.aggregate;
  source.aggregate = sessionId => sessionId === 'a-pending'
    ? { sessionId, eventCount: 1, record: null, disposition: 'retry-later' }
    : aggregate(sessionId);
  const saved: string[] = [];
  const warnings: string[] = [];
  let maxTracked = 0;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    maxTrackedSessions: 1,
    warn: message => { warnings.push(String(message)); },
    saveExecution: async data => { saved.push(String(data.task_id)); return { success: true, record: data }; },
  });
  assert.ok(await waitUntil(() => {
    maxTracked = Math.max(maxTracked, getOtelSpoolConsumerForTest()?.sessions.size ?? 0);
    return saved.includes('b-ready') && getFileCursor(root, toCheckpointRelPath(root, ready)).bytes === fs.statSync(ready).size;
  }),
    'a non-persistable older session must not block every later session at the capacity limit');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, pending)).bytes, 0,
    'making admission capacity available must preserve the pending session for replay');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, ready)).bytes, fs.statSync(ready).size);
  assert.ok(maxTracked <= 1);
  assert.ok(warnings.filter(message => message.includes('session capacity')).length <= 1);
});

test('OTel consumer parked failures leave capacity for healthy sessions and replay after recovery', async t => {
  const { root, add, source } = fixture(t);
  const poisoned = add('a-poisoned');
  add('b-ready');
  let healthySaved = false;
  let poisonSaved = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    maxTrackedSessions: 1,
    parkAfter: 1,
    saveExecution: async data => {
      if (data.task_id === 'a-poisoned') {
        if (!healthySaved) throw new Error('blocked until the healthy session progresses');
        poisonSaved = true;
      } else healthySaved = true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => healthySaved && poisonSaved
    && getFileCursor(root, toCheckpointRelPath(root, poisoned)).bytes === fs.statSync(poisoned).size),
    'parking a failed session must free admission capacity without losing its retry');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, poisoned)).bytes, fs.statSync(poisoned).size);
});

test('OTel consumer defers mixed files only after healthy members have saved and keeps their evaluation due', async t => {
  const { root, add, source } = fixture(t);
  const file = add('a-pending');
  fs.appendFileSync(file, `${JSON.stringify({ sessionId: 'b-ready' })}\n`);
  const aggregate = source.aggregate;
  source.aggregate = sessionId => sessionId === 'a-pending'
    ? { sessionId, eventCount: 1, record: null, disposition: 'retry-later' }
    : aggregate(sessionId);
  let fastSaved = false;
  let evaluated = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    maxTrackedSessions: 2,
    longMs: 50,
    maxWaitMs: 100,
    parkedRetryMs: 5000,
    saveExecution: async data => {
      fastSaved ||= data.skip_evaluation === true;
      evaluated ||= data.force_judgment === true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => fastSaved && evaluated),
    'deferring a mixed file must neither starve another member nor drop its pending evaluation');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, 0);
});

test('OTel consumer retries failed evaluated writes in evaluated mode', async t => {
  const { add, source } = fixture(t);
  add('evaluated-retry');
  let fastCalls = 0;
  let evaluatedCalls = 0;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    longMs: 30,
    maxWaitMs: 60,
    saveExecution: async data => {
      if (data.force_judgment === true) {
        evaluatedCalls += 1;
        if (evaluatedCalls === 1) throw new Error('temporary evaluated write failure');
      } else fastCalls += 1;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => evaluatedCalls >= 2));
  assert.equal(fastCalls, 1);
});

test('OTel consumer summarizes saturated files once per minute instead of once per file and tick', async t => {
  const { add, source } = fixture(t);
  for (let index = 0; index < 10; index++) add(`session-${index}`);
  const warnings: string[] = [];
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    maxTrackedSessions: 1,
    shortMs: 10000,
    longMs: 10000,
    maxWaitMs: 10000,
    warn: message => { warnings.push(String(message)); },
  });
  const state = getOtelSpoolConsumerForTest()!;
  for (let index = 0; index < 10; index++) await runOtelSpoolConsumerTick(state);
  assert.equal(warnings.filter(message => message.includes('session capacity')).length, 1);
  assert.equal(state.sessions.size, 1);
});

test('OTel consumer does not acknowledge new bytes using an earlier member save', async t => {
  const { root, add, source } = fixture(t);
  const file = add('a-changing');
  fs.appendFileSync(file, `${JSON.stringify({ sessionId: 'b-blocked' })}\n`);
  let version = 'first';
  const aggregate = source.aggregate;
  source.aggregate = sessionId => {
    const result = aggregate(sessionId);
    return result.disposition === 'persisted' ? { ...result, record: { ...result.record, query: version } } : result;
  };
  let releaseBlocked!: () => void;
  const blocked = new Promise<void>(resolve => { releaseBlocked = resolve; });
  t.after(releaseBlocked);
  let blockedStarted = false;
  let updatedSaved = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    shortMs: 40,
    longMs: 100,
    maxWaitMs: 200,
    saveExecution: async data => {
      if (data.task_id === 'b-blocked') { blockedStarted = true; await blocked; }
      if (data.task_id === 'a-changing' && data.query === 'second') updatedSaved = true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => blockedStarted));
  version = 'second';
  fs.appendFileSync(file, `${JSON.stringify({ sessionId: 'a-changing' })}\n`);
  await runOtelSpoolConsumerTick(getOtelSpoolConsumerForTest()!);
  releaseBlocked();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, 0,
    'the saved first snapshot must not acknowledge the changed member before its second save');
  assert.ok(await waitUntil(() => updatedSaved
    && getFileCursor(root, toCheckpointRelPath(root, file)).bytes === fs.statSync(file).size));
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, fs.statSync(file).size);
});

test('OTel consumer keeps replayable evaluated work when maintenance blocks after the fast save', async t => {
  const { root, add, source } = fixture(t);
  const file = add('evaluated-maintenance');
  const lock = path.join(root, '.retention-v1', 'maintenance.lock');
  let evaluated = false;
  let fastSaved = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    longMs: 100000,
    maxWaitMs: 100000,
    saveExecution: async data => {
      if (data.skip_evaluation === true) {
        if (!fastSaved) fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: process.pid, token: 'active-maintenance' }));
        fastSaved = true;
        getOtelSpoolConsumerForTest()!.sessions.get(String(data.task_id))!.evaluatedDueAt = Date.now();
      } else evaluated = true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => fastSaved));
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  fs.unlinkSync(lock);
  assert.ok(await waitUntil(() => evaluated),
    'fast work still needs its evaluated phase after maintenance finishes');
});

test('OTel consumer keeps evaluated work when aggregation temporarily returns retry-later', async t => {
  const { add, source } = fixture(t);
  add('evaluated-pending');
  const aggregate = source.aggregate;
  let fastSaved = false;
  let allowEvaluated = false;
  let evaluated = false;
  source.aggregate = sessionId => fastSaved && !allowEvaluated
    ? { sessionId, eventCount: 1, record: null, disposition: 'retry-later' }
    : aggregate(sessionId);
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    longMs: 100000,
    maxWaitMs: 100000,
    saveExecution: async data => {
      if (data.skip_evaluation === true) {
        fastSaved = true;
        getOtelSpoolConsumerForTest()!.sessions.get(String(data.task_id))!.evaluatedDueAt = Date.now();
      }
      else evaluated = true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => fastSaved));
  await new Promise(resolve => setTimeout(resolve, 60));
  allowEvaluated = true;
  assert.ok(await waitUntil(() => evaluated));
});

test('OTel consumer parked evaluated work replays and finishes evaluation', async t => {
  const { add, source } = fixture(t);
  add('parked-evaluated');
  let fastCalls = 0;
  let evaluatedCalls = 0;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    parkAfter: 1,
    longMs: 30,
    maxWaitMs: 60,
    saveExecution: async data => {
      if (data.force_judgment === true) {
        evaluatedCalls += 1;
        if (evaluatedCalls === 1) throw new Error('temporary evaluated write failure');
      } else fastCalls += 1;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => evaluatedCalls >= 2));
  assert.ok(fastCalls >= 1);
});

for (const mode of ['fast', 'evaluated'] as const) {
  test(`OTel consumer ${mode} save only acknowledges the session generation it aggregated`, async t => {
    const { root, add, source } = fixture(t);
    const file = add('changing-during-save');
    let version = 'first';
    const aggregate = source.aggregate;
    source.aggregate = sessionId => {
      const result = aggregate(sessionId);
      return result.disposition === 'persisted' ? { ...result, record: { ...result.record, query: version } } : result;
    };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    t.after(() => { releaseFirst(); releaseSecond(); });
    const snapshots: string[] = [];
    startOtelSpoolConsumer({
      ...options,
      sources: [source],
      shortMs: mode === 'fast' ? 5 : 10000,
      longMs: mode === 'evaluated' ? 5 : 50,
      maxWaitMs: 10000,
      saveExecution: async data => {
        snapshots.push(String(data.query));
        await (snapshots.length === 1 ? first : second);
        return { success: true, record: data };
      },
    });
    assert.ok(await waitUntil(() => snapshots.length === 1));
    version = 'second';
    fs.appendFileSync(file, `${JSON.stringify({ sessionId: 'changing-during-save' })}\n`);
    await runOtelSpoolConsumerTick(getOtelSpoolConsumerForTest()!);
    releaseFirst();
    assert.ok(await waitUntil(() => snapshots.length === 2));
    assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, 0,
      'finishing the old save must not confirm bytes received while that save was in flight');
    assert.deepEqual(snapshots, ['first', 'second']);
    releaseSecond();
    assert.ok(await waitUntil(() => getFileCursor(root, toCheckpointRelPath(root, file)).bytes === fs.statSync(file).size));
  });
}

test('OTel consumer does not evict an in-flight evaluated session when other sessions arrive', async t => {
  const { root, add, source } = fixture(t);
  const file = add('active-session');
  let version = 'first';
  const aggregate = source.aggregate;
  source.aggregate = sessionId => {
    const result = aggregate(sessionId);
    return result.disposition === 'persisted' ? { ...result, record: { ...result.record, query: version } } : result;
  };
  let releaseEvaluated!: () => void;
  const blocked = new Promise<void>(resolve => { releaseEvaluated = resolve; });
  t.after(releaseEvaluated);
  let evaluatedStarted = false;
  let updatedSaved = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    longMs: 20,
    maxWaitMs: 40,
    saveExecution: async data => {
      if (data.task_id === 'active-session' && data.query === 'first' && data.force_judgment === true) {
        evaluatedStarted = true;
        await blocked;
      }
      if (data.task_id === 'active-session' && data.query === 'second') updatedSaved = true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => evaluatedStarted));
  add('new-session');
  await runOtelSpoolConsumerTick(getOtelSpoolConsumerForTest()!);
  version = 'second';
  fs.appendFileSync(file, `${JSON.stringify({ sessionId: 'active-session' })}\n`);
  await runOtelSpoolConsumerTick(getOtelSpoolConsumerForTest()!);
  releaseEvaluated();
  assert.ok(await waitUntil(() => updatedSaved
    && getFileCursor(root, toCheckpointRelPath(root, file)).bytes === fs.statSync(file).size),
    'arrival of other sessions must not orphan new input for the session whose old save is in flight');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, file)).bytes, fs.statSync(file).size);
});

test('OTel consumer permanently failing evaluated work does not block healthy sessions at capacity', async t => {
  const { root, add, source } = fixture(t);
  const failed = add('a-evaluation-failure');
  const healthy = add('b-healthy');
  let healthyEvaluated = false;
  let failedFastSaved = false;
  startOtelSpoolConsumer({
    ...options,
    sources: [source],
    shortMs: 5,
    longMs: 20,
    maxWaitMs: 40,
    maxTrackedSessions: 1,
    parkAfter: 1,
    saveExecution: async data => {
      if (data.task_id === 'a-evaluation-failure') {
        if (data.force_judgment === true) throw new Error('evaluation persistence remains unavailable');
        failedFastSaved = true;
      } else healthyEvaluated ||= data.force_judgment === true;
      return { success: true, record: data };
    },
  });
  assert.ok(await waitUntil(() => failedFastSaved && healthyEvaluated),
    'a failed evaluated phase must retain durable replay but release capacity for healthy work');
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, failed)).bytes, 0);
  assert.equal(getFileCursor(root, toCheckpointRelPath(root, healthy)).bytes, fs.statSync(healthy).size);
  assert.ok((getOtelSpoolConsumerForTest()?.sessions.size ?? 0) <= 1);
});
