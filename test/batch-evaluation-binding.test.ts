/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
