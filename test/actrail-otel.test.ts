import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import test from 'node:test';

import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { actrailPromptHistoryCount } from '@/lib/engine/observability/langfuse-agent-trace';
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
    links: [{
      traceId: '00000000000000000000000000000003',
      spanId: 'request',
      attributes: [attr('actrail.link.role', 'llm.request.trajectory_parent')],
    }],
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
  assert.deepEqual(events[0].links, [{
    traceId: '00000000000000000000000000000003',
    spanId: 'request',
    attributes: { 'actrail.link.role': 'llm.request.trajectory_parent' },
  }]);
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
  assert.equal(getOtelTraceAdapter(events)!.id, 'actrail');
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
  assert.equal(new Date(record.trace_started_at!).toISOString(), '1970-01-01T00:00:01.000Z');
  assert.equal(new Date(record.trace_completed_at!).toISOString(), '1970-01-01T00:00:04.000Z');
  assert.equal(record.latency, 3);
  assert.deepEqual(record.invokedSkills, [{ name: 'repo-check', version: null }]);
  assert.equal(record.actrail_summary.actionCount, 4);
  assert.equal(record.actrail_summary.pairedLlmCalls, 1);
  assert.equal(record.actrail_summary.internalLlmCallsFiltered, 0);
  assert.equal(record.interactions.filter((item: any) => item.role === 'user').length, 1);

  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.stats.llmCalls, 1);
  assert.equal(tree.stats.skillCalls, 1);
  assert.equal(tree.stats.taskCalls, 1);
  assert.equal(tree.stats.totalTokens, 18);
});

test('AcTrail OTLP: displays the reported HTTP status and reason for failed LLM calls', () => {
  const requestId = 'trace:3:error-request';
  const responseId = 'trace:3:error-response';
  const callId = 'trace:3:error-call';
  const events = normalizeBodies([
    bodyFor(span({
      spanId: 'error-request',
      name: 'LLM request deepseek-v4-flash',
      attributes: [
        attr('actrail.action.id', requestId),
        attr('actrail.action.kind', 'llm.request'),
        attr('actrail.action.status', 'success'),
        attr('llm.request.message_preview', '测试限流错误'),
      ],
    })),
    bodyFor(span({
      spanId: 'error-call',
      name: 'LLM call deepseek-v4-flash',
      status: { code: 'STATUS_CODE_ERROR' },
      attributes: [
        attr('actrail.action.id', callId),
        attr('actrail.action.kind', 'llm.call'),
        attr('actrail.action.status', 'error'),
        attr('llm.call.request_action_id', requestId),
        attr('llm.call.response_action_id', responseId),
        attr('http.response.status_code', 429),
        attr('http.response.reason', 'Too Many Requests'),
      ],
    })),
    bodyFor(span({
      spanId: 'error-response',
      name: 'LLM response HTTP 429',
      status: { code: 'STATUS_CODE_ERROR' },
      attributes: [
        attr('actrail.action.id', responseId),
        attr('actrail.action.kind', 'llm.response'),
        attr('actrail.action.status', 'error'),
        attr('http.response.status_code', 429),
        attr('http.response.reason', 'Too Many Requests'),
      ],
    })),
  ]);

  const record = aggregateOtelTraceEvents('00000000000000000000000000000003', events);
  assert.ok(record);
  const failedCall = record.interactions.find((item: any) => item.role === 'assistant') as any;
  assert.deepEqual(failedCall.error, { message: 'LLM 调用失败：HTTP 429 Too Many Requests' });

  const tree = buildAgentCallTree(record.interactions);
  assert.equal(tree.events.find((event) => event.kind === 'llm')?.summary, 'LLM 调用失败：HTTP 429 Too Many Requests');
});

