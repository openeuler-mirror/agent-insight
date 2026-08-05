import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLatestTaskCompletionScoreLookup } from '../src/lib/version-analysis';

test('version analysis uses the latest task-completion result for each execution', () => {
  const lookup = buildLatestTaskCompletionScoreLookup([
    {
      id: 'older',
      score: 62,
      humanScore: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
      case: { executionId: 'exec-1', taskId: 'task-1' },
    },
    {
      id: 'newer',
      score: 88,
      humanScore: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
      case: { executionId: 'exec-1', taskId: 'task-1' },
    },
  ]);

  assert.equal(lookup.byExecutionId.get('exec-1'), 88);
});

test('version analysis prefers the human task-completion score', () => {
  const lookup = buildLatestTaskCompletionScoreLookup([
    {
      id: 'result-1',
      score: 74,
      humanScore: 91,
      updatedAt: '2026-08-02T00:00:00.000Z',
      case: { executionId: 'exec-1', taskId: 'task-1' },
    },
  ]);

  assert.equal(lookup.byExecutionId.get('exec-1'), 91);
});

test('version analysis only uses taskId fallback for legacy cases without executionId', () => {
  const lookup = buildLatestTaskCompletionScoreLookup([
    {
      id: 'legacy',
      score: 79,
      humanScore: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
      case: { executionId: null, taskId: 'legacy-task' },
    },
    {
      id: 'modern',
      score: 83,
      humanScore: null,
      updatedAt: '2026-08-03T00:00:00.000Z',
      case: { executionId: 'exec-2', taskId: 'modern-task' },
    },
  ]);

  assert.equal(lookup.byLegacyTaskId.get('legacy-task'), 79);
  assert.equal(lookup.byLegacyTaskId.has('modern-task'), false);
  assert.equal(lookup.byExecutionId.get('exec-2'), 83);
});

test('version analysis ignores results without an effective score', () => {
  const lookup = buildLatestTaskCompletionScoreLookup([
    {
      id: 'empty',
      score: null,
      humanScore: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
      case: { executionId: 'exec-1', taskId: 'task-1' },
    },
  ]);

  assert.equal(lookup.byExecutionId.has('exec-1'), false);
});
