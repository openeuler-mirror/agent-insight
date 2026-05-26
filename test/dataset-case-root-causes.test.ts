import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReuseRootCauseCache,
  hashExpectedOutput,
} from '@/lib/dataset-case-root-causes';
import {
  normalizeCase,
  prepareDatasetCasesForPersistence,
  type DatasetCase,
} from '@/server/agent_datasets_storage';

test('reuses cached root causes when expectedOutput is unchanged', async () => {
  let calls = 0;
  const previousCase = normalizeCase({
    id: 'case-1',
    input: 'question',
    expectedOutput: 'same answer',
    rootCauses: [{ content: 'point-a', weight: 1 }],
    rootCauseMeta: {
      status: 'ready',
      expectedOutputHash: hashExpectedOutput('same answer'),
      updatedAt: '2026-05-26T00:00:00.000Z',
    },
  });

  const result = await prepareDatasetCasesForPersistence({
    nextCases: [previousCase],
    previousCases: [previousCase],
    extractor: async () => {
      calls += 1;
      return [{ content: 'new-point', weight: 1 }];
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.cases[0]?.rootCauses, [{ content: 'point-a', weight: 1 }]);
  assert.equal(result.cases[0]?.rootCauseMeta?.status, 'ready');
});

test('re-extracts root causes when expectedOutput changes', async () => {
  let calls = 0;
  const previousCase = normalizeCase({
    id: 'case-1',
    input: 'question',
    expectedOutput: 'old answer',
    rootCauses: [{ content: 'old-point', weight: 1 }],
    rootCauseMeta: {
      status: 'ready',
      expectedOutputHash: hashExpectedOutput('old answer'),
      updatedAt: '2026-05-26T00:00:00.000Z',
    },
  });
  const nextCase: DatasetCase = {
    ...previousCase,
    expectedOutput: 'new answer',
  };

  const result = await prepareDatasetCasesForPersistence({
    nextCases: [nextCase],
    previousCases: [previousCase],
    extractor: async () => {
      calls += 1;
      return [{ content: 'new-point', weight: 2 }];
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.cases[0]?.rootCauses, [{ content: 'new-point', weight: 2 }]);
  assert.equal(result.cases[0]?.rootCauseMeta?.status, 'ready');
  assert.equal(
    canReuseRootCauseCache(result.cases[0]?.expectedOutput || '', result.cases[0]?.rootCauseMeta),
    true,
  );
});

test('marks empty expectedOutput without calling extractor', async () => {
  let calls = 0;
  const result = await prepareDatasetCasesForPersistence({
    nextCases: [{ id: 'case-1', input: 'question', expectedOutput: '', evaluationFocus: '', tags: [], trajectory: '' }],
    extractor: async () => {
      calls += 1;
      return [{ content: 'unused', weight: 1 }];
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.cases[0]?.rootCauseMeta?.status, 'empty');
  assert.deepEqual(result.cases[0]?.rootCauses, []);
});

test('stores failed metadata and warning when extraction fails', async () => {
  const result = await prepareDatasetCasesForPersistence({
    nextCases: [{ id: 'case-1', input: 'question', expectedOutput: 'answer', evaluationFocus: '', tags: [], trajectory: '' }],
    extractor: async () => {
      throw new Error('mock extract failed');
    },
  });

  assert.equal(result.warnings.length, 1);
  assert.equal(result.cases[0]?.rootCauseMeta?.status, 'failed');
  assert.match(result.cases[0]?.rootCauseMeta?.error || '', /mock extract failed/);
  assert.deepEqual(result.cases[0]?.rootCauses, []);
});
