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
import { composeDifyWorkflowTrace } from '@/lib/engine/observability/dify-workflow-trace';
import { buildLangfuseAgentTrace } from '@/lib/engine/observability/langfuse-agent-trace';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { difyAgentFixture, difyAgentAttributes, difyAgentSessionId } from './fixtures/dify-agent-trajectory';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';

const context = { tenantId: 'tenant', appId: 'app', workflowId: 'workflow', workflowRunId: 'run', nodeId: 'agent', nodeExecutionId: 'execution' };
function node(spanId: string, parent: string | null, extra: any = {}): LangfuseTraceNode {
  return { traceId: 'outer', spanId, parentSpanId: parent, sourceParentSpanId: parent, displayParentSpanId: parent, name: spanId, kind: 'chain', startedAt: 900, completedAt: 4000, durationMs: 3100, visibility: 'visible', status: 'success', dify: { ...context }, ...extra } as LangfuseTraceNode;
}
function workflow() { return [node('workflow', null, { dify: { ...context, nodeExecutionId: undefined } }), node('agent-node', 'workflow', { dify: { ...context, nodeType: 'agent' } })]; }
function member(taskId = difyAgentSessionId) {
  const events = normalizeOtlpTraces(difyAgentFixture().body);
  const record = aggregateOtelTraceEvents(difyAgentSessionId, events)!;
  const nodes = record.langfuseTraceNodes!.map(n => ({ ...n, traceId: taskId.slice(5), dify: { ...context, trajectory: true } }));
  return { taskId, user: 'alice', nodes };
}

test('Dify preserves native Workflow correlation fields in the stored node JSON', () => {
  const { body } = difyAgentFixture();
  for (const s of body.resourceSpans[0].scopeSpans[0].spans) s.attributes.push(...difyAgentAttributes({ 'dify.tenant_id': 'tenant', 'dify.app_id': 'app', 'dify.workflow.id': 'workflow', 'dify.workflow.run_id': 'run', 'dify.node.id': 'agent', 'dify.node.execution_id': 'execution' }));
  const record = aggregateOtelTraceEvents(difyAgentSessionId, normalizeOtlpTraces(body))!;
  for (const n of record.langfuseTraceNodes!) assert.deepEqual((n as any).dify, { ...context, trajectory: true });
});

test('Dify projection connects exact execution IDs and keeps original parents and independent source sessions', () => {
  const outer = workflow(), child = member();
  const before = JSON.stringify([outer, child]);
  const result = composeDifyWorkflowTrace('alice', outer, [child]);
  assert.equal(result.linkedTraces, 1);
  assert.equal(result.nodes.length, 6);
  assert.equal(JSON.stringify([outer, child]), before);
  const agent = result.nodes.find(n => n.kind === 'agent')!;
  assert.equal(agent.subagentSessionId, child.taskId);
  assert.equal(agent.sourceParentSpanId, null);
  assert.equal(agent.displayParentSpanId, 'outer:agent-node');
  const tree = buildLangfuseAgentTrace(result.nodes, 'dify:outer').tree!;
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].sessionId, child.taskId);
  assert.equal(tree.children[0].stats.llmCalls, 2);
  assert.equal(tree.children[0].stats.toolCalls, 1);
  assert.equal(tree.children[0].stats.totalTokens, 18);
  assert.equal(tree.events.find(e => e.spawnedChildId === tree.children[0].id)!.parentSourceSpanId, 'outer:agent-node');
});

test('Dify association rejects another owner, tenant, app, workflow run or node execution', () => {
  for (const key of ['tenantId', 'appId', 'workflowRunId', 'nodeExecutionId']) {
    const child = member();
    child.nodes = child.nodes.map(n => ({ ...n, dify: { ...(n as any).dify, [key]: 'foreign' } }));
    assert.equal(composeDifyWorkflowTrace('alice', workflow(), [child]).linkedTraces, 0, key);
  }
  assert.equal(composeDifyWorkflowTrace('alice', workflow(), [{ ...member(), user: 'bob' }]).linkedTraces, 0);
  const outer = workflow().map(n => ({ ...n, dify: { ...(n as any).dify, nodeExecutionId: undefined } }));
  assert.equal(composeDifyWorkflowTrace('alice', outer, [member()]).linkedTraces, 0);
});

test('Dify repeated node executions, retries and colliding raw span IDs remain distinct without duplicate usage', () => {
  const outer = workflow();
  const first = member();
  const retry = member('dify:retry');
  const another = member('dify:another');
  another.nodes = another.nodes.map(n => ({ ...n, dify: { ...(n as any).dify, nodeExecutionId: 'execution-2' } }));
  outer.push(node('second-node', 'workflow', { dify: { ...context, nodeExecutionId: 'execution-2', nodeType: 'agent' } }));
  const result = composeDifyWorkflowTrace('alice', outer, [first, retry, first, another]);
  assert.equal(result.linkedTraces, 3);
  assert.equal(new Set(result.nodes.map(n => n.spanId)).size, result.nodes.length);
  assert.equal(result.nodes.filter(n => n.kind === 'llm').reduce((s, n) => s + (n.usage?.totalTokens || 0), 0), 54);
  assert.equal(result.nodes.find(n => n.kind === 'agent' && n.traceId === 'another')!.displayParentSpanId, 'outer:second-node');
  assert.equal(composeDifyWorkflowTrace('alice', workflow(), [another]).linkedTraces, 0);
});

test('Dify projection refreshes late children and does not attach malformed or ambiguous traces', () => {
  assert.equal(composeDifyWorkflowTrace('alice', workflow(), []).linkedTraces, 0);
  assert.equal(composeDifyWorkflowTrace('alice', workflow(), [member()]).linkedTraces, 1);
  assert.equal(composeDifyWorkflowTrace('alice', [...workflow(), node('duplicate-anchor', 'workflow')], [member()]).linkedTraces, 0);
  const child = member();child.nodes[1] = { ...child.nodes[1], dify: { ...context, tenantId: 'other', trajectory: true } } as any;
  assert.equal(composeDifyWorkflowTrace('alice', workflow(), [child]).linkedTraces, 0);
});

test('Dify projection bounds large model payloads even when the trace has few nodes', () => {
  const child = member();child.nodes[1] = { ...child.nodes[1], input: 'x'.repeat(5 * 1024 * 1024) };
  const result = composeDifyWorkflowTrace('alice', workflow(), [child]);
  assert.equal(result.linkedTraces, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 2);
});

test('Dify projection also bounds the total payload across individually valid retry traces', () => {
  const payload = 'x'.repeat(3_500_000);
  const members = Array.from({ length: 5 }, (_, i) => {
    const child = member(`dify:attempt-${i}`);
    child.nodes[1] = { ...child.nodes[1], input: payload };
    return child;
  });
  const result = composeDifyWorkflowTrace('alice', workflow(), members);
  assert.equal(result.linkedTraces, 4);
  assert.equal(result.truncated, true);
});

test('Linked Agent input never replaces the owning Workflow user request', () => {
  const outer = workflow();
  outer[0] = { ...outer[0], sourceParentSpanId: 'external-platform-span', input: [{ role: 'user', content: 'Owning Workflow question' }] };
  const result = composeDifyWorkflowTrace('alice', outer, [member()]);
  const tree = buildLangfuseAgentTrace(result.nodes, 'dify:outer').tree!;
  assert.equal(tree.events.find(e => e.kind === 'user')!.summary, 'Owning Workflow question');
});
