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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { EvaluatorAttemptConfig } from '@/lib/evaluators/evaluator-execution-config';
import { isRetryableEvaluationFailure, waitForEvaluationRetry, withEvaluationAttempt } from './evaluation-attempt';

type Execution = {
  config: EvaluatorAttemptConfig;
  signal: AbortSignal;
  onAttempt: (attempt: number) => void;
  onCleanupUnconfirmed: () => void;
  retryDelaysMs: readonly number[];
};
const context = new AsyncLocalStorage<Execution>();

export function hasEvaluatorExecutionPolicy(): boolean { return Boolean(context.getStore()); }
export function evaluatorExecutionTimeoutMs(): number | undefined {
  const seconds = context.getStore()?.config.attemptTimeoutSeconds;
  return seconds === undefined ? undefined : seconds * 1000;
}

export function withEvaluatorExecution<T>(
  config: EvaluatorAttemptConfig, signal: AbortSignal, work: () => Promise<T>,
  options: Partial<Pick<Execution, 'onAttempt' | 'onCleanupUnconfirmed' | 'retryDelaysMs'>> = {},
): Promise<T> {
  return context.run({ config, signal, onAttempt: options.onAttempt ?? (() => {}),
    onCleanupUnconfirmed: options.onCleanupUnconfirmed ?? (() => {}), retryDelaysMs: options.retryDelaysMs ?? [2000, 8000, 20000] }, work);
}

export function withConfiguredEvaluationTimeout<T>(work: () => Promise<T>): Promise<T> {
  const execution = context.getStore();
  if (!execution) return work();
  return withEvaluationAttempt(execution.config.attemptTimeoutSeconds * 1000, execution.signal, work,
    { onCleanupUnconfirmed: execution.onCleanupUnconfirmed });
}

export async function runConfiguredEvaluationStage<T>(work: () => Promise<T>, options: { deferTimeout?: boolean } = {}): Promise<T> {
  const execution = context.getStore();
  if (!execution) return work();
  for (let attempt = 1; ; attempt++) {
    execution.signal.throwIfAborted();
    execution.onAttempt(attempt);
    try {
      return await (options.deferTimeout ? work() : withConfiguredEvaluationTimeout(work));
    } catch (error) {
      execution.signal.throwIfAborted();
      if (attempt > execution.config.maxRetries || !isRetryableEvaluationFailure(error)) throw error;
      await waitForEvaluationRetry(execution.retryDelaysMs[attempt - 1] ?? 20000, execution.signal);
    }
  }
}
