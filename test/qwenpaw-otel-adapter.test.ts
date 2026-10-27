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

import assert from 'node:assert/strict'
import test from 'node:test'

import { getAdapter } from '@/lib/ingest/adapters/registry'
import { getOtelTraceAdapter } from '@/lib/ingest/otel/adapter-registry'
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate'
import { computeOwnSkills } from '@/lib/storage/data-service'
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace'
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

test('qwenpaw adapter: adds one root USER from real QwenPaw repr input without an agent span', () => {
  const inputValue = JSON.stringify([
    "name='system' content=[TextBlock(type='text', text='You generate short titles for chat sessions.', id='sys-1')] role='system' id='m-system' metadata={}",
    "name='user' content=[TextBlock(type='text', text='能告诉我你有哪些技能吗？', id='user-1')] role='user' id='m-user' metadata={}",
  ])
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'title-llm',
      name: 'llm.qwen3',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 140, output_tokens: 93, total_tokens: 233 },
      latencyMs: 1800,
      startTimeMs: 1000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'openinference.span.kind': 'LLM',
        'qwenpaw.session_id': 'unknown',
        'qwenpaw.root_session_id': 'session-a',
        'llm.model_name': 'qwen3',
        'input.value': inputValue,
        'output.value': '询问我的技能',
      },
    }),
    qwenpawEvent({
      spanId: 'answer-llm',
      name: 'llm.qwen3',
      kind: 'llm',
      model: 'qwen3',
      usage: { input_tokens: 12000, output_tokens: 600, total_tokens: 12600 },
      latencyMs: 6300,
      startTimeMs: 1200,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'openinference.span.kind': 'LLM',
        'qwenpaw.session_id': 'unknown',
        'qwenpaw.root_session_id': 'session-a',
        'llm.model_name': 'qwen3',
        'input.value': inputValue,
        'output.value': '当然可以，我有文档处理、浏览器、自动化等技能。',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents('session-a', events)

  assert.ok(record)
  assert.equal(record.query, '能告诉我你有哪些技能吗？')
  assert.deepEqual(record.interactions?.map((interaction: any) => interaction.role), ['user', 'assistant', 'assistant'])
  assert.equal(record.interactions?.filter((interaction: any) => interaction.role === 'user').length, 1)
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.ok(tree)
  assert.equal(tree.events[0]?.kind, 'user')
  assert.equal(tree.events[0]?.summary, '能告诉我你有哪些技能吗？')
  assert.equal(tree.events[1]?.kind, 'llm')
})

test('qwenpaw adapter: prefers qwenpaw.user_input over full LLM input payload', () => {
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'llm-1',
      name: 'llm.qwen3',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'unknown',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.user_input': '真实用户问题',
        'input.value': 'system prompt '.repeat(400),
        'output.value': 'answer',
      },
    }),
  ])

  assert.ok(record)
  assert.equal(record.query, '真实用户问题')
  assert.equal(record.interactions?.[0]?.role, 'user')
  assert.equal(record.interactions?.[0]?.content, '真实用户问题')
})

