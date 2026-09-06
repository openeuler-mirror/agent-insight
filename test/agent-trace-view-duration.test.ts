import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTraceTimelineDurationMs } from '@/lib/latency-format';
import { resolveTraceTimelineBounds } from '@/lib/engine/observability/agent-trace';

test('trace timeline duration prefers the tree duration over persisted execution latency', () => {
  assert.equal(resolveTraceTimelineDurationMs(15_000, 24_204), 15_000);
});

test('trace timeline duration falls back to the execution latency when the tree duration is missing', () => {
  assert.equal(resolveTraceTimelineDurationMs(17_146, undefined), 17_146);
  assert.equal(resolveTraceTimelineDurationMs(undefined, 15_000), 15_000);
});

test('trace timeline duration ignores invalid duration candidates', () => {
  assert.equal(resolveTraceTimelineDurationMs(Number.NaN, 24_204), 24_204);
  assert.equal(resolveTraceTimelineDurationMs(0, -1), undefined);
});

test('trace timeline bounds cover the full nested tree span', () => {
  const tree = {
    startedAt: 1000,
    endedAt: 4000,
    events: [
      { startedAt: 1000, completedAt: 2000 },
    ],
    children: [
      {
        startedAt: 2500,
        endedAt: 9000,
        events: [
          { startedAt: 2500, completedAt: 9000 },
        ],
        children: [],
      },
    ],
  } as any;

  const bounds = resolveTraceTimelineBounds(tree, 12_000);
  assert.equal(bounds?.start, 1000);
  assert.equal(bounds?.end, 9000);
  assert.equal(bounds?.durationMs, 8000);
});
