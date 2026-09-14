import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReuseRootCauseCache,
  hashExpectedOutput,
} from '@/lib/dataset-case-root-causes';
import {
  normalizeCase,
  prepareDatasetCasesForPersistence,
  prepareLiveRootCauseCacheWrite,
  type AgentDatasetRecord,
  type DatasetCase,
} from '@/server/agent_datasets_storage';

function datasetWithCases(cases: DatasetCase[]): AgentDatasetRecord {
  return {
    id: 'dataset-1',
    user: 'tester',
    name: 'dataset',
    description: '',
    targetAgent: '',
    targetSkill: '',
    tags: [],
    cases,
    fields: [],
    datasetKind: 'ideal_output',
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
  };
}

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

test('does not backfill unchanged legacy cases during an unrelated dataset save', async () => {
  let calls = 0;
  const previousCase = normalizeCase({
    id: 'legacy-case',
    input: 'question',
    expectedOutput: 'legacy answer',
  });

  const result = await prepareDatasetCasesForPersistence({
    nextCases: [previousCase],
    previousCases: [previousCase],
    extractor: async () => {
      calls += 1;
      return [{ content: 'should not run', weight: 1 }];
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.cases[0]?.rootCauses, []);
  assert.equal(result.cases[0]?.rootCauseMeta, undefined);
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

test('prepares a single-case live extraction cache write', () => {
  const first = normalizeCase({ id: 'case-1', input: 'q1', expectedOutput: 'answer-1' });
  const second = normalizeCase({ id: 'case-2', input: 'q2', expectedOutput: 'answer-2' });
  const result = prepareLiveRootCauseCacheWrite(
    datasetWithCases([first, second]),
    'case-1',
    'answer-1',
    [{ content: 'point-1', weight: 2 }],
    new Date('2026-05-27T00:00:00.000Z'),
  );

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.cases?.[0]?.rootCauses, [{ content: 'point-1', weight: 2 }]);
  assert.equal(result.cases?.[0]?.rootCauseMeta?.status, 'ready');
  assert.equal(result.cases?.[0]?.rootCauseMeta?.expectedOutputHash, hashExpectedOutput('answer-1'));
  assert.deepEqual(result.cases?.[1], second);
});

test('rejects a stale live extraction result after expectedOutput changes', () => {
  const current = normalizeCase({ id: 'case-1', input: 'q', expectedOutput: 'new answer' });
  const result = prepareLiveRootCauseCacheWrite(
    datasetWithCases([current]),
    'case-1',
    'old answer',
    [{ content: 'stale point', weight: 1 }],
    new Date('2026-05-27T00:00:00.000Z'),
  );

  assert.equal(result.status, 'stale');
  assert.equal(result.cases, undefined);
});

test('does not overwrite an already valid root cause cache', () => {
  const current = normalizeCase({
    id: 'case-1',
    input: 'q',
    expectedOutput: 'answer',
    rootCauses: [{ content: 'cached point', weight: 1 }],
    rootCauseMeta: {
      status: 'ready',
      expectedOutputHash: hashExpectedOutput('answer'),
      updatedAt: '2026-05-26T00:00:00.000Z',
    },
  });
  const result = prepareLiveRootCauseCacheWrite(
    datasetWithCases([current]),
    'case-1',
    'answer',
    [{ content: 'late point', weight: 1 }],
    new Date('2026-05-27T00:00:00.000Z'),
  );

  assert.equal(result.status, 'already-cached');
  assert.equal(result.cases, undefined);
});

test('replaces a failed extraction marker after a later live extraction succeeds', () => {
  const current = normalizeCase({
    id: 'case-1',
    input: 'q',
    expectedOutput: 'answer',
    rootCauses: [],
    rootCauseMeta: {
      status: 'failed',
      expectedOutputHash: hashExpectedOutput('answer'),
      updatedAt: '2026-05-26T00:00:00.000Z',
      error: 'temporary model failure',
    },
  });
  const result = prepareLiveRootCauseCacheWrite(
    datasetWithCases([current]),
    'case-1',
    'answer',
    [{ content: 'recovered point', weight: 1 }],
    new Date('2026-05-27T00:00:00.000Z'),
  );

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.cases?.[0]?.rootCauses, [{ content: 'recovered point', weight: 1 }]);
  assert.equal(result.cases?.[0]?.rootCauseMeta?.status, 'ready');
});

test('repairs a ready cache that contains no key points for a non-empty expected output', () => {
  const current = normalizeCase({
    id: 'case-1',
    input: 'q',
    expectedOutput: 'answer',
    rootCauses: [],
    rootCauseMeta: {
      status: 'ready',
      expectedOutputHash: hashExpectedOutput('answer'),
      updatedAt: '2026-05-26T00:00:00.000Z',
    },
  });
  const result = prepareLiveRootCauseCacheWrite(
    datasetWithCases([current]),
    'case-1',
    'answer',
    [{ content: 'fallback point', weight: 1 }],
    new Date('2026-05-27T00:00:00.000Z'),
  );

  assert.equal(result.status, 'updated');
  assert.deepEqual(result.cases?.[0]?.rootCauses, [{ content: 'fallback point', weight: 1 }]);
});
