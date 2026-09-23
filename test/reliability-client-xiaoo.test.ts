import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'
import { normalizeOtlpTraces } from '../src/lib/ingest/otel/normalize'
import { aggregateGenericOtelTraceEvents } from '../src/lib/ingest/otel/adapters/generic'

const client = createRequire(import.meta.url)('../scripts/reliability-client.cjs')
const sid = 'c3ea1a83-eedc-4e75-a606-862962e5e9a1'
const start = { type: 'session_start', data: { session_id: sid, agent: 'defaultagent' } }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-xiaoo-'))
  const previous = Object.fromEntries(['PATH', 'XDG_CONFIG_HOME', 'AGENT_INSIGHT_HOME', 'XIAOO_CONFIG', 'XIAOO_TEST_MODE'].map(k => [k, process.env[k]]))
  const executable = path.join(root, 'xiaoo')
  fs.writeFileSync(executable, `#!${process.execPath}
const mode = process.env.XIAOO_TEST_MODE
if (process.argv.includes('--help')) {
  console.log(process.argv.includes('run')
    ? '--format <FORMAT> json --title --agent --provider --model'
    : 'Usage: xiaoo --cli <command>')
  process.exit(0)
}
if (mode !== 'missing') console.log(${JSON.stringify(JSON.stringify(start))})
if (mode?.startsWith('collector-')) {
  const {spawnSync} = require('node:child_process')
  const target = mode === 'collector-other' ? 'another-session' : ${JSON.stringify(sid)}
  const script = [
    'import sys',
    'sys.path.insert(0, ' + ${JSON.stringify(JSON.stringify(path.resolve('scripts/xiaoo-trace-collector')))} + ')',
    'import otel_trace',
    'otel_trace.note_chat(' + JSON.stringify(target) + ', {"message": {"text": "input only"}})',
    mode === 'collector-user-only' ? '' : mode === 'collector-text'
      ? 'otel_trace.note_stream(' + JSON.stringify(target) + ', "intermediate reply")'
      : 'otel_trace.note_tool(' + JSON.stringify(target) + ', {"call": {"tool_name": "file_edit"}, "outcome": {"output": "fixed"}})',
    'otel_trace.post_otlp_traces = lambda payload: True',
    'otel_trace.flush_session(' + JSON.stringify(target) + ')',
  ].join('\\n')
  const hook = spawnSync('python3', ['-B', '-c', script], {encoding: 'utf8'})
  if (hook.status !== 0) { console.error(hook.stderr); process.exit(9) }
  // Record only the temporary path, so cleanup can be checked after execution.
  require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'activity-dir.txt'), process.env.AGENT_INSIGHT_XIAOO_ACTIVITY_DIR || '')
  if (mode === 'collector-stale') {
    const name = require('node:crypto').createHash('sha256').update(target).digest('hex') + '.json'
    require('node:fs').writeFileSync(require('node:path').join(process.env.AGENT_INSIGHT_XIAOO_ACTIVITY_DIR, name),
      JSON.stringify({sessionId: target, modelActivity: true, observedAtMs: 1}))
  }
  if (mode === 'collector-error') {
    console.log(JSON.stringify({type: 'response', data: {raw_reply: ''}}))
    console.log(JSON.stringify({type: 'error', data: {message: 'LLM provider HTTP 401 Unauthorized'}}))
    process.exit(1)
  }
  if (mode === 'collector-nonzero') process.exit(7)
  console.log(JSON.stringify({type: 'response', data: {raw_reply: '', session_id: target}}))
  if (mode === 'collector-timeout') setInterval(() => {}, 1000)
  else process.exit(0)
} else if (mode === 'error') {
  process.stdout.write(JSON.stringify({type: 'error', data: {message: 'LLM provider error: HTTP 401 Unauthorized'}}))
} else if (mode === 'nonzero') {
  console.error('runtime crashed')
  process.exitCode = 7
} else if (mode === 'timeout') {
  setInterval(() => {}, 1000)
} else {
  if (mode === 'empty-then-text') console.log(JSON.stringify({type: 'response', data: {raw_reply: ''}}))
  setTimeout(() => process.stdout.write(JSON.stringify({type: 'response', data: {
    raw_reply: mode === 'empty' ? '' : 'hello',
    cwd: process.cwd(),
  }})), 40)
}
`)
  fs.chmodSync(executable, 0o755)
  process.env.PATH = `${root}:${previous.PATH || ''}`
  process.env.XDG_CONFIG_HOME = path.join(root, 'config')
  process.env.AGENT_INSIGHT_HOME = path.join(root, 'data')
  delete process.env.XIAOO_CONFIG
  return {
    root, executable,
    installCollector() {
      const collector = path.join(process.env.AGENT_INSIGHT_HOME!, 'xiaoo-trace-collector')
      const config = path.join(process.env.XDG_CONFIG_HOME!, 'xiaoo')
      fs.mkdirSync(collector, { recursive: true })
      fs.mkdirSync(config, { recursive: true })
      fs.writeFileSync(path.join(collector, 'plugin.json'), '[]')
      fs.writeFileSync(path.join(config, 'config.toml'), `[hooker]\nplugins = ["${collector}/plugin.json"]\n`)
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

test('xiaoo invocation uses native JSON CLI, safe argv and provider/model split', () => {
  const f = fixture()
  try {
    const invocation = client.buildExperimentCaseInvocation(f.executable, {
      platform: 'xiaoo', agent: 'defaultagent', input: 'first line\n"quoted" $(literal)',
      model: 'provider/organization/model', correlation: { caseRunId: 'case-1' },
    })
    assert.deepEqual(invocation, { stdin: null, args: [
      '--cli', 'run', '--format', 'json', '--agent', 'defaultagent',
      '-p', 'first line\n"quoted" $(literal)', '--title', 'case-1',
      '--provider', 'provider', '--model', 'organization/model',
    ] })
    const bare = client.buildExperimentCaseInvocation(f.executable, {
      platform: 'xiaoo', agent: 'defaultagent', input: 'hi', model: 'model-only',
    })
    assert.equal(bare.args.includes('--provider'), false)
    assert.deepEqual(bare.args.slice(-2), ['--model', 'model-only'])
  } finally { f.close() }
})

test('xiaoo parser separates session ownership, model activity and structured errors', () => {
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify(start)).traceId, sid)
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify(start)).modelActivity, false)
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify({ ...start, data: { session_id: `xiaoo:${sid}` } })).traceId, sid)
  assert.equal(client.inspectXiaooRunEvent('not json'), null)
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify({type: 'tool_result', data: { session_id: 'other-session' }})).traceId, null)
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify({type: 'response', data: { raw_reply: '' }})).modelActivity, false)
  assert.equal(client.inspectXiaooRunEvent(JSON.stringify({type: 'response', data: { raw_reply: 'hello' }})).modelActivity, true)
  assert.match(client.inspectXiaooRunEvent(JSON.stringify({type: 'error', data: {message: 'LLM provider HTTP 401'}})).error, /401/)
})

