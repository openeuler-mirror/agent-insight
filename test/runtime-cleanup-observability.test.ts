import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntimeCleanup } from '@/lib/runtime-cleanup';
import { readCleanupConfig, type CleanupEvent } from '@/lib/runtime-cleanup/policy';
import { startCleanupScheduler, type CleanupStatus } from '@/lib/runtime-cleanup/scheduler';

test('cleanup reports scheduled, one start, minute progress and complete with bounded reasons', async () => {
  let now = 0;
  let tick!: () => void;
  const statuses: CleanupStatus[] = [];
  const scheduler = startCleanupScheduler({
    config: { ...readCleanupConfig({}), maxSteps: 1 },
    clock: () => now,
    setTimer: callback => { tick = callback; return callback; }, clearTimer: () => {},
    onStatus: status => statuses.push(status),
    createSweep: async function* (): AsyncGenerator<CleanupEvent> {
      yield { kind: 'scanned', scannedBytes: 64 };
      yield { kind: 'deleted', bytes: 123 };
      yield { kind: 'skipped', reason: 'active-or-not-expired' };
      yield { kind: 'skipped', reason: '/secret/customer/trace.jsonl' };
      yield { kind: 'rotated' };
    },
  });
  assert.deepEqual(statuses.map(status => status.phase), ['scheduled']);
  tick(); await scheduler.idle();
  now = 59_999; tick(); await scheduler.idle();
  assert.deepEqual(statuses.map(status => status.phase), ['scheduled', 'sweep start']);
  now = 60_000; tick(); await scheduler.idle();
  assert.equal(statuses.at(-1)?.phase, 'sweep progress');
  now = 60_001; tick(); await scheduler.idle();
  now = 60_002; tick(); await scheduler.idle();
  now = 60_003; tick(); await scheduler.idle();
  assert.deepEqual(statuses.map(status => status.phase), ['scheduled', 'sweep start', 'sweep progress', 'sweep complete']);
  const complete = statuses.at(-1)!;
  assert.equal(complete.phase, 'sweep complete');
  if (complete.phase !== 'sweep complete') throw new Error('missing completion status');
  assert.deepEqual(complete, {
    phase: 'sweep complete', durationMs: 60_003, dryRun: false,
    scanned: 1, deleted: 1, rotated: 1, skipped: 2, freedBytes: 123, readBytes: 64,
    skipReasons: { 'active-or-not-expired': 1, other: 1 },
  });
  assert.equal(JSON.stringify(statuses).includes('/secret'), false);
  now = 3_660_003; tick(); await scheduler.idle();
  assert.equal(statuses.at(-1)?.phase, 'sweep start');
  await scheduler.stop();
});

test('disabled cleanup logs once and never schedules filesystem work', async () => {
  const statuses: CleanupStatus[] = [];
  let scheduled = 0;
  let opened = 0;
  const scheduler = startCleanupScheduler({
    config: readCleanupConfig({ AGENT_INSIGHT_CLEANUP_ENABLED: '0' }),
    createSweep: async function* () { opened++; },
    setTimer: () => { scheduled++; return undefined; }, clearTimer: () => {},
    onStatus: status => statuses.push(status),
  });
  assert.deepEqual(statuses, [{ phase: 'disabled', dryRun: false }]);
  assert.equal(scheduled, 0);
  assert.equal(opened, 0);
  await scheduler.stop();
});

test('throwing cleanup diagnostics do not interrupt deletion or later sweeps', async () => {
  let tick!: () => void;
  let cleaned = 0;
  const errors: unknown[] = [];
  const scheduler = startCleanupScheduler({
    config: readCleanupConfig({}),
    createSweep: async function* () { cleaned++; yield { kind: 'deleted' as const, bytes: 1 }; },
    setTimer: callback => { tick = callback; return callback; }, clearTimer: () => {},
    onStatus: () => { throw new Error('log output unavailable'); },
    onError: error => errors.push(error),
  });
  tick(); await scheduler.idle();
  tick(); await scheduler.idle();
  assert.equal(cleaned, 2);
  assert.deepEqual(errors, []);
  await scheduler.stop();
});

test('runtime registration prints the cleanup disabled status without opening a sweep', async () => {
  const key = Symbol.for('@agent-insight/runtime-cleanup');
  const shared = globalThis as unknown as Record<symbol, unknown>;
  const originalController = shared[key];
  const originalEnabled = process.env.AGENT_INSIGHT_CLEANUP_ENABLED;
  const originalInfo = console.info;
  const messages: unknown[][] = [];
  delete shared[key];
  process.env.AGENT_INSIGHT_CLEANUP_ENABLED = '0';
  console.info = (...args: unknown[]) => { messages.push(args); };
  try {
    const controller = startRuntimeCleanup();
    assert.ok(controller);
    assert.deepEqual(messages, [['[runtime-cleanup] disabled', { dryRun: false }]]);
    await controller.stop();
  } finally {
    console.info = originalInfo;
    if (originalEnabled === undefined) delete process.env.AGENT_INSIGHT_CLEANUP_ENABLED;
    else process.env.AGENT_INSIGHT_CLEANUP_ENABLED = originalEnabled;
    if (originalController === undefined) delete shared[key];
    else shared[key] = originalController;
  }
});
