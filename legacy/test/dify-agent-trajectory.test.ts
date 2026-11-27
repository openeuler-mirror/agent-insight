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

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { buildLangfuseAgentTrace } from '@/lib/engine/observability/langfuse-agent-trace';
import { computeCallStats } from '@/lib/fleet/call-stats';
import { difyAgentFixture, difyAgentAttributes, difyAgentSessionId } from './fixtures/dify-agent-trajectory';

test('Dify Agent trajectory preserves the real model-tool-model sequence without container token duplication', () => {
  const { body } = difyAgentFixture();
  const events = normalizeOtlpTraces(body, { authenticatedUser: 'admin' });
  assert.equal(events.length, 4);
  assert.ok(events.every(e => e.framework === 'dify' && e.sessionId === difyAgentSessionId));
  const record = aggregateOtelTraceEvents(difyAgentSessionId, events)!;
  assert.ok(record);
  assert.equal(record.framework, 'dify');
  assert.equal(record.agentName, 'lookup-agent');
  assert.equal(record.authenticated_ingest, true);
  assert.equal(record.query, 'Look up alpha');
  assert.equal(record.final_result, 'alpha is ok');
  assert.equal(record.tokens, 18);
  assert.equal(record.input_tokens, 14);
  assert.equal(record.output_tokens, 4);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.tool_call_count, 1);
  const first = record.interactions!.find((i: any) => i.spanId === '2222222222222222');
  assert.equal(first.reasoning_content, 'I should use lookup for the code.');
  assert.equal(first.content, '');
  assert.equal(new Date(record.trace_completed_at!).getTime(), 3000);
  const stats = computeCallStats(record.interactions!);
  assert.equal(Object.values(stats.llm).reduce((n, s) => n + s.n, 0), 2);
  assert.equal(Object.values(stats.tool).reduce((n, s) => n + s.n, 0), 1);
  const second = record.interactions!.find((i: any) => i.spanId === '4444444444444444');
  assert.deepEqual(second.requestMessages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(second.requestMessages[3].tool_call_id, 'call-1');
  const tool = record.langfuseTraceNodes!.find(n => n.kind === 'tool')!;
  assert.equal(tool.sourceParentSpanId, '1111111111111111');
  assert.equal(tool.linkedGenerationSpanId, '2222222222222222');
  assert.equal(tool.displayParentSpanId, '2222222222222222');
  assert.deepEqual(tool.input, { item: 'alpha' });
  assert.deepEqual(tool.output, { value: 'ok' });
  const projection = buildLangfuseAgentTrace(record.langfuseTraceNodes!, difyAgentSessionId);
  assert.equal(projection.tree!.agentName, 'lookup-agent');
  assert.equal(projection.tree!.stats.llmCalls, 2);
  assert.equal(projection.tree!.stats.toolCalls, 1);
  assert.equal(projection.tree!.stats.totalTokens, 18);
  assert.deepEqual(projection.interactions.find(i => i.model && i.content === '')!.parts, [{ type: 'reasoning', text: 'I should use lookup for the code.' }]);
  assert.equal(projection.tree!.events.find(e => e.sourceSpanId === '3333333333333333')!.parentSourceSpanId, '2222222222222222');
  assert.equal(projection.interactions.find(i => i.model && i.content === 'alpha is ok')!.requestMessages!.length, 4);
  assert.deepEqual(projection.interactions.find(i => i.model && i.content === 'alpha is ok')!.parts, [{ type: 'reasoning', text: 'The lookup returned ok.' }]);
});

test('Dify Agent late root, retries and shared correlation IDs retain separate stable traces', () => {
  const { body, root } = difyAgentFixture();
  body.resourceSpans[0].scopeSpans[0].spans = body.resourceSpans[0].scopeSpans[0].spans.filter(s => s !== root);
  const early = normalizeOtlpTraces(body);
  const partial = aggregateOtelTraceEvents(difyAgentSessionId, early)!;
  assert.ok(partial);
  assert.equal(partial.trace_completed_at, undefined);
  body.resourceSpans[0].scopeSpans[0].spans = [root];
  const late = normalizeOtlpTraces(body);
  const complete = aggregateOtelTraceEvents(difyAgentSessionId, [...early, ...late, ...early])!;
  assert.equal(complete.llm_call_count, 2);
  assert.equal(complete.tool_call_count, 1);
  assert.equal(complete.tokens, 18);
  body.resourceSpans[0].scopeSpans[0].spans = [{ ...root, traceId: '66666666666666666666666666666666' }];
  assert.notEqual(normalizeOtlpTraces(body)[0].sessionId, difyAgentSessionId);
});

test('Dify Agent error spans preserve status, while pending and foreign framework spans are not claimed', () => {
  const { body, tool, first } = difyAgentFixture();
  (tool as any).status = { code: 'STATUS_CODE_ERROR', message: 'lookup failed' };
  body.resourceSpans[0].scopeSpans[0].spans.push({ ...first, spanId: '7777777777777777', attributes: difyAgentAttributes({ 'gen_ai.operation.name': 'chat', 'logfire.span_type': 'pending_span' }) });
  const events = normalizeOtlpTraces(body);
  assert.equal(events.length, 4);
  const record = aggregateOtelTraceEvents(difyAgentSessionId, events)!;
  assert.equal(record.tool_call_error_count, 1);
  assert.equal(record.langfuseTraceNodes!.find(n => n.kind === 'tool')!.status, 'error');
  assert.equal(record.langfuseTraceNodes!.find(n => n.kind === 'tool')!.statusMessage, 'lookup failed');
  body.resourceSpans[0].scopeSpans[0].spans = [{ ...first, attributes: difyAgentAttributes({ 'agent.insight.framework': 'foreign', 'gen_ai.operation.name': 'chat' }) }];
  assert.ok(normalizeOtlpTraces(body).every(e => e.framework !== 'dify'));
});

test('Dify Agent custom service identity preserves metadata when content reporting is disabled', () => {
  const { body, root, first, second, tool } = difyAgentFixture();
  body.resourceSpans[0].resource.attributes = difyAgentAttributes({ 'service.name': 'custom-dify-agent' });
  for (const span of [root, first, second, tool]) {
    span.attributes = span.attributes.filter(a => !['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'final_result', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result'].includes(a.key));
    span.attributes.push(...difyAgentAttributes({ 'dify.agent_id': 'agent-1' }));
  }
  const events = normalizeOtlpTraces(body);
  assert.equal(events.filter(e => e.framework === 'dify').length, 4);
  const record = aggregateOtelTraceEvents(difyAgentSessionId, events)!;
  assert.equal(record.tokens, 18);
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.tool_call_count, 1);
  assert.deepEqual(record.interactions!.find((i: any) => i.model).requestMessages, []);
  assert.equal(record.langfuseTraceNodes!.find(n => n.kind === 'tool')!.orphanTool, true);
  assert.equal(new Date(record.trace_completed_at!).getTime(), 3000);
});
