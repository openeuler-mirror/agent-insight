import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGrayscaleTraceCase,
  buildGrayscaleTraceCaseId,
  extractDebugJobTokenUsage,
  findLatestRunnableRunIndex,
} from '@/lib/skill-analysis/grayscale-utils';

test('buildGrayscaleTraceCaseId keeps trace-derived case ids unique and stable', () => {
  assert.equal(
    buildGrayscaleTraceCaseId({ task_id: 'sess_a', upload_id: 'upload_a' }, 0),
    'trace:sess_a:upload_a',
  );
  assert.equal(
    buildGrayscaleTraceCaseId({ task_id: 'sess_a' }, 1),
    'trace:sess_a',
  );
  assert.equal(
    buildGrayscaleTraceCaseId({ upload_id: 'upload_only' }, 2),
    'trace:upload:upload_only',
  );
});

test('buildGrayscaleTraceCase preserves trace source metadata for case navigation', () => {
  const item = buildGrayscaleTraceCase({
    task_id: 'exec_123',
    upload_id: 'up_456',
    dataset_id: 'trace-ds',
    dataset_name: 'Recent traces',
    query: 'Summarize the issue',
  }, 3);

  assert.equal(item.id, 'trace:exec_123:up_456');
  assert.equal(item.input, 'Summarize the issue');
  assert.equal(item.datasetId, 'trace-ds');
  assert.equal(item.datasetName, 'Recent traces');
  assert.equal(item.sourceExecutionSessionId, 'exec_123');
  assert.equal(item.sourceUploadId, 'up_456');
});

test('findLatestRunnableRunIndex selects the latest execution-backed run only', () => {
  assert.equal(findLatestRunnableRunIndex(undefined), null);
  assert.equal(findLatestRunnableRunIndex([{ runIndex: 1 }, { runIndex: 2 }]), null);
  assert.equal(findLatestRunnableRunIndex([
    { runIndex: 1, sessionId: 'sess_1' },
    { runIndex: 2 },
    { runIndex: 3, sessionId: 'sess_3' },
  ]), 3);
});

test('extractDebugJobTokenUsage prefers token totals instead of tool-call counts', () => {
  assert.equal(extractDebugJobTokenUsage({ totalTokens: 321 }), 321);
  assert.equal(extractDebugJobTokenUsage({ tokenUsage: { input: 100, output: 40, reasoning: 20, cache: 10 } }), 170);
  assert.equal(extractDebugJobTokenUsage({ tokens: 88, toolCallCount: 999 }), 88);
  assert.equal(extractDebugJobTokenUsage({ toolCallCount: 7 }), 0);
});
