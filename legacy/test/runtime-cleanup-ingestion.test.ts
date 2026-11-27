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
import test from 'node:test';
import { appendJsonlBySession, appendOtelTraceEvents, listJsonlSpoolFiles } from '@/lib/ingest/claude-otel/spool';
import type { OtelTraceEvent } from '@/lib/ingest/claude-otel/types';
import { forgetOtelSpoolFile, getOtelSpoolConsumerForTest, startOtelSpoolConsumer, stopOtelSpoolConsumer } from '@/lib/ingest/otel-consumer/consumer';
import type { SpoolSource } from '@/lib/ingest/otel-consumer/sources';
import { getFileCursor, toCheckpointRelPath } from '@/lib/ingest/otel-consumer/checkpoint';
import type { ExecutionRecord } from '@/lib/storage/data-service';
import { appendJiuwenSpans, readJiuwenSessionIndex } from '@/lib/ingest/otel/jiuwen/spool';
import { markSpoolPurged, readSpoolState, trySpoolMaintenance } from '@/lib/runtime-cleanup/spool-state';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'condition was not reached');
}

function source(root: string, sessionId: string): SpoolSource {
  return {
    id: 'cleanup-integration', spoolDir: () => root,
    listFiles: () => listJsonlSpoolFiles(root), defaultSkipEvaluation: () => true,
    aggregate: () => ({ sessionId, eventCount: 1, disposition: 'persisted', record: {
      task_id: sessionId, user: 'alice', framework: 'test', query: 'run', final_result: 'done',
      trace_completed_at: new Date().toISOString(),
    } }),
  };
}

