import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { getOtelTraceAdapter } from '@/lib/ingest/otel/adapter-registry';
import {
  aggregateQwenCodeTraceEvents,
  isolateQwenCodeOtelEvent,
  protectQwenTraceContent,
  qwenSkillLogToOtelEvent,
} from '@/lib/ingest/otel/adapters/qwencode';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { shouldRefreshStoredQueryFromInteractions } from '@/lib/storage/data-service';
import { extractSkillsWithVersionsFromToolInteractions, normalizeInteractions } from '@/lib/shared/interaction-utils';

function event(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: '2026-07-22T00:00:00.000Z',
    sessionId: 'qwen-session',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'span',
    kind: 'llm',
    serviceName: 'qwencode',
    user: 'admin',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 100,
    startTimeMs: 1_000,
    attributes: { 'agent.insight.framework': 'qwencode' },
    ...overrides,
  };
}

test('QwenCode native OTLP content is redacted and capped at 2000 characters', () => {
  const protectedContent = protectQwenTraceContent(
    `apiKey=sk-sensitive Bearer top-secret ${'x'.repeat(2_500)}`,
  );

  assert.equal(protectedContent.length, 2_000);
  assert.match(protectedContent, /^apiKey=\[REDACTED\] Bearer \[REDACTED\]/);
  assert.match(protectedContent, /…\[truncated\]$/);
  assert.doesNotMatch(protectedContent, /sk-sensitive|top-secret/);
});

test('QwenCode replaces its placeholder query when complete interactions arrive', () => {
  assert.equal(shouldRefreshStoredQueryFromInteractions('Qwen Code Session', 'qwencode'), true);
  assert.equal(shouldRefreshStoredQueryFromInteractions('actual user query', 'qwencode'), false);
});

test('QwenCode uses the canonical root agent name instead of its OTLP service name', () => {
  const record = aggregateQwenCodeTraceEvents('qwen-session', [event({
    name: 'qwen-code.interaction',
    spanId: 'root-agent-name',
    serviceName: 'qwencode',
    attributes: { 'agent.insight.framework': 'qwencode', 'input.value': 'hello' },
  })]);

  assert.equal(record?.agentName, 'qwen-code');
  assert.equal((record?.interactions?.[0] as any)?.agent, 'qwen-code');
});

test('QwenCode adapter applies the native OTLP content limit to query and response', () => {
  const longPrompt = 'p'.repeat(2_500);
  const longResponse = 'r'.repeat(2_500);
  const record = aggregateQwenCodeTraceEvents('qwen-session', [
    event({
      name: 'qwen-code.interaction',
      kind: 'llm',
      spanId: 'root',
      attributes: { 'agent.insight.framework': 'qwencode' },
    }),
    event({
      name: 'qwen-code.llm_request',
      spanId: 'llm',
      startTimeMs: 1_100,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: longPrompt }] }]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: longResponse }] }]),
      },
    }),
  ]);

  assert.ok(record);
  assert.equal(record.query?.length, 2_000);
  assert.match(record.query || '', /…\[truncated\]$/);
  const assistant = record.interactions?.find((interaction: any) => interaction.spanId === 'llm');
  assert.equal(String(assistant?.content || '').length, 2_000);
  assert.match(String(assistant?.content || ''), /…\[truncated\]$/);
});

