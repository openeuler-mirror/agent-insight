import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize'
import { aggregateOtelTraceEvents } from '../src/lib/ingest/otel/aggregate'

const require = createRequire(import.meta.url)
const client = require('../scripts/reliability-client.cjs')
const { PiTraceCollector } = require('../scripts/agent-trace-collectors/pi-agent/lib/pi-trace-core.cjs')
const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-pi-'))
  const keys = ['PATH', 'PI_CODING_AGENT_DIR', 'AGENT_INSIGHT_USER_HOME', 'AGENT_INSIGHT_PI_CONFIG',
    'AGENT_INSIGHT_API_KEY', 'AGENT_INSIGHT_OTLP_ENDPOINT', 'PI_TEST_MODE', 'AGENT_INSIGHT_SUPERVISOR', 'SHELL', 'ZDOTDIR', 'PI_TELEMETRY', 'HOME', 'PI_TEST_CATALOG_AUTH']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const agentDir = path.join(root, 'agent')
  const packageDir = path.join(root, '.agent-insight', 'collectors', 'pi-agent')
  fs.mkdirSync(agentDir)
  const executable = path.join(root, 'pi')
  fs.writeFileSync(executable, `#!${process.execPath}
require('node:fs').appendFileSync(require('node:path').join(__dirname, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.includes('--version')) { console.log('0.85.1'); process.exit(0) }
if (process.argv.includes('--help')) { console.log('--mode --session-id --name --model --print --no-approve'); process.exit(0) }
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog-slow') {
  setTimeout(() => { console.log('fixture slow-model 200K 8K yes no'); process.exit(0) }, 3500)
  return
}
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog-hang') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  return
}
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog-overflow') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024))
  setInterval(() => {}, 1000)
  return
}
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog-invalid') {
  console.log('unexpected output')
  process.exit(0)
}
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog-failure') process.exit(2)
if (process.argv.includes('--list-models') && process.env.PI_TEST_MODE === 'catalog') {
  if (process.env.PI_TEST_CATALOG_AUTH) {
    for (let i = 0; i < 405; i++) console.log('fixture model-' + i + ' 200K 8K yes no')
    console.log('deepseek deepseek-v4-flash 1M 32K no yes')
  } else console.log('No models available')
  process.exit(0)
}
if (process.argv.includes('--list-models')) { console.log('provider model context max-out thinking images\\nfixture org/model 200K 8K yes no'); process.exit(0) }
const emit = e => console.log(JSON.stringify(e))
const mode = process.env.PI_TEST_MODE
const id = process.argv[process.argv.indexOf('--session-id') + 1]
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => input += c)
process.stdin.on('end', () => {
  if (mode !== 'missing') emit({type:'session', id: mode === 'mismatch' ? 'wrong-id' : id})
  if (mode === 'timeout') { setInterval(() => {}, 1000); return }
  if (mode === 'nonzero') { process.exitCode = 7; return }
  emit({type:'message_end', message:{role:'user',content:[{type:'text',text:input}]}})
  if (mode === 'retry' || mode === 'error') {
    emit({type:'message_end', message:{role:'assistant',stopReason:'error',errorMessage:'provider HTTP 401 Unauthorized',content:[]}})
    emit({type:'agent_end',willRetry:mode === 'retry'})
  }
  if (!['empty','error'].includes(mode)) {
    emit({type:'tool_execution_end',result:{sessionId:'not-the-root-session'}})
    emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:input}]}})
  }
  if (mode !== 'incomplete') process.stdout.write(JSON.stringify({type:'agent_settled'}))
})
`)
  fs.chmodSync(executable, 0o755)
  Object.assign(process.env, {
    PATH: `${root}:${previous.PATH || ''}`, PI_CODING_AGENT_DIR: agentDir,
    AGENT_INSIGHT_USER_HOME: root, PI_TELEMETRY: 'off',
  })
  for (const key of ['AGENT_INSIGHT_PI_CONFIG', 'AGENT_INSIGHT_API_KEY', 'AGENT_INSIGHT_OTLP_ENDPOINT', 'AGENT_INSIGHT_SUPERVISOR']) delete process.env[key]
  const settings = (value: unknown) => fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(value))
  const config = (value: unknown) => fs.writeFileSync(path.join(packageDir, 'config.json'), JSON.stringify(value))
  return {
    root, agentDir, packageDir, executable, settings, config,
    installCollector() {
      fs.cpSync(path.resolve('scripts/agent-trace-collectors/pi-agent'), packageDir, { recursive: true })
      fs.cpSync(path.resolve('scripts/agent-trace-collectors/shared'), path.join(packageDir, '..', 'shared'), { recursive: true })
      settings({ packages: [packageDir] })
      config({ enabled: true, apiKey: 'test-only', endpoint: 'http://127.0.0.1:9/otel' })
    },
    close() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('Pi invocation isolates every launch and passes prompts literally over stdin', () => {
  const f = fixture()
  try {
    const input = { platform: 'pi-agent', agent: 'pi-agent', input: '@private.txt\n--help $(literal)', model: 'provider/org/model', correlation: { caseRunId: 'case-1' } }
    const invocation = client.buildExperimentCaseInvocation(f.executable, input)
    assert.equal(invocation.stdin, input.input)
    assert.deepEqual(invocation.args, ['--mode', 'json', '--session-id', invocation.sessionId, '--no-approve', '--print', '--name', 'case-1', '--model', input.model])
    assert.notEqual(client.buildExperimentCaseInvocation(f.executable, input).sessionId, invocation.sessionId)
    assert.throws(() => client.buildExperimentCaseInvocation(f.executable, { ...input, agent: 'worker' }), { code: 'AGENT_RUNTIME_UNAVAILABLE' })
    fs.writeFileSync(f.executable, `#!${process.execPath}\nconsole.log('0.81.0')\n`)
    assert.throws(() => client.buildExperimentCaseInvocation(f.executable, input), { code: 'AGENT_RUNTIME_UNAVAILABLE' })
  } finally { f.close() }
})

test('Pi capabilities require registered, enabled, writable Collector and preserve FI boundaries', async () => {
  const f = fixture()
  try {
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, false)
    f.installCollector()
    await client.refreshPiModelCatalog()
    const ready = client.probeExperimentRuntime('pi-agent')
    assert.equal(ready.ready, true)
    assert.deepEqual(ready.models, ['fixture/org/model'])
    const cfg = { fiPackageRoot: '/missing', maxParallelFi: 1 }
    const caps = client.buildCapabilities(cfg, { refresh: true })
    assert.ok(client.benchmarkAgentPlatformsFromCapabilities(caps).includes('pi-agent'))
    assert.deepEqual(caps.platforms.find((p: any) => p.id === 'pi-agent').agents, ['pi-agent'])
    assert.equal(client.buildFiInventory(cfg).platforms['pi-agent'], undefined)
    const existing = { id: 'opencode', agents: ['build'], models: ['provider/model'] }
    const merged = client.mergePiRuntimeCapability([existing, { id: 'pi-agent', agents: ['worker'] }], ready)
    assert.equal(merged.length, 2)
    assert.equal(merged[0], existing)
    assert.deepEqual(merged[1].agents, ['pi-agent'])
    const before = client.capabilityDiscoveryFingerprint()
    f.settings({ packages: [{ source: f.packageDir, extensions: [] }] })
    assert.notEqual(client.capabilityDiscoveryFingerprint(), before)
    assert.equal(client.probeExperimentRuntime('pi-agent').canResolveTraceId, false)
    f.settings({ packages: [{ source: f.packageDir, autoload: false }] })
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, false)
    f.settings({ packages: [f.packageDir] })
    f.config({ apiKey: 'test-only', enabled: false })
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, false)
    f.config({ apiKey: 'test-only', endpoint: 'file:///not-http' })
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, false)
    f.config({ endpoint: 'http://127.0.0.1:9/otel' })
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, false)
    f.config({ apiKey: 'test-only', endpoint: 'http://127.0.0.1:9/otel' })
    assert.equal(client.probeExperimentRuntime('pi-agent').ready, true)
    assert.equal(fs.existsSync(path.join(f.root, '.agent-insight', 'otel_data', 'pi-agent')), true)
  } finally { f.close() }
})

