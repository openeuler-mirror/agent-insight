import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentCallTree,
  type RawInteraction,
  type ToolCall,
} from '@/lib/engine/observability/agent-trace';
import { getAdapter, resolveFrameworkId } from '@/lib/ingest/adapters/registry';
import { getOtelTraceAdapter } from '@/lib/ingest/otel/adapter-registry';
import { aggregateLlamaIndexTraceEvents } from '@/lib/ingest/otel/adapters/llamaindex';
import { isLlamaIndexOtlpTraceBody, normalizeLlamaIndexOtlpTraces } from '@/lib/ingest/otel/llamaindex';

function value(input: unknown): Record<string, unknown> {
  if (typeof input === 'number') return Number.isInteger(input) ? { intValue: String(input) } : { doubleValue: input };
  if (typeof input === 'boolean') return { boolValue: input };
  return { stringValue: String(input) };
}

function attrs(input: Record<string, unknown>) {
  return Object.entries(input).map(([key, item]) => ({ key, value: value(item) }));
}

function span(args: {
  id: string;
  parent?: string;
  name: string;
  kind: string;
  start: number;
  duration?: number;
  attributes?: Record<string, unknown>;
}) {
  return {
    traceId: 'a'.repeat(32),
    spanId: args.id.padEnd(16, '0'),
    ...(args.parent ? { parentSpanId: args.parent.padEnd(16, '0') } : {}),
    name: args.name,
    startTimeUnixNano: String(args.start * 1_000_000),
    endTimeUnixNano: String((args.start + (args.duration ?? 10)) * 1_000_000),
    attributes: attrs({
      'agent.insight.framework': 'llamaindex',
      'agent.insight.span.kind': args.kind,
      'session.id': 'li-session',
      ...(args.attributes || {}),
    }),
    status: { code: 1 },
  };
}

function payload() {
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': 'llamaindex', 'user.id': 'alice' }) },
      scopeSpans: [{
        scope: { name: 'agent-insight-llamaindex', version: '0.1.0' },
        spans: [
          span({ id: 'root', name: 'AgentWorkflow.run', kind: 'agent', start: 1000, duration: 500, attributes: { 'agent.query': 'find evidence' } }),
          span({ id: 'coord', parent: 'root', name: 'AgentWorkflow.run_agent_step', kind: 'workflow_step', start: 1010, attributes: { 'agent.name': 'Coordinator', 'workflow.step.name': 'run_agent_step' } }),
          span({ id: 'llm1', parent: 'coord', name: 'OpenAILike.chat', kind: 'llm', start: 1020, duration: 50, attributes: { 'gen_ai.request.model': 'deepseek-v4-pro', 'gen_ai.provider.name': 'deepseek', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 4, 'input.value': '[{"role":"system","content":"Use evidence only."},{"role":"user","content":"find evidence"}]', 'output.value': 'delegating' } }),
          span({ id: 'tool', parent: 'llm1', name: 'AgentWorkflow.call_tool', kind: 'tool', start: 1080, duration: 20, attributes: { 'tool.name': 'FunctionTool.search', 'tool.arguments': '{"q":"evidence"}', 'tool.output': 'found', 'tool.status': 'success' } }),
          span({ id: 'suba', parent: 'root', name: 'AgentWorkflow.run_agent_step', kind: 'workflow_step', start: 1110, attributes: { 'agent.name': 'Researcher', 'agent.task': 'research evidence', 'workflow.step.name': 'run_agent_step' } }),
          span({ id: 'retr', parent: 'suba', name: 'VectorIndexRetriever.retrieve', kind: 'retriever', start: 1120, attributes: { 'retrieval.query': 'evidence', 'retrieval.nodes': '[{"source":"doc.md","score":0.9}]' } }),
          span({ id: 'llm2', parent: 'suba', name: 'OpenAILike.chat', kind: 'llm', start: 1140, duration: 60, attributes: { 'agent.name': 'Researcher', 'gen_ai.request.model': 'deepseek-v4-pro', 'gen_ai.usage.input_tokens': 8, 'gen_ai.usage.output_tokens': 6, 'output.value': 'research complete' } }),
          span({ id: 'synth', parent: 'root', name: 'CompactAndRefine.synthesize', kind: 'synthesizer', start: 1220, attributes: { 'input.value': 'evidence', 'output.value': 'final answer' } }),
          span({ id: 'step', parent: 'root', name: 'CustomWorkflow.finalize', kind: 'workflow_step', start: 1250, attributes: { 'workflow.step.name': 'finalize', 'input.value': 'draft', 'output.value': 'final answer' } }),
          span({ id: 'llm3', parent: 'root', name: 'OpenAILike.chat', kind: 'llm', start: 1300, duration: 50, attributes: { 'agent.name': 'Coordinator', 'gen_ai.request.model': 'deepseek-v4-pro', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 3, 'output.value': 'final answer' } }),
        ],
      }],
    }],
  };
}

