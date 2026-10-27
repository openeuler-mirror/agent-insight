import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { inspectBenchmarkExecutionTargets } from '../src/lib/benchmark/execution-targets'
import { parseCapabilities } from '../src/lib/reliability/client-registry'
import { listTraceGenerationPlatforms } from '../src/lib/engine/experiment/execution-targets'
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize'
import { aggregateOtelTraceEvents } from '../src/lib/ingest/otel/aggregate'
import { assertJsonSchema } from '../packages/benchmark-protocol/src/json-schema'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { normalizeExecutionConfig, describeProfile, validateProfile, validateExecution, digest } = require('../packages/benchmark-protocol/execution.cjs')
const { BenchmarkExecutionRunner, FileRunStore, ExecutionBackendRegistry, GitPatchCollector, atomicWriteJson } = require('../services/executor/src/index.cjs')
const { XGovernorClient } = require('../services/executor/src/xgovernor/client.cjs')
const { piEvents, xiaooEvents } = require('../services/executor/src/xgovernor/trace.cjs')
const { executionCapabilities } = require('../services/executor/src/execution-config.cjs')

function configuration() {
  return normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': {
    sourceRevision: 'a'.repeat(40), serverExecutable: '/opt/xgovernor/server',
    runtimes: { 'pi-agent': { kind: 'pi', namespace: 'runtime_pi', agents: ['pi-agent'], workerExecutable: '/opt/xgovernor/pi-worker', executable: '/opt/pi', extensionDirectory: '/opt/extension' } },
    models: { 'provider/model': { provider: 'provider', model: 'model', apiKeyEnv: 'MODEL_KEY' } },
  } } })
}
function profile() { return describeProfile('xgovernor-local-docker', configuration().profiles['xgovernor-local-docker']) }
function request() {
  const p = { ...profile(), backendKey: 'test-backend' }
  const { definitionDigest: prior, ...description } = p
  void prior
  p.definitionDigest = digest(description)
  return {
    runId: 'erun_backend_test', timeoutSeconds: 30,
    task: {
      schemaVersion: 'agent-task/v1', benchmark: { key: 'arbitrary-benchmark' },
      context: { runId: 'erun_backend_test', experimentId: 'exp_test', caseId: 'case_test' },
      task: { instruction: 'Fix it', benchmarkPayload: {} },
      workspace: { provider: 'git', repository: 'https://github.com/example/project.git', revision: 'a'.repeat(40) },
      policy: { workspaceWrite: 'allow', hiddenDataAccess: 'deny', network: 'deny' },
      agentConfig: { platform: 'pi-agent', agent: 'pi-agent', timeoutSeconds: 30 },
      execution: { profile: p, environment: { kind: 'oci-image', image: 'example/test:latest', arch: 'amd64', workspaceRoot: '/testbed' } },
      submission: { requiredArtifacts: [{ name: 'model.patch', mediaType: 'text/x-diff', collector: 'git-patch/v1', maxBytes: 1024 }] },
    },
  }
}

test('execution profiles reject unknown fields and freeze driver/model changes without exposing credentials', () => {
  const config = configuration()
  const original = profile()
  assert.deepEqual(validateProfile(original), original)
  config.profiles['xgovernor-local-docker'].models['provider/model'].apiBase = 'https://model.example/v1'
  assert.notEqual(describeProfile(original.key, config.profiles[original.key]).definitionDigest, original.definitionDigest)
  assert.equal(JSON.stringify(original).includes('MODEL_KEY'), false)
  assert.equal(JSON.stringify(original).includes('/opt/'), false)
  assert.throws(() => normalizeExecutionConfig({ profiles: { other: { shell: 'ignored' } } }), /未知字段/)
  assert.throws(() => validateProfile({ ...original, resources: { ...original.resources, cpu: 99999 } }), /范围/)
  assert.throws(() => validateExecution({ profile: original, environment: { kind: 'oci-image', image: 'https://user:secret@registry', arch: 'amd64', workspaceRoot: '/testbed' } }), /不合法/)
  const schema = JSON.parse(fs.readFileSync(path.resolve('packages/benchmark-protocol/schemas/agent-task.schema.json'), 'utf8'))
  assert.doesNotThrow(() => assertJsonSchema(request().task, schema, 'TEST', 'task'))
  const malformed = request().task
  malformed.execution.profile.resources.memoryMiB = 0
  assert.throws(() => assertJsonSchema(malformed, schema, 'TEST', 'task'), /memoryMiB/)
})

