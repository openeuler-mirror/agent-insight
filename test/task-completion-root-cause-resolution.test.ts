import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRootCauses } from '@/lib/engine/evaluation/root-cause-resolution';

const baseInput = {
  caseInput: 'question',
  expectedOutput: 'expected answer',
  actualOutput: 'actual answer',
};

test('writes a successful live extraction back through the supplied callback', async () => {
  const writes: unknown[] = [];
  const result = await resolveRootCauses(
    {
      ...baseInput,
      onLiveRootCausesExtracted: async rootCauses => {
        writes.push(rootCauses);
      },
    },
    'tester',
    async () => [{ content: 'point-1', weight: 1 }],
  );

  assert.equal(result.source, 'live-extract');
  assert.deepEqual(result.rootCauses, [{ content: 'point-1', weight: 1 }]);
  assert.deepEqual(writes, [[{ content: 'point-1', weight: 1 }]]);
});

test('does not run extraction or writeback when a valid dataset cache is supplied', async () => {
  let extracts = 0;
  let writes = 0;
  const result = await resolveRootCauses(
    {
      ...baseInput,
      precomputedRootCauseSource: 'dataset-cache',
      precomputedRootCauses: [{ content: 'cached point', weight: 2 }],
      onLiveRootCausesExtracted: async () => {
        writes += 1;
      },
    },
    'tester',
    async () => {
      extracts += 1;
      return [];
    },
  );

  assert.equal(result.source, 'dataset-cache');
  assert.deepEqual(result.rootCauses, [{ content: 'cached point', weight: 2 }]);
  assert.equal(extracts, 0);
  assert.equal(writes, 0);
});

test('keeps the live extraction result when best-effort cache persistence fails', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await resolveRootCauses(
      {
        ...baseInput,
        onLiveRootCausesExtracted: async () => {
          throw new Error('mock write failed');
        },
      },
      'tester',
      async () => [{ content: 'point-1', weight: 1 }],
    );

    assert.equal(result.source, 'live-extract');
    assert.deepEqual(result.rootCauses, [{ content: 'point-1', weight: 1 }]);
  } finally {
    console.warn = originalWarn;
  }
});

test('does not write a failed live extraction', async () => {
  let writes = 0;
  const result = await resolveRootCauses(
    {
      ...baseInput,
      onLiveRootCausesExtracted: async () => {
        writes += 1;
      },
    },
    'tester',
    async () => {
      throw new Error('mock extraction failed');
    },
  );

  assert.equal(result.source, 'none');
  assert.deepEqual(result.rootCauses, []);
  assert.equal(writes, 0);
});
