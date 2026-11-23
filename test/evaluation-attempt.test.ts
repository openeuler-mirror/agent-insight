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
  evaluationAttemptSignal, remainingEvaluationTimeMs, trackEvaluationRequest,
  withEvaluationAttempt, isRetryableEvaluationFailure, waitForEvaluationRetry,
} from '@/lib/engine/experiment/evaluation-attempt';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('attempt budget interrupts work and waits for cleanup before returning', async () => {
  let cleaned = false;
  await assert.rejects(withEvaluationAttempt(20, undefined, () => trackEvaluationRequest(() => new Promise<void>((resolve) => {
    evaluationAttemptSignal()!.addEventListener('abort', () => { setTimeout(() => { cleaned = true; resolve(); }, 5); }, { once: true });
  }))), /评估尝试超时/);
  assert.equal(cleaned, true);
  assert.equal(evaluationAttemptSignal(), undefined);
});

test('parallel requests share remaining budget and settle before retry', async () => {
  let secondStopped = false;
  await assert.rejects(withEvaluationAttempt(1000, undefined, async () => {
    const before = remainingEvaluationTimeMs()!;
    await wait(10);
    assert.ok(remainingEvaluationTimeMs()! < before);
    const second = trackEvaluationRequest(() => new Promise<void>((resolve) => {
      evaluationAttemptSignal()!.addEventListener('abort', () => { secondStopped = true; resolve(); }, { once: true });
    }));
    await Promise.all([second, trackEvaluationRequest(async () => { throw new Error('network unavailable'); })]);
  }), /network unavailable/);
  assert.equal(secondStopped, true);
});

test('unconfirmed cleanup prevents retry and late work cannot succeed', async () => {
  let cleanupUnconfirmed = false;
  let finish!: () => void;
  try {
    await assert.rejects(withEvaluationAttempt(5, undefined, () => new Promise<void>(resolve => { finish = resolve; }), {
      cleanupGraceMs: 10, onCleanupUnconfirmed: () => { cleanupUnconfirmed = true; },
    }), (error: unknown) => {
      assert.equal(isRetryableEvaluationFailure(error), false);
      return (error as { code: string }).code === 'EVALUATION_CLEANUP_UNCONFIRMED';
    });
    assert.equal(cleanupUnconfirmed, true);
  } finally { finish(); }
});

test('cancellation interrupts attempt and retry delay; permanent failures do not retry', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('用户取消'), { code: 'EXPERIMENT_CANCELLED' });
  const attempt = withEvaluationAttempt(1000, controller.signal, () => new Promise<void>((resolve) => {
    evaluationAttemptSignal()!.addEventListener('abort', () => resolve(), { once: true });
  }));
  const timer = setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(attempt, /用户取消/);
  clearTimeout(timer);
  await assert.rejects(waitForEvaluationRetry(1000, controller.signal), /用户取消/);
  assert.equal(isRetryableEvaluationFailure(reason), false);
  assert.equal(isRetryableEvaluationFailure({ status: 401, message: 'network error' }), false);
  assert.equal(isRetryableEvaluationFailure({ status: 429, code: 'insufficient_quota' }), false);
  assert.equal(isRetryableEvaluationFailure({ status: 503 }), true);
  assert.equal(isRetryableEvaluationFailure({ name: 'JudgeOutputParseError' }), true);
});