for (const [shell, supervisor] of [['/bin/zsh', 'launchd'], ['/bin/bash', 'systemd']]) {
  test(`Pi model discovery shares ${supervisor}/${path.basename(shell)} environment without validating models`, {
    skip: !fs.existsSync(shell),
  }, async () => {
    const f = fixture()
    try {
      f.installCollector()
      Object.assign(process.env, { HOME: f.root, ZDOTDIR: f.root, SHELL: shell, PI_TEST_MODE: 'catalog' })
      delete process.env.PI_TEST_CATALOG_AUTH
      await client.refreshPiModelCatalog()
      assert.deepEqual(client.probeExperimentRuntime('pi-agent').models, [])
      const startup = 'export PI_TEST_CATALOG_AUTH=not-a-real-key\necho "startup bogus-model 200K 8K yes no"\necho startup-secret >&2\ncd /\n'
      fs.writeFileSync(path.join(f.root, '.zshrc'), startup)
      fs.writeFileSync(path.join(f.root, '.bashrc'), startup)
      fs.writeFileSync(path.join(f.root, '.bash_profile'), '. "$HOME/.bashrc"\n')
      process.env.AGENT_INSIGHT_SUPERVISOR = supervisor
      await client.refreshPiModelCatalog()
      const probe = client.probeExperimentRuntime('pi-agent')
      assert.equal(probe.ready, true)
      assert.equal(probe.models.length, 406)
      assert.ok(probe.models.includes('deepseek/deepseek-v4-flash'))
      assert.ok(!probe.models.includes('startup/bogus-model'))
      assert.equal(process.env.PI_TEST_CATALOG_AUTH, undefined)
      const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(calls.every(args => ['--version', '--help', '--list-models'].some(flag => args.includes(flag))))
      assert.equal(calls.filter(args => args.includes('--list-models')).length, 2)
      client.probeExperimentRuntime('pi-agent')
      await client.refreshPiModelCatalog()
      assert.equal(fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').length, calls.length)
      process.env.PI_TEST_MODE = 'success'
      const run = await client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
        platform: 'pi-agent', agent: 'pi-agent', input: 'literal $(touch SHOULD_NOT_EXIST)', timeoutSeconds: 5,
      })
      assert.equal(run.exitCode, 0)
      assert.equal(run.stderr, undefined)
      assert.equal(fs.existsSync(path.join(f.root, 'SHOULD_NOT_EXIST')), false)
    } finally { f.close() }
  })
}