test('spool receive receipts only advance for actually appended trace events', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-receive-'));
  const root = path.join(temporary, 'new', 'spool');
  try {
    const event: OtelTraceEvent = { sessionId: 'goal-plus:test', traceId: 'trace', spanId: 'span', user: 'alice', framework: 'pi-agent',
      name: 'agent.pi-agent', kind: 'agent', serviceName: 'pi-agent', latencyMs: 0, startTimeMs: 1000,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      attributes: { 'agent.insight.event_id': 'event' }, receivedAt: '2026-09-30T00:00:00Z' };
    appendOtelTraceEvents([event], root);
    const first = readSpoolState(root, event.sessionId);
    assert.ok(first?.generation);
    const duplicate = appendOtelTraceEvents([{ ...event, receivedAt: '2026-10-01T00:00:00Z' }], root);
    assert.equal(duplicate.deduplicatedEvents, 1);
    assert.deepEqual(readSpoolState(root, event.sessionId), first);
    appendOtelTraceEvents([{ ...event, attributes: { ...event.attributes, outcome: 'changed' } }], root);
    assert.notEqual(readSpoolState(root, event.sessionId)?.generation, first.generation);
    assert.equal(listJsonlSpoolFiles(root).length, 1);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('consumer protects an awaited save and confirms only its received generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-consumer-'));
  stopOtelSpoolConsumer();
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let entered = false;
  try {
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session' }]);
    startOtelSpoolConsumer({ sources: [source(root, 'session')], seedOnStart: false,
      shortMs: 100000, tickMs: 10000, longMs: 1, maxWaitMs: 1, log: () => {}, warn: () => {},
      saveExecution: async record => { entered = true; await waiting; return { success: true, record }; },
    });
    await waitFor(() => entered);
    assert.equal(trySpoolMaintenance(root, () => true), undefined);
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session', late: true }]);
    const incoming = readSpoolState(root, 'session');
    finish();
    await waitFor(() => !getOtelSpoolConsumerForTest()?.dispatching);
    assert.equal(readSpoolState(root, 'session')?.generation, incoming?.generation);
    assert.equal(readSpoolState(root, 'session')?.status, 'unknown');
    assert.equal(trySpoolMaintenance(root, () => true), true);
  } finally { finish(); stopOtelSpoolConsumer(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Jiuwen first batch initializes bucket and shared activity receipts without stitching ACP runs', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-jiuwen-'));
  const root = path.join(temporary, 'new', 'spool');
  const previous = process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR;
  process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR = root;
  try {
    appendJiuwenSpans([{ traceId: 'first', spanId: 'span', name: 'agent.step', attrs: { 'agentteam.session.id': 'acp_cli_session' }, startNs: 1, endNs: 2 }]);
    assert.ok(readSpoolState(root, 'first')?.generation);
    assert.ok(readSpoolState(root, 'session:acp_cli_session')?.generation);
    assert.equal(readJiuwenSessionIndex().multiTraceSessions.has('acp_cli_session'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR;
    else process.env.AGENT_INSIGHT_JIUWEN_SPOOL_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('consumer records successful persistence and skips late snapshots after purge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-persist-'));
  stopOtelSpoolConsumer();
  let saves = 0;
  try {
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session' }]);
    const options = { sources: [source(root, 'session')], seedOnStart: false,
      shortMs: 1, tickMs: 5, longMs: 20, maxWaitMs: 40, log: () => {}, warn: () => {},
      saveExecution: async (record: any) => { saves++; return { success: true, record }; },
    };
    startOtelSpoolConsumer(options);
    await waitFor(() => readSpoolState(root, 'session')?.status === 'success');
    const initialSaves = saves;
    assert.ok(initialSaves > 0);
    stopOtelSpoolConsumer();
    markSpoolPurged(root, 'session');
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session', late: true }]);
    startOtelSpoolConsumer(options);
    await waitFor(() => getOtelSpoolConsumerForTest()?.pendingFiles.size === 0);
    assert.equal(saves, initialSaves);
    assert.ok(readSpoolState(root, 'session')?.purgedAt);
  } finally { stopOtelSpoolConsumer(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('fast saves remain visible and replayable across restart until evaluated confirms cleanup eligibility', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-fast-replay-'));
  stopOtelSpoolConsumer();
  let fastSaved = false;
  let evaluatedSaved = false;
  try {
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session' }]);
    const file = listJsonlSpoolFiles(root)[0];
    const relPath = toCheckpointRelPath(root, file);
    const options = {
      sources: [source(root, 'session')], seedOnStart: false, tickMs: 5,
      log: () => {}, warn: () => {},
      saveExecution: async (record: ExecutionRecord) => {
        fastSaved ||= record.skip_evaluation === true;
        evaluatedSaved ||= record.force_judgment === true;
        return { success: true, record };
      },
    };
    startOtelSpoolConsumer({ ...options, shortMs: 1, longMs: 100000, maxWaitMs: 100000 });
    await waitFor(() => fastSaved);
    assert.equal(evaluatedSaved, false);
    assert.equal(getFileCursor(root, relPath).bytes, 0);
    assert.equal(readSpoolState(root, 'session')?.status, 'unknown');
    stopOtelSpoolConsumer();

    startOtelSpoolConsumer({ ...options, shortMs: 100000, longMs: 1, maxWaitMs: 1 });
    await waitFor(() => evaluatedSaved && readSpoolState(root, 'session')?.status === 'success');
    assert.equal(getFileCursor(root, relPath).bytes, fs.statSync(file).size);
  } finally { stopOtelSpoolConsumer(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('deleted abandoned spool releases deferred consumer bookkeeping', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-forget-'));
  stopOtelSpoolConsumer();
  try {
    appendJsonlBySession(root, 'logs.jsonl', [{ sessionId: 'session' }]);
    startOtelSpoolConsumer({ sources: [source(root, 'session')], seedOnStart: false,
      shortMs: 1, tickMs: 10000, longMs: 100000, maxWaitMs: 100000, parkAfter: 1,
      log: () => {}, warn: () => {}, saveExecution: async record => ({ success: false, record }),
    });
    await waitFor(() => getOtelSpoolConsumerForTest()?.deferredFiles.size === 1);
    assert.equal(readSpoolState(root, 'session')?.status, 'unknown');
    assert.equal(getOtelSpoolConsumerForTest()?.pendingFiles.size, 0);
    assert.equal(getOtelSpoolConsumerForTest()?.sessions.size, 0);
    const file = listJsonlSpoolFiles(root)[0];
    const canonicalFile = fs.realpathSync(file);
    fs.unlinkSync(file);
    forgetOtelSpoolFile(root, canonicalFile);
    assert.equal(getOtelSpoolConsumerForTest()?.deferredFiles.size, 0);
    assert.equal(getOtelSpoolConsumerForTest()?.pendingFiles.size, 0);
    assert.equal(getOtelSpoolConsumerForTest()?.sessions.size, 0);
  } finally { stopOtelSpoolConsumer(); fs.rmSync(root, { recursive: true, force: true }); }
});
