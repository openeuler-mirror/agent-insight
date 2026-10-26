import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../scripts/opencode_plugin_otel'
import { buildAgentCallTree } from '../src/lib/engine/observability/agent-trace'

const model = { providerID: 'local', id: 'mock' }
const step = (sessionID: string, assistantMessageID: string) => ({ type: 'session.step.started', created: 100, data: { sessionID, assistantMessageID, agent: 'build', model, started: 100 } })
async function fixture() {
  const factory = (plugin as any).createOpenCodeV2Adapter
  assert.equal(typeof factory, 'function')
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1'
  const uploader = await import('../scripts/opencode_uploader_client.js')
  const records: any[] = [], events: any[] = []
  const context = { session: { context: async (_input: any): Promise<any[]> => [] } }
  const adapter = factory(context, (r: any) => records.push(r), async (event: any) => {
    events.push(event)
    records.push({ kind: 'event', sessionID: event.properties.sessionID, payload: { type: event.type, event } })
  })
  const interactions = (sid: string): any[] => uploader.mergeGraph(uploader.buildState(records), sid)
  return { adapter, context, records, events, interactions }
}

test('V2 snapshots collect user prompts and streamed output through the existing uploader', async () => {
  const f = await fixture()
  f.context.session.context = async () => [{ id: 'user', type: 'user', text: 'test prompt', time: { created: 50 } }]
  await f.adapter.context({ sessionID: 'ses_root', model, system: [{ type: 'text', text: 'system prompt' }] })
  await f.adapter.event(step('ses_root', 'answer'))
  for (const [i, delta] of ['hel', 'lo'].entries()) await f.adapter.event({ id: `delta-${i}`, type: 'session.text.delta', data: { sessionID: 'ses_root', assistantMessageID: 'answer', ordinal: 0, delta } })
  await f.adapter.event({ type: 'session.step.ended', created: 200, data: { sessionID: 'ses_root', assistantMessageID: 'answer', finish: 'stop', tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } } })
  const rows = f.interactions('ses_root')
  assert.equal(rows.find((r: any) => r.messageID === 'user').content, 'test prompt')
  const answer = rows.find((r: any) => r.messageID === 'answer')
  assert.equal(answer.content, 'hello')
  assert.equal(answer.usage.input, 10)
  assert.equal(answer.usage.cache.read, 3)
  assert.equal(answer.modelID, 'mock')
  assert.equal(f.records.find(r => r.kind === 'system.prompt').payload.system[0], 'system prompt')
})

test('V2 concurrent child sessions retain exact parent and task tool relationships', async () => {
  const f = await fixture()
  await f.adapter.event({ type: 'session.created', created: 1, data: { sessionID: 'ses_root', agent: 'build' } })
  await f.adapter.event(step('ses_root', 'root-call'))
  await Promise.all(['a', 'b'].map(async suffix => {
    const child = `ses_${suffix}`, tool = `tool-${suffix}`, mid = `message-${suffix}`
    await f.adapter.event({ type: 'session.created', created: 2, data: { sessionID: child, parentID: 'ses_root', agent: 'worker' } })
    for (const [type, data] of [
      ['input.started', { name: 'subagent' }],
      ['called', { input: { agent: 'worker', prompt: suffix } }],
      ['success', { content: [{ type: 'text', text: suffix }], metadata: { sessionID: child } }],
    ] as const) await f.adapter.event({ type: `session.tool.${type}`, created: 120, data: { sessionID: 'ses_root', assistantMessageID: 'root-call', id: tool, ...data } })
    await f.adapter.event(step(child, mid))
    await f.adapter.event({ type: 'session.text.ended', created: 130, data: { sessionID: child, assistantMessageID: mid, ordinal: 0, text: suffix } })
  }))
  const rows = f.interactions('ses_root')
  for (const suffix of ['a', 'b']) {
    const child = rows.find((r: any) => r.messageID === `message-${suffix}`)
    assert.equal(child.subagent_session_id, `ses_${suffix}`)
    const tool = rows.find((r: any) => r.messageID === 'root-call').parts.find((p: any) => p.callID === `tool-${suffix}`)
    assert.equal(tool.state.sessionID, `ses_${suffix}`)
  }
  f.context.session.context = async ({ sessionID }) => [{ id: `prompt-${sessionID}`, type: 'user', text: 'child prompt', time: { created: 101 } }]
  for (const suffix of ['a', 'b']) await f.adapter.event({ type: 'session.execution.succeeded', data: { sessionID: `ses_${suffix}` } })
  const tree = buildAgentCallTree(f.interactions('ses_root'))!
  assert.equal(tree.children.length, 2)
  assert.equal(tree.events.filter(e => e.kind === 'llm').length, 1)
  for (const child of tree.children) {
    assert.equal(child.events.filter(e => e.kind === 'llm').length, 1)
    assert.equal(child.events.filter(e => e.kind === 'user').length, 1)
  }
})

test('V2 failures and empty native LLM nodes survive final normalization', async () => {
  const f = await fixture()
  for (const mid of ['failed', 'empty']) await f.adapter.event(step('ses_root', mid))
  await f.adapter.event({ type: 'session.step.failed', created: 200, data: { sessionID: 'ses_root', assistantMessageID: 'failed', error: { type: 'provider.unavailable', message: 'provider failed' } } })
  const rows = f.interactions('ses_root')
  const failed = rows.find((r: any) => r.messageID === 'failed')
  assert.equal(failed.status, 'error')
  assert.equal(failed.error_summary, 'provider failed')
  const llms = buildAgentCallTree(rows)!.events.filter(e => e.kind === 'llm')
  assert.equal(llms.length, 2)
  assert.equal(llms.find(e => e.interaction.messageID === 'empty')!.summary, '未采集到模型输出')
})

