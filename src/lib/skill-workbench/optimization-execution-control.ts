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
