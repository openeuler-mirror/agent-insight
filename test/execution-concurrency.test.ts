import assert from 'node:assert/strict';
import test from 'node:test';
import { mapConcurrent, parseExecutionConcurrency } from '../src/lib/engine/experiment/execution-concurrency';

test('execution concurrency validates explicit values and preserves the legacy default', () => {
  assert.equal(parseExecutionConcurrency(undefined), 1);
  assert.equal(parseExecutionConcurrency(8), 8);
  for (const value of [0, -1, 1.5, '4', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseExecutionConcurrency(value));
  }
});

test('bounded execution overlaps jobs, refills free slots and preserves result order', async () => {
  let active = 0, peak = 0;
  const completion: number[] = [];
  const results = await mapConcurrent([40, 5, 5, 5], 2, async (delay, index) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    completion.push(index); active--;
    return index;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(results, [0, 1, 2, 3]);
  assert.deepEqual(completion, [1, 2, 3, 0]);
});

test('failed execution stops new admissions but awaits in-flight work before rejecting', async () => {
  const started: number[] = [];
  let settled = false;
  await assert.rejects(mapConcurrent([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw new Error('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 15));
    settled = true;
  }), /cancelled/);
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, true);
});
