import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTraceTimelineDurationMs } from '@/lib/latency-format';

test('trace timeline duration uses persisted execution latency when a child outlives the root span', () => {
  assert.equal(resolveTraceTimelineDurationMs(15_000, 24_204), 24_204);
});

test('trace timeline duration falls back to the call-tree duration without a persisted execution latency', () => {
  assert.equal(resolveTraceTimelineDurationMs(17_146, undefined), 17_146);
  assert.equal(resolveTraceTimelineDurationMs(15_000, 0), 15_000);
});

test('trace timeline duration ignores invalid duration candidates', () => {
  assert.equal(resolveTraceTimelineDurationMs(Number.NaN, 24_204), 24_204);
  assert.equal(resolveTraceTimelineDurationMs(0, -1), undefined);
});
