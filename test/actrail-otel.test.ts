import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { getAdapter, resolveFrameworkId } from '@/lib/ingest/adapters/registry';
import { getOtelTraceAdapter } from '@/lib/ingest/otel/adapter-registry';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { isActrailOtlpTraceBody } from '@/lib/ingest/otel/actrail';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';

function attr(key: string, value: string | number | boolean) {
  const encoded = typeof value === 'number'
    ? { intValue: String(value) }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : { stringValue: value };
  return { key, value: encoded };
}

function bodyFor(span: Record<string, any>) {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          attr('service.name', 'default-full-monitor-ebpf-on-notify-on'),
          attr('actrail.trace.display_name', 'quickstart'),
          attr('actrail.trace.profile_name', 'default-full-monitor-ebpf-on-notify-on'),
          attr('actrail.trace.id', 3),
        ],
      },
      scopeSpans: [{
        scope: { name: 'actrail.semantic_actions', version: '0.7.1' },
        spans: [span],
      }],
    }],
  };
}

function span(overrides: Record<string, any>) {
  return {
    traceId: '00000000000000000000000000000003',
    spanId: 'span-default',
    name: 'AcTrail action',
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '2000000000',
    status: { code: 'STATUS_CODE_OK' },
    attributes: [],
    ...overrides,
  };
}

function normalizeBodies(bodies: any[]): OtelTraceEvent[] {
  return bodies.flatMap((body) => normalizeOtlpTraces(body, {
    receivedAt: '2026-07-30T00:00:00.000Z',
    authenticatedUser: 'alice',
  }));
}

test('AcTrail OTLP: detects semantic-action scope and preserves source metadata', () => {
  const body = bodyFor(span({
    spanId: 'response',
    name: 'LLM response deepseek-v4-flash',
    attributes: [
      attr('actrail.action.id', 'trace:3:llm.response'),
      attr('actrail.action.kind', 'llm.response'),
      attr('actrail.action.status', 'success'),
      attr('actrail.action.completeness', 'complete'),
      attr('llm.response.model', 'deepseek-v4-flash'),
      attr('llm.response.prompt_tokens', 11),
      attr('llm.response.completion_tokens', 7),
      attr('llm.response.reasoning_tokens', 3),
      attr('llm.response.total_tokens', 18),
    ],
  }));

  assert.equal(isActrailOtlpTraceBody(body), true);
  const events = normalizeOtlpTraces(body, {
    receivedAt: '2026-07-30T00:00:00.000Z',
    authenticatedUser: 'alice',
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].serviceName, 'actrail');
  assert.equal(events[0].sessionId, '00000000000000000000000000000003');
  assert.equal(events[0].kind, 'llm');
  assert.equal(events[0].model, 'deepseek-v4-flash');
  assert.equal(events[0].user, 'alice');
  assert.deepEqual(events[0].usage, {
    input_tokens: 11,
    output_tokens: 7,
    reasoning_tokens: 3,
    total_tokens: 18,
  });
  assert.equal(events[0].attributes['actrail.trace.display_name'], 'quickstart');
  assert.equal(events[0].attributes['otel.scope.name'], 'actrail.semantic_actions');
  assert.equal(events[0].attributes['otel.scope.version'], '0.7.1');
  assert.equal(events[0].attributes['otel.status.code'], 'STATUS_CODE_OK');
});