test('QwenCode adapter aggregates an agent span and its tool span', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      latencyMs: 2_000,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'agent',
        'openinference.span.kind': 'AGENT',
        'input.value': 'Read package.json',
        'gen_ai.request.model': 'qwen3.7-plus',
      },
    }),
    event({
      spanId: 'tool-read',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'tool.read_file',
      startTimeMs: 1_100,
      latencyMs: 40,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'tool',
        'tool.name': 'read_file',
        'tool.arguments': '{"file_path":"package.json"}',
        'tool.output': 'Read package.json',
        'tool.status': 'ok',
      },
    }),
    event({
      spanId: 'llm-response',
      parentSpanId: 'root-agent',
      name: 'llm.qwen-code.chat',
      startTimeMs: 1_200,
      latencyMs: 500,
      usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, total_tokens: 120 },
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'llm',
        'gen_ai.request.model': 'qwen3.7-plus',
        'gen_ai.provider.name': 'openai',
        'output.value': 'The package name is agent-insight.',
      },
    }),
    event({
      spanId: 'hook-stop',
      parentSpanId: 'root-agent',
      // The shared production normalizer represents degraded hook spans as
      // kind=llm, so the Qwen adapter must prefer trace_type=hook.
      kind: 'llm',
      name: 'hook.Stop',
      startTimeMs: 1_800,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'hook',
        'openinference.span.kind': 'INTERNAL',
        'hook.event.name': 'Stop',
        'hook.status': 'ok',
      },
    }),
    // Simulate replay after the server accepted a batch but the collector
    // crashed before moving its local spool file to uploaded/.
    event({
      spanId: 'tool-read',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'tool.read_file',
      startTimeMs: 1_100,
      latencyMs: 40,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'tool',
        'tool.name': 'read_file',
        'tool.arguments': '{"file_path":"package.json"}',
        'tool.output': 'Read package.json',
        'tool.status': 'ok',
      },
    }),
  ];

  assert.equal(getOtelTraceAdapter(events).id, 'qwencode');
  const record = aggregateOtelTraceEvents('qwen-session', events);

  assert.ok(record);
  assert.equal(record.framework, 'qwencode');
  assert.equal(record.user, 'admin');
  assert.equal(record.model, 'qwen3.7-plus');
  assert.equal(record.query, 'Read package.json');
  assert.equal(record.latency, 2);
  assert.equal(new Date(record.timestamp as Date).getTime(), 3_000);
  assert.equal(record.tokens, 125);
  assert.equal(record.llm_call_count, 1);
  assert.equal(record.tool_call_count, 1);
  assert.equal(record.interactions?.[0]?.role, 'user');
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.function?.name, 'read_file');
  assert.equal(record.interactions?.[1]?.tool_calls?.[0]?.output, 'Read package.json');
  assert.equal(record.interactions?.[2]?.content, 'The package name is agent-insight.');
  assert.doesNotMatch(JSON.stringify(record.interactions), /hook\.Stop/);
});

test('QwenCode adapter aggregates Qwen native OTLP GenAI spans', () => {
  const events = [
    event({
      spanId: 'native-root',
      name: 'qwen-code.interaction',
      latencyMs: 900,
      attributes: { 'gen_ai.request.model': 'qwen3-coder', 'session.id': 'native-session' },
    }),
    event({
      spanId: 'native-resumed-interaction',
      name: 'qwen-code.interaction',
      startTimeMs: 5_000,
      latencyMs: 1_000,
      attributes: { 'gen_ai.request.model': 'qwen3-coder', 'interaction.sequence': 2 },
    }),
    event({
      spanId: 'native-llm', parentSpanId: 'native-root', name: 'qwen-code.llm_request', startTimeMs: 1_100,
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      attributes: {
        'gen_ai.request.model': 'qwen3-coder',
        'gen_ai.provider.name': 'dashscope',
        'gen_ai.input.messages': JSON.stringify([
          { role: 'system', content: 'You are Qwen Code.' },
          { role: 'user', content: 'Read package.json' },
        ]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'The package is agent-insight.' }]),
      },
    }),
    event({
      spanId: 'native-side-query', name: 'qwen-code.llm_request', startTimeMs: 8_000,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      attributes: {
        'qwen-code.prompt_id': 'side-query:prompt-suggestion',
        'gen_ai.request.model': 'qwen3-coder',
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'Background suggestion.' }]),
      },
    }),
    event({
      spanId: 'native-http-wrapper', name: 'POST', startTimeMs: 9_000, latencyMs: 5_000,
      attributes: { 'http.request.method': 'POST', 'url.path': '/chat/completions' },
    }),
    event({
      spanId: 'native-tool', parentSpanId: 'native-root', name: 'qwen-code.tool', kind: 'llm', startTimeMs: 1_250,
      attributes: {
        'gen_ai.tool.name': 'shell',
        'gen_ai.tool.call.arguments': '{"command":"node -p \\"require(\\\'./package.json\\\').name\\""}',
        'gen_ai.tool.call.result': 'agent-insight',
      },
    }),
    event({
      spanId: 'native-tool-pre-hook', parentSpanId: 'native-tool', name: 'qwen-code.hook', startTimeMs: 1_251,
      attributes: { 'tool.name': 'shell', error: 'Hook event is not a tool call' },
    }),
    event({
      spanId: 'native-tool-execution', parentSpanId: 'native-tool', name: 'qwen-code.tool.execution', startTimeMs: 1_252,
      attributes: { 'gen_ai.tool.name': 'shell' },
    }),
    event({
      spanId: 'native-subagent', parentSpanId: 'native-root', name: 'qwen-code.subagent', startTimeMs: 1_300,
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      attributes: {
        'qwen-code.subagent.id': 'native-explore-1',
        'qwen-code.subagent.name': 'Explore',
        'qwen-code.subagent.invocation_kind': 'fork',
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'Inspection complete.' }]),
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  assert.ok(record);
  assert.equal(getOtelTraceAdapter(events).id, 'qwencode');
  assert.equal(record.query, 'Read package.json');
  assert.equal(record.model, 'qwen3-coder');
  assert.equal(record.tokens, 23);
  assert.equal(record.latency, 5);
  assert.equal(record.llm_call_count, 1);
  assert.equal(record.tool_call_count, 1);
  assert.match(JSON.stringify(record.interactions), /The package is agent-insight/);
  assert.match(JSON.stringify(record.interactions), /agent-insight/);
  const tool = record.interactions?.find((item: Record<string, any>) => item.tool_calls?.[0]?.function?.name === 'shell');
  assert.equal(tool?.tool_calls?.[0]?.output, 'agent-insight');
  const subagent = record.interactions?.find((item: Record<string, any>) => item.subagent_session_id === 'native-explore-1');
  assert.equal(subagent?.fork, true);
  assert.equal(subagent?.content, 'Inspection complete.');
});

