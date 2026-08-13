import assert from 'node:assert/strict';
import test from 'node:test';
import * as batchBinding from '@/lib/eval/batch-case-start';

test('从数据集执行时优先复用用户选中的评测任务', () => {
  const resolveBinding = (batchBinding as Record<string, unknown>).resolveBatchEvaluationExperimentId;
  assert.equal(typeof resolveBinding, 'function');
  assert.equal(
    (resolveBinding as (config: { evaluationBatchId?: string; evalExperimentId?: string }) => string | undefined)({
      evaluationBatchId: 'selected-experiment',
      evalExperimentId: 'stale-hidden-experiment',
    }),
    'selected-experiment',
  );
});

test('未选择评测任务时兼容已有内部实验绑定', () => {
  const resolveBinding = (batchBinding as Record<string, unknown>).resolveBatchEvaluationExperimentId;
  assert.equal(typeof resolveBinding, 'function');
  assert.equal(
    (resolveBinding as (config: { evaluationBatchId?: string; evalExperimentId?: string }) => string | undefined)({
      evalExperimentId: 'existing-internal-experiment',
    }),
    'existing-internal-experiment',
  );
});
