import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import crypto from "node:crypto"
import * as plugin from "../scripts/opencode_plugin_otel"
import { buildAgentCallTree } from "../src/lib/engine/observability/agent-trace"

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"
const uploaderPromise = import("../scripts/opencode_uploader_client.js")

function proxyHookFixture(t: TestContext, installed = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode proxy #"))
  const insightDir = path.join(home, ".agent-insight")
  const directory = path.join(home, "project")
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true })
  const runtimeDir = path.join(insightDir, "inference-runtime")
  if (installed) {
    fs.mkdirSync(runtimeDir, { recursive: true })
    for (const file of ["inference_proxy.mjs", "inference_config.mjs", "inference_gateway.mjs"]) {
      fs.copyFileSync(path.resolve("scripts", file), path.join(runtimeDir, file))
    }
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { home, insightDir, directory }
}

async function runProxyConfigHook(fixture: ReturnType<typeof proxyHookFixture>, requestAfterConfigFailure?: string) {
  const pluginUrl = pathToFileURL(path.resolve("scripts/opencode_plugin_otel.ts")).href
  const script = `
    const imported = await import(${JSON.stringify(pluginUrl)})
    const initialize = imported.default?.default ?? imported.default
    const hooks = await initialize({ directory: ${JSON.stringify(fixture.directory)} })
    const originalFetch = async () => new Response('original')
    const cfg = { provider: { gateway: { npm: '@ai-sdk/openai-compatible', options: {
      baseURL: 'https://upstream.invalid/v1', apiKey: 'fixture-secret', fetch: originalFetch,
    } } } }
    if (${JSON.stringify(requestAfterConfigFailure)} !== undefined) {
      let configError = '', requestError = ''
      try { await hooks.config(cfg) } catch (error) { configError = error.message }
      try { await fetch(${JSON.stringify(requestAfterConfigFailure)}, { method: 'POST', body: '{}' }) }
      catch (error) { requestError = error.message }
      process.stdout.write(JSON.stringify({ configError, requestError }))
      process.exit(0)
    }
    await hooks.config(cfg)
    process.stdout.write(JSON.stringify({
      baseURL: cfg.provider.gateway.options.baseURL,
      apiKey: cfg.provider.gateway.options.apiKey,
      fetchPreserved: cfg.provider.gateway.options.fetch === originalFetch,
      correlationAvailable: typeof hooks['chat.headers'] === 'function',
    }))
  `
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: fixture.home, AGENT_INSIGHT_HOME: fixture.insightDir,
    XDG_CONFIG_HOME: path.join(fixture.home, ".config"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: "",
    OPENCODE_DISABLE_PROJECT_CONFIG: "false", AGENT_INSIGHT_API_KEY: "", AGENT_INSIGHT_HOST: "",
    AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: "true", AGENT_INSIGHT_OPENCODE_HEARTBEAT_MS: "0",
    AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(fixture.home, "spool"),
    AGENT_INSIGHT_OPENCODE_UPLOADER: path.join(fixture.home, "absent-uploader.js"),
  }
  delete env.AGENT_INSIGHT_DATA_DIR
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", data => { stdout += data })
    child.stderr.on("data", data => { stderr += data })
    child.on("error", reject)
    child.on("close", code => resolve({ code, stdout, stderr }))
  })
}

test("OpenCode config hook keeps collection and provider options when proxy runtime is absent or disabled", async t => {
  for (const installed of [false, true]) {
    const fixture = proxyHookFixture(t, installed)
    const result = await runProxyConfigHook(fixture)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      baseURL: "https://upstream.invalid/v1", apiKey: "fixture-secret", fetchPreserved: true, correlationAvailable: true,
    })
    assert.equal(fs.existsSync(path.join(fixture.insightDir, "inference-proxy")), false)
  }
})