test('qwenpaw adapter: keeps one trace per real turn in the same conversation', () => {
  const trace1 = 'trace-session-a-turn-1'
  const trace2 = 'trace-session-a-turn-2'
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-1',
      sessionId: trace1,
      traceId: trace1,
      startTimeMs: 1000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.agent_id': 'default',
        'qwenpaw.agent.name': 'Default',
        'qwenpaw.turn_id': 'session-a:session-a:turn:1',
        'qwenpaw.trace_key': trace1,
        'qwenpaw.user_input': '第一轮问题',
        'input.value': '第一轮问题',
        'output.value': '第一轮回答',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-1',
      sessionId: trace1,
      traceId: trace1,
      name: 'llm.qwen3',
      kind: 'llm',
      startTimeMs: 1100,
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.turn_id': 'session-a:session-a:turn:1',
        'qwenpaw.trace_key': trace1,
        'qwenpaw.user_input': '第一轮问题',
        'llm.model_name': 'qwen3',
        'input.value': '完整第一轮 prompt',
        'output.value': '第一轮回答',
      },
    }),
    qwenpawEvent({
      spanId: 'agent-2',
      sessionId: trace2,
      traceId: trace2,
      startTimeMs: 2000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.agent_id': 'default',
        'qwenpaw.agent.name': 'Default',
        'qwenpaw.turn_id': 'session-a:session-a:turn:2',
        'qwenpaw.trace_key': trace2,
        'qwenpaw.user_input': '第二轮问题',
        'input.value': '第二轮问题',
        'output.value': '第二轮回答',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-2',
      sessionId: trace2,
      traceId: trace2,
      name: 'llm.qwen3',
      kind: 'llm',
      startTimeMs: 2100,
      usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 },
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.turn_id': 'session-a:session-a:turn:2',
        'qwenpaw.trace_key': trace2,
        'qwenpaw.user_input': '第二轮问题',
        'llm.model_name': 'qwen3',
        'input.value': '完整第二轮 prompt',
        'output.value': '第二轮回答',
      },
    }),
  ]

  const firstRecord = aggregateOtelTraceEvents(trace1, events)
  const secondRecord = aggregateOtelTraceEvents(trace2, events)

  assert.ok(firstRecord)
  assert.ok(secondRecord)
  assert.equal(firstRecord?.task_id, trace1)
  assert.equal(secondRecord?.task_id, trace2)
  assert.equal(firstRecord?.query, '第一轮问题')
  assert.equal(secondRecord?.query, '第二轮问题')
  assert.equal(firstRecord?.agentName, 'Default')
  assert.equal(secondRecord?.agentName, 'Default')
  assert.deepEqual(
    firstRecord?.interactions?.map((interaction: any) => `${interaction.role}:${interaction.content}`),
    ['user:第一轮问题', 'assistant:第一轮回答'],
  )
  assert.deepEqual(
    secondRecord?.interactions?.map((interaction: any) => `${interaction.role}:${interaction.content}`),
    ['user:第二轮问题', 'assistant:第二轮回答'],
  )
  assert.equal(firstRecord?.qwenpaw?.agent_id, 'default')
  assert.equal(secondRecord?.qwenpaw?.agent_id, 'default')
})

test('qwenpaw adapter: ignores system, assistant and tool-only repr messages', () => {
  const inputValue = JSON.stringify([
    "name='system' content=[TextBlock(type='text', text='system only')] role='system'",
    "name='assistant' content=[TextBlock(type='text', text='assistant history')] role='assistant'",
    "name='tool' content=[TextBlock(type='text', text='tool result')] role='tool'",
  ])
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'llm-1',
      name: 'llm.qwen3',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'unknown',
        'qwenpaw.root_session_id': 'session-a',
        'input.value': inputValue,
        'output.value': 'answer',
      },
    }),
  ])

  assert.ok(record)
  assert.equal(record.query, 'QwenPaw Session')
  assert.deepEqual(record.interactions?.map((interaction: any) => interaction.role), ['assistant'])
})

test('qwenpaw adapter: decodes escaped repr text and joins multiple user TextBlocks', () => {
  const inputValue = JSON.stringify([
    "name='user' content=[TextBlock(type='text', text='第一行\\\\n带\\'引号', id='one'), TextBlock(type='text', text='第二段', id='two')] role='user'",
  ])
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'llm-1',
      name: 'llm.qwen3',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'unknown',
        'qwenpaw.root_session_id': 'session-a',
        'input.value': inputValue,
        'output.value': 'answer',
      },
    }),
  ])

  assert.ok(record)
  assert.equal(record.query, "第一行\n带'引号\n第二段")
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

test('qwenpaw adapter: title-generation LLM alone waits for the real conversation span', () => {
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'title-llm',
      name: 'llm.qwen3',
      kind: 'llm',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'qwenpaw.internal_operation': 'title_generation',
        'qwenpaw.title_generation': true,
        'qwenpaw.user_input': '真实问题',
        'input.value': '生成标题',
        'output.value': '标题',
      },
    }),
  ])

  assert.equal(record, null)
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
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'tool.name': 'spawn_subagent',
        'tool.input': '{"task":"write report"}',
        'tool.output': 'spawned sub-1234',
        'qwenpaw.delegation.kind': 'spawn',
        'qwenpaw.delegation.description': 'write report',
        'qwenpaw.delegation.children': ['sub-1234'],
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
        'qwenpaw.session_id': 'sub-1234',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'qwenpaw.agent.name': 'worker',
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
  assert.equal(subagent.trace_synthetic, true)
  assert.equal(subagent.subagent_session_id, 'sub-1234')
  assert.equal(subagent.content, 'report done')
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.ok(calls.some((call: any) => call.function?.name === 'task'))
  assert.ok(calls.some((call: any) => call.function?.name === 'skill.docx'))
  assert.ok(calls.some((call: any) => call.mcp?.server_name === 'github'))
  const skillCall = calls.find((call: any) => call.function?.name === 'skill.docx')
  assert.deepEqual(skillCall?.skill, { name: 'docx', version: '1.2', trigger: 'slash' })
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.ok(tree)
  assert.equal(tree.agentName, 'assistant')
  assert.equal(tree.children[0]?.sessionId, 'sub-1234')
  assert.equal(tree.children[0]?.agentName, 'worker')
  assert.equal(tree.children[0]?.events.filter((event) => event.kind === 'llm').length, 1)
  const skillEvent = tree.children[0]?.events.find((event) => event.kind === 'skill')
  assert.equal(skillEvent?.name, 'docx')
  assert.deepEqual(skillEvent?.args, { input: 'make doc', name: 'docx', version: '1.2' })
})

