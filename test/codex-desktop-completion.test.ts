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
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize'
import { aggregateCodexTraceEvents, keepLatestCodexSpanSnapshots } from '../src/lib/ingest/otel/adapters/codex'
import { shouldReplaceOtelSnapshot } from '../src/lib/ingest/otel/aggregate'
import { buildAgentCallTree } from '../src/lib/engine/observability/agent-trace'

const require = createRequire(import.meta.url)
const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
const { recordsToLifecycleEvents, extractRolloutContentEvents, createDesktopRolloutReader } = require('../scripts/agent-trace-collectors/codex/rollout-reader.cjs')
const { CodexTraceCore, extractOtlpLogRecords } = require('../scripts/agent-trace-collectors/codex/codex-trace-core.cjs')
const { classifyCodexSource } = require('../scripts/agent-trace-collectors/codex/source-classifier.cjs')
const { createRelay } = require('../scripts/agent-trace-collectors/codex/relay.cjs')
const B = 1_790_000_000_000

test('446-21: string zero timeUnixNano falls back to observed event time, never replay wall clock', () => {
    const [record] = extractOtlpLogRecords({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: '0', observedTimeUnixNano: String(BigInt(B) * 1000000n),
        attributes: [{ key: 'event.name', value: { stringValue: 'codex.user_prompt' } }],
    }] }] }] })
    assert.equal(record.timestampMs, B)
})

test('446-22: ambiguous restored turns retain uncorrelated tool data instead of crashing relay replay', async () => {
    const writer = new Writer()
    const core = new CodexTraceCore({ writer, now: () => B })
    const session = core.ensureSession('ambiguous', { timestampMs: B })
    core.turnFor(session, 'one', true, { timestampMs: B, input: 'one' })
    core.turnFor(session, 'two', true, { timestampMs: B, input: 'two' })
    await core.processOtel({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: String(BigInt(B + 100) * 1000000n),
        attributes: Object.entries({ 'event.name': 'codex.tool_result', 'conversation.id': 'ambiguous', 'tool.name': 'exec', call_id: 'tool' })
            .map(([key, value]) => ({ key, value: { stringValue: value } })),
    }] }] }] })
    assert.equal(writer.events.length, 1)
    assert.ok(writer.events[0].sessionId.startsWith('pending:'))
    assert.equal(aggregate(writer.events, writer.events[0].sessionId), null)
})

class Writer {
    events: any[] = []
    async append(event: any) { this.events.push(structuredClone(event)); return event }
    async flush() {}
}
function record(type: string, payload: any, ms: number) {
    return { type, timestamp: new Date(B + ms).toISOString(), payload }
}
function msg(type: string, payload: any, ms: number) { return record('event_msg', { type, ...payload }, ms) }
function parse(records: any[]) {
    let ctx: any = { sourceKind: 'unknown', unknownRecords: 0, toolNames: new Map() }
    const events: any[] = []
    for (const r of records) {
        const lifecycle = recordsToLifecycleEvents(r, ctx); ctx = lifecycle.context
        const content = extractRolloutContentEvents(r, ctx); ctx = content.context
        events.push(...lifecycle.events, ...content.events)
    }
    return events
}
function singleTurn() {
    return [
        record('session_meta', { id: 'thread', originator: 'Codex Desktop', source: 'vscode' }, 0),
        msg('task_started', { turn_id: 'turn' }, 0),
        msg('item_completed', { turn_id: 'turn', item: { type: 'UserMessage', id: 'user', content: [{ text: 'hello' }] } }, 100),
        msg('item_completed', { turn_id: 'turn', item: { type: 'AgentMessage', id: 'message', content: [{ text: 'hello back' }] } }, 2900),
        record('token_usage_record', { turn_id: 'turn', response_id: 'response', usage: { input_tokens: 27322, output_tokens: 29, total_tokens: 27351 } }, 3000),
        msg('task_complete', { turn_id: 'turn', last_agent_message: 'hello back' }, 3500),
    ]
}
async function collected(records = singleTurn()) {
    const writer = new Writer()
    const core = new CodexTraceCore({ writer, now: () => B })
    for (const event of parse(records)) await core.processLifecycleEvent(event)
    return { writer, core }
}
function aggregate(events: any[], id = 'thread:turn:turn') {
    const normalized = normalizeOtlpTraces(canonicalEventsToOtlp(events, { framework: 'codex' }), { authenticatedUser: 'test' })
    return aggregateCodexTraceEvents(id, keepLatestCodexSpanSnapshots(normalized))
}

