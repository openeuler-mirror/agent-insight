import { OpenAI } from 'openai';
import { getOpenAICompatibleClientConfig, type ModelConnectionConfig } from '@/lib/shared/model-connection';
import { ModelTestValidationError, type ModelTestErrorCode } from '@/lib/shared/model-connection-test';

export async function probeModelConnection(
  config: ModelConnectionConfig,
  options: { timeoutMs: number; signal: AbortSignal; fetch?: typeof fetch },
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      const error = new DOMException('Test cancelled', 'AbortError');
      reject(error);
      controller.abort(error);
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    timer = setTimeout(() => {
      const error = new DOMException('Connection test timed out', 'TimeoutError');
      reject(error);
      controller.abort(error);
    }, options.timeoutMs);
  });
  try {
    await Promise.race([deadline, (async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const client = new OpenAI({
        ...getOpenAICompatibleClientConfig(config),
        fetch: options.fetch,
        timeout: options.timeoutMs,
        maxRetries: 0,
      });
      const completion = await client.chat.completions.create({
        model: config.model!,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      }, { signal: controller.signal }).catch((error: unknown) => {
        if (error instanceof SyntaxError) throw new Error('Invalid model response', { cause: 'invalid_response' });
        throw error;
      });
      if (!Array.isArray(completion?.choices) || completion.choices.length === 0) {
        throw new Error('Invalid model response', { cause: 'invalid_response' });
      }
    })()]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
  }
}

export function classifyModelTestError(error: unknown): { code: ModelTestErrorCode; status: number; error: string } {
  if (error instanceof ModelTestValidationError || error instanceof SyntaxError) {
    return { code: 'invalid_request', status: 400, error: 'Invalid connection test parameters' };
  }
  const e = error as { name?: string; status?: number; cause?: unknown } | null;
  if (e?.name === 'TimeoutError' || error instanceof OpenAI.APIConnectionTimeoutError || e?.status === 408 || e?.status === 504) {
    return { code: 'timeout', status: 504, error: 'Connection test timed out' };
  }
  if (e?.name === 'AbortError' || error instanceof OpenAI.APIUserAbortError) {
    return { code: 'cancelled', status: 499, error: 'Connection test cancelled' };
  }
  if (e?.status === 401 || e?.status === 403) return { code: 'authentication', status: 422, error: 'Model authentication failed' };
  if (e?.status === 429) return { code: 'rate_limit', status: 429, error: 'Model service rate limit exceeded' };
  if (e?.status && e.status >= 500) return { code: 'server', status: 502, error: 'Model service unavailable' };
  if (e?.status && e.status >= 400) return { code: 'invalid_request', status: 400, error: 'Model rejected the request; check model and endpoint' };
  if (e?.cause === 'invalid_response') return { code: 'invalid_response', status: 502, error: 'Invalid model response' };
  if (error instanceof OpenAI.APIConnectionError) return { code: 'network', status: 502, error: 'Cannot reach model service' };
  return { code: 'unknown', status: 500, error: 'Connection test failed' };
}
