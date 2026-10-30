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
import { getAdapter } from '@/lib/ingest/adapters/registry';
import { buildLangfuseAgentTrace } from '@/lib/engine/observability/langfuse-agent-trace';
import { computeCallStats } from '@/lib/fleet/call-stats';

const traceId = '11111111111111111111111111111111';
const sessionId = `dify:${traceId}`;
function attrs(values: Record<string, any>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }));
}
function span(id: string, type: string, extra: Record<string, any> = {}, overrides: any = {}) {
  return { traceId, spanId: id, parentSpanId: 'root', name: type, startTimeUnixNano: '2000000000', endTimeUnixNano: '3000000000', status: { code: 1 }, attributes: attrs({ 'node.id': type, 'node.execution_id': id, 'node.type': type, 'gen_ai.framework': 'dify', ...extra }), ...overrides };
}
const start = span('start', 'start', { 'output.value': JSON.stringify({ question: 'hello', 'sys.workflow_run_id': 'run-1', 'sys.conversation_id': 'conversation-1' }) });
const llm = span('llm', 'llm', {
  'gen_ai.span.kind': 'LLM', 'gen_ai.request.model': 'deepseek-flash',
  'gen_ai.usage.input_tokens': 38, 'gen_ai.usage.output_tokens': 35, 'gen_ai.usage.total_tokens': 73,
  'gen_ai.input.messages': JSON.stringify([{ role: 'system', parts: [{ type: 'text', content: 'be concise' }] }, { role: 'user', parts: [{ type: 'text', content: 'hello' }] }]),
  'gen_ai.completion': 'answer', 'output.value': JSON.stringify({ text: 'answer', reasoning_content: 'thinking' }),
});
const end = span('end', 'end', { 'output.value': JSON.stringify({ answer: 'final answer' }) });
const root = span('root', 'workflow', { 'dify.app_id': 'app-1', 'dify.workflow_id': 'workflow-1' }, { name: 'services.workflow_run_agg.WorkflowRunAgg.run', parentSpanId: 'celery', startTimeUnixNano: '1000000000', endTimeUnixNano: '4000000000', attributes: attrs({ 'dify.app_id': 'app-1', 'dify.workflow_id': 'workflow-1' }) });
function body(spans: any[], service = 'langgenius/dify') {
  return { resourceSpans: [{ resource: { attributes: attrs({ 'service.name': service, 'service.instance.id': 'shared-instance' }) }, scopeSpans: [{ spans }] }] };
}
function normalized(spans: any[]) { return normalizeOtlpTraces(body(spans), { authenticatedUser: 'alice' }); }

test('Dify native Workflow filters infrastructure, preserves roles and real root lifecycle', () => {
  const events = normalized([start, llm, end, root, { ...root, spanId: 'sql', name: 'SELECT', attributes: attrs({ 'db.system': 'postgresql' }) }]);
  const record = aggregateOtelTraceEvents(sessionId, events)!;
  assert.ok(record);
  assert.equal(record.framework, 'dify');
  assert.equal(record.task_id, sessionId);
  assert.equal(record.query, 'hello');
  assert.equal(record.final_result, 'final answer');
  assert.equal(record.llm_call_count, 1);
  assert.equal(record.tool_call_count, 0);
  assert.equal(record.tokens, 73);
  assert.equal(record.user, 'alice');
  assert.equal(new Date(record.trace_completed_at!).getTime(), 4000);
  const interaction = record.interactions!.find((row: any) => row.spanId === 'llm');
  assert.deepEqual(interaction.requestMessages.map((m: any) => m.role), ['system', 'user']);
  assert.equal(interaction.content, 'answer');
  assert.equal(record.langfuseTraceNodes!.length, 4);
  assert.equal(record.langfuseTraceNodes!.find(n => n.spanId === 'llm')!.displayParentSpanId, 'root');
  const projected = buildLangfuseAgentTrace(record.langfuseTraceNodes!, traceId);
  const displayed = projected.interactions.find(row => row.model === 'deepseek-flash')!;
  assert.equal(displayed.content, 'answer');
  assert.deepEqual(displayed.requestMessages!.map(m => m.role), ['system', 'user']);
});