test('xiaoo experimental trace ID matches actual Collector normalization and Execution task_id', () => {
  const result = spawnSync('python3', ['-B', '-c', [
    'import sys, json',
    'sys.path.insert(0, "scripts/xiaoo-trace-collector")',
    'from otel_spans import SessionSpanBuffer',
    `buffer = SessionSpanBuffer("${sid}")`,
    'buffer.on_user_message("hello")',
    'buffer.on_assistant_text("hello")',
    'print(json.dumps(buffer.build_resource_spans()))',
  ].join('\n')], { encoding: 'utf8', cwd: process.cwd() })
  assert.equal(result.status, 0, result.stderr)
  const events = normalizeOtlpTraces(JSON.parse(result.stdout), { authenticatedUser: 'test-user' })
  assert.ok(events.length)
  assert.equal(events[0].traceId, '9be190f0407ddd25eece41f8d7c406b2')
  const execution = aggregateGenericOtelTraceEvents(events[0].sessionId, events)
  const experimentTraceId = client.inspectXiaooRunEvent(JSON.stringify(start)).traceId
  assert.equal(execution?.task_id, experimentTraceId)
  assert.ok(execution?.trace_started_at)
  assert.ok(execution?.trace_completed_at)
  assert.equal(
    new Date(execution!.trace_completed_at!).getTime() >= new Date(execution!.trace_started_at!).getTime(),
    true,
  )
  assert.equal(experimentTraceId, sid)
  assert.notEqual(experimentTraceId, events[0].traceId)
})

