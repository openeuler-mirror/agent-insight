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
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { CustomEvaluatorExecutionError } from '@/lib/engine/evaluation/custom-evaluator-runtime';
import { withEvaluatorExecution, runConfiguredEvaluationStage, withConfiguredEvaluationTimeout } from '@/lib/engine/experiment/evaluator-execution-policy';
import { evaluationAttemptSignal, remainingEvaluationTimeMs, isRetryableEvaluationFailure } from '@/lib/engine/experiment/evaluation-attempt';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('only scoring retries; successful preparation and subsequent suggestions are not repeated or timed', async () => {
  const controller = new AbortController();
  const phases = { prepare: 0, score: 0, suggestions: 0 };
  const attempts: number[] = [];
  const value = await withEvaluatorExecution({ attemptTimeoutSeconds: 0.03, maxRetries: 2 }, controller.signal, async () => {
    phases.prepare++;
    assert.equal(remainingEvaluationTimeMs(), undefined);
    await wait(40);
    const facts = { reference: 'frozen analysis' };
    const score = await runConfiguredEvaluationStage(async () => {
      phases.score++;
      assert.equal(facts.reference, 'frozen analysis');
      assert.ok(remainingEvaluationTimeMs()! <= 30);
      if (phases.score < 3) throw new JudgeOutputParseError('invalid JSON', '');
      return 80;
    });
    phases.suggestions++;
    assert.equal(remainingEvaluationTimeMs(), undefined);
    await wait(40);
    return score;
  }, { retryDelaysMs: [0, 0], onAttempt: n => attempts.push(n) });
  assert.equal(value, 80);
  assert.deepEqual(phases, { prepare: 1, score: 3, suggestions: 1 });
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('deferred OpenCode execution excludes preparation and cleanup from its timer', async () => {
  const parent = new AbortController();
  let calls = 0;
  let cleaned = 0;
  await assert.rejects(withEvaluatorExecution({ attemptTimeoutSeconds: 0.01, maxRetries: 1 }, parent.signal,
    () => runConfiguredEvaluationStage(async () => {
      calls++;
      assert.equal(cleaned, calls - 1);
      await wait(20);
      try {
        await withConfiguredEvaluationTimeout(() => new Promise<void>(resolve => {
          evaluationAttemptSignal()!.addEventListener('abort', () => resolve(), { once: true });
        }));
      } finally { await wait(20); cleaned++; }
    }, { deferTimeout: true }), { retryDelaysMs: [0] }), /评估尝试超时/);
  assert.equal(calls, 2);
  assert.equal(cleaned, 2);
});

test('parse-error subclasses and wrapped transport errors retry, while cancellation and auth do not', () => {
  class SimilarityJudgeParseError extends JudgeOutputParseError { name = 'SimilarityJudgeParseError'; }
  assert.equal(isRetryableEvaluationFailure(new SimilarityJudgeParseError('bad output', '')), true);
  const runtime = { configHash: '', model: '', transport: 'opencode' as const, skills: [], tools: [], durationMs: 0 };
  assert.equal(isRetryableEvaluationFailure(new CustomEvaluatorExecutionError('wrapped', runtime, { status: 503 })), true);
  assert.equal(isRetryableEvaluationFailure(new CustomEvaluatorExecutionError('wrapped', runtime, { status: 401 })), false);
  assert.equal(isRetryableEvaluationFailure({ name: 'AbortError' }), false);
});


test('each retry records its cause, duration and retry decision', async () => {
  const diagnostics: import('@/lib/engine/experiment/evaluator-execution-policy').EvaluationAttemptDiagnostic[] = [];
  let calls = 0;
  await withEvaluatorExecution({ attemptTimeoutSeconds: 1, maxRetries: 1 }, new AbortController().signal,
    () => runConfiguredEvaluationStage(async () => { if (++calls === 1) throw new JudgeOutputParseError('invalid JSON api_key=test-secret-value', ''); return 1; }),
    { retryDelaysMs: [0], onAttemptResult: item => diagnostics.push(item) });
  assert.deepEqual(diagnostics.map(item => [item.stage, item.attempt, item.status, item.willRetry]), [[1, 1, 'failed', true], [1, 2, 'success', false]]);
  assert.match(diagnostics[0].errorMessage!, /invalid JSON/);
  assert.doesNotMatch(diagnostics[0].errorMessage!, /test-secret-value/);
  assert.ok(diagnostics.every(item => item.durationMs >= 0));
});
