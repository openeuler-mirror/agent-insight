import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import {
  buildLangfuseTraceNodes,
  mergeLangfuseTraceNodes,
} from '@/lib/ingest/otel/adapters/langfuse-trace';
import { buildLangfuseAgentTrace } from '@/lib/engine/observability/langfuse-agent-trace';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';

function event(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: '2026-07-21T00:00:00.000Z',
    sessionId: 'langfuse-session',
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: 'root',
    name: 'AssistantService.chat',
    kind: 'chain',
    serviceName: 'langfuse-langgraph',
    user: 'fixture',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 1000,
    startTimeMs: 1000,
    attributes: {
      'langfuse.internal.is_app_root': true,
      'langfuse.observation.input': '{"query":"hello"}',
      'langfuse.observation.output': '{"final_output":"done"}',
    },
    ...overrides,
  };
}

test('Langfuse projection preserves every observation and only collapses framework wrappers', () => {
  const events = [
    event({}),
    event({ spanId: 'graph', parentSpanId: 'root', name: 'LangGraph', startTimeMs: 1010, latencyMs: 900 }),
    event({
      spanId: 'summarizer',
      parentSpanId: 'graph',
      name: 'summarizer',
      startTimeMs: 1020,
      latencyMs: 0,
      attributes: {
        'langfuse.observation.input': '{"messages":["large input"]}',
        'langfuse.observation.output': '{"summary":"valuable output"}',
      },
    }),
    event({
      spanId: 'generation',
      parentSpanId: 'graph',
      name: 'ChatDeepSeek',
      kind: 'llm',
      model: 'deepseek-chat',
      startTimeMs: 1030,
      latencyMs: 300,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      attributes: {
        'langfuse.observation.output': '{"tool_calls":[{"id":"call-1"}]}',
      },
    }),
    event({ spanId: 'tools-wrapper', parentSpanId: 'graph', name: 'tools', startTimeMs: 1340, latencyMs: 400 }),
    event({
      spanId: 'tool',
      parentSpanId: 'tools-wrapper',
      name: 'knowledge_retrieve',
      kind: 'tool',
      startTimeMs: 1350,
      latencyMs: 350,
      attributes: {
        'langfuse.observation.metadata.tool_call_id': 'call-1',
        'langfuse.observation.input': '{"query":"hello"}',
        'langfuse.observation.output': '{"documents":[{"text":"answer"}]}',
      },
    }),
    event({
      spanId: 'content-leaf-wrapper',
      parentSpanId: 'graph',
      name: 'RetrievalSession.as_tools',
      startTimeMs: 1710,
      latencyMs: 0,
      attributes: {
        'langfuse.observation.output': '[{"name":"retrieve","description":"search knowledge"}]',
      },
    }),
    event({
      spanId: 'empty-leaf-wrapper',
      parentSpanId: 'graph',
      name: 'model',
      startTimeMs: 1720,
      latencyMs: 0,
      attributes: {},
    }),
  ];

  const nodes = buildLangfuseTraceNodes(events);
  assert.equal(nodes.length, events.length);
  assert.equal(new Set(nodes.map(node => node.spanId)).size, events.length);
  assert.equal(nodes.find(node => node.spanId === 'graph')?.visibility, 'collapsed');
  assert.equal(nodes.find(node => node.spanId === 'tools-wrapper')?.visibility, 'collapsed');
  assert.equal(nodes.find(node => node.spanId === 'content-leaf-wrapper')?.visibility, 'visible');
  assert.equal(nodes.find(node => node.spanId === 'empty-leaf-wrapper')?.visibility, 'collapsed');
  assert.equal(nodes.find(node => node.spanId === 'summarizer')?.visibility, 'visible');
  assert.deepEqual(nodes.find(node => node.spanId === 'summarizer')?.output, { summary: 'valuable output' });
  assert.equal(nodes.find(node => node.spanId === 'summarizer')?.displayParentSpanId, 'root');
  assert.equal(nodes.find(node => node.spanId === 'tool')?.linkedGenerationSpanId, 'generation');
  assert.equal(nodes.find(node => node.spanId === 'tool')?.orphanTool, false);

  const record = aggregateOtelTraceEvents('langfuse-session', events);
  assert.equal(record?.langfuseTraceNodes?.length, events.length);
});