test('xiaoo capability requires structured CLI and the installed Collector, refresh finds installation', () => {
  const f = fixture()
  try {
    assert.equal(client.probeExperimentRuntime('xiaoo', f.executable).ready, false)
    f.installCollector()
    const probe = client.probeExperimentRuntime('xiaoo', f.executable)
    assert.equal(probe.ready, true)
    assert.equal(probe.canResolveTraceId, true)
    const caps = client.buildCapabilities({ fiPackageRoot: '/missing', maxParallelFi: 1 }, { refresh: true })
    assert.ok(client.benchmarkAgentPlatformsFromCapabilities(caps).includes('xiaoo'))
    assert.deepEqual(caps.platforms.find((p: {id: string}) => p.id === 'xiaoo').agents, ['defaultagent'])
    fs.writeFileSync(f.executable, `#!${process.execPath}\nconsole.log('old xiaoo --agent only')\n`)
    assert.equal(client.probeExperimentRuntime('xiaoo', f.executable).ready, false)
    assert.throws(() => client.buildExperimentCaseInvocation(f.executable, {
      platform: 'xiaoo', agent: 'defaultagent', input: 'hi',
    }), { code: 'AGENT_RUNTIME_UNAVAILABLE' })
  } finally { f.close() }
})

test('xiaoo reuses shared execution, early trace reporting and deterministic failure handling', async () => {
  const f = fixture()
  try {
    const reports: string[] = []
    const run = (mode: string, overrides = {}) => {
      process.env.XIAOO_TEST_MODE = mode
      return client.runExperimentCase({ clientId: 'test-client', workspaceBase: f.root }, {
        platform: 'xiaoo', agent: 'defaultagent', input: 'hello',
        timeoutSeconds: 5, firstModelResponseTimeoutSeconds: 2, ...overrides,
      }, async ({ traceId }: {traceId: string}) => { reports.push(traceId) })
    }
    const ok = await run('success')
    assert.equal(ok.traceId, sid)
    assert.equal(ok.modelActivityObserved, true)
    assert.equal(ok.exitCode, 0)
    assert.deepEqual(reports, [sid])
    assert.equal((await run('empty-then-text')).modelActivitySource, 'stdout')
    const withoutEarlyDeadline = await run('success', { firstModelResponseTimeoutSeconds: undefined })
    assert.equal(withoutEarlyDeadline.firstModelResponseTimeoutSeconds, 5)
    await assert.rejects(run('error'), { code: 'MODEL_UNAVAILABLE' })
    await assert.rejects(run('empty'), { code: 'AGENT_NO_OUTPUT' })
    await assert.rejects(run('missing'), { code: 'TRACE_ID_MISSING' })
    await assert.rejects(run('nonzero'), { code: 'AGENT_EXIT_NONZERO' })
    await assert.rejects(run('timeout', { firstModelResponseTimeoutSeconds: 1 }), { code: 'MODEL_START_TIMEOUT' })
    await assert.rejects(run('timeout', { timeoutSeconds: 1 }), (err: any) => {
      assert.equal(err.code, 'AGENT_TIMEOUT')
      assert.equal(err.runFacts.timedOut, true)
      return true
    })
  } finally { f.close() }
})

test('ordinary experiment cancellation interrupts a live Agent process without waiting for its timeout', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    process.env.XIAOO_TEST_MODE = 'timeout'
    const started = Date.now()
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: f.root }, {
      platform: 'xiaoo', agent: 'defaultagent', input: 'cancel this fixture', timeoutSeconds: 60,
      signal: controller.signal,
    }, async () => { controller.abort() }), (error: any) => {
      assert.equal(error.code, 'EXECUTION_CANCELLED')
      assert.equal(error.runFacts.timedOut, false)
      return true
    })
    assert.ok(Date.now() - started < 10_000)
  } finally { controller.abort(); f.close() }
})

