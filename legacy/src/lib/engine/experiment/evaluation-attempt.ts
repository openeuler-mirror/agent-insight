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
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';

type Attempt = { signal: AbortSignal; deadline: number; pending: Set<Promise<unknown>> };
const context = new AsyncLocalStorage<Attempt>();

export function evaluationAttemptSignal(): AbortSignal | undefined { return context.getStore()?.signal; }
export function remainingEvaluationTimeMs(): number | undefined {
  const attempt = context.getStore();
  if (!attempt) return undefined;
  attempt.signal.throwIfAborted();
  return Math.max(1, attempt.deadline - Date.now());
}

export async function trackEvaluationRequest<T>(work: () => Promise<T>): Promise<T> {
  const attempt = context.getStore();
  attempt?.signal.throwIfAborted();
  const promise = work();
  attempt?.pending.add(promise);
  try { return await promise; }
  finally { attempt?.pending.delete(promise); }
}

export async function withEvaluationAttempt<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  work: () => Promise<T>,
  options: { cleanupGraceMs?: number; onCleanupUnconfirmed?: () => void } = {},
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const attempt: Attempt = { signal: controller.signal, deadline: Date.now() + timeoutMs, pending: new Set() };
  const onCancel = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onCancel, { once: true });
  const timeoutError = Object.assign(new Error(`评估尝试超时（${timeoutMs}ms）`), { code: 'EVALUATION_TIMEOUT' });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const running = context.run(attempt, () => Promise.resolve().then(work));
  let failed = false;
  let failure: unknown;
  let output: T | undefined;
  try { output = await Promise.race([running, aborted]); }
  catch (error) { failed = true; failure = controller.signal.aborted ? controller.signal.reason : error; }
  finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onCancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
  if (failed) controller.abort(failure);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled([running, ...attempt.pending]).then(() => true),
    new Promise<false>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), options.cleanupGraceMs ?? 5000); }),
  ]).finally(() => { if (cleanupTimer) clearTimeout(cleanupTimer); });
  if (!settled) {
    controller.abort();
    options.onCleanupUnconfirmed?.();
    throw Object.assign(new Error('评估尝试未能确认停止，已停止重试，请检查残留任务'), { code: 'EVALUATION_CLEANUP_UNCONFIRMED' });
  }
  if (failed) throw failure;
  return output as T;
}

export function isRetryableEvaluationFailure(error: unknown): boolean {
  const item = error as { code?: string; status?: number; name?: string; message?: string } | null;
  if (['EXPERIMENT_CANCELLED', 'EVALUATION_CLEANUP_UNCONFIRMED'].includes(item?.code || '')) return false;
  if ([400, 401, 403, 404].includes(item?.status || 0)) return false;
  if (/insufficient_quota|quota exceeded|鉴权|未配置|无效配置/i.test(`${item?.code} ${item?.message}`)) return false;
  if (item?.name === 'AbortError') return false;
  if (item?.code === 'EVALUATION_TIMEOUT' || error instanceof JudgeOutputParseError || item?.name === 'JudgeOutputParseError') return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause && cause !== error) return isRetryableEvaluationFailure(cause);
  if (item?.status === 429 || (item?.status ?? 0) >= 500) return true;
  return /timeout|timed out|超时|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang/i.test(`${item?.code} ${item?.message}`);
}

export async function waitForEvaluationRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
