import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/storage/prisma';
import { GenerationError } from '../src/lib/trace-datasets/contracts';
import { generationErrorResponse } from '../src/server/trace-datasets/http';
import { getTraceDatasetManager, startTraceDatasetManager, TraceDatasetManager } from '../src/server/trace-datasets/manager';

const runtime = globalThis as typeof globalThis & {
  traceDatasetManager?: TraceDatasetManager;
  traceDatasetStartup?: { ready: boolean; pending?: Promise<void>; error?: GenerationError; retryAt: number };
};

test('background generator initialization gates concurrent requests and recovers after failure', async t => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'file:/tmp/trace-startup-unused.db';
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  t.mock.method(db, 'getClient', () => client);
  t.mock.method(console, 'warn', () => {});
  const originalManager = runtime.traceDatasetManager, originalStartup = runtime.traceDatasetStartup;
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const listeners = signals.map(signal => new Set(process.listeners(signal)));
  t.after(async () => {
    runtime.traceDatasetManager = originalManager; runtime.traceDatasetStartup = originalStartup;
    signals.forEach((signal, i) => {
      for (const listener of process.listeners(signal)) if (!listeners[i].has(listener)) process.removeListener(signal, listener);
    });
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    await client.$disconnect();
  });

  await t.test('startup returns immediately, concurrent API calls get 503, and all reuse one ready manager', async t => {
    runtime.traceDatasetManager = undefined; runtime.traceDatasetStartup = undefined;
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const start = t.mock.method(TraceDatasetManager.prototype, 'start', () => barrier);
    assert.equal(startTraceDatasetManager(), undefined);
    const pending = runtime.traceDatasetStartup!.pending;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => getTraceDatasetManager()));
    assert.equal(start.mock.callCount(), 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status !== 'rejected') continue;
      assert.equal(result.reason.code, 'FEATURE_INITIALIZING');
      const response = generationErrorResponse(result.reason);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Retry-After'), '2');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await response.json()).error.code, 'FEATURE_INITIALIZING');
    }
    finish(); await pending;
    const ready = await getTraceDatasetManager();
    assert.equal(await getTraceDatasetManager(), ready);
    startTraceDatasetManager();
    assert.equal(start.mock.callCount(), 1);
  });

  await t.test('a failed initialization settles safely, throttles retries and can recover', async t => {
    runtime.traceDatasetManager = undefined; runtime.traceDatasetStartup = undefined;
    let now = 100000, fail = true;
    t.mock.method(Date, 'now', () => now);
    const before = signals.map(signal => process.listenerCount(signal));
    const start = t.mock.method(TraceDatasetManager.prototype, 'start', async () => { if (fail) throw new Error('missing worker'); });
    startTraceDatasetManager();
    await runtime.traceDatasetStartup!.pending;
    assert.equal(runtime.traceDatasetManager, undefined);
    assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
    for (let i = 0; i < 10; i++) {
      await assert.rejects(getTraceDatasetManager(), (error: GenerationError) => {
        assert.equal(error.code, 'FEATURE_UNAVAILABLE');
        const response = generationErrorResponse(error);
        assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '30');
        return true;
      });
    }
    assert.equal(start.mock.callCount(), 1);
    now += 30001; fail = false;
    await assert.rejects(getTraceDatasetManager(), (error: GenerationError) => error.code === 'FEATURE_INITIALIZING');
    await runtime.traceDatasetStartup!.pending;
    assert.ok(await getTraceDatasetManager());
    assert.equal(start.mock.callCount(), 2);
  });

  await t.test('unsupported storage is unavailable without starting workers', async t => {
    runtime.traceDatasetManager = undefined; runtime.traceDatasetStartup = undefined;
    process.env.DATABASE_URL = 'postgresql://unused.invalid/test';
    const start = t.mock.method(TraceDatasetManager.prototype, 'start', async () => {});
    startTraceDatasetManager(); await runtime.traceDatasetStartup!.pending;
    await assert.rejects(getTraceDatasetManager(), (error: GenerationError) => error.code === 'FEATURE_UNAVAILABLE' && error.message.includes('SQLite'));
    assert.equal(start.mock.callCount(), 0);
  });
});