test('qwenpaw adapter: error metadata makes a successful-looking tool call fail consistently', () => {
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'tool-error',
      name: 'tool.read_file',
      kind: 'tool',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'tool.name': 'read_file',
        'tool.status': 'success',
        'error.message': 'file missing',
      },
    }),
  ])

  assert.ok(record)
  assert.equal(record.tool_call_error_count, 1)
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.equal(calls[0]?.state, 'error')
  assert.equal(calls[0]?.error, 'file missing')
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.equal(tree?.events.find((event) => event.kind === 'tool')?.toolError, 'file missing')
})

test('qwenpaw adapter: nonzero exit code fails while output alone does not', () => {
  const record = aggregateOtelTraceEvents('session-a', [
    qwenpawEvent({
      spanId: 'tool-output-only',
      name: 'tool.write_file',
      kind: 'tool',
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'tool.name': 'write_file',
        'tool.status': 'success',
        'tool.output': 'written',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-exit-one',
      name: 'tool.execute_shell_command',
      kind: 'tool',
      startTimeMs: 1100,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': 'session-a',
        'qwenpaw.root_session_id': 'session-a',
        'tool.name': 'execute_shell_command',
        'tool.status': 'success',
        'tool.exit_code': 1,
        'tool.output': 'Command failed with exit code 1.',
      },
    }),
  ])

  assert.ok(record)
  assert.equal(record.tool_call_error_count, 1)
  const calls = record.interactions?.flatMap((interaction: any) => interaction.tool_calls || []) || []
  assert.equal(calls.find((call: any) => call.id === 'tool-output-only')?.state, 'success')
  assert.equal(calls.find((call: any) => call.id === 'tool-exit-one')?.state, 'error')
  const tree = buildAgentCallTree(record.interactions as any[])
  const failedEvent = tree?.events.find((event) => event.toolCallId === 'tool-exit-one')
  assert.equal(failedEvent?.toolStatus, 'error')
  assert.equal(failedEvent?.toolExitCode, 1)
  assert.equal(failedEvent?.output, 'Command failed with exit code 1.')
})

test('qwenpaw adapter: a synthetic subagent span still preserves the agent node without a fake llm row', () => {
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
        'input.value': 'delegate',
        'output.value': 'done',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-root',
      parentSpanId: 'agent-root',
      name: 'llm.qwen3',
      kind: 'llm',
      startTimeMs: 1100,
      latencyMs: 200,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'llm.model_name': 'qwen3',
        'input.value': 'delegate',
        'output.value': 'I will start a subagent.',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-root-task',
      parentSpanId: 'llm-root',
      name: 'spawn_subagent',
      kind: 'tool',
      startTimeMs: 1400,
      latencyMs: 20,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'tool.name': 'spawn_subagent',
        'tool.input': '{"task":"child task"}',
        'tool.output': '[SESSION: sub-1234]',
        'qwenpaw.delegation.kind': 'spawn',
        'qwenpaw.delegation.description': 'child task',
        'qwenpaw.delegation.children': ['sub-1234'],
      },
    }),
    qwenpawEvent({
      spanId: 'sub-agent',
      parentSpanId: 'tool-root-task',
      name: 'agent',
      kind: 'llm',
      startTimeMs: 1800,
      latencyMs: 1200,
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
        'input.value': 'child task',
        'output.value': 'child result',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.ok(tree)
  const child = tree.children[0]
  assert.ok(child)
  assert.equal(child?.events.filter((event) => event.kind === 'llm').length, 0)
})

