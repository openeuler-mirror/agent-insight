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

import { performance } from 'node:perf_hooks';
import { readCleanupConfig, type CleanupEvent } from './policy';

type Sweep = AsyncGenerator<CleanupEvent>;
type Budget = { maxSteps: number; sliceMs: number; maxReadBytes: number; clock?: () => number };

type CleanupCounts = {
  scanned: number; deleted: number; rotated: number; skipped: number;
  freedBytes: number; readBytes: number; skipReasons: Record<string, number>;
};
export type CleanupStatus =
  | { phase: 'scheduled'; dryRun: boolean; startupDelayMs: number; intervalMs: number; normalDays: number; abnormalDays: number }
  | { phase: 'disabled' | 'sweep start'; dryRun: boolean }
  | ({ phase: 'sweep progress' | 'sweep complete'; dryRun: boolean; durationMs: number } & CleanupCounts);

const SKIP_REASONS = new Set([
  'active-or-not-expired', 'busy-or-changed', 'dry-run', 'legacy-ownership-unknown',
  'file-unavailable-or-changed', 'archive-changed', 'unsafe-path-or-depth',
  'owner-active-or-path-changed', 'unsupported-file-type', 'file-changed-or-unavailable',
  'unsafe-root', 'root-unavailable', 'invalid-root-or-retention', 'user-directory-unavailable',
  'unsafe-path', 'unknown-owner', 'not-expired', 'owner-active-or-unknown',
  'home-changed-or-unavailable', 'runtime-home-not-owned', 'metadata-depth-limit',
  'metadata-file-changed', 'unsupported-metadata-entry', 'metadata-directory-not-empty',
  'metadata-unavailable-or-changed',
]);

function skipReason(reason: string | undefined): string {
  if (reason && SKIP_REASONS.has(reason)) return reason;
  if (reason && /^(logs|temporary-homes|spool(?:-[a-z-]+)?)-failed$/.test(reason)) return 'category-failed';
  return 'other';
}

export async function runCleanupSlice(iterator: Sweep, budget: Budget, onEvent?: (event: CleanupEvent) => void) {
  const clock = budget.clock || (() => performance.now());
  const started = clock();
  let steps = 0;
  let readBytes = 0;
  do {
    const next = await iterator.next();
    if (next.done) return { done: true, steps, readBytes };
    steps++;
    readBytes += next.value.scannedBytes || 0;
    onEvent?.(next.value);
  } while (steps < budget.maxSteps && readBytes < budget.maxReadBytes && clock() - started < budget.sliceMs);
  return { done: false, steps, readBytes };
}

export function startCleanupScheduler(options: {
  createSweep: () => Sweep;
  config?: ReturnType<typeof readCleanupConfig>;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onError?: (error: unknown) => void;
  onEvent?: (event: CleanupEvent) => void;
  onComplete?: () => void;
  onStatus?: (status: CleanupStatus) => void;
  clock?: () => number;
}) {
  const config = options.config || readCleanupConfig();
  const clock = options.clock || (() => performance.now());
  const setTimer = options.setTimer || ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  });
  const clearTimer = options.clearTimer || (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let stopped = false;
  let sweep: Sweep | undefined;
  let working: Promise<void> | undefined;
  const freshCounts = (): CleanupCounts => ({ scanned: 0, deleted: 0, rotated: 0, skipped: 0, freedBytes: 0, readBytes: 0, skipReasons: {} });
  let counts = freshCounts();
  let startedAt = 0;
  let lastProgressAt = 0;
  const status = (value: CleanupStatus) => {
    try { options.onStatus?.(value); } catch { /* Diagnostics cannot interrupt maintenance. */ }
  };
  const snapshot = (phase: 'sweep progress' | 'sweep complete'): CleanupStatus => ({
    phase, ...counts, skipReasons: { ...counts.skipReasons },
    durationMs: Math.max(0, Math.round(clock() - startedAt)), dryRun: config.dryRun,
  });
  const report = (error: unknown) => {
    try { (options.onError || console.warn)(error); } catch { /* cleanup cannot fail startup */ }
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    try { timer = setTimer(tick, delay); }
    catch (error) { stopped = true; report(error); }
  };
  const run = async () => {
    let delay = config.pauseMs;
    try {
      if (!sweep) {
        counts = freshCounts();
        startedAt = clock();
        lastProgressAt = startedAt;
        status({ phase: 'sweep start', dryRun: config.dryRun });
        sweep = options.createSweep();
      }
      const result = await runCleanupSlice(sweep, config, event => {
        counts[event.kind]++;
        if (event.kind === 'deleted') counts.freedBytes += event.bytes || 0;
        counts.readBytes += event.scannedBytes || 0;
        if (event.kind === 'skipped') {
          const reason = skipReason(event.reason);
          counts.skipReasons[reason] = (counts.skipReasons[reason] || 0) + 1;
        }
        options.onEvent?.(event);
      });
      if (result.done) {
        sweep = undefined;
        delay = config.intervalMs;
        status(snapshot('sweep complete'));
        options.onComplete?.();
      } else if (clock() - lastProgressAt >= 60_000) {
        lastProgressAt = clock();
        status(snapshot('sweep progress'));
      }
    } catch (error) {
      report(error);
      try { await sweep?.return(undefined); } catch (closeError) { report(closeError); }
      sweep = undefined;
      delay = config.intervalMs;
    } finally {
      working = undefined;
      schedule(delay);
    }
  };
  function tick() {
    if (stopped || working) return;
    working = run();
  }
  if (config.enabled) {
    schedule(config.startupDelayMs);
    if (!stopped) status({ phase: 'scheduled', dryRun: config.dryRun,
      startupDelayMs: config.startupDelayMs, intervalMs: config.intervalMs,
      normalDays: config.normalDays, abnormalDays: config.abnormalDays });
  } else status({ phase: 'disabled', dryRun: config.dryRun });
  return {
    idle: async () => { await working; },
    stop: async () => {
      stopped = true;
      clearTimer(timer);
      await working;
      try { await sweep?.return(undefined); } catch (error) { report(error); }
      sweep = undefined;
    },
  };
}

export async function* roundRobin(sweeps: Sweep[]): Sweep {
  const pending = new Set(sweeps);
  try {
    while (pending.size) {
      for (const sweep of pending) {
        const next = await sweep.next();
        if (next.done) pending.delete(sweep);
        else yield next.value;
      }
    }
  } finally {
    const results = await Promise.allSettled([...pending].map(sweep => sweep.return(undefined)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
