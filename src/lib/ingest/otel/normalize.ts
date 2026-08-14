import { normalizeClaudeOtlpTraces } from '@/lib/ingest/claude-otel/otlp-json';
import { isActrailOtlpTraceBody, normalizeActrailOtlpTraces } from './actrail';
import { isLangfuseOtlpTraceBody, normalizeLangfuseOtlpTraces } from './langfuse';
import { isLlamaIndexOtlpTraceBody, normalizeLlamaIndexOtlpTraces } from './llamaindex';

export function normalizeOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
) {
  if (isActrailOtlpTraceBody(body)) {
    return normalizeActrailOtlpTraces(body, opts);
  }

  if (isLangfuseOtlpTraceBody(body)) {
    return normalizeLangfuseOtlpTraces(body, opts);
  }
  if (isLlamaIndexOtlpTraceBody(body)) {
    return normalizeLlamaIndexOtlpTraces(body, opts);
  }

  return normalizeClaudeOtlpTraces(body, opts);
}