test('QwenCode adapter converts the native skill_launch OTLP log into a skill event', () => {
  const skill = qwenSkillLogToOtelEvent({
    receivedAt: '2026-08-08T00:00:00.000Z',
    eventName: 'qwen-code.skill_launch',
    eventTimestamp: '2026-08-08T00:00:01.000Z',
    sessionId: 'qwen-session',
    resource: { 'service.name': 'qwencode' },
    attributes: { skill_name: 'project-info', success: true },
    body: 'Skill launch: project-info. Success: true.',
    traceId: 'c'.repeat(32),
    spanId: 'skill-log',
  });
  assert.ok(skill);
  assert.equal(skill.sessionId, 'qwencode:qwen-session');
  assert.equal(skill.attributes['agent.insight.trace_type'], 'skill');
  assert.equal(skill.attributes['skill.name'], 'project-info');

  const root = event({
    spanId: 'root-agent', name: 'qwen-code.interaction',
    attributes: { 'gen_ai.request.model': 'qwen3-coder' },
  });
  const record = aggregateOtelTraceEvents('qwencode:qwen-session', [isolateQwenCodeOtelEvent(root), skill]);
  assert.equal(record?.tool_call_count, 0);
  assert.match(JSON.stringify(record?.interactions), /project-info/);
});

test('QwenCode Skill aggregation prefers the complete Tool span in either arrival order', () => {
  const root = isolateQwenCodeOtelEvent(event({
    spanId: 'root-agent', name: 'qwen-code.interaction', latencyMs: 3_000,
    attributes: { 'gen_ai.request.model': 'qwen3-coder' },
  }));
  const skillLog = qwenSkillLogToOtelEvent({
    receivedAt: '2026-08-08T00:00:00.000Z', eventName: 'qwen-code.skill_launch',
    eventTimestamp: '2026-08-08T00:00:02.000Z', sessionId: 'qwen-session',
    resource: { 'service.name': 'qwencode' },
    attributes: { skill_name: 'project-info', success: true },
    body: 'Skill launch: project-info. Success: true.',
    traceId: 'd'.repeat(32), spanId: 'same-skill-span',
  });
  assert.ok(skillLog);
  const completeTool = isolateQwenCodeOtelEvent(event({
    traceId: 'd'.repeat(32), spanId: 'same-skill-span', parentSpanId: 'root-agent',
    name: 'qwen-code.tool', startTimeMs: 1_200, latencyMs: 750,
    attributes: {
      'gen_ai.tool.name': 'skill',
      'gen_ai.tool.call.arguments': '{"skill":"project-info"}',
      'gen_ai.tool.call.result': '{"output":"complete skill instructions"}',
    },
  }));

  for (const pair of [[skillLog, completeTool], [completeTool, skillLog]]) {
    const record = aggregateOtelTraceEvents('qwencode:qwen-session', [root, ...pair]);
    const skill = record?.interactions?.find((item: Record<string, any>) =>
      item.tool_calls?.[0]?.function?.name === 'skill',
    );
    assert.equal(skill?.tool_calls?.[0]?.output, '{"output":"complete skill instructions"}');
    assert.equal(skill?.timeInfo?.completed, '1970-01-01T00:00:01.950Z');
  }
});

