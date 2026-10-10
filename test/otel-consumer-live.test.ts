import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { appendJsonlBySession, currentSpoolDay, readEventsForSession } from '@/lib/ingest/claude-otel/spool';
import { getOtelSpoolConsumerForTest, startOtelSpoolConsumer, stopOtelSpoolConsumer } from '@/lib/ingest/otel-consumer/consumer';
import type { SpoolSource } from '@/lib/ingest/otel-consumer/sources';
import { LiveSpoolDiscovery, liveScanDays } from '@/lib/ingest/otel-consumer/live-discovery';
import { LiveRowParser } from '@/lib/ingest/otel-consumer/live-row';
import { noteSpoolReceived } from '@/lib/runtime-cleanup/spool-state';

async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'condition was not reached');
}

function fixture(t: TestContext) {
  stopOtelSpoolConsumer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-live-'));
  t.after(() => { stopOtelSpoolConsumer(); fs.rmSync(root, { recursive: true, force: true }); });
  let fullScans = 0;
  const files: string[] = [];
  const source: SpoolSource = {
    id: 'otel-traces', spoolDir: () => root, fileName: 'traces.jsonl',
    listFiles: () => { fullScans += 1; return files; },
    aggregate: sessionId => ({
      sessionId, eventCount: 1, disposition: 'persisted',
      record: { task_id: sessionId, user: 'test-user', framework: 'test',
        query: readEventsForSession<{ sessionId: string; marker?: string }>(root, 'traces.jsonl', sessionId).map(event => event.marker).join(','),
        final_result: 'done' },
    }),
    defaultSkipEvaluation: () => true,
  };
  const append = (sessionId: string, marker: string, receivedAt = new Date().toISOString()) => {
    appendJsonlBySession(root, 'traces.jsonl', [{ sessionId, marker, receivedAt }]);
    const file = path.join(root, currentSpoolDay(), 'sessions', sessionId, 'traces.jsonl');
    if (!files.includes(file)) files.push(file);
    return file;
  };
  const old = (sessionId: string) => {
    const file = path.join(root, currentSpoolDay(), 'sessions', sessionId, 'traces.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId, marker: 'old', receivedAt: '2000-01-01T00:00:00.000Z' }) + '\n');
    files.push(file);
    noteSpoolReceived(root, sessionId, Date.parse('2000-01-01T00:00:00.000Z'));
    fs.utimesSync(file, 946684800, 946684800);
    return file;
  };
  return { root, source, files, append, old, fullScans: () => fullScans };
}

const timing = { shortMs: 5, longMs: 20, maxWaitMs: 40, tickMs: 5, aggCooldownFactor: 0, aggGlobalFactor: 0, log: () => {}, warn: () => {} };

test('live is the default and starts without listing or consuming static historical files', async t => {
  const f = fixture(t);
  f.old('old-only');
  fs.writeFileSync(path.join(f.root, 'consumer-checkpoint.json'), JSON.stringify({ version: 1, files: {} }));
  let saves = 0;
  startOtelSpoolConsumer({ ...timing, sources: [f.source], saveExecution: async record => { saves += 1; return { success: true, record }; } });
  assert.equal(f.fullScans(), 0, 'startup must not synchronously enumerate the historical spool');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(saves, 0);
  assert.equal(getOtelSpoolConsumerForTest()?.sessions.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'consumer-checkpoint.json'), 'utf8')).files, {});
});

test('live receives an immediate new append and keeps old fragments of the same session', async t => {
  const f = fixture(t);
  f.old('continued');
  f.old('static-other');
  const saved: Array<{ id: string; query: string }> = [];
  startOtelSpoolConsumer({ ...timing, startMode: 'live', sources: [f.source], saveExecution: async record => {
    saved.push({ id: String(record.task_id), query: String(record.query) }); return { success: true, record };
  } });
  f.append('continued', 'new');
  f.append('brand-new', 'new');
  await until(() => saved.some(record => record.id === 'continued') && saved.some(record => record.id === 'brand-new'));
  assert.ok(saved.some(record => record.id === 'continued' && record.query === 'old,new'));
  assert.ok(saved.every(record => record.id !== 'static-other'));
  assert.equal(f.fullScans(), 0);
});

