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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';
import { batchHasEndedTeamRoot } from '@/lib/ingest/otel/jiuwen/coalesce';
import { isMultiTraceSpan, spanSession } from '@/lib/ingest/otel/jiuwen/spool';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { getTraceLifecycle } from '@/lib/observe/trace-lifecycle';

// Reduced from the 0.0.13y ARM64 image's real OTLP exports; prompt payloads are sanitized.
const fixtures = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/jiuwen-013y-spans.json'), 'utf8'));
const spans = (kind = 'enabled'): JiuwenSpan[] => structuredClone(fixtures[kind]);
const llms = (rows: JiuwenSpan[]) => rows.filter(s => s.attrs['openjiuwen.trajectory.record.kind'] === 'inference');

test('0.0.13y: recovers the authored user message rather than system reminders', () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!;
  assert.equal(rec.query, '介绍杭州');
  assert.equal(rec.agentName, 'main_agent');
  assert.equal(rec.subagentCount, 0);
  assert.equal(rec.task_id, `jiuwen-${spans()[0].traceId}`);
  assert.equal(rec.interactions.find((i: any) => i.role === 'system')?.content, '你是一个简洁的助手。');
});

test('0.0.13y: counts inference once and preserves token usage and assistant text', () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans())!;
  assert.equal(rec.llm_call_count, 1);
  assert.equal(rec.input_tokens, 19596);
  assert.equal(rec.output_tokens, 62);
  assert.equal(rec.tokens, 19658);
  assert.equal(rec.reasoning_tokens, 16);
  assert.equal(rec.cache_read_input_tokens, 19328);
  assert.match(rec.final_result!, /杭州/);
  assert.equal(rec.interactions.filter((i: any) => i.usage).length, 1);
  const tree = buildAgentCallTree(rec.interactions)!;
  assert.equal(tree.stats.cacheReadTokens, 19328);
  assert.equal(tree.stats.reasoningTokens, 16);
});

test('0.0.13y: associates sibling tool spans by explicit call id with full arguments and result', () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans('tool'))!;
  assert.equal(rec.llm_call_count, 2);
  assert.equal(rec.tool_call_count, 1);
  assert.equal(rec.tokens, 39442);
  const turns = rec.interactions.filter((i: any) => i.role === 'assistant');
  assert.equal(turns.length, 2);
  const call = turns[0].tool_calls[0];
  assert.equal(call.function.name, 'read_file');
  assert.equal(JSON.parse(call.function.arguments).file_path, '/tmp/trace-verification.txt');
  assert.match(call.output, /AI013Y-B349-TOOL-RESULT/);
  assert.equal(call.state, 'success');
  assert.equal(turns[1].tool_calls.length, 0);
  assert.equal(rec.final_result, 'AI013Y-B349-TOOL-RESULT: 2+3=5');
});

test('0.0.13y: missing call ids do not attach sibling tools by time', () => {
  const rows = spans('tool');
  rows.find(s => s.name.startsWith('execute_tool'))!.attrs['gen_ai.tool.call.id'] = 'unmatched-call';
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.tool_call_count, 1);
  const inferenceTurns = rec.interactions.filter((i: any) => i.usage);
  assert.equal(inferenceTurns.flatMap((i: any) => i.tool_calls || []).length, 0);
  assert.equal(rec.interactions.flatMap((i: any) => i.tool_calls || []).length, 1);
  const tree = buildAgentCallTree(rec.interactions)!;
  assert.equal(tree.stats.llmCalls, 2);
  assert.equal(tree.events.filter(event => event.kind === 'tool').length, 1);
});

test('0.0.13y: closed root is an explicit completion and bypasses batch throttling', () => {
  const rows = spans();
  const root = rows.find(s => s.attrs['openjiuwen.trace.root'])!;
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.trace_started_at, new Date(Math.floor(root.startNs / 1e6)).toISOString());
  assert.equal(rec.trace_completed_at, new Date(Math.floor(root.endNs / 1e6)).toISOString());
  assert.equal(batchHasEndedTeamRoot([root], root.traceId!), true);
  root.attrs['openjiuwen.trace.complete'] = false;
  assert.equal(batchHasEndedTeamRoot([root], root.traceId!), false);
});

test('0.0.13y: single-agent boundaries do not mark a conversation for cross-trace stitching', () => {
  const rows = spans();
  const agent = rows.find(s => s.name.includes('.task_iteration.'))!;
  assert.equal(spanSession(agent), 'ai-013y-b349-enabled-20261108');
  assert.equal(isMultiTraceSpan(agent), false);
});

test('0.0.13y: event-only batches do not create placeholder execution records', () => {
  const events = spans().filter(s => s.attrs['openjiuwen.trajectory.record.kind'] === 'event');
  assert.equal(aggregateJiuwenOtlpFromSpans(events), null);
});

test('0.0.13y: retried spans are not counted twice during aggregation', () => {
  const rows = spans('tool');
  const rec = aggregateJiuwenOtlpFromSpans([...rows, ...structuredClone(rows)])!;
  assert.equal(rec.llm_call_count, 2);
  assert.equal(rec.tool_call_count, 1);
  assert.equal(rec.tokens, 39442);
});

