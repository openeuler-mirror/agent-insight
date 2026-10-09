import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupEligibility, DAY_MS, readCleanupConfig } from '@/lib/runtime-cleanup/policy';
import { roundRobin, runCleanupSlice, startCleanupScheduler } from '@/lib/runtime-cleanup/scheduler';

test('cleanup uses last receive time, success 7d and abnormal 14d; activity wins', () => {
  const now = 100 * DAY_MS;
  const state = { status: 'success' as const, completedAt: now - 8 * DAY_MS, lastReceivedAt: now - 8 * DAY_MS };
  assert.equal(cleanupEligibility(state, now).eligible, true);
  assert.equal(cleanupEligibility({ ...state, lastReceivedAt: now - DAY_MS }, now).eligible, false);
  assert.equal(cleanupEligibility({ ...state, status: 'failed' }, now).eligible, false);
  assert.equal(cleanupEligibility({ ...state, status: 'failed', lastReceivedAt: now - 14 * DAY_MS }, now).eligible, true);
  assert.equal(cleanupEligibility({ status: 'running', lastReceivedAt: now - 13 * DAY_MS }, now).eligible, false);
  assert.equal(cleanupEligibility({ status: 'running', lastReceivedAt: now - 14 * DAY_MS }, now).reason, 'inactive');
  assert.equal(cleanupEligibility({ ...state, busy: true }, now).eligible, false);
  assert.equal(cleanupEligibility({ ...state, lastReceivedAt: NaN }, now).eligible, false);
});

test('configuration rejects invalid values and caps cleanup resource budgets', () => {
  const c = readCleanupConfig({ AGENT_INSIGHT_CLEANUP_MAX_STEPS: '10000000', AGENT_INSIGHT_CLEANUP_SLICE_MS: '-1' });
  assert.equal(c.maxSteps, 1000);
  assert.equal(c.sliceMs, 50);
  assert.equal(c.startupDelayMs, 60_000);
});

test('cleanup retention, rotation, file limits and read budgets can be configured together', () => {
  const c = readCleanupConfig({
    AGENT_INSIGHT_CLEANUP_ENABLED: 'false', AGENT_INSIGHT_CLEANUP_DRY_RUN: 'true',
    AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS: '10', AGENT_INSIGHT_CLEANUP_ABNORMAL_DAYS: '21',
    AGENT_INSIGHT_CLEANUP_MAX_READ_BYTES: '2097152',
    AGENT_INSIGHT_CLEANUP_LOG_RETENTION_DAYS: '30', AGENT_INSIGHT_CLEANUP_LOG_ROTATE_HOURS: '12',
    AGENT_INSIGHT_CLEANUP_LOG_MAX_FILE_BYTES: '10485760', AGENT_INSIGHT_CLEANUP_LOG_MAX_TOTAL_BYTES: '104857600',
    AGENT_INSIGHT_CLEANUP_TEMP_RETENTION_HOURS: '48',
  });
  assert.equal(c.enabled, false); assert.equal(c.dryRun, true);
  assert.equal(c.normalDays, 10); assert.equal(c.abnormalDays, 21);
  assert.equal(c.maxReadBytes, 2097152);
  assert.equal(c.logRetentionDays, 30); assert.equal(c.logRotateMs, 12 * 3600_000);
  assert.equal(c.logMaxFileBytes, 10485760); assert.equal(c.logMaxTotalBytes, 104857600);
  assert.equal(c.temporaryHomeRetentionMs, 48 * 3600_000);
});

