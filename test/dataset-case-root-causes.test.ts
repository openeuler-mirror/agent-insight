import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRootCauses } from '@/lib/engine/evaluation/root-cause-resolution';

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

test('reuses the stored cache when expectedOutput is unchanged', async () => {
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
    nextCases: [{ ...previousCase, rootCauses: [{ content: 'client-supplied point', weight: 99 }] }],
    previousCases: [previousCase],
  });

  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.cases[0]?.rootCauses, [{ content: 'point-a', weight: 1 }]);
  assert.deepEqual(result.cases[0]?.rootCauseMeta, previousCase.rootCauseMeta);
});

test('saves a batch of new answers without preparing model-derived caches', async () => {
  const nextCases = Array.from({ length: 20 }, (_, index) => normalizeCase({
    id: `case-${index}`,
    input: `question-${index}`,
    expectedOutput: `answer-${index}`,
    trajectory: 'original trace',
    values: { custom: index },
    source: 'trace-backflow',
    traceSource: { taskId: `task-${index}`, capturedAt: '2026-05-26T00:00:00.000Z' },
    rootCauses: [{ content: 'client-supplied point', weight: 1 }],
    rootCauseMeta: {
      status: 'ready',
      expectedOutputHash: hashExpectedOutput(`answer-${index}`),
      updatedAt: '2026-05-26T00:00:00.000Z',
    },
  }));

  const result = await prepareDatasetCasesForPersistence({ nextCases });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.cases.length, 20);
  for (const [index, item] of result.cases.entries()) {
    assert.deepEqual(item, { ...nextCases[index], rootCauses: [], rootCauseMeta: undefined });
  }
  assert.equal(nextCases[0].rootCauseMeta?.status, 'ready');
});

test('invalidates a changed answer then extracts once during evaluation and reuses the result', async () => {
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
  const saved = await prepareDatasetCasesForPersistence({
    nextCases: [{ ...previousCase, expectedOutput: 'new answer' }],
    previousCases: [previousCase],
  });
  const savedCase = saved.cases[0];
  assert.equal(savedCase.expectedOutput, 'new answer');
  assert.deepEqual(savedCase.rootCauses, []);
  assert.equal(savedCase.rootCauseMeta, undefined);
  assert.deepEqual(saved.warnings, []);

  let dataset = datasetWithCases(saved.cases);
  let extracts = 0;
  const extractor = async () => {
    extracts += 1;
    return [{ content: 'new-point', weight: 2 }];
  };
  const first = await resolveRootCauses({
    caseInput: savedCase.input,
    expectedOutput: savedCase.expectedOutput,
    onLiveRootCausesExtracted: rootCauses => {
      const write = prepareLiveRootCauseCacheWrite(
        dataset, savedCase.id, savedCase.expectedOutput, rootCauses,
        new Date('2026-05-27T00:00:00.000Z'),
      );
      assert.equal(write.status, 'updated');
      dataset = { ...dataset, cases: write.cases! };
    },
  }, 'tester', extractor);
  assert.equal(first.source, 'live-extract');
  assert.equal(canReuseRootCauseCache('new answer', dataset.cases[0].rootCauseMeta), true);

  const subsequentSave = await prepareDatasetCasesForPersistence({
    nextCases: saved.cases,
    previousCases: dataset.cases,
  });
  const cachedCase = subsequentSave.cases[0];
  const second = await resolveRootCauses({
    caseInput: cachedCase.input,
    expectedOutput: cachedCase.expectedOutput,
    precomputedRootCauses: cachedCase.rootCauses,
    precomputedRootCauseSource: 'dataset-cache',
  }, 'tester', extractor);
  assert.equal(second.source, 'dataset-cache');
  assert.deepEqual(second.rootCauses, [{ content: 'new-point', weight: 2 }]);
  assert.equal(extracts, 1);
});

