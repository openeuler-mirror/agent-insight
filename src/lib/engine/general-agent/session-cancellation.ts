export async function withSessionCancellation<T>(
  signal: AbortSignal | undefined,
  abortSession: () => Promise<boolean>,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let stopping: Promise<Error | null> | undefined;
  const stop = () => {
    stopping ||= abortSession().then(
      (confirmed) => confirmed ? null : new Error('停止 OpenCode 执行未确认，请检查运行服务'),
      () => new Error('停止 OpenCode 执行未确认，请检查运行服务'),
    );
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await work();
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (stopping) {
      const error = await stopping;
      if (error) throw error;
    }
  }
}