test('V2 retry steps reuse their native message without duplicating LLM nodes', async () => {
  const f = await fixture()
  await f.adapter.event(step('ses_root', 'answer'))
  await f.adapter.event({ type: 'session.step.failed', created: 120, data: { sessionID: 'ses_root', assistantMessageID: 'answer', error: { message: 'retryable' } } })
  await f.adapter.event(step('ses_root', 'answer'))
  await f.adapter.event({ type: 'session.text.ended', created: 130, data: { sessionID: 'ses_root', assistantMessageID: 'answer', ordinal: 0, text: 'recovered' } })
  await f.adapter.event({ type: 'session.step.ended', created: 200, data: { sessionID: 'ses_root', assistantMessageID: 'answer', finish: 'stop' } })
  const rows = f.interactions('ses_root')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content, 'recovered')
  assert.equal(rows[0].status, undefined)
})

test('V2 deduplicates replayed deltas and recovers interrupted output from snapshots', async () => {
  const f = await fixture()
  await f.adapter.event(step('ses_root', 'answer'))
  const delta = { id: 'replay', type: 'session.reasoning.delta', data: { sessionID: 'ses_root', assistantMessageID: 'answer', ordinal: 0, delta: 'thinking' } }
  await f.adapter.event(delta); await f.adapter.event(delta)
  f.context.session.context = async () => [{ id: 'answer', type: 'assistant', agent: 'build', model, content: [{ type: 'reasoning', text: 'thinking' }], time: { created: 100, completed: 200 } }]
  await f.adapter.event({ type: 'session.execution.interrupted', created: 200, data: { sessionID: 'ses_root', reason: 'user' } })
  assert.equal(f.events.filter(e => e.type === 'message.part.delta').length, 1)
  assert.equal(f.interactions('ses_root')[0].parts[0].text, 'thinking')
  assert.equal(f.events.at(-1).type, 'session.idle')
})

test('V2 collector registers observational hooks only and tolerates snapshot and stream failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-collector-'))
  const saved = { ...process.env }, registry: Record<string, any> = {}
  Object.assign(process.env, { AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_OPENCODE_UPLOADER: path.join(root, 'missing'), AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: 'true', AGENT_INSIGHT_HOST: '', AGENT_INSIGHT_API_KEY: '' })
  delete process.env.AGENT_INSIGHT_DATA_DIR
  let cleanup: any
  try {
    cleanup = await (plugin as any).setupOpenCodeV2({ location: { directory: root }, session: { context: async () => { throw new Error('snapshot unavailable') }, hook: async (name: string, fn: any) => { registry[name] = fn } }, event: { subscribe: async function* () { throw new Error('stream unavailable') } }, provider: { transform: () => assert.fail('collector must not change provider routing') } })
    assert.deepEqual(Object.keys(registry).sort(), ['compaction', 'context', 'generate', 'title'])
    const input = { sessionID: 'ses_root', model, system: ['prompt'], options: { temperature: 0.2 }, messages: [] }
    const before = structuredClone(input)
    await registry.context(input)
    assert.deepEqual(input, before)
    await cleanup(); cleanup = undefined
    const files = fs.readdirSync(path.join(root, 'otel_data/opencode'), { recursive: true }).filter(p => String(p).endsWith('.jsonl'))
    assert.equal(files.length, 1)
    assert.match(fs.readFileSync(path.join(root, 'otel_data/opencode', String(files[0])), 'utf8'), /system.prompt/)
    assert.match(fs.readFileSync(path.join(root, 'logs/opencode_plugin.log'), 'utf8'), /stream unavailable/)
  } finally {
    await cleanup?.()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('V2 hung snapshots time out without blocking hooks or creating repeated RPCs', async () => {
  const f = await fixture()
  let calls = 0
  f.context.session.context = () => { calls++; return new Promise(() => {}) }
  const input = { sessionID: 'ses_root', model, system: [] }
  const started = Date.now()
  await Promise.race([
    Promise.all([f.adapter.context(input), f.adapter.context(input)]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('hook blocked')), 1000)),
  ])
  assert.ok(Date.now() - started < 1000)
  assert.equal(calls, 1)
  assert.ok(f.records.some(r => r.kind === 'collector.error' && /timed out/.test(r.payload.message)))
})


test('V2 captures late snapshots once while active and ignores them after disposal', async () => {
  for (const disposed of [false, true]) {
    const f = await fixture()
    let resolve!: (values: any[]) => void
    f.context.session.context = () => new Promise(r => { resolve = r })
    const input = { sessionID: 'ses_root', model, system: [] }
    await Promise.all([f.adapter.context(input), f.adapter.context(input)])
    if (disposed) f.adapter.close()
    resolve([{ type: 'user', id: 'slow-user', text: 'late prompt', time: { created: 100 } }])
    await new Promise(r => setImmediate(r))
    assert.equal(f.events.filter(e => e.type === 'message.updated').length, disposed ? 0 : 1)
    if (!disposed) assert.equal(f.interactions('ses_root')[0].content, 'late prompt')
  }
})


test('V2 late final snapshot triggers another terminal upload after its data', async () => {
  const f = await fixture()
  let resolve!: (values: any[]) => void
  f.context.session.context = () => new Promise(r => { resolve = r })
  await f.adapter.event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } })
  assert.equal(f.events.filter(e => e.type === 'session.idle').length, 1)
  resolve([{ type: 'user', id: 'late-user', text: 'late final prompt', time: { created: 100 } }])
  await new Promise(r => setImmediate(r))
  assert.equal(f.events.filter(e => e.type === 'session.idle').length, 2)
  assert.equal(f.events.at(-1).type, 'session.idle')
  assert.equal(f.interactions('ses_root')[0].content, 'late final prompt')
})