test('0.0.13y: failed tool spans preserve the error state', () => {
  const rows = spans('tool');
  const tool = rows.find(s => s.name.startsWith('execute_tool'))!;
  tool.attrs['error.type'] = 'FileNotFoundError';
  tool.attrs['gen_ai.tool.call.result'] = '{"success":false,"error":"file does not exist"}';
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.tool_call_error_count, 1);
  const call = rec.interactions.flatMap((i: any) => i.tool_calls || [])[0];
  assert.equal(call.state, 'error');
  assert.match(call.output, /file does not exist/);
});

test('semantic JSON tool outputs preserve embedded JSON and quotes without Python-repr truncation', () => {
  const rows = spans('tool');
  const output = '{"foo":"bar","baz":1,"text":"it\'s valid"}';
  rows.find(s => s.name.startsWith('execute_tool'))!.attrs['gen_ai.tool.call.result'] = JSON.stringify({ success: true, data: { output } });
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.interactions.flatMap((i: any) => i.tool_calls || [])[0].output, output);
});

test('semantic assistant text preserves numeric and JSON-looking answers verbatim', () => {
  for (const content of ['2', 'false', 'null', '{"answer":2}']) {
    const rows = spans();
    llms(rows)[0].attrs['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content }] }]);
    assert.equal(aggregateJiuwenOtlpFromSpans(rows)!.final_result, content);
  }
});

test('semantic root failures remain failed after the explicit completion signal', () => {
  const rows = spans();
  const root = rows.find(s => s.attrs['openjiuwen.trace.root'])!;
  root.status = { code: 2, message: 'model invocation failed' };
  root.attrs['error.type'] = 'RuntimeError';
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(getTraceLifecycle(rec.trace_completed_at, rec).traceStatus, 'failed');
  assert.match(JSON.stringify(rec.failures), /model invocation failed/);
});

test('legacy llm.call remains readable alongside semantic inference spans', () => {
  const rows = spans();
  const first = llms(rows)[0];
  const legacy: JiuwenSpan = { name: 'llm.call', traceId: first.traceId, spanId: 'legacy-extra',
    startNs: first.endNs + 1, endNs: first.endNs + 100, attrs: {
      'gen_ai.prompt.0.content': 'legacy request', 'gen_ai.completion.0.content': 'legacy reply',
      'gen_ai.usage.prompt_tokens': 2, 'gen_ai.usage.completion_tokens': 3,
    } };
  const rec = aggregateJiuwenOtlpFromSpans([...rows, legacy])!;
  assert.equal(rec.llm_call_count, 2);
  assert.equal(rec.tokens, 19663);
});

test('semantic nested agents follow explicit tool parent chains in the rendered trace tree', () => {
  const span = (id: string, name: string, parent: string | undefined, agent: string, kind: string, start: number,
    attrs: Record<string, any> = {}): JiuwenSpan => ({
    name, spanId: id, parentSpanId: parent, traceId: 'nested', startNs: start * 1e6, endNs: (start + 1) * 1e6,
    attrs: { 'openjiuwen.trajectory.schema_version': '1', 'openjiuwen.trajectory.record.kind': kind,
      'gen_ai.agent.name': agent, 'gen_ai.agent.id': agent, ...attrs },
  });
  const call = (id: string) => JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', id, name: 'task_tool', arguments: {} }] }]);
  const rows = [
    span('main', 'agent.main.task_iteration.1', undefined, 'main', 'agent', 1),
    span('llm-main', 'chat model', 'main', 'main', 'inference', 2, {
      'gen_ai.operation.name': 'chat', 'gen_ai.output.messages': call('spawn-child'),
    }),
    span('tool-main', 'execute_tool task_tool', 'main', 'main', 'tool', 3, {
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'task_tool', 'gen_ai.tool.call.id': 'spawn-child',
      'gen_ai.tool.call.arguments': '{"task_description":"delegate"}',
    }),
    span('child', 'agent.child.task_iteration.1', 'tool-main', 'child', 'agent', 4),
    span('llm-child', 'chat model', 'child', 'child', 'inference', 5, {
      'gen_ai.operation.name': 'chat', 'gen_ai.output.messages': call('spawn-grandchild'),
    }),
    span('tool-child', 'execute_tool task_tool', 'child', 'child', 'tool', 6, {
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'task_tool', 'gen_ai.tool.call.id': 'spawn-grandchild',
    }),
    span('grandchild', 'agent.grandchild.task_iteration.1', 'tool-child', 'grandchild', 'agent', 7),
    span('llm-grandchild', 'chat model', 'grandchild', 'grandchild', 'inference', 8, { 'gen_ai.operation.name': 'chat' }),
  ];
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  const tree = buildAgentCallTree(rec.interactions)!;
  assert.equal(rec.subagentCount, 2);
  assert.equal(tree.agentName, 'main');
  assert.equal(tree.children[0].agentName, 'child');
  assert.equal(tree.children[0].children[0]?.agentName, 'grandchild');
});

test('semantic agents with the same display name retain distinct explicit sessions', () => {
  const span = (id: string, name: string, parent: string | undefined, agent: string, agentId: string, kind: string,
    attrs: Record<string, any> = {}): JiuwenSpan => ({
    name, spanId: id, parentSpanId: parent, traceId: 'same-name', startNs: 1e9, endNs: 2e9,
    attrs: { 'openjiuwen.trajectory.schema_version': '1', 'openjiuwen.trajectory.record.kind': kind,
      'gen_ai.agent.name': agent, 'gen_ai.agent.id': agentId, ...attrs },
  });
  const rows = [span('root', 'agent.main.task_iteration.1', undefined, 'main', 'main', 'agent'),
    span('llm-root', 'chat model', 'root', 'main', 'main', 'inference', { 'gen_ai.operation.name': 'chat',
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [1, 2].map(n => ({ type: 'tool_call', id: `spawn-${n}`, name: 'task_tool' })) }]),
    })];
  for (const n of [1, 2]) rows.push(
    span(`tool-${n}`, 'execute_tool task_tool', 'root', 'main', 'main', 'tool', {
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'task_tool', 'gen_ai.tool.call.id': `spawn-${n}`,
    }),
    span(`worker-${n}`, 'agent.worker.task_iteration.1', `tool-${n}`, 'worker', `worker-${n}`, 'agent'),
    span(`llm-${n}`, 'chat model', `worker-${n}`, 'worker', `worker-${n}`, 'inference', {
      'gen_ai.operation.name': 'chat', 'openjiuwen.execution.subject.id': `worker-${n}`,
      'openjiuwen.execution.subject.session_id': `worker-session-${n}`,
    }),
  );
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.subagentCount, 2);
  const sessions = rec.interactions.filter((i: any) => i.role === 'subagent').map((i: any) => i.subagent_session_id);
  assert.deepEqual(sessions, ['worker-session-1', 'worker-session-2']);
  assert.equal(buildAgentCallTree(rec.interactions)!.children.length, 2);
});