test('AcTrail OTLP: keeps the latest span revision and builds UI interactions', () => {
  const requestId = 'trace:3:request';
  const responseId = 'trace:3:response';
  const callId = 'trace:3:call';
  const events = normalizeBodies([
    bodyFor(span({
      spanId: 'agent-process',
      name: 'opencode',
      attributes: [
        attr('actrail.action.id', 'trace:3:command'),
        attr('actrail.action.kind', 'command.invocation'),
        attr('actrail.action.status', 'success'),
        attr('actrail.action.completeness', 'complete'),
        attr('invocation.kind', 'agent'),
      ],
    })),
    bodyFor(span({
      spanId: 'request',
      parentSpanId: 'call',
      name: 'LLM request deepseek-v4-flash',
      attributes: [
        attr('actrail.action.id', requestId),
        attr('actrail.action.kind', 'llm.request'),
        attr('actrail.action.status', 'success'),
        attr('actrail.action.completeness', 'complete'),
        attr('llm.request.model', 'deepseek-v4-flash'),
        attr('llm.request.message_preview', '检查一下当前项目'),
      ],
    })),
    bodyFor(span({
      spanId: 'call',
      name: 'LLM call deepseek-v4-flash',
      endTimeUnixNano: '1000000000',
      status: { code: 'STATUS_CODE_UNSET' },
      attributes: [
        attr('actrail.action.id', callId),
        attr('actrail.action.kind', 'llm.call'),
        attr('actrail.action.status', 'in_progress'),
        attr('actrail.action.completeness', 'complete'),
        attr('llm.call.model', 'deepseek-v4-flash'),
        attr('llm.call.request_action_id', requestId),
        attr('llm.call.response_action_id', responseId),
      ],
    })),
    bodyFor(span({
      spanId: 'call',
      name: 'LLM call deepseek-v4-flash',
      endTimeUnixNano: '4000000000',
      attributes: [
        attr('actrail.action.id', callId),
        attr('actrail.action.kind', 'llm.call'),
        attr('actrail.action.status', 'success'),
        attr('actrail.action.completeness', 'complete'),
        attr('llm.call.model', 'deepseek-v4-flash'),
        attr('llm.call.request_action_id', requestId),
        attr('llm.call.response_action_id', responseId),
      ],
    })),
    bodyFor(span({
      spanId: 'response',
      name: 'LLM response deepseek-v4-flash',
      endTimeUnixNano: '4000000000',
      attributes: [
        attr('actrail.action.id', responseId),
        attr('actrail.action.kind', 'llm.response'),
        attr('actrail.action.status', 'success'),
        attr('actrail.action.completeness', 'complete'),
        attr('llm.response.model', 'deepseek-v4-flash'),
        attr('llm.response.provider_id', 'openai-compatible'),
        attr('llm.response.content_text', '检查完成'),
        attr('llm.response.reasoning_text', '先读取项目状态'),
        attr('llm.response.prompt_tokens', 11),
        attr('llm.response.completion_tokens', 7),
        attr('llm.response.reasoning_tokens', 3),
        attr('llm.response.total_tokens', 18),
        attr('llm.response.tool_calls_json', JSON.stringify([
          {
            id: 'tool-skill',
            type: 'function',
            function: { name: 'skill', arguments: JSON.stringify({ name: 'repo-check' }) },
          },
          {
            id: 'tool-task',
            type: 'function',
            function: { name: 'task', arguments: JSON.stringify({ description: '检查仓库', subagent_type: 'general' }) },
          },
        ])),
      ],
    })),
  ]);

  const record = aggregateOtelTraceEvents('00000000000000000000000000000003', events);
  assert.ok(record);
  assert.equal(getOtelTraceAdapter(events).id, 'actrail');
  assert.equal(record.framework, 'actrail');
  assert.equal(record.agentName, 'opencode');
  assert.equal(record.query, '检查一下当前项目');
  assert.equal(record.final_result, '检查完成');
  assert.equal(record.llm_call_count, 1);
  assert.equal(record.tool_call_count, 2);
  assert.equal(record.tokens, 18);
  assert.equal(record.input_tokens, 11);
  assert.equal(record.output_tokens, 7);
  assert.equal(record.reasoning_tokens, 3);
  assert.deepEqual(record.invokedSkills, [{ name: 'repo-check', version: null }]);
  assert.equal(record.actrail_summary.actionCount, 4);
  assert.equal(record.actrail_summary.pairedLlmCalls, 1);
  assert.equal(record.interactions.filter((item: any) => item.role === 'user').length, 1);

  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.stats.llmCalls, 1);
  assert.equal(tree.stats.skillCalls, 1);
  assert.equal(tree.stats.taskCalls, 1);
  assert.equal(tree.stats.totalTokens, 18);
});

test('AcTrail framework registry exposes Skill support without claiming a subagent tree', () => {
  assert.equal(resolveFrameworkId('actrail'), 'actrail');
  assert.equal(getAdapter('actrail').descriptor.label, 'AcTrail');
  assert.equal(getAdapter('actrail').capabilities?.skills, true);
  assert.equal(getAdapter('actrail').capabilities?.subagentTree, false);
  assert.equal(getAdapter('actrail').sessionMergeStrategy, 'snapshot-replace');
});

const realSamplePath = process.env.ACTRAIL_OTLP_SAMPLE;
test('AcTrail real sample: reduces revisions and produces a stable trace projection', {
  skip: !realSamplePath,
}, async () => {
  const events: OtelTraceEvent[] = [];
  const input = fs.createReadStream(realSamplePath!);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let sourceLines = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    sourceLines += 1;
    events.push(...normalizeOtlpTraces(JSON.parse(line), {
      receivedAt: '2026-07-30T00:00:00.000Z',
      authenticatedUser: 'alice',
    }));
  }

  assert.equal(sourceLines, 11_824);
  const sessionId = '00000000000000000000000000000003';
  const record = aggregateOtelTraceEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.framework, 'actrail');
  assert.equal(record.agentName, 'opencode');
  assert.equal(record.llm_call_count, 10);
  assert.equal(record.tool_call_count, 6);
  assert.equal(record.tokens, 74_945);
  assert.equal(record.input_tokens, 72_230);
  assert.equal(record.output_tokens, 2_715);
  assert.equal(record.reasoning_tokens, 1_673);
  assert.equal(record.interactions.filter((item: any) => item.role === 'user').length, 2);
  assert.deepEqual(record.invokedSkills, [{ name: 'grill-me', version: null }]);
  assert.equal(record.actrail_summary.actionCount, 3_499);
  assert.equal(record.actrail_summary.pairedLlmCalls, 10);
  assert.equal(record.actrail_summary.unmatchedResponses, 2);
  assert.deepEqual(record.actrail_summary.actionCounts, {
    'process.exec': 182,
    'command.invocation': 182,
    'file.modify': 243,
    'file.read': 2778,
    'file.write': 82,
    'llm.request': 10,
    'llm.call': 10,
    'llm.response': 12,
  });

  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.stats.llmCalls, 10);
  assert.equal(tree.stats.skillCalls, 1);
  assert.equal(tree.stats.taskCalls, 2);
  assert.equal(tree.stats.totalTokens, 74_945);
  assert.equal(tree.children.length, 0);
});