test('live scans changed legacy mixed files without waking their old sessions', async t => {
  const f = fixture(t);
  const file = path.join(f.root, currentSpoolDay(), 'traces.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'legacy-old', receivedAt: '2000-01-01T00:00:00Z' }) + '\n');
  f.files.push(file);
  const saved: string[] = [];
  startOtelSpoolConsumer({ ...timing, startMode: 'live', sources: [f.source], saveExecution: async record => {
    saved.push(String(record.task_id)); return { success: true, record };
  } });
  fs.appendFileSync(file, JSON.stringify({ sessionId: 'legacy-new', receivedAt: new Date().toISOString() }) + '\n');
  await until(() => saved.includes('legacy-new'));
  assert.ok(saved.every(sessionId => sessionId === 'legacy-new'));
});

test('explicit resume consumes surviving historical data even when no checkpoint exists', async t => {
  const f = fixture(t);
  f.old('old-resumed');
  const saved: string[] = [];
  startOtelSpoolConsumer({ ...timing, startMode: 'resume', sources: [f.source], saveExecution: async record => {
    saved.push(String(record.task_id)); return { success: true, record };
  } });
  await until(() => saved.includes('old-resumed'));
});


test('streaming routing parser preserves escaped UTF-8 fields after a large nested payload', () => {
  const parser = new LiveRowParser();
  const receivedAt = new Date().toISOString();
  const sessionId = '中文😀"\\';
  const row = Buffer.from(JSON.stringify({ payload: { sessionId: 'nested-wrong', receivedAt: '2000-01-01', body: 'x'.repeat(2 * 1024 * 1024) }, sessionId, receivedAt }));
  for (const byte of row) parser.push(byte);
  assert.deepEqual(parser.finish(), { sessionId, receivedAt: Date.parse(receivedAt) });
  assert.ok(JSON.stringify(parser).length < 1000, 'payload is never retained in parser memory');
});

test('live discovery traverses all receiving days since startup across multiple midnights', () => {
  const days = [...liveScanDays(new Date(2026, 9, 1, 23, 59).getTime(), new Date(2026, 9, 4, 0, 1).getTime())];
  assert.deepEqual(days, ['2026-10-04', '2026-10-01', '2026-10-02', '2026-10-03']);
});

test('bounded notice overflow is recovered from receipts while a failing session frees capacity', async t => {
  const f = fixture(t);
  const aggregate = f.source.aggregate;
  f.source.aggregate = id => id === 'poison' ? { sessionId: id, record: null, disposition: 'retry-later', eventCount: 1 } : aggregate(id);
  const saved: string[] = [];
  startOtelSpoolConsumer({ ...timing, startMode: 'live', maxTrackedSessions: 1, parkedRetryMs: 100000, sources: [f.source], saveExecution: async record => {
    saved.push(String(record.task_id)); return { success: true, record };
  } });
  f.append('poison', 'new');
  f.append('healthy-overflow', 'new');
  await until(() => saved.includes('healthy-overflow'));
  assert.ok(getOtelSpoolConsumerForTest()!.sessions.size <= 1);
  assert.ok(getOtelSpoolConsumerForTest()!.deferredFiles.size <= 1);
});

test('five receiptless large files progress beyond a chunk without evicting unfinished readers', async t => {
  const f = fixture(t);
  const cutoff = Date.now() - 10;
  for (let index = 0; index < 5; index++) {
    const file = path.join(f.root, currentSpoolDay(), 'sessions', `large-${index}`, 'traces.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'old', receivedAt: '2000-01-01', payload: 'x'.repeat(160000) }) + '\n'
      + JSON.stringify({ payload: 'y'.repeat(80000), sessionId: `large-${index}`, receivedAt: new Date().toISOString() }) + '\n');
  }
  const found = new Set<string>();
  const discovery = new LiveSpoolDiscovery([f.source], cutoff, 10, (_, id) => { found.add(id); return true; });
  t.after(() => discovery.stop());
  for (let tick = 0; tick < 100 && found.size < 5; tick++) await discovery.tick();
  assert.deepEqual([...found].sort(), ['large-0', 'large-1', 'large-2', 'large-3', 'large-4']);
});

test('receipt fallback finds overflow data after two midnights and ignores unrelated roots', async t => {
  const f = fixture(t);
  const cutoff = new Date(2026, 9, 1, 23, 58).getTime();
  const receivedAt = new Date(2026, 9, 1, 23, 59).getTime();
  const file = path.join(f.root, '2026-10-01', 'sessions', 'overflow', 'traces.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  noteSpoolReceived(f.root, 'overflow', receivedAt);
  const found: string[] = [];
  const discovery = new LiveSpoolDiscovery([f.source], cutoff, 1, (_, id) => { found.push(id); return true; }, () => new Date(2026, 9, 4, 0, 1).getTime());
  t.after(() => discovery.stop());
  discovery.receive({ root: path.join(f.root, 'unrelated'), sessionId: 'foreign', receivedAt });
  for (let tick = 0; tick < 10 && !found.includes('overflow'); tick++) await discovery.tick();
  assert.ok(found.includes('overflow'));
  assert.ok(!found.includes('foreign'));
});

test('stopping live consumer removes the receipt listener and prevents later appends from scheduling', async t => {
  const f = fixture(t);
  let saves = 0;
  startOtelSpoolConsumer({ ...timing, startMode: 'live', sources: [f.source], saveExecution: async record => { saves++; return { success: true, record }; } });
  const state = getOtelSpoolConsumerForTest()!;
  stopOtelSpoolConsumer();
  f.append('after-stop', 'new');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(globalThis.__otelLiveReceiptListener, undefined);
  assert.equal(state.sessions.size, 0);
  assert.equal(saves, 0);
});


test('streaming routing rejects extra roots and honors duplicate fields whose last value is not a string', () => {
  const valid = JSON.stringify({ sessionId: 'old-session', receivedAt: new Date().toISOString() });
  for (const row of ['garbage' + valid, valid + valid, '[' + valid + ']', valid.slice(0, -1) + ',"sessionId":null}', valid.slice(0, -1) + ',"receivedAt":{"value":"wrong"}}']) {
    const parser = new LiveRowParser();
    for (const byte of Buffer.from(row)) parser.push(byte);
    assert.equal(parser.finish(), undefined, row);
  }
});