test('Dify late Start batches and shared instances keep a stable per-trace identity', () => {
  const early = normalized([llm]);
  const late = normalized([start, end, root]);
  assert.deepEqual([...new Set([...early, ...late].map(e => e.sessionId))], [sessionId]);
  assert.equal(aggregateOtelTraceEvents(sessionId, early)!.trace_completed_at, undefined);
  assert.equal(aggregateOtelTraceEvents(sessionId, [...early, ...late, ...early])!.tokens, 73);
  const other = normalized([{ ...llm, traceId: '22222222222222222222222222222222' }]);
  assert.notEqual(other[0].sessionId, early[0].sessionId);
  assert.equal(getAdapter('dify').sessionMergeStrategy, 'snapshot-replace');
});

test('Dify preserves errors, repeated node executions and control nodes without inventing LLM calls', () => {
  const tool = span('tool-1', 'tool', { 'input.value': '{"q":"hello"}', 'output.value': 'failed' }, { status: { code: 'STATUS_CODE_ERROR', message: 'timeout' } });
  const events = normalized([root, start, llm, tool, { ...tool, spanId: 'tool-2', attributes: attrs({ 'node.id': 'tool', 'node.execution_id': 'tool-2', 'node.type': 'tool' }) }, span('retrieve', 'knowledge-retrieval'), span('branch', 'if-else')]);
  const record = aggregateOtelTraceEvents(sessionId, events)!;
  assert.equal(record.llm_call_count, 1);
  assert.equal(record.tool_call_count, 2);
  assert.equal(record.tool_call_error_count, 2);
  assert.equal(Object.values(computeCallStats(record.interactions!).llm).reduce((sum, s) => sum + s.n, 0), 1);
  assert.equal(record.langfuseTraceNodes!.find(n => n.spanId === 'tool-1')!.statusMessage, 'timeout');
});

test('Dify detection tolerates malformed unrelated telemetry without breaking the generic receiver', () => {
  assert.deepEqual(normalizeOtlpTraces({ resourceSpans: {} }), []);
  assert.doesNotThrow(() => normalizeOtlpTraces({ resourceSpans: [null, { scopeSpans: [null, { spans: [null] }] }] }));
});

test('Dify recognition does not claim spans declaring another framework', () => {
  const foreign = span('foreign', 'llm', { 'agent.insight.framework': 'foreign-framework' });
  const events = normalizeOtlpTraces(body([foreign, llm]));
  assert.equal(events.filter(e => e.framework === 'dify').length, 1);
  assert.ok(events.filter(e => e.framework === 'dify').every(e => e.spanId !== 'foreign'));
  assert.ok(events.some(e => e.spanId === 'foreign'));
  assert.notEqual(events.find(e => e.spanId === 'foreign')!.sessionId, events.find(e => e.spanId === 'llm')!.sessionId);
});

test('Dify and Langfuse sharing a distributed trace aggregate independently', () => {
  const payload = body([llm]);
  payload.resourceSpans.push({ resource: { attributes: attrs({ 'service.name': 'langgraph' }) }, scopeSpans: [{ spans: [{ ...llm, spanId: 'foreign-llm', parentSpanId: '', attributes: attrs({ 'langfuse.observation.type': 'generation', 'langfuse.trace.metadata.ls_integration': 'langgraph', 'gen_ai.request.model': 'foreign-model' }) }] }] });
  const events = normalizeOtlpTraces(payload);
  const own = aggregateOtelTraceEvents(sessionId, events)!;
  const foreign = aggregateOtelTraceEvents(traceId, events)!;
  assert.equal(own.framework, 'dify');
  assert.equal(foreign.framework, 'langfuse-langgraph');
  assert.equal(own.llm_call_count, 1);
  assert.equal(foreign.llm_call_count, 1);
  assert.equal(own.authenticated_ingest, false);
});

test('Dify root completion is absent for child-only and missing-content telemetry', () => {
  const bare = span('bare', 'llm');
  const record = aggregateOtelTraceEvents(sessionId, normalized([bare]))!;
  assert.equal(record.final_result, '');
  assert.equal(record.tokens, 0);
  assert.equal(record.trace_completed_at, undefined);
  assert.deepEqual(record.interactions![0].requestMessages, []);
  assert.equal(aggregateOtelTraceEvents(sessionId, normalized([root, bare]))!.trace_completed_at, undefined);
});

test('Dify Workflow without an outer model preserves the Start question in its root input', () => {
  const record = aggregateOtelTraceEvents(sessionId, normalized([root, start, end]))!;
  const projection = buildLangfuseAgentTrace(record.langfuseTraceNodes!, sessionId);
  assert.equal(projection.interactions.find(i => i.role === 'user')?.content, 'hello');
});