test('invalid cleanup settings fall back safely and related limits stay consistent', () => {
  const c = readCleanupConfig({
    AGENT_INSIGHT_CLEANUP_ENABLED: 'invalid', AGENT_INSIGHT_CLEANUP_DRY_RUN: 'invalid',
    AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS: '21', AGENT_INSIGHT_CLEANUP_ABNORMAL_DAYS: '7',
    AGENT_INSIGHT_CLEANUP_MAX_READ_BYTES: '0', AGENT_INSIGHT_CLEANUP_LOG_RETENTION_DAYS: 'NaN',
    AGENT_INSIGHT_CLEANUP_LOG_ROTATE_HOURS: '-1', AGENT_INSIGHT_CLEANUP_LOG_MAX_FILE_BYTES: '10485760',
    AGENT_INSIGHT_CLEANUP_LOG_MAX_TOTAL_BYTES: '1048576', AGENT_INSIGHT_CLEANUP_TEMP_RETENTION_HOURS: 'Infinity',
  });
  assert.equal(c.enabled, true); assert.equal(c.dryRun, false);
  assert.equal(c.abnormalDays, 21); assert.equal(c.maxReadBytes, 1048576);
  assert.equal(c.logRetentionDays, 14); assert.equal(c.logRotateMs, DAY_MS);
  assert.equal(c.logMaxTotalBytes, c.logMaxFileBytes); assert.equal(c.temporaryHomeRetentionMs, DAY_MS);
  assert.equal(readCleanupConfig({ AGENT_INSIGHT_CLEANUP_MAX_READ_BYTES: '9999999999' }).maxReadBytes, 16 * 1024 * 1024);
});

test('a slice stops at its step, byte and monotonic time budgets and resumes', async () => {
  let steps = 0;
  async function* scan() { while (steps < 10) { steps++; yield { kind: 'scanned' as const, scannedBytes: 64 }; } }
  const iterator = scan();
  assert.equal((await runCleanupSlice(iterator, { maxSteps: 3, maxReadBytes: 1000, sliceMs: 50 })).done, false);
  assert.equal(steps, 3);
  await runCleanupSlice(iterator, { maxSteps: 100, maxReadBytes: 128, sliceMs: 50 });
  assert.equal(steps, 5);
  let elapsed = 0;
  await runCleanupSlice(iterator, { maxSteps: 100, maxReadBytes: 1000, sliceMs: 50, clock: () => elapsed += 30 });
  assert.equal(steps, 7);
});

test('startup registers only a timer, failed work is caught and rescheduled, stop cancels', async () => {
  const timers: Array<{ callback: () => void; delay: number; cancelled?: boolean }> = [];
  let opened = 0;
  const errors: unknown[] = [];
  const scheduler = startCleanupScheduler({
    config: readCleanupConfig({}),
    createSweep: async function* () { opened++; throw new Error('disk unavailable'); },
    onError: e => errors.push(e),
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: timer => { (timer as typeof timers[number]).cancelled = true; },
  });
  assert.equal(opened, 0);
  assert.equal(timers[0].delay, 60_000);
  timers[0].callback();
  await scheduler.idle();
  assert.equal(opened, 1);
  assert.equal(errors.length, 1);
  assert.equal(timers.length, 2);
  await scheduler.stop();
  assert.equal(timers[1].cancelled, true);
});

test('scheduler never overlaps a pending filesystem operation', async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(r => { resolve = r; });
  let steps = 0;
  const callbacks: Array<() => void> = [];
  const scheduler = startCleanupScheduler({
    config: readCleanupConfig({}),
    createSweep: async function* () { steps++; await gate; yield { kind: 'scanned' as const }; },
    setTimer: callback => { callbacks.push(callback); return callback; }, clearTimer: () => {},
  });
  callbacks[0](); callbacks[0]();
  assert.equal(steps, 1);
  resolve();
  await scheduler.idle();
  assert.equal(steps, 1);
  await scheduler.stop();
});

test('timer failures after a sweep are contained and every generator closes after a close failure', async () => {
  let tick!: () => void;
  let schedules = 0;
  const errors: unknown[] = [];
  const scheduler = startCleanupScheduler({
    config: readCleanupConfig({}),
    createSweep: async function* () {},
    setTimer: callback => { if (schedules++) throw new Error('timer unavailable'); tick = callback; return 1; },
    clearTimer: () => {}, onError: error => errors.push(error),
  });
  tick(); await scheduler.idle();
  assert.equal(errors.length, 1);
  await scheduler.stop();
  let closed = 0;
  async function* first() { try { yield { kind: 'scanned' as const }; } finally { closed++; throw new Error('close failure'); } }
  async function* second() { try { yield { kind: 'scanned' as const }; } finally { closed++; } }
  const sweep = roundRobin([first(), second()]);
  await sweep.next(); await sweep.next();
  await assert.rejects(sweep.return(undefined), /close failure/);
  assert.equal(closed, 2);
});
