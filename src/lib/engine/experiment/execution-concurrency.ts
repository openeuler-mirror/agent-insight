export function parseExecutionConcurrency(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('执行并发必须为正整数');
  }
  return value;
}

export async function mapConcurrent<T, R>(
  items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(items.length, parseExecutionConcurrency(concurrency)) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await run(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return results;
}
