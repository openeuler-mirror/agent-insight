import assert from 'node:assert/strict'
import test from 'node:test'

import { getAdapter } from '@/lib/ingest/adapters/registry'
import { getOtelTraceAdapter } from '@/lib/ingest/otel/adapter-registry'
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate'
import { computeOwnSkills } from '@/lib/storage/data-service'
import type { OtelTraceEvent } from '@/lib/ingest/otel/types'

function qwenpawEvent(overrides: Partial<OtelTraceEvent>): OtelTraceEvent {
  return {
    receivedAt: '2026-08-01T00:00:00.000Z',
    sessionId: 'session-a',
    traceId: 'trace-a',
    spanId: 'span-a',
    name: 'agent',
    kind: 'llm',
    serviceName: 'qwenpaw',
    user: 'alice',
    model: 'qwen3',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 0,
    startTimeMs: 1000,
    attributes: {
      'agent.insight.framework': 'qwenpaw',
      'gen_ai.span.kind': 'AGENT',
      'qwenpaw.session_id': 'session-a',
      'qwenpaw.root_session_id': 'session-a',
      'qwenpaw.agent.name': 'assistant',
      'qwenpaw.user_id': 'alice',
      'qwenpaw.channel': 'console',
      'input.value': 'hello',
      'output.value': 'done',
    },
    ...overrides,
  }
}

test('qwenpaw adapter: aggregates agent, llm and tool spans into one record', () => {
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-root',
      latencyMs: 1200,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.agent.name': 'assistant',
        'qwenpaw.user_id': 'alice',
        'qwenpaw.channel': 'console',
        'input.value': 'hello',
        'output.value': 'done',
        'llm.token_count.total': 18,
      },
    }),
    qwenpawEvent({
      spanId: 'llm-1',
      parentSpanId: 'agent-root',
      name: 'llm.qwen3',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      latencyMs: 800,
      startTimeMs: 1100,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'llm.model_name': 'qwen3',
        'input.value': 'hello',
        'output.value': 'done',
        'llm.token_count.prompt': 11,
        'llm.token_count.completion': 7,
        'llm.token_count.total': 18,
      },
    }),
    qwenpawEvent({
      spanId: 'tool-1',
      parentSpanId: 'llm-1',
      name: 'shell',
      kind: 'tool',
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs: 50,
      startTimeMs: 2100,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'tool.name': 'shell',
        'tool.input': 'ls',
        'tool.output': 'README.md',
        'tool.status': 'success',
        'tool.exit_code': 0,
      },
    }),
  ]

  const record = aggregateOtelTraceEvents('session-a', events)

  assert.ok(record)
  assert.equal(record.framework, 'qwenpaw')
  assert.equal(record.query, 'hello')
  assert.equal(record.final_result, 'done')
  assert.equal(record.model, 'qwen3')
  assert.equal(record.tokens, 18)
  assert.equal(record.input_tokens, 11)
  assert.equal(record.output_tokens, 7)
  assert.equal(record.latency, 1200)
  assert.equal(record.user, 'alice')
  assert.equal(record.agentName, 'assistant')
  assert.equal(record.llm_call_count, 1)
  assert.equal(record.tool_call_count, 1)
  assert.equal(record.tool_call_error_count, 0)
  assert.equal(record.qwenpaw?.channel, 'console')
  assert.ok(record.interactions?.some((interaction: any) => interaction.role === 'user'))
  assert.ok(record.interactions?.some((interaction: any) => interaction.role === 'assistant'))
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.equal(calls[0]?.function?.name, 'shell')
  assert.equal(calls[0]?.exit_code, 0)
  assert.equal(calls[0]?.output, 'README.md')
})

test('qwenpaw adapter: explicit session end marker sets trace_completed_at', () => {
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-root',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.agent.name': 'assistant',
        'qwenpaw.user_id': 'alice',
        'input.value': 'hello',
        'output.value': 'done',
      },
    }),
    qwenpawEvent({
      spanId: 'end-marker',
      name: 'qwenpaw.session.end',
      startTimeMs: 9999,
      latencyMs: 0,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.session.end': true,
        'qwenpaw.completed_at': '2026-08-01T00:00:02.000Z',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents('session-a', events)

  assert.ok(record)
  assert.equal(record.final_result, 'done')
  assert.equal(record.trace_completed_at, '2026-08-01T00:00:02.000Z')
  assert.equal(record.llm_call_count, 0)
  assert.equal(record.tool_call_count, 0)
})

test('qwenpaw adapter: subagent end marker does not complete the root trace', () => {
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-root',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.agent.name': 'assistant',
        'qwenpaw.user_id': 'alice',
        'input.value': 'hello',
        'output.value': 'done',
      },
    }),
    qwenpawEvent({
      spanId: 'sub-end-marker',
      name: 'qwenpaw.session.end',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'qwenpaw.session_id': 'sub-1234',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.parent_session_id': 'session-a',
        'qwenpaw.session.end': true,
        'qwenpaw.completed_at': '2026-08-01T00:00:01.000Z',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents('session-a', events)

  assert.ok(record)
  assert.equal(record.trace_completed_at, undefined)
})