test('detects and normalizes LlamaIndex OTLP without collapsing semantic kinds', () => {
  const body = payload();
  assert.equal(isLlamaIndexOtlpTraceBody(body), true);
  const events = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' });
  assert.equal(events.length, 10);
  assert.deepEqual(new Set(events.map(event => event.kind)), new Set(['agent', 'chain', 'llm', 'tool']));
  assert.equal(events.find(event => event.spanId?.startsWith('llm1'))?.usage.total_tokens, 14);
  assert.equal(events.find(event => event.spanId?.startsWith('retr'))?.attributes['retrieval.nodes'], '[{"source":"doc.md","score":0.9}]');
});

test('uses declared owner only for service credentials and prevents user spoofing', () => {
  const serviceEvents = normalizeLlamaIndexOtlpTraces(payload(), { authenticatedUser: 'admin' });
  assert.equal(serviceEvents[0]?.user, 'alice');

  const userEvents = normalizeLlamaIndexOtlpTraces(payload(), { authenticatedUser: 'bob' });
  assert.equal(userEvents[0]?.user, 'bob');
});

test('aggregates an error-only LLM trace without an Agent span', () => {
  const body = {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': 'llamaindex', 'user.id': 'alice' }) },
      scopeSpans: [{
        scope: { name: 'agent-insight-llamaindex', version: '0.1.0' },
        spans: [{
          ...span({
            id: 'failed',
            name: 'OpenAILike.complete',
            kind: 'llm',
            start: 1000,
            attributes: {
              'gen_ai.request.model': 'deepseek-v4-pro',
              'input.value': 'failing prompt',
            },
          }),
          status: { code: 2, message: 'Insufficient Balance' },
        }],
      }],
    }],
  };
  const events = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'admin' });
  const record = aggregateLlamaIndexTraceEvents('li-session', events);
  assert.ok(record);
  assert.equal(record.agentName, 'LlamaIndex Agent');
  assert.equal(record.query, 'failing prompt');
  assert.equal(record.llm_call_count, 1);
  const failedInteraction = record.interactions.find((item: RawInteraction) => item.role === 'assistant');
  assert.equal(failedInteraction?.status, 'error');
  assert.equal(failedInteraction?.error_summary, 'Insufficient Balance');
  assert.equal('trace_framework' in (failedInteraction || {}), false);
  assert.ok(record.trace_completed_at);
  assert.equal(record.failures?.[0]?.failure_type, 'llm_error');
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.stats.llmCalls, 1);
  assert.match(tree.events.find(event => event.kind === 'llm')?.summary || '', /Insufficient Balance/);
});

test('counts nested LLM wrappers as one provider call and does not duplicate usage', () => {
  const body = payload();
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  const leaf = spans.find(item => item.name === 'OpenAILike.chat');
  assert.ok(leaf);
  leaf.attributes.push(...attrs({
    'gen_ai.usage.input_tokens': 11,
    'gen_ai.usage.output_tokens': 7,
  }));
  spans.push(span({
    id: 'wrap',
    parent: 'coord',
    name: 'OpenAILike.achat',
    kind: 'llm',
    start: 1019,
    duration: 55,
    attributes: {
      'gen_ai.request.model': 'deepseek-v4-pro',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'input.value': 'find evidence',
      'output.value': 'delegating',
    },
  }));
  leaf.parentSpanId = 'wrap'.padEnd(16, '0');

  const events = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' });
  const record = aggregateLlamaIndexTraceEvents('li-session', events);
  assert.ok(record);
  assert.equal(record.llm_call_count, 3);
  assert.equal(record.input_tokens, 24);
  assert.equal(record.output_tokens, 16);
  assert.equal(record.tokens, 40);
  assert.equal(record.interactions.filter((item: RawInteraction) => item.role === 'assistant').length, 3);
});

