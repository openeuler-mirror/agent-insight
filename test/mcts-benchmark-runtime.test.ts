import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectBenchmarkExecutionTargets } from '../src/lib/benchmark/execution-targets'
import { listTraceGenerationPlatforms } from '../src/lib/engine/experiment/execution-targets'
import { parseCapabilities } from '../src/lib/reliability/client-registry'

const runtime = require('../services/executor/src/mcts-runtime.cjs')
const { runProcess } = require('../services/executor/src/index.cjs')
const client = require('../scripts/reliability-client.cjs')

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function readClientConfig(raw: Record<string, unknown>, contents?: string, overrides: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-mcts-env-'))
  try {
    fs.mkdirSync(path.join(root, 'client'))
    fs.mkdirSync(path.join(root, 'workdir'))
    fs.writeFileSync(path.join(root, 'client', 'config.json'), JSON.stringify(raw))
    if (contents !== undefined) fs.writeFileSync(path.join(root, '.env'), contents)
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: root, DATABASE_URL: 'file:process.db' }
    delete env.AGENT_INSIGHT_DATA_DIR
    for (const key of ['AGENT_INSIGHT_MCTS_REPO_DIR', 'AGENT_INSIGHT_MCTS_PYTHON', 'AGENT_INSIGHT_MCTS_TRACE_LAUNCHER']) delete env[key]
    Object.assign(env, overrides)
    const result = spawnSync(process.execPath, ['-e', `
      const client = require(${JSON.stringify(path.resolve(__dirname, '../scripts/reliability-client.cjs'))});
      const cfg = client.loadConfig();
      process.stdout.write(JSON.stringify({
        repo: cfg.mctsRepoDir, python: cfg.mctsPython, launcher: cfg.mctsTraceLauncher,
        clientId: cfg.clientId, credential: cfg.deviceCredential, database: process.env.DATABASE_URL,
      }));
    `], { cwd: path.join(root, 'workdir'), env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return { config: JSON.parse(result.stdout), root }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('MCTS client reads shared .env paths outside its cwd and preserves registered credentials', () => {
  const { config } = readClientConfig({ clientId: 'fixture-client', deviceCredential: 'fixture-device' }, [
    '# MCTS deployment paths',
    'export AGENT_INSIGHT_MCTS_REPO_DIR="/srv/MCTS # workspace" # quoted path',
    "AGENT_INSIGHT_MCTS_PYTHON='/srv/python env/bin/python'",
    'AGENT_INSIGHT_MCTS_TRACE_LAUNCHER=/srv/collector/run.cjs # inline comment',
    'DATABASE_URL=file:unrelated-platform.db',
  ].join('\r\n'))
  assert.deepEqual(config, {
    repo: '/srv/MCTS # workspace', python: '/srv/python env/bin/python', launcher: '/srv/collector/run.cjs',
    clientId: 'fixture-client', credential: 'fixture-device', database: 'file:process.db',
  })
})

test('MCTS client resolves process environment before .env before JSON configuration', () => {
  const { config } = readClientConfig({
    mctsRepoDir: '/json/MCTS', mctsPython: '/json/python', mctsTraceLauncher: '/json/run.cjs',
  }, 'AGENT_INSIGHT_MCTS_REPO_DIR=/file/MCTS\nAGENT_INSIGHT_MCTS_PYTHON=/file/python\n', {
    AGENT_INSIGHT_MCTS_REPO_DIR: '/process/MCTS',
  })
  assert.equal(config.repo, '/process/MCTS')
  assert.equal(config.python, '/file/python')
  assert.equal(config.launcher, '/json/run.cjs')
})

test('MCTS client keeps JSON and collector defaults when .env is missing or empty', () => {
  for (const contents of [undefined, 'AGENT_INSIGHT_MCTS_REPO_DIR=\nAGENT_INSIGHT_MCTS_PYTHON=\n']) {
    const { config, root } = readClientConfig({ mctsRepoDir: '/json/MCTS' }, contents)
    assert.equal(config.repo, '/json/MCTS')
    assert.equal(config.python, '')
    assert.equal(config.launcher, path.join(root, 'collectors', 'mcts-xgovernor-proxy', 'run.cjs'))
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-mcts-'))
  const repoDir = path.join(root, 'MCTS')
  const workspace = path.join(root, 'workspace')
  const launcherDir = path.join(root, 'collector')
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(path.join(repoDir, 'testcases_union', 'core'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'testcases_union', 'res'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, '.venv', 'bin'), { recursive: true })
  fs.mkdirSync(launcherDir)
  fs.mkdirSync(path.join(root, 'shared'))
  fs.mkdirSync(binDir)
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(repoDir, 'testcases_union', 'run_union.sh'), '#!/bin/bash\npython -m testcases_union.core.main "$@"\n')
  fs.writeFileSync(path.join(repoDir, 'testcases_union', 'config.env'), '')
  fs.writeFileSync(path.join(repoDir, 'testcases_union', 'core', 'main.py'), '--output-dir')
  fs.writeFileSync(path.join(repoDir, 'testcases_union', 'res', 'xgovernor_client.py'), '')
  const traceLauncher = path.join(launcherDir, 'run.cjs')
  fs.writeFileSync(traceLauncher, '')
  fs.writeFileSync(path.join(launcherDir, 'core.cjs'), '')
  fs.writeFileSync(path.join(launcherDir, 'gateway.cjs'), '')
  fs.writeFileSync(path.join(root, 'shared', 'trace-transport.cjs'), '')
  fs.writeFileSync(path.join(root, 'shared', 'collaboration-transport.cjs'), '')
  fs.writeFileSync(path.join(launcherDir, 'config.json'), JSON.stringify({ proxyEnabled: true, apiKey: 'fixture-key' }))
  for (const [file, body] of [
    [path.join(repoDir, '.venv', 'bin', 'python'), 'echo 3.11'],
    [path.join(binDir, 'pi'), 'exit 99'],
  ]) {
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(file, 0o755)
  }
  const priorPath = process.env.PATH
  process.env.PATH = `${binDir}:${priorPath || ''}`
  git(workspace, 'init', '-q')
  git(workspace, 'config', 'user.email', 'test@example.invalid')
  git(workspace, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'before\n')
  git(workspace, 'add', 'hello.txt')
  git(workspace, 'commit', '-qm', 'base')
  const revision = git(workspace, 'rev-parse', 'HEAD').trim()
  const config = { mctsRepoDir: repoDir, mctsTraceLauncher: traceLauncher }
  const runId = `erun_${'a'.repeat(32)}`
  const payload = {
    platform: 'pi-mcts', agent: 'pi-mcts', benchmarkKey: 'swe-bench',
    benchmarkPayload: { instanceId: 'example__project-1', repo: 'example/project', baseCommit: revision },
    workspace: { repository: 'https://github.com/example/project.git', revision },
    correlation: { caseRunId: runId }, cwd: workspace, timeoutSeconds: 60,
  }
  return {
    root, repoDir, workspace, config, runId, payload,
    outputDir: path.join(repoDir, 'testcases_union', 'output', 'sweverified', runId),
    writeTrace() {
      const directory = path.join(repoDir, 'testcases_union', 'output', 'sweverified', runId,
        '.agent-insight', 'otel_data', 'mcts-xgovernor', 'key-hash')
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'runtime-ledger.json'), JSON.stringify({
        version: 1, runs: [{ sessionId: `mcts.run.${'b'.repeat(32)}` }],
      }))
    },
    close() {
      if (priorPath === undefined) delete process.env.PATH
      else process.env.PATH = priorPath
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('pi-mcts runs through the proxy without a local Pi CLI, applies the selected patch and links the root Trace', async () => {
  const f = fixture()
  try {
    assert.deepEqual(runtime.probeMctsBenchmarkRuntime(f.config), { ready: true })
    const caps = client.buildCapabilities({ ...f.config, maxParallelFi: 1 }, {
      probe: { ready: false, platforms: {} },
    })
    assert.ok(caps.platforms.some((item: { id: string }) => item.id === 'pi-mcts'))
    assert.deepEqual(caps.components['agent-runtime/pi-mcts/v1'], { ready: true })
    assert.ok(client.benchmarkAgentPlatformsFromCapabilities(caps).includes('pi-mcts'))
    const launches: { command: string; args: string[]; options: Record<string, unknown> }[] = []
    const runner = async (command: string, args: string[], options: Record<string, unknown>) => {
      if (command === process.execPath) {
        launches.push({ command, args, options })
        fs.mkdirSync(f.outputDir, { recursive: true })
        f.writeTrace()
        fs.writeFileSync(path.join(f.outputDir, 'artifact.patch'), [
          'diff --git a/hello.txt b/hello.txt',
          '--- a/hello.txt',
          '+++ b/hello.txt',
          '@@ -1 +1 @@',
          '-before',
          '+after',
          '',
        ].join('\n'))
        return { stdout: '', stderr: '' }
      }
      return runProcess(command, args, options)
    }
    const result = await runtime.runMctsBenchmarkCase(f.config, f.payload, runner)
    assert.equal(result.traceId, '6bdf5e0958c25ac591cfdb4b7aecca53')
    assert.match(result.traceId, /^[0-9a-f]{32}$/)
    assert.equal(fs.readFileSync(path.join(f.workspace, 'hello.txt'), 'utf8'), 'after\n')
    assert.deepEqual(launches[0].args, [
      f.config.mctsTraceLauncher, '--strict', '--config', path.join(path.dirname(f.config.mctsTraceLauncher), 'config.json'),
      '--', 'bash', path.join(f.repoDir, 'testcases_union', 'run_union.sh'),
      '--mode', 'sweverified', '--runtime', 'pi', '--testbench', 'sweverified',
      '--instance-id', 'example__project-1', '--split', 'test', '--output-dir', f.runId,
    ])
    assert.equal((launches[0].options.env as Record<string, string>).AGENT_INSIGHT_HOME,
      path.join(f.outputDir, '.agent-insight'))
    assert.ok((launches[0].options.env as Record<string, string>).PATH.startsWith(path.join(f.outputDir, '.agent-insight', 'bin')))
    assert.equal(fs.readlinkSync(path.join(f.outputDir, '.agent-insight', 'bin', 'python')),
      path.join(f.repoDir, '.venv', 'bin', 'python'))
    assert.equal(launches[0].options.abortSignal, 'SIGINT')
    assert.equal(launches[0].options.killProcessGroup, true)
  } finally { f.close() }
})

test('pi-mcts accepts a client configured Python outside the repository', async () => {
  const f = fixture()
  try {
    const customPython = path.join(f.root, 'python-env', 'bin', 'python3.11')
    fs.mkdirSync(path.dirname(customPython), { recursive: true })
    fs.copyFileSync(path.join(f.repoDir, '.venv', 'bin', 'python'), customPython)
    const config = { ...f.config, mctsPython: customPython }
    assert.deepEqual(runtime.probeMctsBenchmarkRuntime(config), { ready: true })
    let actualEnv: Record<string, string> | undefined
    await assert.rejects(runtime.runMctsBenchmarkCase(config, f.payload, async (_command: string, _args: string[], options: { env?: Record<string, string> }) => {
      actualEnv = options.env
      throw new Error('stop after launch')
    }))
    assert.ok(actualEnv?.PATH.startsWith(path.join(f.outputDir, '.agent-insight', 'bin')))
    assert.equal(fs.readlinkSync(path.join(f.outputDir, '.agent-insight', 'bin', 'python')), customPython)
    assert.equal(actualEnv?.MCTS_PYTHON, undefined)
  } finally { f.close() }
})

test('pi-mcts refuses stale output and mismatched task inputs', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      runtime.runMctsBenchmarkCase(f.config, { ...f.payload, benchmarkPayload: { ...f.payload.benchmarkPayload, instanceId: '../bad' } }),
      { code: 'MCTS_TASK_INVALID' },
    )
    fs.mkdirSync(f.outputDir, { recursive: true })
    await assert.rejects(runtime.runMctsBenchmarkCase(f.config, f.payload), { code: 'MCTS_OUTPUT_CONFLICT' })
  } finally { f.close() }
})

test('pi-mcts retains its root Trace ID when the run fails', async () => {
  const f = fixture()
  try {
    let traceId: string | undefined
    await assert.rejects(
      runtime.runMctsBenchmarkCase(f.config, f.payload, async () => {
        f.writeTrace()
        throw new Error('MCTS failed')
      }),
      (error: { runFacts?: { traceId?: string } }) => {
        traceId = error.runFacts?.traceId
        return true
      },
    )
    assert.equal(traceId, '6bdf5e0958c25ac591cfdb4b7aecca53')
  } finally { f.close() }
})

test('pi-mcts appears only as a ready Benchmark target', () => {
  const capabilities = parseCapabilities(JSON.stringify({
    actions: ['RUN_EXPERIMENT_CASE', 'RUN_BENCHMARK_CASE'],
    platforms: [{ id: 'pi-mcts', agents: ['pi-mcts'], models: [], actions: ['RUN_BENCHMARK_CASE'],
      runBenchmarkCase: { version: 1, returnsTraceId: true } }],
    components: { 'git-workspace/v1': { ready: true }, 'git-patch/v1': { ready: true },
      'agent-runtime/pi-mcts/v1': { ready: true } },
  }))
  assert.deepEqual(listTraceGenerationPlatforms(capabilities), [])
  const clientRow = {
    clientId: 'client-mcts', name: 'MCTS host', hostname: 'host', os: 'linux', arch: 'x64',
    status: 'online', serviceHealth: 'healthy', lastSeenAt: new Date(), unboundAt: null,
    capabilitiesJson: JSON.stringify(capabilities),
  }
  const manifest = { requiredCapabilities: ['git-workspace/v1', 'git-patch/v1'] }
  const targets = inspectBenchmarkExecutionTargets(clientRow as never, manifest as never)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].platform, 'pi-mcts')
  assert.equal(targets[0].ready, true)
})

test('process group cancellation sends SIGINT and lets child clean up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcts-cancel-'))
  const marker = path.join(root, 'cleaned')
  const script = path.join(root, 'child.cjs')
  fs.writeFileSync(script, `process.on('SIGINT', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(130) }); setInterval(() => {}, 100)`)
  const controller = new AbortController()
  try {
    const run = runProcess(process.execPath, [script], {
      signal: controller.signal, killProcessGroup: true, abortSignal: 'SIGINT', terminateGraceMs: 2_000,
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    controller.abort()
    await assert.rejects(run)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'yes')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
