import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clusterTraceTagsByPrefix,
  extractTraceTagPrefix,
  fitTraceTagCount,
} from '@/lib/trace-tag-clustering';

test('extracts the prefix before the first underscore or hyphen', () => {
  assert.equal(extractTraceTagPrefix('agent_v1'), 'agent');
  assert.equal(extractTraceTagPrefix('agent-v2'), 'agent');
  assert.equal(extractTraceTagPrefix('agent-prod_v3'), 'agent');
  assert.equal(extractTraceTagPrefix('baseline'), null);
  assert.equal(extractTraceTagPrefix('_draft'), null);
});

test('clusters tags by prefix and keeps ungrouped tags last', () => {
  const clusters = clusterTraceTagsByPrefix([
    { name: 'checkout-v2', usageCount: 3 },
    { name: 'baseline', usageCount: 1 },
    { name: 'agent_v2', usageCount: 4 },
    { name: 'agent-v1', usageCount: 2 },
    { name: 'checkout_v1', usageCount: 5 },
  ]);

  assert.deepEqual(clusters.map(cluster => cluster.prefix), ['agent', 'checkout', null]);
  assert.deepEqual(clusters[0].tags.map(tag => tag.name), ['agent-v1', 'agent_v2']);
  assert.equal(clusters[0].usageCount, 6);
  assert.equal(clusters[1].usageCount, 8);
  assert.equal(clusters[2].usageCount, 1);
});

test('shows every trace tag that fits before falling back to an overflow count', () => {
  const overflowWidths = [0, 28, 28, 28];

  assert.equal(fitTraceTagCount({
    availableWidth: 124,
    tagWidths: [52, 52],
    overflowWidths,
  }), 2);

  assert.equal(fitTraceTagCount({
    availableWidth: 100,
    tagWidths: [52, 52, 52],
    overflowWidths,
  }), 1);
});

test('allows long trace tags to shrink to an ellipsis width', () => {
  assert.equal(fitTraceTagCount({
    availableWidth: 128,
    tagWidths: [180, 160],
    overflowWidths: [0, 28, 28],
  }), 2);
});
