import { normalizeClaudeOtlpTraces } from '@/lib/ingest/claude-otel/otlp-json';
import { isLangfuseOtlpTraceBody, normalizeLangfuseOtlpTraces } from './langfuse';
import { isLlamaIndexOtlpTraceBody, normalizeLlamaIndexOtlpTraces } from './llamaindex';

export function normalizeOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
) {
  if (isLangfuseOtlpTraceBody(body)) {
    return normalizeLangfuseOtlpTraces(body, opts);
  }
  if (isLlamaIndexOtlpTraceBody(body)) {
    return normalizeLlamaIndexOtlpTraces(body, opts);
  }

  return normalizeClaudeOtlpTraces(body, opts);
}