test('446-14: concrete Desktop originators outrank the shared app-server service', () => {
    for (const originator of ['Codex Desktop', 'Codex_Desktop', 'codex-desktop']) {
        assert.equal(classifyCodexSource({ originator, serviceName: 'codex-app-server' }).sourceKind, 'desktop')
    }
    assert.equal(classifyCodexSource({ clientName: 'agent-insight-proxy', originator: 'Codex Desktop' }).sourceKind, 'app_server')
    assert.equal(classifyCodexSource({ serviceName: 'codex-app-server' }).sourceKind, 'app_server')
})

test('446-15: a same-turn follow-up must not replace the initial goal', () => {
    const core = new CodexTraceCore({ writer: new Writer(), now: () => B })
    const session = core.ensureSession('thread', { timestampMs: B })
    core.promptTurn(session, 'turn', 'initial', B, 'hook')
    assert.equal(core.promptTurn(session, 'turn', 'follow-up', B + 100, 'otel').input, 'initial')
})

test('446-15: a late Hook follow-up and its native alias stay in the original execution', () => {
    const core = new CodexTraceCore({ writer: new Writer(), now: () => B })
    const session = core.ensureSession('thread', { timestampMs: B })
    const original = core.promptTurn(session, 'turn', 'initial', B, 'hook')
    core.promptTurn(session, 'native-first', 'initial', B + 1, 'otel')
    core.promptTurn(session, 'turn', 'follow-up', B + 20000, 'hook')
    assert.equal(core.promptTurn(session, 'native-follow-up', 'follow-up', B + 20001, 'otel'), original)
    assert.equal(session.turns.size, 1)
})

test('446-16: one actual reply is one LLM with both output and usage', async () => {
    const { writer } = await collected()
    const result = aggregate(writer.events)!
    assert.equal(result.tokens, 27351)
    assert.equal(result.llm_call_count, 1)
    const replies = result.interactions.filter((i: any) => i.role === 'assistant' && !i.tool_calls)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].content, 'hello back')
    assert.equal((replies[0].usage as any).total, 27351)
})

test('446-16: standalone tool transport does not invent an extra model call in the UI', async () => {
    const { writer } = await collected()
    const root = writer.events.find(e => e.kind === 'agent')
    const result = aggregate([...writer.events, { ...root, kind: 'tool', spanId: 'tool', name: 'tool.exec',
        parentSpanId: root.spanId, startTimeMs: B + 200, endTimeMs: B + 300,
        input: 'echo test', output: 'test', tool: { name: 'exec', arguments: { command: 'echo test' }, result: 'test' } }])!
    const tree = buildAgentCallTree(result.interactions)!
    assert.equal(tree.stats.llmCalls, result.llm_call_count)
    assert.equal(tree.stats.toolCalls, 1)
})

test('446-16: tool-only responses retain usage and separate owners never merge', async () => {
    const { writer } = await collected([
        ...singleTurn().slice(0, 3),
        record('token_usage_record', { turn_id: 'turn', response_id: 'tool-response', usage: { total_tokens: 100 } }, 1000),
        ...singleTurn().slice(3),
    ])
    const result = aggregate(writer.events)!
    assert.equal(result.tokens, 27451)
    assert.equal(result.llm_call_count, 2)
    const body = writer.events.find(i => i.kind === 'llm' && i.output)
    const foreign = { ...body, spanId: 'foreign', parentSpanId: 'child', output: 'different owner' }
    const normalized = normalizeOtlpTraces(canonicalEventsToOtlp([...writer.events, foreign], { framework: 'codex' }), { authenticatedUser: 'test' })
    assert.ok(keepLatestCodexSpanSnapshots(normalized).some((i: any) => i.spanId === 'foreign'))
})