test('Benchmark sandbox readiness is independent from the native CLI readiness and model catalog', () => {
  const p = profile()
  const cap = {
    actions: ['RUN_BENCHMARK_CASE', 'RUN_EXPERIMENT_CASE'],
    platforms: [{ id: 'pi-agent', agents: ['pi-agent'], models: ['native/unavailable'], runExperimentCase: { version: 2, returnsTraceId: true }, runBenchmarkCase: { version: 1, returnsTraceId: true } }],
    components: { 'execution-backend/v1': { ready: true }, 'agent-runtime/pi-agent/v1': { ready: false } },
    executionProfiles: [{ profile: p, benchmarks: ['swe-bench'], ready: true }],
  }
  const row = { clientId: 'client', name: 'host', status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null, capabilitiesJson: JSON.stringify(cap) }
  const manifest = { adapterKey: 'swe-bench', requiredCapabilities: [] }
  const [target] = inspectBenchmarkExecutionTargets(row as never, manifest as never)
  assert.equal(target.ready, true)
  assert.deepEqual(target.agents, ['pi-agent'])
  assert.deepEqual(target.models, ['provider/model'])
  assert.equal(listTraceGenerationPlatforms(parseCapabilities(row.capabilitiesJson)).length, 1)
  const automatic = configuration().profiles['xgovernor-local-docker']
  automatic.models = {}
  cap.executionProfiles[0].profile = describeProfile('xgovernor-local-docker', automatic)
  assert.deepEqual(inspectBenchmarkExecutionTargets({ ...row, capabilitiesJson: JSON.stringify(cap) } as never, manifest as never)[0].models, ['native/unavailable'])
  cap.executionProfiles[0].ready = false
  assert.equal(inspectBenchmarkExecutionTargets({ ...row, capabilitiesJson: JSON.stringify(cap) } as never, manifest as never)[0].ready, false)
  delete (cap as any).executionProfiles
  assert.equal(inspectBenchmarkExecutionTargets({ ...row, capabilitiesJson: JSON.stringify(cap) } as never, manifest as never)[0].ready, false)
})

test('unconfigured or unsupported host advertises a reason instead of silently enabling native execution', () => {
  const result = executionCapabilities({ config: configuration(), env: {}, os: 'darwin', refresh: true })
  assert.equal(result.profiles[0].ready, false)
  assert.match(result.profiles[0].note, /Linux/)
})

async function runnerFixture(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-backend-'))
  const store = new FileRunStore(root)
  const sent: any[] = []
  const calls: string[] = []
  const task = request()
  await store.accept({ ...task, requestDigest: 'sha256:test' })
  const backend = {
    async prepare(_task: unknown, context: any) { const handle = { backendKey: 'test-backend', runId: task.runId, opaque: { remoteReference: 'sandbox-1' } }; calls.push('prepare'); await context.persist(handle); return handle },
    async runAgent(handle: any) { assert.equal(handle.opaque.remoteReference, 'sandbox-1'); calls.push('run'); return { exitCode: 0, traceId: 'exact-trace' } },
    async collect(_handle: unknown, contract: any) { calls.push('collect'); const bytes = Buffer.from('diff'); return { ...contract, bytes, sha256: digestBytes(bytes) } },
    async close() { calls.push('close'); return { status: 'succeeded' } },
    async cancel() { calls.push('cancel') },
    async recover() { calls.push('recover'); return { status: 'succeeded' } },
    ...overrides,
  }
  const registry = new ExecutionBackendRegistry([['test-backend', backend]])
  const callback = { async progress() {}, async uploadArtifact() { return { artifactId: 'artifact-1' } }, async complete(_request: unknown, body: unknown) { sent.push(body) } }
  const runner = new BenchmarkExecutionRunner({ store, executionBackends: registry, callback })
  return { root, store, calls, sent, runner, task, backend, callback }
}
function digestBytes(bytes: Buffer) { return `sha256:${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}` }