test('legacy task tool name fallback retains fan-out topology', () => {
  const rows: JiuwenSpan[] = [
    { name: 'llm.call', spanId: 'l', traceId: 'legacy', startNs: 1e9, endNs: 2e9,
      attrs: { 'agentteam.session.id': 'legacy-session', 'gen_ai.prompt.1.content': 'delegate', 'gen_ai.usage.total_tokens': 3 } },
    { name: 'tool.task_tool', spanId: 't', traceId: 'legacy', startNs: 3e9, endNs: 4e9,
      attrs: { 'agentteam.session.id': 'legacy-session', 'gen_ai.tool.input': '{"subagent_type":"worker","task_description":"calculate"}',
        'gen_ai.tool.output': "success=True data={'output': '2'} error=None" } },
  ];
  const rec = aggregateJiuwenOtlpFromSpans(rows)!;
  assert.equal(rec.task_id, 'legacy-session');
  assert.equal(rec.subagentCount, 1);
  assert.equal(rec.tool_call_count, 1);
});

test('0.0.13y: detached child spans use explicit execution subject parents and spawn result session ids', () => {
  const rec = aggregateJiuwenOtlpFromSpans(spans('delegation'))!;
  assert.equal(rec.llm_call_count, 6);
  assert.equal(rec.tokens, 131238);
  assert.equal(rec.tool_call_count, 4);
  assert.equal(rec.subagentCount, 1);
  assert.equal(rec.final_result, '2');
  const tree = buildAgentCallTree(rec.interactions)!;
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].agentName, 'statusline-setup');
  assert.match(tree.children[0].sessionId!, /_sub_statusline-setup_/);
  assert.equal(tree.children[0].stats.llmCalls, 1);
  assert.equal(tree.stats.taskCalls, 1);
});

test('legacy team child identities are scoped to their root run across owners', () => {
  const records = ['alice', 'bob'].map(user => {
    const root = `legacy-${user}`;
    const rows: JiuwenSpan[] = [
      { name: 'team.demo', spanId: 'team', attrs: { 'agentteam.team.name': 'demo', 'agentteam.session.id': root }, startNs: 1e9, endNs: 9e9 },
      { name: 'agent.leader.task_iteration.1', spanId: 'leader', parentSpanId: 'team', attrs: {}, startNs: 2e9, endNs: 8e9 },
      { name: 'agent.worker.task_iteration.1', spanId: 'worker', parentSpanId: 'team', attrs: {}, startNs: 3e9, endNs: 7e9 },
      { name: 'llm.call', spanId: 'reply', parentSpanId: 'worker', attrs: { 'gen_ai.completion.0.content': `${user} result` }, startNs: 4e9, endNs: 5e9 },
    ];
    return aggregateJiuwenOtlpFromSpans(rows.map(row => ({ ...row, traceId: root })), { user })!;
  });
  const children = records.map(record => buildAgentCallTree(record.interactions, record.task_id)!.children[0]);
  assert.notEqual(children[0].sessionId, children[1].sessionId);
  children.forEach((child, index) => assert.ok(child.sessionId!.includes(records[index].task_id!)));
});