test('xiaoo empty final reply uses only this run/session Collector activity after normal exit', async () => {
  const f = fixture()
  try {
    const run = (mode: string) => {
      process.env.XIAOO_TEST_MODE = mode
      return client.runExperimentCase({clientId: 'test', workspaceBase: f.root}, {
        platform: 'xiaoo', agent: 'defaultagent', input: 'fix fixture', timeoutSeconds: 2,
      })
    }
    for (const mode of ['collector-tool', 'collector-text']) {
      const result = await run(mode)
      assert.equal(result.exitCode, 0)
      assert.equal(result.modelActivityObserved, true)
      assert.equal(result.modelActivitySource, 'collector')
      assert.equal(result.traceId, sid)
      const evidenceDir = fs.readFileSync(path.join(f.root, 'activity-dir.txt'), 'utf8')
      assert.ok(evidenceDir)
      assert.equal(fs.existsSync(evidenceDir), false)
    }
    for (const [mode, code] of [
      ['collector-other', 'AGENT_NO_OUTPUT'], ['collector-user-only', 'AGENT_NO_OUTPUT'],
      ['collector-stale', 'AGENT_NO_OUTPUT'],
      ['collector-error', 'MODEL_UNAVAILABLE'], ['collector-nonzero', 'AGENT_EXIT_NONZERO'],
      ['collector-timeout', 'AGENT_TIMEOUT'], ['empty', 'AGENT_NO_OUTPUT'],
    ]) {
      await assert.rejects(run(mode), {code})
      const evidenceDir = fs.readFileSync(path.join(f.root, 'activity-dir.txt'), 'utf8')
      assert.equal(fs.existsSync(evidenceDir), false)
    }
  } finally { f.close() }
})

test('supervised xiaoo inherits existing shell credentials without leaking startup output', {
  skip: !fs.existsSync('/bin/zsh'),
}, async () => {
  const f = fixture()
  const keys = ['SHELL', 'ZDOTDIR', 'AGENT_INSIGHT_SUPERVISOR', 'INSIGHT_TEST_MODEL_KEY']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    const cwd = path.join(f.root, 'workspace with spaces')
    fs.mkdirSync(cwd)
    fs.writeFileSync(path.join(f.root, '.zshrc'), [
      'export INSIGHT_TEST_MODEL_KEY="existing-terminal-key"',
      'echo "existing-terminal-key"',
      'echo "HTTP 401 existing-terminal-key" >&2',
      'cd /',
      '',
    ].join('\n'))
    Object.assign(process.env, { SHELL: '/bin/zsh', ZDOTDIR: f.root, AGENT_INSIGHT_SUPERVISOR: 'launchd' })
    delete process.env.INSIGHT_TEST_MODEL_KEY
    const input = 'literal $(touch SHOULD_NOT_EXIST); "quoted"\nsecond line'
    fs.writeFileSync(f.executable, `#!${process.execPath}
if (process.argv.includes('--help')) {
  console.log(process.argv.includes('run') ? '--format json --title --agent --provider --model' : 'xiaoo --cli command')
  process.exit(0)
}
const valid = process.env.INSIGHT_TEST_MODEL_KEY === 'existing-terminal-key'
  && process.cwd() === ${JSON.stringify(fs.realpathSync(cwd))}
  && process.env.PWD === ${JSON.stringify(cwd)}
  && process.env.AGENT_INSIGHT_CASE_RUN_ID === 'shell-case'
  && process.argv[process.argv.indexOf('-p') + 1] === ${JSON.stringify(input)}
if (!valid) { console.error('environment or argv mismatch'); process.exit(8) }
console.log(${JSON.stringify(JSON.stringify(start))})
if (process.env.XIAOO_TEST_MODE === 'timeout') setInterval(() => {}, 1000)
else console.log(JSON.stringify({type: 'response', data: {raw_reply: 'ok'}}))
`)
    const payload = { platform: 'xiaoo', agent: 'defaultagent', input, cwd, timeoutSeconds: 5,
      correlation: { caseRunId: 'shell-case' } }
    const run = await client.runExperimentCase({ clientId: 'test', workspaceBase: cwd }, payload)
    assert.equal(run.exitCode, 0)
    assert.equal(run.traceId, sid)
    assert.equal(run.stderr, undefined)
    assert.equal(JSON.stringify(run).includes('existing-terminal-key'), false)
    assert.equal(process.env.INSIGHT_TEST_MODEL_KEY, undefined)
    assert.equal(fs.existsSync(path.join(cwd, 'SHOULD_NOT_EXIST')), false)

    process.env.XIAOO_TEST_MODE = 'timeout'
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: cwd },
      { ...payload, timeoutSeconds: 1 }), { code: 'AGENT_TIMEOUT' })

    fs.writeFileSync(path.join(f.root, '.zshrc'), 'sleep 10\n')
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: cwd },
      { ...payload, timeoutSeconds: 1 }), { code: 'AGENT_TIMEOUT' })

    const ordinary = { args: ['run'], stdin: 'hello' }
    assert.equal(client.buildAgentProcessLaunch('opencode', '/test/opencode', ordinary, cwd).executable, '/test/opencode')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    f.close()
  }
})