test('renders CompletionResponse and ChatResponse as readable LLM text', () => {
  const body = payload();
  const llmSpans = body.resourceSpans[0].scopeSpans[0].spans.filter(item =>
    item.attributes.some(attribute =>
      attribute.key === 'agent.insight.span.kind'
      && attribute.value.stringValue === 'llm'
    )
  );
  assert.equal(llmSpans.length, 3);

  const replaceOutput = (target: typeof llmSpans[number], output: string) => {
    const attribute = target.attributes.find(item => item.key === 'output.value');
    assert.ok(attribute);
    attribute.value = value(output);
  };
  replaceOutput(llmSpans[0], JSON.stringify({
    text: 'Thought: 先加载路由 Skill\nAction: skill\nAction Input: {"name":"coordinator-routing","version":1}',
    additional_kwargs: {},
  }));
  replaceOutput(llmSpans[1], JSON.stringify({
    message: {
      role: 'assistant',
      blocks: [{ block_type: 'text', text: '研究证据已经整理完成。' }],
    },
  }));
  replaceOutput(llmSpans[2], JSON.stringify({
    text: 'Thought: complete\nAnswer: 已完成汇总。',
  }));

  const normalized = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' });
  const normalizedOutputs = normalized
    .filter(event => event.kind === 'llm')
    .map(event => event.attributes['output.value']);
  assert.equal(normalizedOutputs.length, 3);
  assert.match(String(normalizedOutputs[1]), /研究证据已经整理完成/);
  const record = aggregateLlamaIndexTraceEvents('li-session', normalized);
  assert.ok(record);
  const contents = (record.interactions as RawInteraction[])
    .filter(interaction =>
      (interaction.role === 'assistant' || interaction.role === 'subagent')
      && !interaction.trace_synthetic
    )
    .map(interaction => interaction.content);
  assert.deepEqual(contents, [
    '先加载路由 Skill',
    '研究证据已经整理完成。',
    '已完成汇总。',
  ]);
  assert.equal(record.final_result, '已完成汇总。');
  assert.ok(contents.every(item => !String(item).startsWith('{')));
});

test('aggregates Agent, subagent, tool, LLM, RAG and workflow data', () => {
  const events = normalizeLlamaIndexOtlpTraces(payload(), { authenticatedUser: 'alice' });
  const record = aggregateLlamaIndexTraceEvents('li-session', events);
  assert.ok(record);
  assert.equal(record.framework, 'llamaindex');
  assert.equal(record.query, 'find evidence');
  assert.equal(record.final_result, 'final answer');
  assert.equal(record.latency, 0.5);
  assert.equal(record.tokens, 36);
  assert.equal(record.llm_call_count, 3);
  assert.equal(record.tool_call_count, 1);
  assert.equal(record.user, 'alice');
  assert.equal(record.interactions.find((item: RawInteraction) => item.role === 'system')?.content, 'Use evidence only.');
  assert.equal(
    record.interactions.find((item: RawInteraction) => item.role === 'assistant')?.requestMessages?.[0]?.role,
    'system',
  );
  assert.ok(record.interactions.some((item: RawInteraction) => item.trace_kind === 'chain' && item.trace_name === 'Retrieve context'));
  assert.ok(record.interactions.some((item: RawInteraction) => item.trace_kind === 'chain' && item.trace_name === 'Synthesize response'));
  assert.ok(record.interactions.some((item: RawInteraction) => item.trace_kind === 'chain' && item.trace_name === 'Finalize'));
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.agentName, 'Coordinator');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].agentName, 'Researcher');
  assert.ok(tree.children[0].events.some(event => event.kind === 'chain'));
  assert.ok(tree.events.some(event => event.kind === 'tool' && event.name === 'search' && event.summary === 'search (q=evidence)'));
});