test('446-18: authoritative completion closes the collector turn across restore', async () => {
    const { core } = await collected()
    assert.equal(core.status().activeTurns.length, 0)
    const restored = new CodexTraceCore({ writer: new Writer(), now: () => B + 4000 })
    restored.restore(core.snapshot())
    assert.equal(restored.status().activeTurns.length, 0)
})

test('446-18: terminal snapshots cannot be reverted by a later running snapshot', async () => {
    const { writer } = await collected()
    const final = writer.events.filter(e => e.attributes?.['codex.execution.status'] === 'completed').at(-1)
    const stale = { ...final, endTimeMs: B + 9000, attributes: { ...final.attributes, 'codex.execution.status': 'in_progress' } }
    assert.equal(aggregate([...writer.events, stale])!.executionStatus, 'completed')
})

test('446-18: the shared pre-adapter dedupe retains Codex terminal state only', async () => {
    const { writer } = await collected()
    const events = normalizeOtlpTraces(canonicalEventsToOtlp(writer.events, { framework: 'codex' }), { authenticatedUser: 'test' })
    const terminal = events.findLast(e => e.attributes['codex.execution.status'] === 'completed')!
    const stale = { ...terminal, latencyMs: 9000, attributes: { ...terminal.attributes, 'codex.execution.status': 'in_progress' } }
    assert.equal(shouldReplaceOtelSnapshot(terminal, stale), false)
    const generic = { ...terminal, serviceName: 'generic', framework: undefined, attributes: {} }
    assert.equal(shouldReplaceOtelSnapshot(generic, { ...generic, latencyMs: 9000 }), true)
})

test('446-19: forked history never replays parent completions or synthetic aborts', () => {
    const events = parse([
        record('session_meta', { id: 'child', session_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, thread_source: 'subagent', originator: 'Codex Desktop' }, 100),
        record('session_meta', { id: 'parent', originator: 'Codex Desktop' }, 100),
        msg('task_started', { turn_id: 'old-parent-turn' }, 100),
        msg('user_message', { message: 'inherited parent goal' }, 100),
        msg('task_complete', { turn_id: 'old-parent-turn' }, 101),
        msg('turn_aborted', { turn_id: 'parent-turn', reason: 'interrupted' }, 102),
        msg('thread_settings_applied', { thread_id: 'child' }, 103),
        msg('task_started', { turn_id: 'child-turn', root_turn_id: 'parent-turn', turn_attribution: { parent_turn_id: 'parent-turn' } }, 104),
        record('token_usage_record', { turn_id: 'child-turn', response_id: 'child-response', usage: { total_tokens: 10 } }, 105),
    ])
    assert.ok(events.every(e => e.sourceThreadId === 'child'))
    assert.ok(!events.some(e => ['execution_interrupted', 'execution_completed'].includes(e.eventType)))
    assert.equal(events.find(e => e.eventType === 'rollout_usage').sourceExecutionId, 'child-turn')
})

test('446-19: fork suppression survives checkpoint restart and retains child work', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fork-checkpoint-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'rollout-2026-09-21T00-00-00-child.jsonl')
    const prefix = [
        record('session_meta', { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'thread', agent_path: '/root/child' } } } }, 10000),
        record('session_meta', { id: 'thread' }, 10000),
        msg('turn_aborted', { turn_id: 'turn' }, 10000),
    ]
    await fs.writeFile(file, prefix.map(r => JSON.stringify(r)).join('\n') + '\n')
    const { core, writer } = await collected()
    const options = { enabled: true, sessionsDir: dir, checkpointPath: path.join(dir, 'checkpoint.json'), backfillAfterMs: 1,
        onEvents: async (events: any[]) => { for (const event of events) await core.processLifecycleEvent(event) } }
    await createDesktopRolloutReader(options).scan()
    const suffix = [
        msg('thread_settings_applied', { thread_id: 'child' }, 10001),
        msg('task_started', { turn_id: 'child-turn', root_turn_id: 'turn', turn_attribution: { parent_turn_id: 'turn' } }, 10002),
        msg('item_completed', { turn_id: 'child-turn', item: { type: 'AgentMessage', id: 'child-message', content: [{ text: 'child result' }] } }, 11000),
        record('token_usage_record', { turn_id: 'child-turn', response_id: 'child-response', usage: { total_tokens: 100 } }, 11001),
        msg('task_complete', { turn_id: 'child-turn', last_agent_message: 'child result' }, 11002),
    ]
    await fs.appendFile(file, suffix.map(r => JSON.stringify(r)).join('\n') + '\n')
    const reader = createDesktopRolloutReader(options)
    await reader.scan()
    assert.equal((await reader.scan()).events, 0)
    const result = aggregate(writer.events)!
    assert.equal(result.executionStatus, 'completed')
    assert.equal(result.tokens, 27451)
    assert.ok(writer.events.some(e => e.kind === 'subagent' && e.output === 'child result'))
    assert.ok(!writer.events.some(e => e.attributes?.['codex.execution.status'] === 'interrupted'))
})

