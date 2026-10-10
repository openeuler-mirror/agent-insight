export interface StreamCheckpointWriter {
  schedule: () => void;
  flush: () => Promise<void>;
  cancel: () => void;
}

export function createStreamCheckpointWriter<T>({
  capture,
  persist,
  intervalMs = 1_000,
  onError,
}: {
  capture: () => T;
  persist: (snapshot: T) => Promise<void>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): StreamCheckpointWriter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  let lastError: unknown = null;
  let cancelled = false;

  const enqueue = () => {
    if (cancelled) return;
    const snapshot = capture();
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          await persist(snapshot);
          lastError = null;
        } catch (error) {
          lastError = error;
          onError?.(error);
        }
      });
  };

  return {
    schedule() {
      if (cancelled || timer) return;
      timer = setTimeout(() => {
        timer = null;
        enqueue();
      }, intervalMs);
    },
    async flush() {
      if (cancelled) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      enqueue();
      await chain;
      if (lastError) throw lastError;
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
