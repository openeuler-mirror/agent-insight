import type { Event } from '../../src/server/trace-datasets/normalizer';

export function traceTurn(id: string, input: string, output: string, context = 'fresh', start = Date.parse('2026-09-06T01:00:00Z') + id.charCodeAt(0) * 1000) {
  const rootId = `${id}-root`, answerId = `${id}-answer`;
  const messages = context === 'history' ? [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'prior answer' }, { role: 'user', content: input }] : [{ role: 'system', content: 'system prompt' }, { role: 'user', content: input }];
  const events: Event[] = [{ role: 'user', content: input, timestamp: new Date(start).toISOString() }, { role: 'assistant', content: output, traceId: id, spanId: answerId, timestamp: new Date(start + 10).toISOString() }];
  const spans = [
    { traceId: id, spanId: rootId, kind: 'chain', startTimeMs: start, latencyMs: 100, attributes: { 'input.value': input, 'output.value': output, 'tool.outcome': 'ok' } },
    { traceId: id, spanId: answerId, parentSpanId: rootId, kind: 'llm', startTimeMs: start + 10, latencyMs: 80, attributes: { 'input.value': JSON.stringify(messages), 'output.value': output, 'tool.outcome': 'ok', 'gen_ai.response.finish_reasons': ['stop'] } },
  ];
  return { events, spans };
}