test('446-23: thread-scoped child metadata does not steal parent Hook tools', async () => {
    const { core, writer } = await collected()
    await core.processHook({ hook_event_name: 'SubagentStart', session_id: 'thread', turn_id: 'turn', agent_id: 'child', timestamp_ms: B + 4000 })
    await core.processHook({ hook_event_name: 'PreToolUse', session_id: 'thread', turn_id: 'turn', tool_name: 'parent-tool', tool_use_id: 'parent-call', tool_input: {}, timestamp_ms: B + 4001 })
    await core.processLifecycleEvent({ eventType: 'subagent_started', sourceThreadId: 'child', sourceExecutionId: 'child-turn', timestampMs: B + 4100,
        payload: { parentThreadId: 'thread', parentTurnId: 'turn', agentName: 'child' } })
    await core.processHook({ hook_event_name: 'PostToolUse', session_id: 'thread', turn_id: 'turn', tool_name: 'parent-tool', tool_use_id: 'parent-call', tool_response: 'parent result', timestamp_ms: B + 5000 })
    await core.processHook({ hook_event_name: 'PostToolUse', session_id: 'child', turn_id: 'child-turn', tool_name: 'child-tool', tool_use_id: 'child-call', tool_response: 'child result', timestamp_ms: B + 5100 })
    await core.processLifecycleEvent({ eventType: 'execution_completed', sourceThreadId: 'child', sourceExecutionId: 'child-turn', timestampMs: B + 5200, payload: { output: 'finished' } })
    const interactions = aggregate(writer.events)!.interactions
    const parent = interactions.find((i: any) => i.tool_calls?.[0]?.function?.name === 'parent-tool')!
    const child = interactions.find((i: any) => i.tool_calls?.[0]?.function?.name === 'child-tool')!
    assert.equal(parent.subagent_session_id, undefined)
    assert.ok(child.subagent_session_id)
})

test('446-20: a completed turn is not labelled as an interrupted transition', async () => {
    const { core } = await collected([
        ...singleTurn(), msg('task_started', { turn_id: 'next' }, 10000), msg('user_message', { message: 'next goal' }, 10001),
    ])
    assert.equal(core.lifecycleReducer.snapshot().transitions[0].kind, 'completed_followed_by_execution')
})

test('446-18: rollout terminal uploads after durable scan, not five minutes later', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-terminal-test-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const sessions = path.join(dir, 'sessions')
    await fs.mkdir(sessions)
    await fs.writeFile(path.join(sessions, 'rollout-2026-09-21T00-00-00-thread.jsonl'), singleTurn().map(r => JSON.stringify(r)).join('\n') + '\n')
    let flushes = 0
    const writer = new Writer()
    const uploader = { start() {}, stop() {}, async flushOnce() { flushes++; return { uploadedEvents: writer.events.length } } }
    const relay = await createRelay({
        config: { apiKey: 'test-key', installSecret: 'test-secret', endpoint: 'http://127.0.0.1:9', relayPort: 0, uploadIntervalMs: 300000,
            homeDir: dir, desktopRolloutIngress: true, desktopSessionsDir: sessions, desktopRolloutBackfillAfterMs: 1, desktopRolloutScanIntervalMs: 10000 },
        stateDir: path.join(dir, 'state'), writer, uploader, port: 0,
    })
    await relay.start()
    t.after(() => relay.stop())
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(flushes > 0, 'completion must trigger upload without the periodic timer')
})
