import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOptimizationTargetVersion,
  getOptimizationTransitionLabel,
} from '@/lib/skill-workbench/optimization-display';

test('优化记录使用基线到候选的版本区间标题', () => {
  assert.equal(getOptimizationTransitionLabel({ baseVersion: 1, candidateVersionLabel: 'v2 候选' }), 'v1 → v2');
});

test('已发布记录优先使用正式发布版本', () => {
  const record = { baseVersion: 1, candidateVersionLabel: 'v2-rc1 候选', publishedVersion: 3 };
  assert.equal(getOptimizationTargetVersion(record), 'v3');
  assert.equal(getOptimizationTransitionLabel(record), 'v1 → v3');
});

test('缺少候选标签时按基线递增生成目标版本', () => {
  assert.equal(getOptimizationTransitionLabel({ baseVersion: 0 }), 'v0 → v1');
});