test('QwenCode adapter ignores foreign collector events even when a session id collides', () => {
  const qwenRoot = event({
    spanId: 'qwen-root',
    name: 'agent.qwen-code',
    attributes: {
      'agent.insight.framework': 'qwencode',
      'agent.insight.trace_type': 'agent',
      'input.value': 'Qwen-only request',
    },
  });
  const foreignTool = event({
    spanId: 'foreign-tool',
    serviceName: 'hermes',
    kind: 'tool',
    name: 'tool.foreign',
    attributes: {
      'agent.insight.framework': 'hermes',
      'agent.insight.trace_type': 'tool',
      'tool.name': 'foreign',
      'tool.output': 'must not enter the Qwen trace',
    },
  });

  const record = aggregateQwenCodeTraceEvents('qwen-session', [qwenRoot, foreignTool]);

  assert.ok(record);
  assert.equal(record.framework, 'qwencode');
  assert.equal(record.query, 'Qwen-only request');
  assert.equal(record.tool_call_count, 0);
  assert.doesNotMatch(JSON.stringify(record.interactions), /foreign|must not enter/);
});

test('QwenCode ingest namespaces a colliding session without changing foreign events', () => {
  const qwenRoot = event({
    sessionId: 'shared-session',
    spanId: 'qwen-root',
    name: 'agent.qwen-code',
    attributes: {
      'agent.insight.framework': 'qwencode',
      'agent.insight.trace_type': 'agent',
      'input.value': 'Qwen request',
    },
  });
  const foreignRoot = event({
    sessionId: 'shared-session',
    spanId: 'hermes-root',
    serviceName: 'hermes',
    name: 'agent.hermes',
    attributes: {
      'agent.insight.framework': 'hermes',
      'agent.insight.trace_type': 'agent',
      'openinference.span.kind': 'AGENT',
      'input.value': 'Hermes request',
    },
  });

  const isolatedQwen = isolateQwenCodeOtelEvent(qwenRoot);
  const unchangedForeign = isolateQwenCodeOtelEvent(foreignRoot);

  assert.equal(isolatedQwen.sessionId, 'qwencode:shared-session');
  assert.equal(isolatedQwen.attributes['qwen.session.id'], 'shared-session');
  assert.equal(unchangedForeign, foreignRoot);

  const events = [isolatedQwen, unchangedForeign];
  const qwenRecord = aggregateOtelTraceEvents('qwencode:shared-session', events);
  const foreignRecord = aggregateOtelTraceEvents('shared-session', events);
  assert.ok(qwenRecord);
  assert.ok(foreignRecord);
  assert.equal(qwenRecord?.framework, 'qwencode');
  assert.notEqual(foreignRecord?.framework, 'qwencode');
});

test('QwenCode adapter links a capitalized Qwen subagent type into the agent tree', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'delegate' },
    }),
    event({
      spanId: 'child-agent',
      parentSpanId: 'root-agent',
      name: 'agent.Explore',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'subagent',
        'agent.id': 'Explore-call-1',
        'agent.type': 'Explore',
        'agent.llm_call_count': 1,
        'output.value': 'done',
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].agentName, 'Explore');
  assert.equal(tree.children[0].subagentType, 'explore');
  assert.equal(record?.tokens, 15);
  assert.equal(record?.llm_call_count, 1);
});

test('QwenCode adapter restores a nested subagent delegation chain', () => {
  const events = [
    event({ spanId: 'root-agent', name: 'agent.qwen-code', attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'nested' } }),
    event({
      spanId: 'parent-agent', parentSpanId: 'root-agent', name: 'agent.Explore',
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent', 'agent.id': 'Explore-1', 'agent.type': 'Explore' },
    }),
    event({
      spanId: 'child-agent', parentSpanId: 'parent-agent', name: 'agent.Plan', startTimeMs: 1_100,
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent', 'agent.id': 'Plan-1', 'agent.type': 'Plan', 'agent.parent_id': 'Explore-1' },
    }),
    event({
      spanId: 'grandchild-agent', parentSpanId: 'child-agent', name: 'agent.Review', startTimeMs: 1_200,
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent', 'agent.id': 'Review-1', 'agent.type': 'Review', 'agent.parent_id': 'Plan-1' },
    }),
  ];
  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].agentName, 'Explore');
  assert.equal(tree.children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].agentName, 'Plan');
  assert.equal(tree.children[0].children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].children[0].agentName, 'Review');
});

