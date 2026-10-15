import assert from "node:assert/strict"
import test from "node:test"
import * as plugin from "../scripts/opencode_plugin_otel"
import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"
const uploaderPromise = import("../scripts/opencode_uploader_client.js")

const assistant = (sessionID: string, id: string, parentID = "msg_user") => ({
  id, sessionID, parentID, role: "assistant", agent: "build",
  modelID: "probe", providerID: "gateway", time: { created: 1000 },
})
const input = (sessionID: string) => ({
  sessionID, agent: "build", message: { id: "msg_user" },
  model: { id: "probe", providerID: "gateway" },
})
function create(messages: (id: string) => any[], records: any[], transport: any = { fetch: globalThis.fetch }) {
  assert.equal(typeof (plugin as any).createInferenceCorrelation, "function")
  return (plugin as any).createInferenceCorrelation({
    client: { session: { messages: async ({ path }: any) => ({ data: messages(path.id) }) } },
  }, (record: any) => records.push(record), transport)
}

test("OpenCode correlation separates calls sharing a user message and concurrent child sessions", async () => {
  const records: any[] = []
  const current = new Map([['ses_root', 'msg_a'], ['ses_child_a', 'msg_b'], ['ses_child_b', 'msg_c']])
  const capture = create((sid) => [{ info: assistant(sid, current.get(sid)!) }], records)
  const results = await Promise.all([...current.keys()].map(async (sid) => {
    const output = { headers: { "existing-header": "retained" } } as any
    await capture.headers(input(sid), output)
    assert.equal(output.headers['x-agent-insight-session-id'], sid)
    assert.equal(output.headers['x-agent-insight-message-id'], current.get(sid))
    assert.equal(output.headers['existing-header'], 'retained')
    assert.ok(output.headers['x-agent-insight-request-id'])
    return output.headers['x-agent-insight-request-id']
  }))
  current.set('ses_root', 'msg_next')
  const next = { headers: {} } as any
  await capture.headers(input('ses_root'), next)
  results.push(next.headers['x-agent-insight-request-id'])
  assert.equal(new Set(results).size, 4)
  assert.ok(records.every(r => r.kind === 'llm.request' && r.payload.messageID !== 'msg_user'))
})

test("OpenCode correlation records distinct HTTP attempts across hook and transport retries", async () => {
  const records: any[] = []
  const seen: Headers[] = []
  const originalFetch = async (_url: any, init: any) => {
    seen.push(new Headers(init.headers))
    assert.equal(init.body, 'unchanged body')
    return new Response('{}', { status: seen.length === 1 ? 503 : 200 })
  }
  const transport = { fetch: originalFetch }
  const capture = create(sid => [{ info: assistant(sid, 'msg_assistant') }], records, transport)
  capture.configure()
  const wrapped = transport.fetch
  capture.configure()
  assert.equal(transport.fetch, wrapped)
  const first = { headers: {} } as any
  await capture.headers(input('ses_root'), first)
  await wrapped('http://localhost/v1/chat/completions', { headers: first.headers, body: 'unchanged body' })
  const retry = { headers: {} } as any
  await capture.headers(input('ses_root'), retry)
  assert.equal(retry.headers['x-agent-insight-request-id'], first.headers['x-agent-insight-request-id'])
  await wrapped('http://localhost/v1/chat/completions', { headers: retry.headers, body: 'unchanged body' })
  await wrapped('http://localhost/v1/chat/completions', { headers: retry.headers, body: 'unchanged body' })
  assert.equal(new Set(seen.map(h => h.get('x-agent-insight-attempt-id'))).size, 3)
  assert.ok(seen.every(h => h.get('x-agent-insight-request-id') === first.headers['x-agent-insight-request-id']))
  const completed = records.filter(r => r.kind === 'llm.attempt' && r.payload.status_code)
  assert.deepEqual(completed.map(r => r.payload.status_code), [503, 200, 200])
})

test("OpenCode correlation preserves fetch installed by provider auth loaders after config", async () => {
  const records: any[] = []
  const response = new Response('{}')
  const controller = new AbortController()
  const originalFetch = Object.assign((_url: any, init: any) => {
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), 'local-dummy')
    assert.ok(headers.get('x-agent-insight-attempt-id'))
    assert.equal(init.body, 'converted body')
    assert.equal(init.signal, controller.signal)
    return Promise.resolve(response)
  }, { preconnect: () => {} })
  const transport = { fetch: originalFetch }
  const capture = create(sid => [{ info: assistant(sid, 'msg_assistant') }], records, transport)
  const cfg: any = { provider: { gateway: { options: { baseURL: 'http://localhost/v1' } } } }
  capture.configure(cfg)
  let authCalls = 0
  const authFetch = async (url: any, init: any) => {
    authCalls++
    return transport.fetch(url, { ...init, body: 'converted body', headers: { ...init.headers, authorization: 'local-dummy' } })
  }
  const resolvedOptions = { fetch: authFetch, ...cfg.provider.gateway.options }
  assert.equal(resolvedOptions.fetch, authFetch)
  assert.deepEqual(cfg.provider.gateway.options, { baseURL: 'http://localhost/v1' })
  const output = { headers: {} }
  await capture.headers(input('ses_root'), output)
  assert.equal(await resolvedOptions.fetch('http://localhost/v1', { headers: output.headers, signal: controller.signal }), response)
  assert.equal(authCalls, 1)
  assert.equal(transport.fetch.preconnect, originalFetch.preconnect)
  assert.equal(records.filter(r => r.kind === 'llm.attempt' && r.payload.status_code).length, 1)
})