test('hides low-value LlamaIndex runtime wrappers and keeps meaningful workflow steps', () => {
  const body = payload();
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  spans.push(
    span({ id: 'init', parent: 'root', name: 'AgentWorkflow.init_run', kind: 'workflow_step', start: 1001, attributes: { 'workflow.step.name': 'init_run', 'code.function': 'init_run' } }),
    span({ id: 'setup', parent: 'root', name: 'AgentWorkflow.setup_agent', kind: 'workflow_step', start: 1002, attributes: { 'workflow.step.name': 'setup_agent', 'code.function': 'setup_agent' } }),
    span({ id: 'parse', parent: 'root', name: 'AgentWorkflow.parse_agent_output', kind: 'workflow_step', start: 1210, attributes: { 'workflow.step.name': 'parse_agent_output', 'code.function': 'parse_agent_output' } }),
    span({ id: 'aggregate', parent: 'root', name: 'AgentWorkflow.aggregate_tool_results', kind: 'workflow_step', start: 1211, attributes: { 'workflow.step.name': 'aggregate_tool_results', 'code.function': 'aggregate_tool_results' } }),
  );

  const events = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' });
  const record = aggregateLlamaIndexTraceEvents('li-session', events);
  assert.ok(record);
  const chainNames = record.interactions
    .filter((item: RawInteraction) => item.trace_kind === 'chain')
    .map((item: RawInteraction) => item.trace_name);
  assert.ok(chainNames.includes('Run agent step'));
  assert.ok(chainNames.includes('Retrieve context'));
  assert.ok(chainNames.includes('Synthesize response'));
  assert.ok(chainNames.includes('Finalize'));
  assert.ok(!chainNames.some((name: string) => /Initialize|Setup|Parse agent output|Aggregate tool results/i.test(name)));
});

test('summarizes LlamaIndex Skill versions and custom Tool arguments', () => {
  const tree = buildAgentCallTree([{
    role: 'assistant',
    content: '执行计算流程',
    tool_calls: [
      { function: { name: 'skill', arguments: '{"name":"calculation-workflow","version":1}' } },
      { function: { name: 'multiply', arguments: '{"a":6,"b":7,"api_key":"redacted"}' } },
    ],
  }]);
  assert.ok(tree);
  assert.equal(tree.events.find(event => event.kind === 'skill')?.summary, 'skill: calculation-workflow@1');
  assert.equal(tree.events.find(event => event.kind === 'tool')?.summary, 'multiply (a=6, b=7)');
});

test('merges a context-only root name into its explicit Agent instance', () => {
  const body = payload();
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  spans[0].attributes.push(...attrs({ 'agent.name': 'Coordinator' }));
  spans[1].attributes.push(...attrs({ 'agent.instance.id': 'coordinator-instance' }));
  spans[4].attributes.push(...attrs({ 'agent.instance.id': 'researcher-instance' }));
  // Context metadata can remain stale after a handoff; structural ancestry
  // must win over that context-only root name.
  spans[6].attributes.push(...attrs({ 'agent.name': 'Coordinator' }));

  const events = normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' });
  const record = aggregateLlamaIndexTraceEvents('li-session', events);
  assert.ok(record);
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.agentName, 'Coordinator');
  assert.deepEqual(tree.children.map(child => child.agentName), ['Researcher']);
  assert.ok(tree.children[0].events.some(event => event.kind === 'llm'));
  assert.equal(tree.stats.llmCalls + tree.children[0].stats.llmCalls, 3);
  const taskNames = (record.interactions as RawInteraction[])
    .flatMap(interaction => interaction.tool_calls || [])
    .filter(call => call.function?.name === 'task')
    .map(call => JSON.parse(call.function?.arguments || '{}').subagent_type);
  assert.deepEqual(taskNames, ['researcher']);
  const spawn = (record.interactions as RawInteraction[]).find(interaction => interaction.trace_synthetic);
  assert.equal(spawn?.trace_synthetic, true);
});