test('AcTrail OTLP: infers Claude title generation, extracts the session prompt, and limits trace time', () => {
  const sessionId = '00000000000000000000000000000003';
  function event(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
    return {
      receivedAt: '2026-07-30T00:00:00.000Z',
      sessionId,
      traceId: sessionId,
      spanId: 'span-default',
      name: 'AcTrail action',
      kind: 'llm',
      serviceName: 'actrail',
      user: 'alice',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 0,
      startTimeMs: 1000,
      attributes: {},
      ...overrides,
    };
  }

  function llmPair(args: {
    id: string;
    startTimeMs: number;
    endTimeMs: number;
    prompt: string;
    content: string;
    inputTokens: number;
    outputTokens: number;
    backgroundKind?: string;
    toolCalls?: unknown[];
  }): OtelTraceEvent[] {
    const requestId = args.id + ':request';
    const callId = args.id + ':call';
    const responseId = args.id + ':response';
    return [
      event({
        spanId: requestId,
        name: 'LLM request',
        startTimeMs: args.startTimeMs,
        attributes: {
          'actrail.action.id': requestId,
          'actrail.action.kind': 'llm.request',
          'llm.request.message_preview': args.prompt,
          ...(args.backgroundKind ? { 'llm.request.background_kind': args.backgroundKind } : {}),
        },
      }),
      event({
        spanId: callId,
        name: 'LLM call',
        model: 'deepseek-v4-flash',
        startTimeMs: args.startTimeMs,
        latencyMs: args.endTimeMs - args.startTimeMs,
        attributes: {
          'actrail.action.id': callId,
          'actrail.action.kind': 'llm.call',
          'llm.call.request_action_id': requestId,
          'llm.call.response_action_id': responseId,
        },
      }),
      event({
        spanId: responseId,
        name: 'LLM response',
        startTimeMs: args.endTimeMs,
        usage: {
          input_tokens: args.inputTokens,
          output_tokens: args.outputTokens,
          total_tokens: args.inputTokens + args.outputTokens,
        },
        attributes: {
          'actrail.action.id': responseId,
          'actrail.action.kind': 'llm.response',
          'llm.response.content_text': args.content,
          ...(args.toolCalls ? { 'llm.response.tool_calls_json': JSON.stringify(args.toolCalls) } : {}),
        },
      }),
    ];
  }

  const events = [
    event({
      spanId: 'process-noise',
      kind: 'span',
      startTimeMs: 0,
      latencyMs: 20_000,
      attributes: {
        'actrail.action.id': 'process-noise',
        'actrail.action.kind': 'process.exit',
      },
    }),
    ...llmPair({
      id: 'title',
      startTimeMs: 1000,
      endTimeMs: 2000,
      prompt: '<session>\n调用两个子 Agent 检查项目\n</session>\n\nWrite the title in the predominant language of the session',
      content: '{"title":"两个子 Agent 检查项目"}',
      inputTokens: 20,
      outputTokens: 5,
    }),
    ...llmPair({
      id: 'main',
      startTimeMs: 3000,
      endTimeMs: 6000,
      prompt: '<SYSTEM>internal instructions</SYSTEM>',
      content: '',
      inputTokens: 100,
      outputTokens: 10,
      toolCalls: [{
        id: 'task-1',
        type: 'function',
        function: { name: 'task', arguments: JSON.stringify({ description: '检查项目' }) },
      }],
    }),
    ...llmPair({
      id: 'final',
      startTimeMs: 7000,
      endTimeMs: 9000,
      prompt: '<SYSTEM>internal instructions</SYSTEM>',
      content: '两个子 Agent 已完成检查',
      inputTokens: 50,
      outputTokens: 5,
    }),
  ];

  const record = aggregateOtelTraceEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.query, '调用两个子 Agent 检查项目');
  assert.equal(record.final_result, '两个子 Agent 已完成检查');
  assert.equal(record.llm_call_count, 2);
  assert.equal(record.tool_call_count, 1);
  assert.equal(record.tokens, 165);
  assert.equal(record.input_tokens, 150);
  assert.equal(record.output_tokens, 15);
  assert.equal(record.latency, 6);
  assert.equal(new Date(record.timestamp!).toISOString(), '1970-01-01T00:00:03.000Z');
  assert.equal(new Date(record.trace_started_at!).toISOString(), '1970-01-01T00:00:03.000Z');
  assert.equal(new Date(record.trace_completed_at!).toISOString(), '1970-01-01T00:00:09.000Z');
  assert.equal(record.interactions.filter((item: any) => item.role === 'user').length, 1);
  assert.equal(record.interactions.filter((item: any) => item.role === 'assistant').length, 2);
  assert.equal(record.interactions.some((item: any) => item.content === '两个子 Agent 检查项目'), false);
  assert.equal(record.actrail_summary.pairedLlmCalls, 2);
  assert.equal(record.actrail_summary.internalLlmCallsFiltered, 1);
  assert.equal(record.actrail_summary.userTurnInference, 'title-generation-preview');
});