test('qwenpaw adapter: builds nested subagent task tree with real agent names', () => {
  const sessionId = 'session-a'
  const events: OtelTraceEvent[] = [
    qwenpawEvent({
      spanId: 'agent-root',
      startTimeMs: 1000,
      latencyMs: 5000,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.agent_id': 'default',
        'qwenpaw.agent.name': 'Default',
        'qwenpaw.turn_id': 'session-a:session-a:turn:1',
        'qwenpaw.user_input': '请分派任务',
        'input.value': '请分派任务',
        'output.value': '完成',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-root',
      parentSpanId: 'agent-root',
      name: 'llm.qwen3',
      kind: 'llm',
      startTimeMs: 1100,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.turn_id': 'session-a:session-a:turn:1',
        'qwenpaw.user_input': '请分派任务',
        'llm.model_name': 'qwen3',
        'input.value': '请分派任务',
        'output.value': '我会启动子 agent。',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-root-task',
      parentSpanId: 'llm-root',
      name: 'spawn_subagent',
      kind: 'tool',
      startTimeMs: 1200,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': sessionId,
        'qwenpaw.root_session_id': sessionId,
        'tool.name': 'spawn_subagent',
        'tool.input': '{"task":"第一层任务"}',
        'tool.output': '[SESSION: sub-1]\n已启动',
        'qwenpaw.delegation.kind': 'spawn',
        'qwenpaw.delegation.description': '第一层任务',
        'qwenpaw.delegation.children': ['sub-1'],
      },
    }),
    qwenpawEvent({
      spanId: 'agent-sub-1',
      name: 'agent',
      kind: 'llm',
      startTimeMs: 1300,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'sub-1',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'qwenpaw.agent_id': 'default',
        'qwenpaw.agent.name': 'Default · Subagent',
        'agent.subagent': true,
        'subagent.session.id': 'sub-1',
        'input.value': '第一层任务',
        'output.value': '我要继续分派。',
      },
    }),
    qwenpawEvent({
      spanId: 'llm-sub-1',
      name: 'llm.qwen3',
      kind: 'llm',
      startTimeMs: 1400,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'LLM',
        'qwenpaw.session_id': 'sub-1',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'qwenpaw.agent.name': 'Default · Subagent',
        'llm.model_name': 'qwen3',
        'output.value': '我要继续分派。',
      },
    }),
    qwenpawEvent({
      spanId: 'tool-sub-task',
      parentSpanId: 'llm-sub-1',
      name: 'chat_with_agent',
      kind: 'tool',
      startTimeMs: 1500,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'TOOL',
        'qwenpaw.session_id': 'sub-1',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': sessionId,
        'qwenpaw.agent.name': 'Default · Subagent',
        'tool.name': 'chat_with_agent',
        'tool.input': '{"to_agent":"worker","text":"第二层任务"}',
        'tool.output': '[SESSION: worker-session]\nworker done',
        'qwenpaw.delegation.kind': 'chat_with_agent',
        'qwenpaw.delegation.description': '第二层任务',
        'qwenpaw.delegation.target_agent': 'Worker',
        'qwenpaw.delegation.children': ['worker-session'],
      },
    }),
    qwenpawEvent({
      spanId: 'agent-worker',
      name: 'agent',
      kind: 'llm',
      startTimeMs: 1600,
      attributes: {
        'agent.insight.framework': 'qwenpaw',
        'gen_ai.span.kind': 'AGENT',
        'qwenpaw.session_id': 'worker-session',
        'qwenpaw.root_session_id': sessionId,
        'qwenpaw.parent_session_id': 'sub-1',
        'qwenpaw.agent_id': 'worker',
        'qwenpaw.agent.name': 'Worker',
        'agent.subagent': true,
        'subagent.session.id': 'worker-session',
        'input.value': '第二层任务',
        'output.value': 'worker done',
      },
    }),
  ]

  const record = aggregateOtelTraceEvents(sessionId, events)

  assert.ok(record)
  assert.equal(record.agentName, 'Default')
  assert.equal(record.subagentCount, 2)
  const tree = buildAgentCallTree(record.interactions as any[])
  assert.ok(tree)
  assert.equal(tree.agentName, 'Default')
  assert.equal(tree.children[0]?.agentName, 'Default · Subagent')
  assert.equal(tree.children[0]?.sessionId, 'sub-1')
  assert.equal(tree.children[0]?.children[0]?.agentName, 'Worker')
  assert.equal(tree.children[0]?.children[0]?.sessionId, 'worker-session')
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
  assert.ok(adapter)
  assert.equal(adapter.id, 'qwenpaw')

  const generic = getOtelTraceAdapter([
    qwenpawEvent({
      serviceName: 'other',
      attributes: { 'gen_ai.span.kind': 'LLM' },
    }),
  ])
  assert.ok(generic)
  assert.notEqual(generic.id, 'qwenpaw')
  assert.equal(getAdapter('qwenpaw').isPlaceholderQuery?.('QwenPaw Session', 'qwenpaw'), true)
  assert.equal(getAdapter('qwenpaw').capabilities?.subagentTree, true)
})