test('uses handoff ownership to preserve a multi-level AgentWorkflow tree', () => {
  const body = payload();
  const spans = body.resourceSpans[0].scopeSpans[0].spans;
  spans[1].attributes.push(...attrs({ 'agent.instance.id': 'coordinator-instance' }));
  spans[4].attributes.push(...attrs({ 'agent.instance.id': 'researcher-instance' }));
  spans.push(
    span({
      id: 'handoff1',
      parent: 'llm1',
      name: 'AgentWorkflow.call_tool',
      kind: 'tool',
      start: 1090,
      attributes: {
        'agent.name': 'Coordinator',
        'tool.name': 'handoff',
        'tool.arguments': '{"to_agent":"Researcher","reason":"research first"}',
      },
    }),
    span({
      id: 'handoff2',
      parent: 'root',
      name: 'AgentWorkflow.call_tool',
      kind: 'tool',
      start: 1210,
      attributes: {
        // Real AgentWorkflow traces keep the root name on sibling tool spans;
        // the preceding explicit Researcher instance identifies the owner.
        'agent.name': 'Coordinator',
        'tool.name': 'handoff',
        'tool.arguments': '{"to_agent":"Writer","reason":"write the result"}',
      },
    }),
    span({
      id: 'writer',
      parent: 'root',
      name: 'AgentWorkflow.run_agent_step',
      kind: 'workflow_step',
      start: 1230,
      attributes: {
        'agent.name': 'Writer',
        'agent.instance.id': 'writer-instance',
        'workflow.step.name': 'run_agent_step',
      },
    }),
    span({
      id: 'writerllm',
      parent: 'writer',
      name: 'OpenAILike.chat',
      kind: 'llm',
      start: 1240,
      attributes: {
        'agent.name': 'Writer',
        'gen_ai.request.model': 'deepseek-v4-pro',
        'output.value': 'written result',
      },
    }),
  );

  const record = aggregateLlamaIndexTraceEvents(
    'li-session',
    normalizeLlamaIndexOtlpTraces(body, { authenticatedUser: 'alice' }),
  );
  assert.ok(record);
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.deepEqual(tree.children.map(child => child.agentName), ['Researcher']);
  assert.deepEqual(tree.children[0].children.map(child => child.agentName), ['Writer']);
});

test('keeps concurrent same-name Agent instances as separate child nodes', () => {
  const events = normalizeLlamaIndexOtlpTraces(payload());
  const first = events.find(event => event.attributes?.['agent.name'] === 'Researcher');
  assert.ok(first);
  first.attributes = { ...first.attributes, 'agent.instance.id': 'researcher-instance-a' };
  const second = {
    ...first,
    spanId: 'subb',
    startTimeMs: first.startTimeMs + 1,
    attributes: {
      ...first.attributes,
      'agent.instance.id': 'researcher-instance-b',
      'agent.task': 'research independent evidence',
      'agent.insight.status': 'error',
    },
  };
  const record = aggregateLlamaIndexTraceEvents('li-session', [...events, second]);
  assert.ok(record);
  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map(child => child.agentName), ['Researcher', 'Researcher']);
  assert.notEqual(tree.children[0].sessionId, tree.children[1].sessionId);
  const failedSpawn = (record.interactions as RawInteraction[])
    .flatMap((interaction: RawInteraction) => interaction.tool_calls || [])
    .find((call: ToolCall) =>
      String(call.function?.arguments).includes('researcher-instance-b')
    );
  assert.equal(failedSpawn?.state, 'error');
});

test('registers LlamaIndex ahead of the generic OTLP fallback', () => {
  const events = normalizeLlamaIndexOtlpTraces(payload());
  assert.equal(getOtelTraceAdapter(events).id, 'llamaindex');
  assert.equal(resolveFrameworkId('llama-index'), 'llamaindex');
  const adapter = getAdapter('llamaindex');
  assert.equal(adapter.descriptor.onboard, 'plugin');
  assert.equal(adapter.capabilities?.subagentTree, true);
  assert.equal(adapter.sessionMergeStrategy, 'snapshot-replace');
});

test('extracts skill calls from normalized LlamaIndex interactions', () => {
  const adapter = getAdapter('llamaindex');
  const skills = adapter.extractSkills?.([{
    role: 'assistant',
    tool_calls: [{ function: { name: 'load_skill', arguments: '{"name":"research","version":2}' } }],
  }]);
  assert.deepEqual(skills, [{ name: 'research', version: 2 }]);
});