test('AcTrail OTLP: projects canonical user content, tool results, and subagent links', () => {
  const sessionId = 'trace-new-contract';
  function event(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
    return {
      receivedAt: '2026-08-20T00:00:00.000Z',
      sessionId,
      traceId: sessionId,
      spanId: 'span-default',
      name: 'AcTrail action',
      kind: 'llm',
      serviceName: 'actrail',
      user: 'alice',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 0,
      startTimeMs: 1000,
      attributes: {},
      ...overrides,
    };
  }

  function link(spanId: string, role: string) {
    return { spanId, attributes: { 'actrail.link.role': role, 'actrail.link.confidence': 'observed' } };
  }

  function llmPair(args: {
    id: string;
    startTimeMs: number;
    prompt: string;
    response: string;
    requestLinks?: OtelTraceEvent['links'];
    toolCalls?: unknown[];
    system?: unknown;
    messages?: unknown[];
    requestHeaders?: string;
  }): OtelTraceEvent[] {
    const requestId = args.id + ':request';
    const callId = args.id + ':call';
    const responseId = args.id + ':response';
    return [
      event({
        spanId: requestId,
        startTimeMs: args.startTimeMs,
        links: args.requestLinks,
        attributes: {
          'actrail.action.id': requestId,
          'actrail.action.kind': 'llm.request',
          'llm.request.message_preview': 'preview only',
          'llm.request.canonical_body_json': JSON.stringify({
            model: 'test-model',
            ...(args.system === undefined ? {} : { system: args.system }),
            messages: args.messages || [{ role: 'user', content: args.prompt }],
          }),
          ...(args.requestHeaders ? { 'http.request.headers_text': args.requestHeaders } : {}),
        },
      }),
      event({
        spanId: callId,
        startTimeMs: args.startTimeMs,
        latencyMs: 100,
        model: 'test-model',
        attributes: {
          'actrail.action.id': callId,
          'actrail.action.kind': 'llm.call',
          'llm.call.request_action_id': requestId,
          'llm.call.response_action_id': responseId,
        },
      }),
      event({
        spanId: responseId,
        startTimeMs: args.startTimeMs + 100,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        attributes: {
          'actrail.action.id': responseId,
          'actrail.action.kind': 'llm.response',
          'llm.response.content_text': args.response,
          ...(args.toolCalls ? { 'llm.response.tool_calls_json': JSON.stringify(args.toolCalls) } : {}),
        },
      }),
    ];
  }

  const rootToolCalls = [
    {
      id: 'call-agent',
      type: 'function',
      function: { name: 'Agent', arguments: JSON.stringify({ prompt: '检查子模块' }) },
    },
    {
      id: 'call-bash',
      type: 'function',
      function: { name: 'Bash', arguments: JSON.stringify({ command: 'pwd' }) },
    },
    {
      id: 'call-skill',
      type: 'function',
      function: { name: 'Skill', arguments: JSON.stringify({ skill: 'systematic-debugging' }) },
    },
  ];
  const rootPair = llmPair({
    id: 'root',
    startTimeMs: 1000,
    prompt: '真正的用户问题',
    response: '',
    toolCalls: rootToolCalls,
    requestHeaders: 'User-Agent: claude-cli/2.1.227 (external, cli)\nx-app: cli',
  });
  const childPair = llmPair({
    id: 'child',
    startTimeMs: 2000,
    prompt: '检查子模块',
    response: '子 Agent 已完成',
    requestLinks: [link('invocation-agent', 'agent.invocation.child_llm_request')],
  });
  const childFollowPair = llmPair({
    id: 'child-follow',
    startTimeMs: 2500,
    prompt: '继续检查',
    response: '子 Agent 补充完成',
    requestLinks: [link('child:request', 'llm.request.trajectory_parent')],
  });
  const finalPair = llmPair({
    id: 'final',
    startTimeMs: 3000,
    prompt: '真正的用户问题',
    response: '最终回答',
    system: [{ type: 'text', text: '系统提示' }],
    messages: [
      { role: 'user', content: '真正的用户问题' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-skill',
          name: 'Skill',
          input: { skill: 'systematic-debugging' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-skill',
          content: 'Launching skill: systematic-debugging',
        },
        {
          type: 'text',
          text: 'Base directory for this skill: /skills/systematic-debugging',
        },
        {
          type: 'text',
          text: '# Systematic Debugging\n完整 Skill 内容',
        }],
      },
    ],
  });
  const events = [
    event({
      spanId: 'identity',
      name: 'agent identity process-4097',
      kind: 'span',
      attributes: {
        'actrail.action.id': 'identity',
        'actrail.action.kind': 'agent.identity',
      },
    }),
    ...rootPair,
    event({
      spanId: 'tool-agent',
      startTimeMs: 1200,
      links: [link('root:response', 'llm.response.tool_call')],
      attributes: {
        'actrail.action.id': 'tool-agent-action',
        'actrail.action.kind': 'llm.tool_call',
        'llm.tool_call.id': 'call-agent',
        'llm.tool_call.name': 'Agent',
        'llm.tool_call.ordinal': 0,
        'llm.tool_call.response_action_id': 'root:response',
      },
    }),
    event({
      spanId: 'tool-bash',
      startTimeMs: 1300,
      links: [link('root:response', 'llm.response.tool_call')],
      attributes: {
        'actrail.action.id': 'tool-bash-action',
        'actrail.action.kind': 'llm.tool_call',
        'llm.tool_call.id': 'call-bash',
        'llm.tool_call.name': 'Bash',
        'llm.tool_call.ordinal': 1,
        'llm.tool_call.response_action_id': 'root:response',
      },
    }),
    event({
      spanId: 'result-bash',
      startTimeMs: 1500,
      links: [link('tool-bash', 'llm.tool_call.result')],
      attributes: {
        'actrail.action.id': 'result-bash-action',
        'actrail.action.kind': 'llm.tool_result',
        'llm.tool_result.id': 'call-bash',
        'llm.tool_result.binding_state': 'bound',
        'llm.tool_result.is_error': false,
        'llm.tool_result.content_export_state': 'exported',
        'llm.tool_result.content_json': JSON.stringify({ output: '/workspace' }),
      },
    }),
    event({
      spanId: 'invocation-agent',
      startTimeMs: 1600,
      links: [link('tool-agent', 'llm.tool_call.agent_invocation')],
      attributes: {
        'actrail.action.id': 'invocation-agent-action',
        'actrail.action.kind': 'agent.invocation',
        'agent.invocation.tool_name': 'Agent',
        'agent.invocation.tool_call_id': 'call-agent',
        'agent.invocation.tool_call_action_id': 'tool-agent-action',
        'agent.invocation.agent_type': 'explore',
      },
    }),
    ...childPair,
    ...childFollowPair,
    ...finalPair,
  ];

  const record = aggregateOtelTraceEvents(sessionId, events);
  assert.ok(record);
  assert.equal(record.query, '真正的用户问题');
  assert.equal(record.final_result, '最终回答');
  assert.equal(record.agentName, 'Claude Code');
  assert.equal(record.llm_call_count, 4);
  assert.equal(record.tool_call_count, 3);
  assert.equal(record.tool_call_error_count, 0);
  assert.deepEqual(record.invokedSkills, [{ name: 'systematic-debugging', version: null }]);
  assert.equal(record.interactions.filter((item: any) => item.role === 'user').length, 1);

  const rootAssistant = record.interactions.find((item: any) =>
    item.role === 'assistant' && item.tool_calls?.length === 3
  ) as any;
  assert.ok(rootAssistant);
  const taskCall = rootAssistant.tool_calls.find((call: any) => call.function.name === 'task');
  assert.ok(taskCall);
  assert.deepEqual(JSON.parse(taskCall.function.arguments), {
    prompt: '检查子模块',
    subagent_type: 'explore',
    session_id: 'invocation-agent',
    actrail_tool_name: 'Agent',
  });
  const bashCall = rootAssistant.tool_calls.find((call: any) => call.function.name === 'Bash');
  assert.deepEqual(bashCall.output, { output: '/workspace' });
  assert.equal(bashCall.state, 'completed');
  const skillCall = rootAssistant.tool_calls.find((call: any) => call.function.name === 'Skill');
  assert.equal(skillCall.state, 'completed');
  assert.match(skillCall.output, /Launching skill: systematic-debugging/);
  assert.match(skillCall.output, /完整 Skill 内容/);

  const childInteractions = record.interactions.filter((item: any) => item.role === 'subagent') as any[];
  assert.equal(childInteractions.length, 2);
  assert.equal(childInteractions[0].subagent_session_id, 'invocation-agent');
  assert.equal(childInteractions[0].subagent_type, 'explore');
  assert.equal(childInteractions[0].content, '子 Agent 已完成');
  assert.equal(childInteractions[1].subagent_session_id, 'invocation-agent');
  assert.equal(childInteractions[1].content, '子 Agent 补充完成');
  assert.equal(record.actrail_summary.subagentTreeAvailable, true);
  assert.equal(record.actrail_summary.toolResultsAvailable, true);
  assert.equal(record.actrail_summary.matchedToolResults, 2);
  assert.equal(record.actrail_summary.toolResultBodies, 2);

  const finalAssistant = record.interactions.find((item: any) => item.content === '最终回答') as any;
  assert.ok(finalAssistant);
  assert.deepEqual(finalAssistant.requestMessages.map((message: any) => message.role), [
    'system',
    'user',
    'assistant',
    'user',
  ]);
  assert.match(finalAssistant.requestMessages[0].content, /系统提示/);
  assert.match(finalAssistant.requestMessages[3].content, /Launching skill: systematic-debugging/);
  assert.match(finalAssistant.requestMessages[3].content, /完整 Skill 内容/);
  assert.equal(record.interactions.every((item: any) => item.agent === 'Claude Code' || item.role === 'subagent'), true);

  const tree = buildAgentCallTree(record.interactions);
  assert.ok(tree);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].sessionId, 'invocation-agent');
  assert.equal(tree.children[0].subagentType, 'explore');
  assert.equal(tree.children[0].stats.llmCalls, 2);
});