test('Pi catalog failures and unsupported shells preserve runtime readiness with an empty list', async () => {
  const f = fixture()
  try {
    f.installCollector()
    process.env.PI_TEST_MODE = 'catalog-failure'
    assert.equal((await client.refreshPiModelCatalog()).error, 'EXIT_NONZERO')
    const failed = client.probeExperimentRuntime('pi-agent')
    assert.equal(failed.ready, true)
    assert.deepEqual(failed.models, [])
    Object.assign(process.env, { SHELL: '/not-supported/fish', AGENT_INSIGHT_SUPERVISOR: 'systemd' })
    assert.equal((await client.refreshPiModelCatalog()).error, 'SPAWN_FAILED')
    const unsupported = client.probeExperimentRuntime('pi-agent')
    assert.equal(unsupported.ready, true)
    assert.deepEqual(unsupported.models, [])
  } finally { f.close() }
})

test('Pi slow catalogs run asynchronously beyond three seconds and coalesce concurrent refreshes', async () => {
  const f = fixture()
  let ticks = 0
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    f.installCollector()
    process.env.PI_TEST_MODE = 'catalog-slow'
    client.probeExperimentRuntime('pi-agent')
    assert.equal(client.PI_MODEL_PROBE_TIMEOUT_MS, 20000)
    timer = setInterval(() => { ticks++ }, 50)
    const [first, second] = await Promise.all([client.refreshPiModelCatalog(), client.refreshPiModelCatalog()])
    assert.equal(first.error, null)
    assert.deepEqual(first.models, ['fixture/slow-model'])
    assert.equal(first, second)
    assert.ok(ticks >= 20, `event-loop heartbeat only ticked ${ticks} times`)
    assert.deepEqual(client.probeExperimentRuntime('pi-agent').models, first.models)
    const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(args => args.includes('--list-models')).length, 1)
  } finally { clearInterval(timer); f.close() }
})