test('QwenCode adapter preserves Fork subagent context inheritance', () => {
  const events = [
    event({ spanId: 'root-agent', name: 'agent.qwen-code', attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'fork work' } }),
    event({
      spanId: 'fork-agent-running', parentSpanId: 'root-agent', name: 'agent.fork', startTimeMs: 1_050, latencyMs: 5,
      attributes: {
        'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent',
        'agent.id': 'fork-1', 'agent.type': 'fork', 'agent.fork': 'true',
        'agent.forked_from_session_id': 'qwen-session',
        'agent.status': 'running', 'output.value': 'Fork started',
      },
    }),
    event({
      spanId: 'fork-agent-completed', parentSpanId: 'root-agent', name: 'agent.fork', startTimeMs: 1_050, latencyMs: 500,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      attributes: {
        'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent',
        'agent.id': 'fork-1', 'agent.type': 'fork', 'agent.fork': 'true',
        'agent.forked_from_session_id': 'qwen-session',
        'agent.status': 'ok', 'output.value': 'FORK-RETRY-0722',
      },
    }),
  ];
  const record = aggregateOtelTraceEvents('qwen-session', events);
  const fork = record?.interactions?.find(
    (interaction: Record<string, unknown>) => interaction.subagent_session_id === 'fork-1',
  );
  assert.ok(fork);
  assert.equal(fork.fork, true);
  assert.equal(fork.forked_from_session_id, 'qwen-session');
  assert.equal(fork.content, 'FORK-RETRY-0722');
  assert.equal(record?.tokens, 12);
});

test('QwenCode adapter keeps concurrent subagents as siblings', () => {
  const events = [
    event({ spanId: 'root-agent', name: 'agent.qwen-code', attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'parallel work' } }),
    event({
      spanId: 'explore-agent', parentSpanId: 'root-agent', name: 'agent.Explore', startTimeMs: 1_100,
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent', 'agent.id': 'Explore-1', 'agent.type': 'Explore' },
    }),
    event({
      spanId: 'review-agent', parentSpanId: 'root-agent', name: 'agent.Review', startTimeMs: 1_100,
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent', 'agent.id': 'Review-1', 'agent.type': 'Review' },
    }),
  ];
  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(tree);
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map((child) => child.agentName).sort(), ['Explore', 'Review']);
  assert.ok(tree.children.every((child) => child.children.length === 0));
});

