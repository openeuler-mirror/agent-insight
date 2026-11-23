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

import {
  deriveKeyPointItemScore,
  deriveTaskCompletionScoreFromFindings,
} from '../src/lib/engine/evaluation/task-completion-scoring';

test('deriveKeyPointItemScore accepts explicit 0-1 score', () => {
  assert.equal(deriveKeyPointItemScore({ score: 0.75 }), 0.75);
  assert.equal(deriveKeyPointItemScore({ score: '0.25' }), 0.25);
});

test('deriveKeyPointItemScore rejects missing or out-of-range score', () => {
  assert.throws(() => deriveKeyPointItemScore({ covered: true }), /explicit score between 0 and 1/i);
  assert.throws(() => deriveKeyPointItemScore({ score: 1.2 }), /explicit score between 0 and 1/i);
  assert.throws(() => deriveKeyPointItemScore({ score: -0.1 }), /explicit score between 0 and 1/i);
});

test('deriveTaskCompletionScoreFromFindings uses equal-weight average', () => {
  const summary = deriveTaskCompletionScoreFromFindings([
    { content: 'a', score: 1 },
    { content: 'b', score: 0.25 },
    { content: 'c', score: 0.5 },
  ]);

  assert.equal(summary.itemCount, 3);
  assert.equal(summary.findings.length, 3);
  assert.equal(summary.score, (1 + 0.25 + 0.5) / 3);
});

test('deriveTaskCompletionScoreFromFindings rejects empty findings', () => {
  assert.throws(
    () => deriveTaskCompletionScoreFromFindings([]),
    /must include key_point_findings with explicit scores/i,
  );
});
