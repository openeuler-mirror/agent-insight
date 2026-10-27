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

import {
  finishOptimizationCancellation,
  isOptimizationCancellationRequested,
  markOptimizationStopUnconfirmed,
  OptimizationCancelledError,
  watchOptimizationCancellation,
} from './optimization-cancellation';

export async function withOptimizationCancellation(
  taskId: string | undefined,
  work: (signal?: AbortSignal) => Promise<void>,
  onCancelled: () => Promise<void>,
) {
  if (!taskId) return work();
  const watcher = await watchOptimizationCancellation(() => isOptimizationCancellationRequested(taskId));
  try {
    await work(watcher.signal);
  } catch (error) {
    if (error instanceof Error && error.message.includes('停止 OpenCode 执行未确认')) {
      await markOptimizationStopUnconfirmed(taskId);
      throw error;
    }
    if (!watcher.signal.aborted && !(error instanceof OptimizationCancelledError)) throw error;
    await finishOptimizationCancellation(taskId);
    await onCancelled();
  } finally {
    await watcher.close();
  }
}