test('qwenpaw adapter: keeps subagent, skill and mcp spans associated', () => {
  const sessionId = 'session-a'
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-root',
      startTimeMs: 1000,
      latencyMs: 3000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.agent.name': 'assistant',
        'qwenpaw.user_id': 'alice',
        'qwenpaw.channel': 'dingtalk',
        'qwenpaw.source': 'chat',
        'input.value': 'generate a report',
        'output.value': 'report generated',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-root',
      parentSpanId: 'agent-root',
      name: 'llm.qwen3',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      startTimeMs: 1100,
      latencyMs: 500,
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'llm.model_name': 'qwen3',
        'input.value': 'generate a report',
        'output.value': 'I will spawn a worker.',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-subagent',
      parentSpanId: 'llm-root',
      name: 'spawn_subagent',
      kind: 'tool',
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 1700,
      latencyMs: 20,
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'tool.name': 'spawn_subagent',
        'tool.input': '{"task":"write report"}',
        'tool.output': 'spawned sub-1234',
      },
    }),
    qwenpawEvent({
      spanId: 'sub-agent',
      parentSpanId: 'tool-subagent',
      name: 'agent',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 1800,
      latencyMs: 1000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'sub-1234',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'qwenpaw.agent.name': 'worker',
        'agent.subagent': true,
        'subagent.session.id': 'sub-1234',
        'subagent.status': 'success',
        'input.value': 'write report',
        'output.value': 'report done',
      },
    }),
    qwenpawEvent({
      spanId: 'sub-llm',
      parentSpanId: 'sub-agent',
      name: 'llm.qwen3',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
      startTimeMs: 1900,
      latencyMs: 400,
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'sub-1234',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'llm.model_name': 'qwen3',
        'input.value': 'write report',
        'output.value': 'report done',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-skill',
      parentSpanId: 'sub-llm',
      name: 'skill.docx',
      kind: 'tool',
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 2400,
      latencyMs: 100,
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'tool.name': 'skill',
        'skill.name': 'docx',
        'skill.version': '1.2',
        'skill.trigger': 'slash',
        'skill.input': 'make doc',
        'skill.output': 'ok',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-mcp',
      parentSpanId: 'agent-root',
      name: 'mcp__github__get_issue',
      kind: 'tool',
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      startTimeMs: 2600,
      latencyMs: 300,
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'tool.name': 'mcp__github__get_issue',
        'mcp.server.name': 'github',
        'mcp.tool.name': 'get_issue',
        'protocol': 'mcp',
        'mcp.arguments': '{"issue":1}',
        'mcp.result': 'issue found',
        'tool.status': 'error',
        'error.message': 'rate limited',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.framework, 'qwenpaw')
  assert.equal(record.tool_call_count, 3)
  assert.equal(record.tool_call_error_count, 1)
  assert.equal(record.llm_call_count, 2)
  assert.equal(record.subagentCount, 1)
  assert.deepEqual(record.invokedSkills, [{ name: 'docx', version: 1.2 }])
  assert.deepEqual(getAdapter('qwenpaw').extractSkills?.(record.interactions || []), [{ name: 'docx', version: 1.2 }])
  assert.deepEqual(computeOwnSkills('qwenpaw', record.interactions || []), [])
  assert.equal(record.qwenpaw?.channel, 'dingtalk')
  assert.equal(record.qwenpaw?.source, 'chat')
  assert.equal(record.qwenpaw?.mcp_call_count, 1)
  assert.deepEqual(record.qwenpaw?.skill_names, ['docx'])
  const subagent = record.interactions?.find((interaction: any) => interaction.role === 'subagent')
  assert.ok(subagent)
  assert.equal(subagent.subagent_session_id, 'sub-1234')
  assert.equal(subagent.content, 'report done')
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.ok(calls.some((call: any) => call.function?.name === 'skill.docx'))
  assert.ok(calls.some((call: any) => call.mcp?.server_name === 'github'))
})

test('qwenpaw adapter: carries cron metadata into the execution record', () => {
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'cron-root',
      sessionId: 'cron:job-1',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'cron:job-1',
        'qwenpaw.root_session_id': 'cron:job-1',
        'qwenpaw.agent.name': 'assistant',
        'qwenpaw.source': 'cron',
        'qwenpaw.channel': 'dingtalk',
        'cron.job_id': 'job-1',
        'cron.job_name': 'daily report',
        'cron.trigger': 'scheduled',
        'cron.status': 'success',
        'input.value': 'generate daily report',
        'output.value': 'report sent',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents('cron:job-1', events)

  assert.ok(record)
  assert.equal(record.query, 'generate daily report')
  assert.equal(record.final_result, 'report sent')
  assert.equal(record.qwenpaw?.cron_job_id, 'job-1')
  assert.equal(record.qwenpaw?.cron_job_name, 'daily report')
  assert.equal(record.qwenpaw?.cron_trigger, 'scheduled')
  assert.equal(record.qwenpaw?.cron_status, 'success')
})

test('qwenpaw adapter: matches only qwenpaw traces', () => {
  const adapter = getOtelTraceAdapter([
    qwenpawEvent({ spanId: 'root' }),
  ])
  assert.equal(adapter.id, 'qwenpaw')

  const generic = getOtelTraceAdapter([
    qwenpawEvent({
      serviceName: 'other',
      attributes: { 'gen_ai.span.kind': 'LLM' },
    }),
  ])
  assert.notEqual(generic.id, 'qwenpaw')
})
