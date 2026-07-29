import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExperimentTraceSearchFilter,
  buildExperimentTraceWhere,
  parseExperimentTraceFilters,
} from '../src/lib/engine/experiment/trace-filters';

test('parseExperimentTraceFilters normalizes search, dates, and duplicate tags', () => {
  const params = new URLSearchParams({
    search: '  trace input  ',
    from: '2026-07-01T00:00:00.000Z',
    to: 'invalid',
    tagIds: 'tag-a,tag-b,tag-a,,tag-c',
  });

  const filters = parseExperimentTraceFilters(params);

  assert.equal(filters.search, 'trace input');
  assert.equal(filters.from?.toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(filters.to, undefined);
  assert.deepEqual(filters.tagIds, ['tag-a', 'tag-b', 'tag-c']);
});

test('parseExperimentTraceFilters caps text and tag inputs to the API contract', () => {
  const params = new URLSearchParams({
    search: 'x'.repeat(250),
    tagIds: Array.from({ length: 25 }, (_, index) => `tag-${index}`).join(','),
  });

  const filters = parseExperimentTraceFilters(params);

  assert.equal(filters.search.length, 200);
  assert.equal(filters.tagIds.length, 20);
});

test('fuzzy search matches when either the task input or Trace ID contains the keyword', () => {
  assert.deepEqual(buildExperimentTraceSearchFilter('  account  '), {
    OR: [
      { id: { contains: 'account' } },
      { taskId: { contains: 'account' } },
      { query: { contains: 'account' } },
    ],
  });
  assert.deepEqual(buildExperimentTraceSearchFilter('   '), {});
});

test('buildExperimentTraceWhere combines agent, text, time, and tag matches', () => {
  const from = new Date('2026-07-01T00:00:00.000Z');
  const to = new Date('2026-07-29T00:00:00.000Z');
  const where = buildExperimentTraceWhere(
    'alice',
    'build',
    { search: 'session-1', from, to, tagIds: ['tag-a'] },
  );

  assert.deepEqual(where, {
    user: 'alice',
    isSubagent: false,
    agentName: 'build',
    OR: [
      { id: { contains: 'session-1' } },
      { taskId: { contains: 'session-1' } },
      { query: { contains: 'session-1' } },
    ],
    timestamp: { gte: from, lte: to },
    AND: [{
      executionTags: {
        some: {
          user: 'alice',
          tagId: 'tag-a',
          tag: { user: 'alice', kind: { in: ['version', 'business'] } },
        },
      },
    }],
  });
});

test('buildExperimentTraceWhere preserves the legacy unscoped query when no user or filters are supplied', () => {
  assert.deepEqual(
    buildExperimentTraceWhere(
      null,
      '',
      { search: '', tagIds: [] },
    ),
    { isSubagent: false },
  );
});

test('buildExperimentTraceWhere emits one relation clause per tag for AND matching', () => {
  const where = buildExperimentTraceWhere(
    'alice',
    'build',
    { search: '', tagIds: ['tag-a', 'tag-b'] },
  );

  assert.deepEqual(where.AND, [
    {
      executionTags: {
        some: {
          user: 'alice',
          tagId: 'tag-a',
          tag: { user: 'alice', kind: { in: ['version', 'business'] } },
        },
      },
    },
    {
      executionTags: {
        some: {
          user: 'alice',
          tagId: 'tag-b',
          tag: { user: 'alice', kind: { in: ['version', 'business'] } },
        },
      },
    },
  ]);
});

test('tag filtering without an authenticated user returns no candidates', () => {
  const where = buildExperimentTraceWhere(
    null,
    'build',
    { search: '', tagIds: ['tag-a'] },
  );

  assert.deepEqual(where, {
    isSubagent: false,
    agentName: 'build',
    id: { in: [] },
  });
});
