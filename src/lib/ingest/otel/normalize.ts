import { normalizeClaudeOtlpTraces } from '@/lib/ingest/claude-otel/otlp-json';
import { isActrailOtlpTraceBody, normalizeActrailOtlpTraces } from './actrail';
import { isLangfuseOtlpTraceBody, normalizeLangfuseOtlpTraces } from './langfuse';

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

  return normalizeClaudeOtlpTraces(body, opts);
}