test('AcTrail prompt history keeps only the current tool-use and tool-result pair', () => {
  const messages = [
    { role: 'system', content: 'system prompt v2' },
    { role: 'user', content: 'original question' },
    { role: 'system', content: 'dynamic skill list v2' },
    {
      role: 'assistant',
      content: JSON.stringify([
        { type: 'tool_use', id: 'call-old', name: 'Bash', input: { command: 'pwd' } },
      ]),
    },
    {
      role: 'user',
      content: JSON.stringify([
        { type: 'tool_result', tool_use_id: 'call-old', content: '/workspace', is_error: false },
      ]),
    },
    {
      role: 'assistant',
      content: JSON.stringify([
        { type: 'tool_use', id: 'call-current', name: 'Skill', input: { skill: 'systematic-debugging' } },
      ]),
    },
    {
      role: 'user',
      content: JSON.stringify([
        { type: 'tool_result', tool_use_id: 'call-current', content: 'Launching skill' },
        { type: 'text', text: '完整 Skill 内容' },
      ]),
    },
    { role: 'system', content: 'trailing dynamic agent list' },
  ];

  assert.equal(actrailPromptHistoryCount(messages), 5);
  assert.deepEqual(
    messages.slice(actrailPromptHistoryCount(messages)).filter((message) => message.role !== 'system').map((message) => message.role),
    ['assistant', 'user'],
  );
});

test('AcTrail framework registry exposes Skill and subagent tree support', () => {
  assert.equal(resolveFrameworkId('actrail'), 'actrail');
  assert.equal(getAdapter('actrail').descriptor.label, 'AcTrail');
  assert.equal(getAdapter('actrail').capabilities?.skills, true);
  assert.equal(getAdapter('actrail').capabilities?.subagentTree, true);
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