test('Pi catalog timeout preserves the last success, retries sooner and never publishes partial output', async () => {
  const f = fixture()
  try {
    f.installCollector()
    assert.equal((await client.refreshPiModelCatalog()).error, null)
    for (const [mode, error] of [['catalog-hang', 'TIMEOUT'], ['catalog-failure', 'EXIT_NONZERO'],
      ['catalog-overflow', 'OUTPUT_LIMIT'], ['catalog-invalid', 'INVALID_OUTPUT']]) {
      process.env.PI_TEST_MODE = mode
      const started = Date.now()
      const failed = await client.refreshPiModelCatalog({ force: true, timeoutMs: 500 })
      assert.equal(failed.error, error)
      assert.deepEqual(failed.models, ['fixture/org/model'])
      assert.ok(Date.now() - started < 3000)
      assert.ok(failed.nextRefreshAt - Date.now() <= 30000)
      assert.ok(failed.nextRefreshAt - Date.now() > 0)
      assert.equal(await client.refreshPiModelCatalog(), failed)
    }
    process.env.PI_TEST_MODE = 'success'
    const now = Date.now
    try {
      Date.now = () => now() + 31000
      assert.equal((await client.refreshPiModelCatalog()).error, null)
    } finally { Date.now = now }
    process.env.PI_TEST_MODE = 'catalog'
    delete process.env.PI_TEST_CATALOG_AUTH
    const empty = await client.refreshPiModelCatalog({ force: true })
    assert.equal(empty.error, null)
    assert.deepEqual(empty.models, [])
    assert.deepEqual(client.probeExperimentRuntime('pi-agent').models, [])
    process.env.PI_TEST_MODE = 'success'
    assert.equal((await client.refreshPiModelCatalog({ force: true })).error, null)
    f.settings({ packages: [f.packageDir], defaultModel: 'changed' })
    assert.deepEqual(client.probeExperimentRuntime('pi-agent').models, [])
  } finally { f.close() }
})

test('Pi shared executor handles retry success, final failures, no output and deadlines', async () => {
  const f = fixture()
  try {
    f.installCollector()
    const reports: string[] = []
    const run = (mode: string, overrides = {}) => {
      process.env.PI_TEST_MODE = mode
      return client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
        platform: 'pi-agent', agent: 'pi-agent', input: '@literal --help\n你好',
        timeoutSeconds: 5, firstModelResponseTimeoutSeconds: 2, ...overrides,
      }, async ({ traceId }: { traceId: string }) => { reports.push(traceId) })
    }
    const success = await run('success')
    assert.equal(success.exitCode, 0)
    assert.equal(success.modelActivityObserved, true)
    assert.match(success.traceId, /^agent-insight-[a-f0-9]{32}__task0$/)
    assert.deepEqual(reports, [success.traceId])
    const retry = await run('retry')
    assert.equal(retry.exitCode, 0)
    assert.notEqual(retry.traceId, success.traceId)
    for (const [mode, code] of [['error','MODEL_UNAVAILABLE'], ['empty','AGENT_NO_OUTPUT'],
      ['missing','TRACE_ID_MISSING'], ['mismatch','TRACE_ID_MISMATCH'], ['nonzero','AGENT_EXIT_NONZERO'], ['incomplete','AGENT_INCOMPLETE']]) {
      await assert.rejects(run(mode), { code })
    }
    await assert.rejects(run('timeout', { firstModelResponseTimeoutSeconds: 1 }), { code: 'MODEL_START_TIMEOUT' })
    await assert.rejects(run('timeout', { timeoutSeconds: 1 }), { code: 'AGENT_TIMEOUT' })
  } finally { f.close() }
})

test('Pi refuses execution when Collector is absent instead of creating an unbindable run', async () => {
  const f = fixture()
  try {
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
      platform: 'pi-agent', agent: 'pi-agent', input: 'hello',
    }), { code: 'AGENT_RUNTIME_UNAVAILABLE' })
  } finally { f.close() }
})

test('Pi parser recognizes only real model activity and waits through retry events', () => {
  const inspect = client.createPiEventInspector({ sessionId: 'test-base' })
  const emit = (value: unknown) => inspect(JSON.stringify(value))
  assert.equal(emit({ type: 'session', id: 'test-base' }).traceId, 'test-base__task0')
  for (const type of ['agent_start', 'turn_start', 'message_start', 'auto_retry_start']) assert.equal(Boolean(emit({ type }).modelActivity), false)
  assert.equal(emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } }).modelActivity, true)
  assert.equal(emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'connection failed' } }).error, null)
  assert.equal(emit({ type: 'agent_end', willRetry: true }).error, null)
  assert.equal(emit({ type: 'agent_settled' }).error, 'Pi model: connection failed')
  assert.equal(client.classifyAgentExitFailure({ platform: 'pi-agent', exitCode: 1,
    diagnostic: 'Model "unknown/provider-model" not found. Use --list-models to see available models.' }).code, 'MODEL_UNAVAILABLE')
})