test('QwenCode adapter attributes native subagent LLM usage to the matching child trace', () => {
  const events = [
    event({
      traceId: 'root-trace', spanId: 'root-agent', name: 'qwen-code.interaction', latencyMs: 5_000,
      attributes: { 'gen_ai.agent.name': 'qwencode', 'input.value': 'run two Explore agents' },
    }),
    event({
      traceId: 'root-llm-trace', spanId: 'root-llm', name: 'qwen-code.llm_request', startTimeMs: 1_010,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      attributes: { 'gen_ai.request.model': 'qwen', 'qwen-code.prompt_id': 'qwen-session########0' },
    }),
    event({
      traceId: 'child-trace-a', spanId: 'child-a', name: 'qwen-code.subagent', startTimeMs: 1_100, latencyMs: 1_000,
      attributes: {
        'gen_ai.agent.name': 'Explore',
        'qwen-code.subagent.id': 'Explore-call-a',
        'qwen-code.subagent.name': 'Explore',
      },
    }),
    event({
      traceId: 'child-trace-b', spanId: 'child-b', name: 'qwen-code.subagent', startTimeMs: 1_100, latencyMs: 1_200,
      attributes: {
        'gen_ai.agent.name': 'Explore',
        'qwen-code.subagent.id': 'Explore-call-b',
        'qwen-code.subagent.name': 'Explore',
      },
    }),
    event({
      traceId: 'child-trace-a', spanId: 'child-a-llm-1', name: 'qwen-code.llm_request', startTimeMs: 1_120,
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      attributes: { subagent_name: 'Explore', 'qwen-code.prompt_id': 'qwen-session#Explore-a#0', 'output.value': 'Inspecting package.json' },
    }),
    event({
      traceId: 'child-trace-a', spanId: 'child-a-llm-2', name: 'qwen-code.llm_request', startTimeMs: 1_500,
      usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
      attributes: { subagent_name: 'Explore', 'qwen-code.prompt_id': 'qwen-session#Explore-a#1', 'output.value': 'Package result' },
    }),
    event({
      traceId: 'child-trace-b', spanId: 'child-b-llm', name: 'qwen-code.llm_request', startTimeMs: 1_130,
      usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
      attributes: { subagent_name: 'Explore', 'qwen-code.prompt_id': 'qwen-session#Explore-b#0', 'output.value': 'README result' },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(record);
  assert.ok(tree);
  assert.equal(record.tokens, 158);
  assert.equal(tree.stats.totalTokens, 110);
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map((child) => child.stats.totalTokens).sort((a, b) => a - b), [23, 25]);
  assert.deepEqual(tree.children.map((child) => child.stats.llmCalls).sort((a, b) => a - b), [1, 2]);
  assert.equal(
    tree.stats.totalTokens + tree.children.reduce((sum, child) => sum + child.stats.totalTokens, 0),
    record.tokens,
  );
});

test('QwenCode adapter restores Agent Team members delegated through agent tools', () => {
  const events = [
    event({ spanId: 'root-agent', name: 'agent.qwen-code', attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'team work' } }),
    event({
      spanId: 'team-explorer', parentSpanId: 'root-agent', name: 'agent.explorer', startTimeMs: 1_100,
      attributes: {
        'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent',
        'agent.id': 'team-1:member:explorer', 'agent.name': 'explorer', 'agent.type': 'Explore',
        'team.id': 'team-1', 'team.name': 'pkg-inspect', 'output.value': 'Task #1 updated (status: completed, owner: explorer).',
      },
    }),
    event({
      spanId: 'team-reviewer', parentSpanId: 'root-agent', name: 'agent.reviewer', startTimeMs: 1_100,
      attributes: {
        'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'subagent',
        'agent.id': 'team-1:member:reviewer', 'agent.name': 'reviewer', 'agent.type': 'Explore',
        'team.id': 'team-1', 'team.name': 'pkg-inspect', 'output.value': 'Task #2 updated (status: completed, owner: reviewer).',
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(tree);
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map((child) => child.agentName).sort(), ['explorer', 'reviewer']);
  assert.deepEqual(tree.children.map((child) => child.subagentType).sort(), ['explorer', 'reviewer']);
});

test('QwenCode adapter retains model and provider for each protocol switch', () => {
  const events = [
    event({ spanId: 'root-agent', name: 'agent.qwen-code', attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'switch provider' } }),
    event({
      spanId: 'qwen-call', parentSpanId: 'root-agent', name: 'llm.qwen-code.chat', kind: 'llm', startTimeMs: 1_100,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'llm', 'gen_ai.request.model': 'qwen3.7-plus', 'gen_ai.provider.name': 'qwen', 'output.value': 'qwen response' },
    }),
    event({
      spanId: 'ollama-call', parentSpanId: 'root-agent', name: 'llm.qwen-code.chat', kind: 'llm', startTimeMs: 1_200,
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'llm', 'gen_ai.request.model': 'qwen2.5-coder:7b', 'gen_ai.provider.name': 'ollama', 'output.value': 'local response' },
    }),
  ];
  const record = aggregateOtelTraceEvents('qwen-session', events);
  const llmTurns = record?.interactions?.filter(
    (interaction: Record<string, unknown>) => interaction.role === 'assistant' && interaction.spanId,
  ) || [];
  assert.deepEqual(llmTurns.map((turn: Record<string, unknown>) => [turn.model, turn.provider]), [
    ['qwen3.7-plus', 'qwen'],
    ['qwen2.5-coder:7b', 'ollama'],
  ]);
  assert.equal(record?.tokens, 27);
});

test('QwenCode adapter exposes Qwen skill calls without counting them as tools', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'agent',
        'input.value': 'Use the demo skill',
      },
    }),
    event({
      spanId: 'skill-call',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'skill.demo-skill',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'skill',
        'tool.name': 'skill',
        'tool.arguments': '{"skill":"demo-skill","version":"1.2.0"}',
        'tool.output': 'Skill loaded',
        'tool.status': 'ok',
        'skill.name': 'demo-skill',
        'skill.version': '1.2.0',
        'skill.trigger_mode': 'tool',
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(record);
  assert.ok(tree);
  assert.equal(record.tool_call_count, 0);
  assert.equal(tree.stats.toolCalls, 0);
  assert.equal(tree.stats.skillCalls, 1);
  assert.equal(tree.events.find((item) => item.kind === 'skill')?.args?.skill, 'demo-skill');
  assert.equal(tree.events.find((item) => item.kind === 'skill')?.name, 'demo-skill');
  assert.deepEqual(
    extractSkillsWithVersionsFromToolInteractions(normalizeInteractions(record.interactions || [])),
    [{ name: 'demo-skill', version: null }],
  );
});