test('leaves unchanged legacy cases for lazy extraction during evaluation', async () => {
  const previousCase = normalizeCase({
    id: 'legacy-case', input: 'question', expectedOutput: 'legacy answer',
  });
  const result = await prepareDatasetCasesForPersistence({
    nextCases: [previousCase], previousCases: [previousCase],
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.cases[0]?.rootCauses, []);
  assert.equal(result.cases[0]?.rootCauseMeta, undefined);
});

test('clears old key points and marks a cleared answer as empty', async () => {
  const previousCase = normalizeCase({
    id: 'case-1', input: 'question', expectedOutput: 'answer',
    rootCauses: [{ content: 'old-point', weight: 1 }],
  });
  const result = await prepareDatasetCasesForPersistence({
    nextCases: [{
      ...previousCase,
      expectedOutput: '  ',
      values: { ...previousCase.values, reference_output: '  ' },
    }],
    previousCases: [previousCase],
  });
  assert.equal(result.cases[0]?.rootCauseMeta?.status, 'empty');
  assert.equal(canReuseRootCauseCache('', result.cases[0]?.rootCauseMeta), true);
  assert.deepEqual(result.cases[0]?.rootCauses, []);
});

test('clears an empty marker when an answer is added so evaluation can extract it', async () => {
  const empty = await prepareDatasetCasesForPersistence({
    nextCases: [normalizeCase({ id: 'case-1', input: 'question', expectedOutput: '' })],
  });
  const result = await prepareDatasetCasesForPersistence({
    nextCases: [{ ...empty.cases[0], expectedOutput: 'new answer' }],
    previousCases: empty.cases,
  });
  assert.equal(result.cases[0]?.rootCauseMeta, undefined);
  assert.deepEqual(result.cases[0]?.rootCauses, []);
});

for (const cache of [
  { status: 'failed', answer: 'answer', points: ['old-point'] },
  { status: 'ready', answer: 'outdated answer', points: ['old-point'] },
  { status: 'ready', answer: 'answer', points: [] },
  { status: 'empty', answer: 'answer', points: [] },
] as const) {
  test(`discards an unusable ${cache.status} cache (${cache.answer}, ${cache.points.length} points)`, async () => {
    const previousCase = normalizeCase({
      id: 'case-1', input: 'question', expectedOutput: 'answer',
      rootCauses: cache.points.map(content => ({ content, weight: 1 })),
      rootCauseMeta: {
        status: cache.status,
        expectedOutputHash: hashExpectedOutput(cache.answer),
        updatedAt: '2026-05-26T00:00:00.000Z',
      },
    });
    const result = await prepareDatasetCasesForPersistence({
      nextCases: [previousCase], previousCases: [previousCase],
    });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.cases[0]?.rootCauses, []);
    assert.equal(result.cases[0]?.rootCauseMeta, undefined);
  });
}

test('explicit backfill can extract missing caches and force-refresh a valid cache', async () => {
  const previousCase = normalizeCase({ id: 'case-1', input: 'question', expectedOutput: 'answer' });
  let extracts = 0;
  const extractor = async () => {
    extracts += 1;
    return [{ content: `point-${extracts}`, weight: 1 }];
  };
  const filled = await prepareDatasetCasesForPersistence({
    nextCases: [previousCase], previousCases: [previousCase], extractor,
  });
  assert.equal(filled.cases[0].rootCauseMeta?.status, 'ready');
  assert.equal(extracts, 1);

  const reused = await prepareDatasetCasesForPersistence({
    nextCases: filled.cases, previousCases: filled.cases, extractor,
  });
  assert.equal(extracts, 1);
  assert.deepEqual(reused.cases[0].rootCauses, [{ content: 'point-1', weight: 1 }]);

  const refreshed = await prepareDatasetCasesForPersistence({
    nextCases: filled.cases, previousCases: filled.cases, extractor, forceRefresh: true,
  });
  assert.equal(extracts, 2);
  assert.deepEqual(refreshed.cases[0].rootCauses, [{ content: 'point-2', weight: 1 }]);
});

test('explicit backfill records failures and retries them only when requested', async () => {
  const previousCase = normalizeCase({ id: 'case-1', input: 'question', expectedOutput: 'answer' });
  const failed = await prepareDatasetCasesForPersistence({
    nextCases: [previousCase], previousCases: [previousCase],
    extractor: async () => { throw new Error('model unavailable'); },
  });
  assert.equal(failed.cases[0].rootCauseMeta?.status, 'failed');
  assert.deepEqual(failed.warnings, [{ caseId: 'case-1', message: 'model unavailable' }]);

  let extracts = 0;
  const extractor = async () => {
    extracts += 1;
    return [{ content: 'recovered point', weight: 1 }];
  };
  const skipped = await prepareDatasetCasesForPersistence({
    nextCases: failed.cases, previousCases: failed.cases, extractor,
  });
  assert.equal(extracts, 0);
  assert.equal(skipped.cases[0].rootCauseMeta?.status, 'failed');

  const retried = await prepareDatasetCasesForPersistence({
    nextCases: failed.cases, previousCases: failed.cases, extractor, retryFailed: true,
  });
  assert.equal(extracts, 1);
  assert.equal(retried.cases[0].rootCauseMeta?.status, 'ready');
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
