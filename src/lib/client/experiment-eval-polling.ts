import { apiFetch } from '@/lib/client/api';

type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export interface WaitForExperimentTasksTerminalOptions {
  user: string;
  experimentId: string;
  taskIds: string[];
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  fetcher?: Fetcher;
}

function cancellationError(): Error {
  return new Error('评测状态等待已取消');
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancellationError();
  await new Promise<void>((resolve, reject) => {
    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(cancellationError());
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForExperimentTasksTerminal({
  user,
  experimentId,
  taskIds,
  signal,
  pollIntervalMs = 3_000,
  maxWaitMs = 17 * 60_000,
  requestTimeoutMs = 15_000,
  fetcher = apiFetch,
}: WaitForExperimentTasksTerminalOptions): Promise<void> {
  const expectedTaskIds = new Set(taskIds.map(String).filter(Boolean));
  if (expectedTaskIds.size === 0) return;
  const deadline = Date.now() + maxWaitMs;
  let lastError = '';

  while (Date.now() <= deadline) {
    if (signal?.aborted) throw cancellationError();
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal?.addEventListener('abort', abortRequest, { once: true });
    const requestTimer = setTimeout(
      abortRequest,
      Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())),
    );
    try {
      const params = new URLSearchParams({
        user,
        runId: experimentId,
        limit: '500',
      });
      const response = await fetcher(`/api/experiments/eval-results?${params.toString()}`, {
        cache: 'no-store',
        signal: requestController.signal,
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const data = await response.json().catch(() => ({}));
        const rows = Array.isArray(data?.results) ? data.results : [];
        const states = new Map<string, string>();
        for (const row of rows) {
          const taskId = String(row?.taskId || '');
          if (expectedTaskIds.has(taskId)) states.set(taskId, String(row?.status || ''));
        }
        const allTerminal = Array.from(expectedTaskIds).every((taskId) => {
          const status = states.get(taskId);
          return status === 'done' || status === 'failed';
        });
        if (allTerminal) return;
      }
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      lastError = requestController.signal.aborted
        ? '单次状态查询超时'
        : error instanceof Error ? error.message : String(error || '网络错误');
    } finally {
      clearTimeout(requestTimer);
      signal?.removeEventListener('abort', abortRequest);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining), signal);
  }

  throw new Error(lastError
    ? `结果评估等待超时（最后一次查询失败：${lastError}），已跳过轨迹对齐写入`
    : '结果评估等待超时，已跳过轨迹对齐写入');
}