test('QwenCode adapter keeps an MCP span as one tool interaction', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'agent',
        'input.value': 'Call an MCP tool',
      },
    }),
    event({
      spanId: 'mcp-call',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'mcp.filesystem.read_file',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'mcp',
        'tool.name': 'mcp__filesystem__read_file',
        'tool.arguments': '{"path":"package.json"}',
        'tool.output': 'package contents',
        'tool.status': 'ok',
        'rpc.system': 'mcp',
        'mcp.server.name': 'filesystem',
        'mcp.tool.name': 'read_file',
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(record);
  assert.ok(tree);
  assert.equal(record.tool_call_count, 1);
  assert.equal(tree.stats.toolCalls, 1);
  assert.equal(tree.stats.skillCalls, 0);
  assert.equal(tree.events.find((item) => item.kind === 'tool')?.name, 'mcp__filesystem__read_file');
});

test('QwenCode adapter preserves Plan Mode phases as tool interactions', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'agent',
        'input.value': 'Plan this change',
      },
    }),
    event({
      spanId: 'plan-enter',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'plan.enter',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'plan',
        'tool.name': 'enter_plan_mode',
        'tool.arguments': '{"userRequested":true}',
        'tool.output': 'Entered plan mode.',
        'tool.status': 'ok',
        'plan.id': 'qwen-session:plan:1',
        'plan.phase': 'enter',
        'plan.status': 'active',
      },
    }),
    event({
      spanId: 'plan-steps',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'plan.steps',
      startTimeMs: 1_200,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'plan',
        'tool.name': 'todo_write',
        'tool.arguments': '{"todos":[{"id":"1","content":"Inspect code","status":"completed"}]}',
        'tool.output': 'Todos updated',
        'tool.status': 'ok',
        'plan.id': 'qwen-session:plan:1',
        'plan.phase': 'steps',
        'plan.status': 'updated',
      },
    }),
    event({
      spanId: 'plan-exit',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'plan.proposal',
      startTimeMs: 1_400,
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'plan',
        'tool.name': 'exit_plan_mode',
        'tool.arguments': '{"plan":"1. Inspect code\\n2. Implement"}',
        'tool.output': 'User approved.',
        'tool.status': 'ok',
        'plan.id': 'qwen-session:plan:1',
        'plan.phase': 'proposal',
        'plan.status': 'approved',
      },
    }),
  ];

  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(record);
  assert.ok(tree);
  assert.equal(record.tool_call_count, 3);
  assert.equal(tree.stats.toolCalls, 3);
  assert.deepEqual(
    tree.events.filter((item) => item.kind === 'tool').map((item) => item.name),
    ['enter_plan_mode', 'todo_write', 'exit_plan_mode'],
  );
});

test('QwenCode adapter retains Team lifecycle actions as part of the root trace', () => {
  const events = [
    event({
      spanId: 'root-agent',
      name: 'agent.qwen-code',
      attributes: { 'agent.insight.framework': 'qwencode', 'agent.insight.trace_type': 'agent', 'input.value': 'Use a team' },
    }),
    event({
      spanId: 'team-create',
      parentSpanId: 'root-agent',
      kind: 'tool',
      name: 'team.create',
      attributes: {
        'agent.insight.framework': 'qwencode',
        'agent.insight.trace_type': 'team',
        'tool.name': 'team_create',
        'tool.arguments': '{"team_name":"health-check","description":"Implement endpoint"}',
        'tool.output': 'Team created',
        'tool.status': 'ok',
        'team.id': 'qwen-session:team:health-check',
        'team.name': 'health-check',
        'team.action': 'create',
      },
    }),
  ];
  const record = aggregateOtelTraceEvents('qwen-session', events);
  const tree = buildAgentCallTree(record?.interactions || []);
  assert.ok(record);
  assert.ok(tree);
  assert.equal(record.tool_call_count, 1);
  assert.equal(tree.events.find((item) => item.kind === 'tool')?.name, 'team_create');
});
