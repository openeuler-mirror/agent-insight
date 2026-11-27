/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed
 * under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize'
import { aggregateCodexTraceEvents, keepLatestCodexSpanSnapshots } from '../src/lib/ingest/otel/adapters/codex'

const require = createRequire(import.meta.url)
const { CodexTraceCore } = require('../scripts/agent-trace-collectors/codex/codex-trace-core.cjs')
const { recordsToLifecycleEvents } = require('../scripts/agent-trace-collectors/codex/rollout-reader.cjs')
const { canonicalEventsToOtlp, redactValue } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
const B = 1_794_239_956_605
const prompt = '[$research](C:\\Users\\example\\.agents\\skills\\research\\SKILL.md) 今日新闻'

class Writer {
    events: any[] = []
    async append(event: any) { this.events.push(redactValue(event)); return event }
    async flush() {}
}
function fixture() {
    const writer = new Writer()
    return { writer, core: new CodexTraceCore({ writer, now: () => B }) }
}
function native(core: any, id = 'native', text = prompt, ms = 5058, kind = 'codex.user_prompt', attrs = {}) {
    return core.processOtel({ resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: String(BigInt(B + ms) * 1000000n),
        attributes: Object.entries({ 'event.name': kind, 'conversation.id': 'thread', 'turn.id': id, prompt: text, ...attrs })
            .map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } })),
    }] }] }] })
}
async function lifecycle(core: any, turnId = 'framework', text = prompt, offset = 0) {
    let context: any = { sourceKind: 'unknown', unknownRecords: 0, toolNames: new Map() }
    for (const [ms, type, payload] of [
        [offset, 'session_meta', { id: 'thread', originator: 'Codex Desktop', source: 'vscode' }],
        [offset, 'event_msg', { type: 'task_started', turn_id: turnId }],
        [offset + 5072, 'event_msg', { type: 'item_completed', turn_id: turnId,
            item: { type: 'UserMessage', id: `user-${turnId}`, content: [{ text }] } }],
    ] as const) {
        const parsed = recordsToLifecycleEvents({ type, timestamp: new Date(B + ms).toISOString(), payload }, context)
        context = parsed.context
        for (const event of parsed.events) await core.processLifecycleEvent(event)
    }
}
async function complete(core: any, turnId = 'framework', ms = 12000) {
    await core.processLifecycleEvent({ eventId: `done-${turnId}`, eventType: 'execution_completed',
        source: 'desktop_rollout', sourceKind: 'desktop', sourceThreadId: 'thread', sourceExecutionId: turnId,
        timestampMs: B + ms, status: 'completed', payload: { output: 'news summary' } })
}
function records(writer: Writer) {
    const normalized = normalizeOtlpTraces(canonicalEventsToOtlp(writer.events, { framework: 'codex' }), { authenticatedUser: 'test' })
    return [...new Set(normalized.map(e => e.sessionId).filter(id => id?.includes(':turn:')))]
        .map(id => aggregateCodexTraceEvents(id, keepLatestCodexSpanSnapshots(normalized.filter(e => e.sessionId === id))))
        .filter(Boolean)
}

for (const order of ['otel-first', 'lifecycle-first']) {
    test(`446-15: redacted skill prompt has one completed execution (${order})`, async () => {
        const { core, writer } = fixture()
        if (order === 'otel-first') { await native(core); await lifecycle(core) }
        else { await lifecycle(core); await native(core) }
        await native(core, 'internal-response', '', 6000, 'codex.sse_event', {
            kind: 'response.completed', response_id: 'response', total_token_count: 42,
        })
        await complete(core)
        const result = records(writer)
        assert.equal(result.length, 1, 'one visible Execution across all appended snapshots')
        const session = core.sessions.get('thread')
        assert.equal(session.turns.size, 1, 'no separate native prompt or pending internal turns')
        assert.equal(core.turnFor(session, 'native'), core.turnFor(session, 'framework'))
        assert.equal(core.turnFor(session, 'framework').closed, true)
        assert.equal(result[0]!.executionStatus, 'completed')
        assert.equal(result[0]!.sourceKind, 'desktop')
        assert.equal(result[0]!.latency, 12000)
        assert.equal(result[0]!.tokens, 42)
        assert.equal(result[0]!.llm_call_count, 1)
        assert.equal(result[0]!.interactions.filter((i: any) => i.role === 'user').length, 1)
        assert.ok(!JSON.stringify(core.snapshot()).includes('C:\\\\Users'), 'state must not retain raw local paths')
    })
}

test('446-15: alias survives relay restart and closes through the framework id', async () => {
    const { core, writer } = fixture()
    await native(core)
    await lifecycle(core)
    const restored = new CodexTraceCore({ writer, now: () => B })
    restored.restore(core.snapshot())
    await complete(restored)
    const session = restored.sessions.get('thread')
    assert.equal(session.turns.size, 1)
    assert.equal(restored.turnFor(session, 'native'), restored.turnFor(session, 'framework'))
    assert.equal(restored.turnFor(session, 'framework').closed, true)
})

test('446-15: repeated identical real turns remain separate, even within ten seconds', async () => {
    const { core, writer } = fixture()
    await lifecycle(core, 'one', 'same', 0)
    await native(core, 'native-one', 'same', 5100)
    await complete(core, 'one', 6000)
    await lifecycle(core, 'two', 'same', 6100)
    await native(core, 'native-two', 'same', 11200)
    await complete(core, 'two', 12000)
    const session = core.sessions.get('thread')
    assert.equal(session.turns.size, 2)
    assert.equal(core.turnFor(session, 'native-two'), core.turnFor(session, 'two'))
    assert.notEqual(core.turnFor(session, 'one'), core.turnFor(session, 'two'))
    assert.equal(records(writer).length, 2)
})

test('446-15: ambiguous redacted prompts do not guess between real executions', async () => {
    const { core } = fixture()
    await lifecycle(core, 'one')
    await lifecycle(core, 'two', prompt, 1)
    await native(core)
    assert.equal(core.sessions.get('thread').turns.size, 3)
})

test('446-15: different prompts and expired matches are not merged', async () => {
    for (const [text, ms] of [['different task', 5058], [prompt, 20000]] as const) {
        const { core } = fixture()
        await lifecycle(core)
        await native(core, 'native', text, ms)
        assert.equal(core.sessions.get('thread').turns.size, 2)
    }
})

test('446-15: lifecycle follow-up aliases native prompt without replacing the initial goal', async () => {
    const { core, writer } = fixture()
    await lifecycle(core, 'framework', 'initial')
    await core.processLifecycleEvent({ eventId: 'follow-up', eventType: 'user_input_accepted',
        source: 'desktop_rollout', sourceKind: 'desktop', sourceThreadId: 'thread', sourceExecutionId: 'framework',
        timestampMs: B + 20000, inputKind: 'follow_up_unknown', payload: { content: redactValue(prompt) } })
    await native(core, 'follow-up-native', prompt, 20001)
    const session = core.sessions.get('thread')
    assert.equal(session.turns.size, 1)
    assert.equal(core.turnFor(session, 'framework').input, 'initial')
    assert.equal(records(writer).length, 1)
})
