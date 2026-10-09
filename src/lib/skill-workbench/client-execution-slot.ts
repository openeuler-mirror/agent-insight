const queuesKey = Symbol.for('agent-insight.skill-client-execution-queues');
const state = globalThis as unknown as { [queuesKey]: Map<string, Promise<void>> | undefined };
const queues = state[queuesKey] ??= new Map<string, Promise<void>>();

export async function withSkillClientSlot<T>(workerId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(workerId) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  queues.set(workerId, queued);
  try {
    await previous;
    signal.throwIfAborted();
    return await run();
  } finally {
    release();
    if (queues.get(workerId) === queued) queues.delete(workerId);
  }
}
