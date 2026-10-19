import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../scripts/opencode_plugin_otel'

const model = { providerID: 'local', id: 'mock' }
const step = (sessionID: string, assistantMessageID: string) => ({ type: 'session.step.started', created: 100, data: { sessionID, assistantMessageID, agent: 'build', model, started: 100 } })
async function fixture() {
  const factory = (plugin as any).createOpenCodeV2Adapter
  assert.equal(typeof factory, 'function')
  const records: any[] = [], events: any[] = []
  const context = { session: { context: async () => [] } }
  const adapter = factory(context, (r: any) => records.push(r), async (e: any) => events.push(e), { identityTimeoutMs: 20 })
  const request = (sessionID: string, kind = 'primary') => ({ sessionID, agent: 'build', model, kind, request: new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' }) })
  return { adapter, context, records, events, request }
}

test('V2 binds delayed step events to request identities, including concurrent sessions and retries', async () => {
  const f = await fixture()
  const requests = [f.request('ses_A'), f.request('ses_B')]
  for (const r of requests) {
    const modelRequest = { ...r, headers: {} }
    await f.adapter.modelRequest(modelRequest)
    r.request = new Request(r.request, { headers: modelRequest.headers })
  }
  await Promise.all(requests.map(r => f.adapter.request(r)))
  assert.ok(requests.every(r => !r.request.headers.has('x-agent-insight-message-id')))
  assert.equal(new Set(requests.map(r => r.request.headers.get('x-agent-insight-attempt-id'))).size, 2)
  for (const [i, r] of requests.entries()) await f.adapter.response({ ...r, response: new Response('{}', { status: i ? 200 : 503, headers: { 'x-agent-insight-call-id': `00000000-0000-4000-8000-00000000000${i}` } }) })
  await f.adapter.event(step('ses_B', 'msg_B'))
  await f.adapter.event(step('ses_A', 'msg_A'))
  const retry = f.request('ses_A'), metadata = { ...retry, headers: {} }
  await f.adapter.modelRequest(metadata)
  retry.request = new Request(retry.request, { headers: metadata.headers })
  await f.adapter.request(retry)
  await f.adapter.response({ ...retry, response: new Response('{}', { headers: { 'x-agent-insight-call-id': '00000000-0000-4000-8000-000000000002' } }) })
  await f.adapter.event(step('ses_A', 'msg_A'))
  const bound = f.records.filter(r => r.kind === 'llm.attempt' && r.payload.call_id)
  assert.equal(bound.length, 3)
  assert.equal(bound.find(r => r.payload.status_code === 503).payload.messageID, 'msg_A')
  assert.equal(new Set(bound.filter(r => r.sessionID === 'ses_A').map(r => r.payload.request_id)).size, 1)
  assert.equal(new Set(bound.map(r => r.payload.transport_request_id)).size, 3)
})

test('V2 requires model-request identity and does not bind auxiliary requests to primary steps', async () => {
  const f = await fixture()
  await assert.rejects(f.adapter.request(f.request('ses_A')), /identity/i)
  const title = f.request('ses_A', 'title'), metadata = { ...title, headers: {} }
  await f.adapter.modelRequest(metadata)
  title.request = new Request(title.request, { headers: metadata.headers })
  await f.adapter.request(title)
  await f.adapter.event(step('ses_A', 'msg_A'))
  assert.equal(title.request.headers.get('x-agent-insight-session-id'), 'ses_A')
  assert.equal(title.request.headers.get('x-agent-insight-message-id'), null)
  assert.ok(!f.records.some(r => r.kind === 'llm.attempt'))
})

test('V2 normalizes parent relationships, streamed text, tool children and failed LLM results', async () => {
  const f = await fixture()
  await f.adapter.event({ type: 'session.created', created: 50, data: { sessionID: 'ses_child', parentID: 'ses_root', agent: 'worker' } })
  await f.adapter.event(step('ses_child', 'msg_child'))
  await f.adapter.event({ type: 'session.text.ended', created: 110, data: { sessionID: 'ses_child', assistantMessageID: 'msg_child', ordinal: 0, text: 'hello' } })
  await f.adapter.event({ type: 'session.step.failed', created: 200, data: { sessionID: 'ses_child', assistantMessageID: 'msg_child', error: { type: 'provider.unavailable', message: 'failure' } } })
  assert.equal(f.events[0].properties.info.parentID, 'ses_root')
  assert.ok(f.events.some(e => e.type === 'message.part.updated' && e.properties.part.text === 'hello'))
  const end = f.events.filter(e => e.type === 'message.updated').at(-1).properties.info
  assert.equal(end.id, 'msg_child')
  assert.equal(end.role, 'assistant')
  assert.equal(end.time.completed, 200)
  assert.ok(end.error)
})

 test('V2 leaves ambiguous native steps unassigned after missing lifecycle events', async () => {
  const f = await fixture()
  for (let i = 0; i < 2; i++) {
    const r = f.request('ses_A'), metadata = { ...r, headers: {} }
    await f.adapter.modelRequest(metadata)
    r.request = new Request(r.request, { headers: metadata.headers })
    await f.adapter.request(r)
  }
  await f.adapter.event(step('ses_A', 'msg_A'))
  assert.ok(!f.records.some(r => r.kind === 'llm.attempt'))
  assert.ok(f.records.some(r => r.kind === 'llm.correlation.unbound'))
})

test('V2 preserves native text and reasoning deltas before a final snapshot exists', async () => {
  const f = await fixture()
  for (const kind of ['text', 'reasoning']) await f.adapter.event({ type: `session.${kind}.delta`, id: kind, data: { sessionID: 'ses_A', assistantMessageID: 'msg_A', ordinal: 0, delta: `partial ${kind}` } })
  assert.deepEqual(f.events.map(e => e.properties.delta), ['partial text', 'partial reasoning'])
})

test('V2 context hook preserves system prompts with native model identity', async () => {
  const f = await fixture()
  await f.adapter.context({ sessionID: 'ses_A', model, system: [{ type: 'text', text: 'system one' }, { type: 'text', text: 'system two' }] })
  const system = f.records.find(r => r.kind === 'system.prompt')
  assert.deepEqual(system.payload.system, ['system one', 'system two'])
  assert.equal(system.modelID, model.id)
  assert.equal(system.providerID, model.providerID)
  assert.equal(system.payload.length, 21)
})


test('V2 setup fails closed for lost event streams and managed WebSockets, while restore preserves transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-setup-'))
  const before = { ...process.env }
  const registry: Record<string, any> = {}
  let transform: any, endStream!: () => void
  Object.assign(process.env, { AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(root, 'spool'), AGENT_INSIGHT_OPENCODE_UPLOADER: path.join(root, 'missing'), AGENT_INSIGHT_OPENCODE_HEARTBEAT_MS: '0', AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: 'true', AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_HOST: '' })
  let cleanup: any
  try {
    const setup = (plugin as any).setupOpenCodeV2
    cleanup = await setup({ location: { directory: root }, session: { context: async () => [], hook: async (name: string, fn: any) => { registry[name] = fn } }, provider: { transform: async (fn: any) => { transform = fn } }, event: { subscribe: async function* ({ signal }: any) { await new Promise<void>(r => { endStream = r; signal.addEventListener('abort', () => r(), { once: true }) }) } } })
    const provider = { id: 'local', settings: { transport: 'websocket' } }
    const editor = { list: () => [{ provider }], update: (_id: string, fn: any) => fn(provider) }
    transform(editor); assert.equal(provider.settings.transport, 'websocket')
    fs.mkdirSync(path.join(root, 'inference-proxy'))
    const installation = path.join(root, 'inference-proxy/installation.json')
    fs.writeFileSync(installation, JSON.stringify({ enabled: true, agents: ['opencode'] }))
    transform(editor); assert.equal(provider.settings.transport, 'http')
    await assert.rejects(registry['experimental.ws.handshake']({}), /WebSocket.*blocked/)
    const req: any = { sessionID: 'ses_A', agent: 'build', model, kind: 'primary', headers: {} }
    await registry['model.request'](req)
    req.request = new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: req.headers, body: '{}' })
    await assert.rejects(registry['http.request'](req), /Cannot find module/, 'missing installed runtime must not bypass proxy')
    fs.writeFileSync(installation, JSON.stringify({ enabled: false, agents: ['opencode'] }))
    await registry['experimental.ws.handshake']({})
    endStream(); await new Promise(r => setImmediate(r))
    await assert.rejects(registry['http.request'](req), /event stream unavailable/)
  } finally {
    await cleanup?.()
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
    Object.assign(process.env, before)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native failed empty assistant survives upload normalization as one LLM with every retry ID', async () => {
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1'
  const uploader = await import('../scripts/opencode_uploader_client.js')
  const { buildAgentCallTree } = await import('../src/lib/engine/observability/agent-trace')
  const state = uploader.buildState([
    { kind: 'event', payload: { type: 'message.updated', event: { properties: { info: { id: 'msg_fail', sessionID: 'ses_fail', role: 'assistant', agent: 'build', error: { type: 'provider.invalid-request', message: 'request rejected' }, finish: 'error', time: { created: 100, completed: 200 } } } } } },
    ...['call-failed', 'call-retry-failed'].map((id, i) => ({ kind: 'llm.attempt', sessionID: 'ses_fail', payload: { messageID: 'msg_fail', request_id: 'oc_logical', attempt_id: String(i), call_id: id, status_code: i ? 400 : 503 } })),
  ])
  const interactions: any[] = uploader.mergeGraph(state, 'ses_fail')
  const tree = buildAgentCallTree(interactions)!
  const llms = tree.events.filter(e => e.kind === 'llm')
  assert.equal(llms.length, 1)
  assert.equal(llms[0].summary, 'request rejected')
  assert.equal(llms[0].interaction.status, 'error')
  assert.deepEqual(llms[0].interaction.inference_call_ids, ['call-failed', 'call-retry-failed'])
})

test('V1 session errors bind only through the exact gateway response call ID', async () => {
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1'
  const uploader = await import('../scripts/opencode_uploader_client.js')
  const call = '00000000-0000-4000-8000-000000000001'
  const records = [
    ...['a', 'b'].map(mid => ({ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: { id: mid, sessionID: 'ses', role: 'assistant' } } } } })),
    { kind: 'llm.attempt', sessionID: 'ses', payload: { messageID: 'a', request_id: 'oc_a', attempt_id: 'a', call_id: call } },
    { kind: 'event', sessionID: 'ses', payload: { type: 'session.error', event: { properties: { sessionID: 'ses', error: { data: { message: 'terminal failure', responseHeaders: { 'x-agent-insight-call-id': call } } } } } } },
  ]
  const messages: any[] = uploader.mergeGraph(uploader.buildState(records), 'ses')
  assert.equal(messages.find(m => m.messageID === 'a').error_summary, 'terminal failure')
  assert.equal(messages.find(m => m.messageID === 'a').status, 'error')
  assert.equal(messages.find(m => m.messageID === 'b').status, undefined)
})