test('a replacement backend executes an arbitrary Benchmark without local paths or Runtime branches', async () => {
  const f = await runnerFixture()
  try {
    await f.runner.execute(f.task)
    assert.deepEqual(f.calls, ['prepare', 'run', 'collect', 'close'])
    assert.equal(f.sent[0].runFacts.traceId, 'exact-trace')
    assert.equal((await f.store.state(f.task.runId)).terminalStatus, 'succeeded')
    assert.ok((await f.store.state(f.task.runId)).completionDeliveredAt)
    assert.ok((await f.store.state(f.task.runId)).terminalAt)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('cleanup failure persists the backend handle and recovery never reruns the Agent', async () => {
  const f = await runnerFixture({ async close() { return { status: 'failed', message: 'backend unavailable' } } })
  try {
    await f.runner.execute(f.task)
    const state = await f.store.state(f.task.runId)
    assert.equal(state.stage, 'cleanup_pending')
    assert.equal(state.completionDeliveredAt, undefined)
    assert.equal(f.sent.length, 0)
    await f.runner.resume(f.task, state)
    assert.equal(f.calls.filter(item => item === 'run').length, 1)
    assert.equal(f.sent[0].status, 'succeeded')
    assert.equal(f.sent[0].cleanup.status, 'succeeded')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('completion acknowledgement is persisted only after a successful callback retry', async () => {
  const f = await runnerFixture()
  try {
    const complete = f.callback.complete
    f.callback.complete = async () => { throw new Error('temporary callback outage') }
    await f.runner.execute(f.task)
    const pending = await f.store.state(f.task.runId)
    assert.equal(pending.stage, 'complete_pending')
    assert.equal(pending.completionDeliveredAt, undefined)
    f.callback.complete = complete
    await f.runner.resume(f.task, pending)
    const done = await f.store.state(f.task.runId)
    assert.equal(done.stage, 'terminal')
    assert.ok(done.completionDeliveredAt)
    assert.equal(f.calls.filter(item => item === 'run').length, 1)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('Artifact upload retry uses durable bytes after the sandbox has been closed', async () => {
  const f = await runnerFixture()
  try {
    let attempts = 0
    f.callback.uploadArtifact = async () => { if (++attempts === 1) throw Object.assign(new Error('offline'), { retryable: true }); return { artifactId: 'artifact-1' } }
    await f.runner.execute(f.task)
    const state = await f.store.state(f.task.runId)
    assert.equal(state.stage, 'upload_pending')
    assert.ok(f.calls.includes('close'))
    await f.runner.resume(f.task, state)
    assert.equal(f.calls.filter(item => item === 'run').length, 1)
    assert.equal(f.calls.filter(item => item === 'collect').length, 1)
    assert.equal(f.sent[0].status, 'succeeded')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('xGovernor adapter prepares and collects through session APIs and checks actual container isolation', async () => {
  const { XGovernorExecutionBackend } = require('../services/executor/src/xgovernor/backend.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-protocol-'))
  const config = configuration()
  const frozen = profile()
  const imageId = `sha256:${'b'.repeat(64)}`
  const body = request().task
  body.benchmark.key = 'swe-bench'
  body.task.benchmarkPayload = { instanceId: 'example__project-1' }
  body.execution.environment.image = 'swebench/sweb.eval.x86_64.example_1776_project-1:latest'
  body.execution.profile = frozen
  let handle: any
  let child: any
  let environment: any
  let starts = 0
  const commands: string[][] = []
  let alive = false
  const prior = process.env.MODEL_KEY
  process.env.MODEL_KEY = 'fixture-secret'
  const backend = new XGovernorExecutionBackend({
    config, baseDir: root, atomicWriteJson, GitPatchCollector,
    probe: () => ({ profiles: [{ profile: frozen, ready: true }] }),
    spawnImpl(_file: string, _args: string[], options: any) {
      environment = options.env
      child = new EventEmitter()
      starts++
      Object.assign(child, { exitCode: starts === 1 ? 1 : null, signalCode: null })
      if (starts === 1) fs.writeSync(options.stdio[1], 'Address already in use (os error 98)\n')
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    async processRunner(_file: string, args: string[]) {
      const command = args.slice(2)
      if (command[0] === 'info') return { stdout: 'x86_64' }
      if (command[0] === 'image') return { stdout: command.includes('--format') ? `[]|${imageId}` : JSON.stringify([{ Id: imageId, Architecture: 'amd64', Os: 'linux', RepoDigests: [] }]) }
      if (command[0] === 'ps') return { stdout: alive ? 'container-1' : '' }
      if (command[0] === 'inspect') return { stdout: JSON.stringify([{ Id: 'container-1', Image: imageId, Mounts: [], Config: { User: '10001:10001', WorkingDir: '/testbed' }, HostConfig: { NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 4096 * 1024 ** 2, NanoCpus: 2e9, PidsLimit: 512 } }]) }
      throw new Error(`unexpected Docker request ${command}`)
    },
    async fetchImpl(url: string, options: any) {
      const payload = options.body ? JSON.parse(options.body) : null
      let result: any = {}
      if (url.endsWith('/sessions/open')) {
        alive = true
        assert.equal(payload.ext.runtime_pi.backend_id, 'docker')
        assert.equal(payload.llm.api_key_env, 'AGENT_INSIGHT_CASE_MODEL_KEY')
        assert.equal(JSON.stringify(payload).includes('fixture-secret'), false)
        result = { runtime_id: payload.runtime_id, isolation: { boundary: 'container', network: 'isolated' } }
      } else if (url.endsWith('/sessions/exec')) {
        commands.push(payload.command)
        result = { exit_code: 0, stdout: payload.command[1] === 'rev-parse' ? 'a'.repeat(40) : payload.command[1] === 'remote' ? 'https://github.com/example/project.git' : payload.command[1] === 'diff' ? 'diff' : '', stderr: '', timed_out: false }
      } else if (url.endsWith('/sessions/close')) { alive = false; child.exitCode = 0 }
      return Response.json(result)
    },
  })
  try {
    const context = { runId: body.context.runId, async persist(next: unknown) { handle = next } }
    assert.equal((await backend.recover({}, context)).status, 'succeeded')
    handle = await backend.prepare(body, context)
    assert.equal(starts, 2)
    assert.equal(environment.AGENT_INSIGHT_CASE_MODEL_KEY, 'fixture-secret')
    assert.equal(environment.MODEL_KEY, undefined)
    assert.equal(JSON.stringify(handle).includes('fixture-secret'), false)
    assert.equal(environment.XGOVERNOR_DOCKER_IMAGE, imageId)
    assert.equal(handle.opaque.imageId, imageId)
    assert.deepEqual(handle.opaque.executionConfig, config.profiles['xgovernor-local-docker'])
    assert.equal(environment.XGOVERNOR_DEFAULT_WORKSPACE_ROOT, '/testbed')
    assert.equal((fs.statSync(path.join(handle.opaque.directory, 'admin.auth')).mode & 0o777), 0o600)
    const artifact = await backend.collect(handle, body.submission.requiredArtifacts[0], context)
    assert.equal(artifact.bytes.toString(), 'diff')
    assert.ok(commands.some(args => args[1] === 'diff' && args.includes('--binary')))
    assert.equal((await backend.close(handle)).status, 'succeeded')
    backend.reservations.set('other-profile-run', { cpu: os.availableParallelism(), memoryMiB: 1 })
    assert.throws(() => backend.validate(body), (e: any) => e.code === 'SERVICE_BUSY')
    backend.reservations.delete('other-profile-run')
    await assert.rejects(backend.close({ ...handle, opaque: { ...handle.opaque, directory: '/somebody-else' } }), /ownership/)
  } finally {
    if (prior === undefined) delete process.env.MODEL_KEY; else process.env.MODEL_KEY = prior
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('xGovernor accepts the empty 202 cancellation response without replaying the request', async () => {
  let calls = 0
  const client = new XGovernorClient('http://127.0.0.1:1', 'secret', async () => {
    calls++
    return new Response(null, { status: 202 })
  })
  assert.equal(await client.request('/sessions/cancel', { runtime_id: 'runtime-1' }), null)
  assert.equal(calls, 1)
})

test('an in-flight Case retains its original runtime and model mapping after dependency activation', async t => {
  const { XGovernorExecutionBackend } = require('../services/executor/src/xgovernor/backend.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-version-binding-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = configuration().profiles['xgovernor-local-docker']
  original.runtimes['pi-agent'].traceExporter = '/previous-release/trace-exporter'
  const active = configuration()
  active.profiles['xgovernor-local-docker'].models['provider/model'].model = 'new-model'
  active.profiles['xgovernor-local-docker'].runtimes = {}
  let exportCalls = 0
  const backend = new XGovernorExecutionBackend({
    config: active, baseDir: root, atomicWriteJson,
    async fetchImpl() { return new Response(null, { status: 500 }) },
    async processRunner(file: string, _args: string[], options: any) {
      exportCalls++
      assert.equal(file, '/previous-release/trace-exporter')
      assert.equal(JSON.parse(options.input).model, 'model')
      throw new Error('fixture stops after verifying the frozen trace mapping')
    },
  })
  const directory = path.join(root, 'xgovernor-runs', 'run_bound')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'admin.auth'), 'fixture')
  const handle = { backendKey: 'xgovernor', runId: 'run_bound', opaque: {
    directory, profileKey: 'xgovernor-local-docker', executionConfig: original, runtimeId: 'old-runtime', modelId: 'provider/model', adminPort: 1,
  } }
  await assert.rejects(backend.runAgent(handle, { platform: 'pi-agent', input: 'fix it' }, { async persist() {} }), /HTTP 500/)
  assert.equal(exportCalls, 1)
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'lease.json'), 'utf8'))
  assert.equal(persisted.executionConfig.models['provider/model'].model, 'model')
})

test('partial prepare failure is cleaned through the persisted handle and cancellation survives restart', async () => {
  const f = await runnerFixture({ async prepare(_task: unknown, context: any) { await context.persist({ backendKey: 'test-backend', runId: context.runId, opaque: { partial: true } }); throw new Error('open failed') } })
  try {
    await f.runner.execute(f.task)
    assert.ok(f.calls.includes('close'))
    assert.equal(f.sent[0].status, 'failed')
    await f.store.writeState(f.task.runId, { stage: 'agent_running', cleanup: null })
    await f.store.cancel(f.task.runId)
    await f.runner.resume(f.task, await f.store.state(f.task.runId))
    assert.equal((await f.store.state(f.task.runId)).terminalStatus, 'cancelled')
    assert.equal(f.calls.includes('run'), false)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('concurrent journal patches preserve resource ownership and Artifact delivery state', async () => {
  const f = await runnerFixture()
  try {
    await Promise.all([f.store.writeState(f.task.runId, { executionHandle: { key: 'owned' } }), f.store.writeState(f.task.runId, { uploadedArtifacts: ['one'] }), f.store.writeState(f.task.runId, { runFacts: { traceId: 'trace' } })])
    const state = await f.store.state(f.task.runId)
    assert.equal(state.executionHandle.key, 'owned')
    assert.deepEqual(state.uploadedArtifacts, ['one'])
    assert.equal(state.runFacts.traceId, 'trace')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

function stream(text: string) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}

test('SSE handles fragmented CRLF and unicode, correlates exact turns, and refuses replay on a broken stream', async () => {
  let calls = 0
  const terminal = { runtime_id: 'runtime-1', turn_id: 'turn-1', kind: 'turn_completed', outcome: 'complete' }
  const client = new XGovernorClient('http://127.0.0.1:1', 'secret', async () => { calls++; return stream(`event: output_delta\r\ndata: ${JSON.stringify({ ...terminal, kind: 'output_delta', delta: '中文' })}\r\n\r\ndata: ${JSON.stringify(terminal)}\r\n\r\n`) })
  assert.equal((await client.events('runtime-1', 'turn-1')).outcome, 'complete')
  assert.equal(calls, 1)
  const broken = new XGovernorClient('http://127.0.0.1:1', 'secret', async () => stream(': ping\n\n'))
  await assert.rejects(broken.events('runtime-1', 'turn-1'), (e: any) => e.code === 'XGOVERNOR_STREAM_LOST')
  const mismatched = new XGovernorClient('http://127.0.0.1:1', 'secret', async () => stream(`data: ${JSON.stringify(terminal)}\n\n`))
  await assert.rejects(mismatched.events('runtime-2', 'turn-1'), (e: any) => e.code === 'XGOVERNOR_EVENT_MISMATCH')
})

test('native Pi conversion retains full tool arguments/results and detects incomplete history', () => {
  const records = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] } },
    { type: 'message', message: { role: 'assistant', model: 'model', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'run tests' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'Full tool output' }] } },
    { type: 'message', message: { role: 'assistant', model: 'model', content: [{ type: 'text', text: 'Done' }] } },
  ]
  const metadata = { runId: 'run-a', runtimeId: 'runtime-a', startedAt: 1000, input: 'Fix it' }
  const events = piEvents(records, metadata)
  assert.deepEqual(events.find((event: any) => event.kind === 'tool').tool.arguments, { command: 'run tests' })
  assert.equal(events.find((event: any) => event.kind === 'tool').tool.result[0].text, 'Full tool output')
  assert.equal(events.find((event: any) => event.kind === 'agent').sessionId, 'xgovernor:run-a')
  assert.throws(() => piEvents(records.slice(0, 2), metadata), /缺少结果/)
})

test('xiaoO Worker state capture preserves NDJSON and exports complete native tool data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-worker-capture-'))
  const snapshot = { runtime_kind: 'xiaoo', schema_version: 1, state: { loop_state: { messages: [
    { role: 'user', blocks: [{ type: 'text', text: 'Fix it' }], timestamp_ms: 1000 },
    { role: 'assistant', blocks: [{ type: 'tool_use', call_id: 'c1', tool_name: 'bash', input: { command: 'test' } }], timestamp_ms: 1100, api_usage_tokens: 17 },
    { role: 'tool', blocks: [{ type: 'tool_result', call_id: 'c1', tool_name: 'bash', output: 'Full output', is_error: false }], timestamp_ms: 1200 },
    { role: 'assistant', blocks: [{ type: 'text', text: 'Done' }], reasoning_content: 'Native reasoning', timestamp_ms: 1300 },
  ] } } }
  const frames = [{ kind: 'ready' }, { kind: 'state', state: snapshot }, { kind: 'event', event: { kind: 'completed', outcome: 'complete' } }]
  try {
    const worker = path.join(root, 'worker.cjs')
    const statePath = path.join(root, 'state.json')
    fs.writeFileSync(worker, `process.stdout.write(${JSON.stringify(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')});`)
    const executed = spawnSync(process.execPath, [path.resolve('services/executor/src/xgovernor/capture-worker.cjs'), process.execPath, statePath, worker], { input: '', encoding: 'utf8', timeout: 10000 })
    assert.equal(executed.status, 0, executed.stderr)
    assert.deepEqual(executed.stdout.trim().split('\n').map(line => JSON.parse(line)), frames)
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), snapshot)
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
    const events = xiaooEvents(snapshot, { runId: 'run-xiao', runtimeId: 'runtime-xiao', startedAt: 1000, input: 'Fix it', model: 'model' })
    assert.deepEqual(events.find((e: any) => e.kind === 'tool').tool.arguments, { command: 'test' })
    assert.equal(events.find((e: any) => e.kind === 'tool').tool.result[0].text, 'Full output')
    assert.equal(events.find((e: any) => e.kind === 'llm').usage.total, 17)
    assert.equal(events.find((e: any) => e.kind === 'agent').name, 'agent.xiaoo')
    const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
    const otlp = normalizeOtlpTraces(canonicalEventsToOtlp(events, { framework: 'xiaoo' }), { authenticatedUser: 'alice' })
    const record = aggregateOtelTraceEvents('xgovernor:run-xiao', otlp)
    assert.equal(record?.framework, 'xiaoo')
    assert.equal(record?.agentName, 'xiaoo')
    assert.equal(record?.tool_call_count, 1)
    assert.ok(record?.trace_completed_at)
    assert.throws(() => xiaooEvents({ ...snapshot, schema_version: 2 }, {}), /版本不兼容/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Runner forwards an early root while Agent is running and retains it through subsequent stages', async () => {
  let f: Awaited<ReturnType<typeof runnerFixture>>
  f = await runnerFixture({ async runAgent(_handle: unknown, _input: unknown, context: any) {
    await context.onTraceId({ traceId: 'live-root' })
    const state = await f.store.state(f.task.runId)
    assert.equal(state.stage, 'agent_running')
    assert.equal(state.progress.traceId, 'live-root')
    assert.equal(f.sent.length, 0)
    return { exitCode: 0, traceId: 'live-root' }
  } })
  const reports: any[] = []
  f.callback.progress = async (...[_request, stage, details]: any[]) => { reports.push({ stage, details }) }
  try {
    await f.runner.execute(f.task)
    assert.ok(reports.some(report => report.stage === 'agent_running' && report.details.traceId === 'live-root'))
    assert.ok(reports.filter(report => ['collecting', 'uploading', 'cleaning'].includes(report.stage)).every(report => report.details.traceId === 'live-root'))
    assert.equal(f.sent[0].runFacts.traceId, 'live-root')
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('sandbox snapshots permit pending tools, keep one stable root and cannot replace the terminal root with a late live snapshot', () => {
  for (const platform of ['pi-agent', 'xiaoo']) {
    const metadata = { runId: `snapshots-${platform}`, runtimeId: 'runtime', startedAt: 1000, input: 'Fix it' }
    const records = [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }], timestamp: 1000 } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'test' } }], timestamp: 1100 } },
    ]
    const live = piEvents(records, { ...metadata, partial: true })
    assert.equal(live.find((event: any) => event.kind === 'agent').status, 'running')
    assert.throws(() => piEvents(records, metadata), /缺少结果/)
    const final = piEvents([...records, { type: 'message', message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'Done' }], timestamp: 1200 } }], metadata)
    const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
    const normalize = (events: any[]) => normalizeOtlpTraces(canonicalEventsToOtlp(events, { framework: platform }), { authenticatedUser: 'alice' })
    const before = aggregateOtelTraceEvents(`xgovernor:${metadata.runId}`, normalize(live))
    assert.ok(before)
    assert.equal(before.trace_completed_at, undefined)
    const after = aggregateOtelTraceEvents(`xgovernor:${metadata.runId}`, [...normalize(final), ...normalize(live)])
    assert.ok(after?.trace_completed_at)
    assert.equal(after?.llm_call_count, 1)
    assert.equal(after?.tool_call_count, 1)
  }
})