test("OpenCode config hook loads the installed proxy before requests and passes the project directory", async t => {
  const fixture = proxyHookFixture(t)
  const token = "fixture-control-token"
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/_agent_insight/health")
    assert.equal(req.headers["x-agent-insight-control"], token)
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ instance: token }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const root = path.join(fixture.insightDir, "inference-proxy")
  fs.mkdirSync(root, { recursive: true })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ origin, token, accountHash: crypto.createHash('sha256').update('anonymous').digest('hex').slice(0, 16), runtimePath: fs.realpathSync(path.join(fixture.insightDir, 'inference-runtime/inference_proxy.mjs')) }))
  fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({ enabled: true, agents: ["opencode"], files: [], launchers: [] }))
  const projectConfig = path.join(fixture.directory, "opencode.json")
  fs.writeFileSync(projectConfig, JSON.stringify({ provider: { project: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://project.invalid/v1" } } } }))
  const result = await runProxyConfigHook(fixture)
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.ok(output.baseURL.startsWith(origin + "/managed/opencode/"), output.baseURL)
  assert.equal(output.apiKey, "fixture-secret")
  assert.equal(output.fetchPreserved, true)
  assert.equal(output.correlationAvailable, true)
  assert.ok(JSON.parse(fs.readFileSync(projectConfig, "utf8")).provider.project.options.baseURL.startsWith(origin + "/managed/opencode/"))
})

test("OpenCode config hook rejects installed proxy failures instead of allowing direct inference", async t => {
  const fixture = proxyHookFixture(t)
  const root = path.join(fixture.insightDir, "inference-proxy")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "installation.json"), "invalid-installation-json")
  const result = await runProxyConfigHook(fixture)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Agent Insight OpenCode inference proxy configuration failed/)
  assert.equal(result.stdout, "")
})

test("OpenCode blocks model requests when the host swallows a managed config failure", async t => {
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.end('{}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`
  for (const runtimePresent of [true, false]) {
    const fixture = proxyHookFixture(t, runtimePresent)
    const root = path.join(fixture.insightDir, 'inference-proxy')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ enabled: true, agents: ['opencode'] }))
    if (runtimePresent) {
      fs.writeFileSync(path.join(fixture.insightDir, 'inference-runtime/inference_proxy.mjs'),
        "export function prepareOpenCodeConfig() { throw new Error('fixture-secret must never escape') }")
    }
    const result = await runProxyConfigHook(fixture, endpoint)
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.match(output.configError, /Agent Insight OpenCode inference proxy configuration failed/)
    assert.match(output.requestError, /inference proxy.*blocked/i)
    assert.doesNotMatch(JSON.stringify(output), /fixture-secret/)
    assert.equal(requests, 0, 'a swallowed config error must not permit direct model inference')
  }
})

test("OpenCode skips a broken runtime when proxy management is disabled", async t => {
  const fixture = proxyHookFixture(t)
  const root = path.join(fixture.insightDir, 'inference-proxy')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ enabled: false, agents: ['opencode'] }))
  fs.writeFileSync(path.join(fixture.insightDir, 'inference-runtime/inference_proxy.mjs'), "throw new Error('disabled runtime must not load')")
  const result = await runProxyConfigHook(fixture)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).baseURL, 'https://upstream.invalid/v1')
})

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

test("OpenCode observer blocks model POST requests without bindings and can recover after successful configuration", async () => {
  const sent: unknown[][] = []
  const transport = { fetch: (...args: unknown[]) => { sent.push(args); return Promise.resolve(new Response('{}')) } }
  const capture = create(() => [], [], transport)
  capture.configure()
  capture.setBlocked(true)
  for (const endpoint of ['chat/completions', 'responses', 'messages']) {
    const url = `https://inference.invalid/v1/${endpoint}?feature=1`
    await assert.rejects(transport.fetch(url, { method: 'POST' }), /inference proxy.*blocked/i)
    await assert.rejects(transport.fetch(new Request(url, { method: 'POST' })), /inference proxy.*blocked/i)
  }
  assert.equal(sent.length, 0)
  await transport.fetch('https://inference.invalid/v1/models', { method: 'GET' })
  await transport.fetch('https://inference.invalid/v1/messages', { method: 'GET' })
  capture.setBlocked(false)
  await transport.fetch('https://inference.invalid/v1/messages', { method: 'POST' })
  assert.equal(sent.length, 3)
})

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