test('Langfuse trace snapshots merge monotonically by span id', () => {
  const first = buildLangfuseTraceNodes([event({}), event({ spanId: 'child', parentSpanId: 'root', name: 'child' })]);
  const second = buildLangfuseTraceNodes([event({ spanId: 'child', parentSpanId: 'root', name: 'child', latencyMs: 2000 })]);
  const merged = mergeLangfuseTraceNodes(first, second);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(node => node.spanId === 'child')?.durationMs, 2000);
});

test('Langfuse observations project into the existing agent tree without business-name rules', () => {
  const events = [
    event({
      name: 'workflow_root_unseen_before',
      attributes: {
        'langfuse.observation.input': '{"request":{"history":[{"role":"user","content":"older question"},{"role":"assistant","content":"older answer"},{"role":"user","content":"current user question"}]}}',
        'langfuse.observation.output': '{"final_output":"done"}',
      },
    }),
    event({
      spanId: 'wrapper',
      parentSpanId: 'root',
      name: 'LangGraph',
      startTimeMs: 1010,
      latencyMs: 800,
    }),
    event({
      spanId: 'worker',
      parentSpanId: 'wrapper',
      name: 'arbitrary_worker_42',
      kind: 'agent',
      startTimeMs: 1020,
      latencyMs: 700,
      attributes: {},
    }),
    event({
      spanId: 'business-chain',
      parentSpanId: 'worker',
      name: 'domain_step_never_hardcoded',
      kind: 'chain',
      startTimeMs: 1030,
      latencyMs: 100,
      attributes: {
        'langfuse.observation.input': '{"question":"keep this"}',
        'langfuse.observation.output': '{"answer":"keep this too"}',
      },
    }),
    event({
      spanId: 'llm-any',
      parentSpanId: 'business-chain',
      name: 'provider_model_arbitrary',
      kind: 'llm',
      model: 'model-z',
      startTimeMs: 1140,
      latencyMs: 200,
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      attributes: {
        'langfuse.observation.input': '[{"role":"user","content":"prompt body"}]',
        'langfuse.observation.output': '{"content":"response body"}',
      },
    }),
    event({
      spanId: 'tool-any',
      parentSpanId: 'worker',
      name: 'tool_name_arbitrary',
      kind: 'tool',
      startTimeMs: 1350,
      latencyMs: 100,
      attributes: {
        'langfuse.observation.input': '{"key":"value"}',
        'langfuse.observation.output': '{"found":true}',
      },
    }),
  ];

  const nodes = buildLangfuseTraceNodes(events);
  const projected = buildLangfuseAgentTrace(nodes);
  const root = projected.tree!;
  assert.equal(root.agentName, 'workflow_root_unseen_before');
  assert.equal(root.id.includes(':'), false);
  assert.equal(root.events[0].kind, 'user');
  assert.equal(root.events[0].summary, 'current user question');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].agentName, 'arbitrary_worker_42');
  assert.equal(root.events.some(item => item.name === 'LangGraph'), false);
  assert.equal(root.events.some(item => item.spawnedChildId === root.children[0].id), true);
  assert.equal(root.events.find(item => item.spawnedChildId === root.children[0].id)?.treeHidden, true);

  const childEvents = root.children[0].events;
  assert.deepEqual(childEvents.map(item => [item.kind, item.name]), [
    ['chain', 'domain_step_never_hardcoded'],
    ['llm', 'provider_model_arbitrary'],
    ['tool', 'tool_name_arbitrary'],
  ]);
  assert.equal(childEvents[1].parentSourceSpanId, 'business-chain');
  assert.deepEqual(childEvents[0].args, { question: 'keep this' });
  assert.deepEqual(childEvents[0].output, { answer: 'keep this too' });
  assert.equal(childEvents[1].interaction.model, 'model-z');
  assert.equal(childEvents[1].usage?.total, 19);
  assert.equal(projected.interactions.some(item => item.content?.includes('prompt body')), true);
  assert.equal(projected.interactions.some(item => item.content?.includes('response body')), true);
});