test('Pi reported task ID matches the real Collector and OTLP aggregation contract', async () => {
  const events: any[] = []
  const collector = new PiTraceCollector({
    config: { enabled: true, apiKey: 'test-only', endpoint: 'http://127.0.0.1:9', homeDir: os.tmpdir() },
    writer: { async append(event: any) { events.push(event) }, async flush() {} },
    uploader: { start() {}, stop() {}, async flushOnce() {} },
  })
  collector.startSession('test-base')
  collector.recordInput('hello')
  collector.beginAgent({ prompt: 'hello' }, { sessionManager: { getSessionId: () => 'test-base' } })
  collector.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'world' }], stopReason: 'stop', timestamp: Date.now() })
  await collector.settleAgent()
  await collector.shutdown()
  const normalized = normalizeOtlpTraces(canonicalEventsToOtlp(events, { framework: 'pi-agent' }), { authenticatedUser: 'test' })
  const id = client.createPiEventInspector({ sessionId: 'test-base' })(JSON.stringify({ type: 'session', id: 'test-base' })).traceId
  assert.equal(normalized[0].sessionId, id)
  assert.notEqual(normalized[0].traceId, id)
  assert.equal(aggregateOtelTraceEvents(id, normalized)?.task_id, id)
})

test('supervised Pi retains stdin and isolates shell startup output', { skip: !fs.existsSync('/bin/zsh') }, async () => {
  const f = fixture()
  try {
    f.installCollector()
    fs.writeFileSync(path.join(f.root, '.zshrc'), 'echo startup-secret\necho startup-secret >&2\ncd /\n')
    Object.assign(process.env, { SHELL: '/bin/zsh', ZDOTDIR: f.root, AGENT_INSIGHT_SUPERVISOR: 'launchd' })
    const result = await client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
      platform: 'pi-agent', agent: 'pi-agent', input: 'literal $(touch SHOULD_NOT_EXIST)', timeoutSeconds: 5,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, undefined)
    assert.equal(fs.existsSync(path.join(f.root, 'SHOULD_NOT_EXIST')), false)
  } finally { f.close() }
})

test('installed Pi CLI integrates with the existing Collector against an isolated local provider', {
  skip: !process.env.PI_EXPERIMENT_TEST_CLI,
}, async () => {
  const realCli = process.env.PI_EXPERIMENT_TEST_CLI!
  const f = fixture()
  const traces: unknown[] = []
  const prompts: any[] = []
  let rejectAuth = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      if (req.url === '/otel') {
        traces.push(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      prompts.push(JSON.parse(body))
      if (rejectAuth) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'unauthorized test request' } }))
        return
      }
      if (prompts.length === 1) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'temporarily unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'hello from local provider' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]) res.write(`data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', model: 'test-model', ...chunk })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    f.installCollector()
    fs.unlinkSync(f.executable)
    fs.symlinkSync(realCli, f.executable)
    f.settings({ packages: [f.packageDir], retry: { enabled: true, maxRetries: 1, baseDelayMs: 20, provider: { maxRetries: 0 } } })
    f.config({ enabled: true, apiKey: 'local-test-only', endpoint: `http://127.0.0.1:${port}/otel`, shutdownTimeoutMs: 1000 })
    fs.writeFileSync(path.join(f.agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
      models: [{ id: 'test-model', name: 'test-model', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }))
    const input = '@not-a-file --help\n只回复 hello，不执行工具。'
    const result = await client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
      platform: 'pi-agent', agent: 'pi-agent', model: 'fixture/test-model', input, timeoutSeconds: 20,
    })
    assert.equal(result.exitCode, 0)
    assert.ok(prompts.length >= 2, 'the real CLI retried the transient failure')
    assert.ok(JSON.stringify(prompts[0].messages).includes('@not-a-file --help'))
    const normalized = traces.flatMap(payload => normalizeOtlpTraces(payload as any, { authenticatedUser: 'test' }))
    assert.ok(normalized.length, 'the real Collector uploaded spans')
    assert.ok(normalized.every(event => event.sessionId === result.traceId), 'retry remains within task0')
    assert.equal(aggregateOtelTraceEvents(result.traceId, normalized)?.task_id, result.traceId)
    rejectAuth = true
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
      platform: 'pi-agent', agent: 'pi-agent', model: 'fixture/test-model', input: 'hello', timeoutSeconds: 20,
    }), { code: 'MODEL_UNAVAILABLE' })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    f.close()
  }
})