test('sandbox exporter publishes an empty running root before native history exists without accepting it as a complete trace', async () => {
  const { exportTrace } = require('../services/executor/src/xgovernor/trace.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sandbox-root-'))
  const handle = { runId: 'empty-running-root', opaque: { directory, runtimeId: 'runtime', startedAt: 1000, platform: 'pi-agent' } }
  const config = { models: {}, traceApiKeyEnv: 'FIXTURE_MISSING_TRACE_KEY' }
  try {
    await assert.rejects(exportTrace(handle, { kind: 'pi' }, config, { partial: true, input: 'Fix it', platform: 'pi-agent' }), (error: any) => error.code === 'TRACE_AUTH_MISSING')
    const files = fs.readdirSync(path.join(directory, 'trace-spool'), { recursive: true }) as string[]
    const spool = files.find(file => file.endsWith('.jsonl'))!
    const event = JSON.parse(fs.readFileSync(path.join(directory, 'trace-spool', spool), 'utf8').trim())
    assert.equal(event.sessionId, 'xgovernor:empty-running-root')
    assert.equal(event.status, 'running')
    assert.equal(event.attributes['xgovernor.runtime_id'], 'runtime')
    assert.equal(event.attributes['agent.insight.trace.completed'], false)
    const { canonicalEventsToOtlp } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs')
    const beforeModel = aggregateOtelTraceEvents(event.sessionId, normalizeOtlpTraces(canonicalEventsToOtlp([event], { framework: 'pi-agent' }), { authenticatedUser: 'alice' }))
    assert.ok(beforeModel)
    assert.equal(beforeModel.trace_completed_at, undefined)
    assert.equal(beforeModel.llm_call_count, 0)
    await assert.rejects(exportTrace(handle, { kind: 'pi' }, config, { input: 'Fix it', platform: 'pi-agent' }))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('sandbox live export serializes snapshots and drains before final export', async () => {
  const { liveTraceReporter } = require('../services/executor/src/xgovernor/trace.cjs')
  const calls: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const reporter = liveTraceReporter({}, {}, {}, { onTraceId: async ({ traceId }: any) => { calls.push(traceId) } }, null, {
    intervalMs: 10000,
    exportTrace: async () => { calls.push('partial'); await gate; return { traceId: 'stable-root' } },
  })
  const pending = reporter.tick()
  assert.equal(calls.length, 1)
  const stopped = reporter.stop()
  release()
  await pending
  await stopped
  calls.push('final')
  assert.deepEqual(calls, ['partial', 'stable-root', 'final'])
  reporter.tick()
  assert.equal(calls.length, 3)
})
