import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executionIdsMatchingAllTags,
  parseObserveTraceTagFilters,
} from '@/lib/trace-tag-filters';

test('user tag filters normalize duplicates and take precedence over legacy business tags', () => {
  const params = new URLSearchParams({
    tagIds: 'version-a,business-b,version-a,,business-c',
    bizTag: 'legacy-a,legacy-b',
  });

  assert.deepEqual(parseObserveTraceTagFilters(params), {
    userTagIds: ['version-a', 'business-b', 'business-c'],
    legacyBusinessTagIds: [],
  });
});

test('legacy business tag filters remain available when tagIds is absent', () => {
  const params = new URLSearchParams({ bizTag: 'business-a,business-b,business-a' });

  assert.deepEqual(parseObserveTraceTagFilters(params), {
    userTagIds: [],
    legacyBusinessTagIds: ['business-a', 'business-b'],
  });
});

test('user tag filters are capped at the shared multi-select limit', () => {
  const params = new URLSearchParams({
    tagIds: Array.from({ length: 25 }, (_, index) => `tag-${index}`).join(','),
  });

  assert.equal(parseObserveTraceTagFilters(params).userTagIds.length, 20);
});

test('execution IDs match only when every selected user tag is attached', () => {
  const rows = [
    { executionId: 'trace-a', tagId: 'version-a' },
    { executionId: 'trace-a', tagId: 'business-a' },
    { executionId: 'trace-b', tagId: 'version-a' },
    { executionId: 'trace-c', tagId: 'business-a' },
    { executionId: 'trace-a', tagId: 'version-a' },
  ];

  assert.deepEqual(
    executionIdsMatchingAllTags(rows, ['version-a', 'business-a']),
    ['trace-a'],
  );
});
