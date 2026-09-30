import { performance } from 'node:perf_hooks';
import { readCleanupConfig, type CleanupEvent } from './policy';

type Sweep = AsyncGenerator<CleanupEvent>;
type Budget = { maxSteps: number; sliceMs: number; maxReadBytes: number; clock?: () => number };

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
}) {
  const config = options.config || readCleanupConfig();
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
      sweep ||= options.createSweep();
      const result = await runCleanupSlice(sweep, config, options.onEvent);
      if (result.done) {
        sweep = undefined;
        delay = config.intervalMs;
        options.onComplete?.();
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
  if (config.enabled) schedule(config.startupDelayMs);
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