test("OpenCode correlation shares one observer across plugin instances and passes unrelated fetches through", async () => {
  const records: any[] = []
  const observed: any[] = []
  const promise = Promise.resolve(new Response('{}'))
  const originalFetch = function (this: any, ...args: any[]) { observed.push({ receiver: this, args }); return promise }
  const transport = { fetch: originalFetch }
  const captures = [create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport),
    create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)]
  const output = { headers: {} }
  for (const capture of captures) { capture.configure(); await capture.headers(input('ses_root'), output) }
  await transport.fetch('http://localhost/v1', { headers: output.headers })
  const attempts = records.filter(r => r.kind === 'llm.attempt')
  assert.equal(attempts.length, 2)
  assert.equal(new Set(attempts.map(r => r.payload.attempt_id)).size, 1)
  assert.equal(new Headers(observed[0].args[1].headers).get('x-agent-insight-attempt-id'), attempts[0].payload.attempt_id)
  const init = { headers: { 'x-agent-insight-request-id': 'unknown' } }
  assert.equal(transport.fetch('http://localhost/unrelated', init), promise)
  assert.equal(observed[1].args[1], init)
  assert.equal(observed[1].receiver, transport)
  assert.equal(records.filter(r => r.kind === 'llm.attempt').length, 2)
})

test("OpenCode correlation leaves unbound or ambiguous requests unlabelled and preserves transport errors", async () => {
  const records: any[] = []
  for (const candidates of [[], [assistant('ses_root', 'a'), assistant('ses_root', 'b')],
    [{ ...assistant('ses_root', 'done'), time: { created: 1, completed: 2 } }],
    [assistant('ses_other', 'foreign')], [assistant('ses_root', 'wrong-parent', 'other-user')]]) {
    const capture = create(() => candidates.map(info => ({ info })), records)
    const output = { headers: { retained: 'yes' } }
    await capture.headers(input('ses_root'), output)
    assert.deepEqual(output.headers, { retained: 'yes' })
  }
  const originalError = new Error('private transport detail')
  const transport = { fetch: async (..._args: any[]) => { throw originalError } }
  const capture = create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)
  const output = { headers: {} }
  await capture.headers(input('ses_root'), output)
  await assert.rejects(() => transport.fetch('http://localhost', { headers: output.headers }), error => error === originalError)
  assert.ok(records.some(r => r.kind === 'llm.attempt' && r.payload.error_type === 'Error'))
  assert.ok(!JSON.stringify(records).includes('private transport detail'))
})

test("OpenCode correlation survives upload aggregation, duplicate snapshots, JSON and final child LLM nodes", async () => {
  const uploader = await uploaderPromise
  const records: any[] = []
  for (const [sid, parentID, mid] of [['ses_root', '', 'msg_root'], ['ses_child', 'ses_root', 'msg_child']]) {
    records.push({ kind: 'event', payload: { type: 'session.created', event: { properties: { info: { id: sid, parentID } } } } })
    records.push({ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: assistant(sid, mid) } } } })
    records.push({ kind: 'event', payload: { type: 'message.part.updated', event: { properties: { part: { id: `part-${mid}`, sessionID: sid, messageID: mid, type: 'text', text: 'model response' } } } } })
    records.push({ kind: 'llm.request', sessionID: sid, payload: { messageID: mid, request_id: `request-${mid}` } })
    for (const [attempt_id, status_code] of [['failed', 503], ['success', 200]]) {
      const attempt = { kind: 'llm.attempt', sessionID: sid, payload: { messageID: mid, request_id: `request-${mid}`, attempt_id: `${mid}-${attempt_id}`, started_at: '2026-10-14T00:00:00Z', status_code } }
      records.push(attempt, attempt)
    }
  }
  const interactions = uploader.mergeGraph(uploader.buildState(records), 'ses_root')
  const tree = buildAgentCallTree(JSON.parse(JSON.stringify(interactions)))!
  const nodes = [tree, ...tree.children].flatMap(n => n.events.filter(e => e.kind === 'llm'))
  assert.equal(nodes.length, 2)
  for (const node of nodes) {
    const message = node.interaction as any
    assert.equal(message.inference_request_id, `request-${message.messageID}`)
    assert.equal(message.inference_attempts.length, 2)
    assert.deepEqual(message.inference_attempts.map((a: any) => a.status_code), [503, 200])
  }
})

test("OpenCode gateway call IDs survive failed retries and final LLM projection", async () => {
  const uploader = await uploaderPromise
  const ids = ['271c5a62-6e08-43ac-b8eb-761ad374a241', '0ffb3a6a-9f8a-464e-b973-049a45019858']
  const records: any[] = [{ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: assistant('ses_root', 'msg_a') } } } }]
  let count = 0
  const transport = { fetch: async () => new Response('{}', { status: count === 0 ? 503 : 200, headers: { 'x-agent-insight-call-id': ids[count++] } }) }
  const capture = create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)
  const output = { headers: {} }
  await capture.headers(input('ses_root'), output)
  for (let i = 0; i < 2; i++) await (transport.fetch as any)('http://localhost/v1', { headers: output.headers })
  assert.deepEqual(records.filter(r => r.payload.call_id).map(r => r.payload.call_id), ids)
  records.push({ kind: 'event', payload: { type: 'message.part.updated', event: { properties: { part: { id: 'part-a', sessionID: 'ses_root', messageID: 'msg_a', type: 'text', text: 'model response' } } } } })
  const tree = buildAgentCallTree(JSON.parse(JSON.stringify(uploader.mergeGraph(uploader.buildState(records), 'ses_root'))))!
  assert.deepEqual(tree.events.find(e => e.kind === 'llm')?.interaction.inference_call_ids, ids)
})
