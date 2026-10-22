import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { GET } from '@/app/api/ingest/setup/bundle/route'

const repositoryRoot = path.resolve(__dirname, '..')
const clientFiles = [
  'scripts/agent-insight-home.cjs',
  'scripts/install-ras-client.js',
  'scripts/reliability-client.cjs',
  'scripts/xgovernor.cjs',
  'scripts/ordinary-experiment-state.cjs',
  'scripts/skill-experiment-workspace.cjs',
  'scripts/agent-run-diagnostics.cjs',
  'scripts/opencode-experiment-events.cjs',
  'scripts/opencode-experiment-events.mjs',
  'scripts/ws-client.cjs',
  'scripts/install-fault-injection.js',
  'scripts/lib/fi-python-runtime.js',
  'scripts/fi-worker.js',
  'packages/project-config/index.cjs',
  'packages/project-config/yaml.cjs',
  'packages/benchmark-protocol/execution.cjs',
  'scripts/agent-trace-collectors/shared/trace-transport.cjs',
  'config/benchmark/executor.yaml',
  'services/executor/src/index.cjs',
  'services/executor/src/runtime-options.cjs',
  'services/executor/src/execution-backend.cjs',
  'services/executor/src/execution-config.cjs',
  'services/executor/src/execution-images.cjs',
  'services/executor/src/execution-workspace.cjs',
  'services/executor/src/xgovernor/backend.cjs',
  'services/executor/src/xgovernor/dependency-manager.cjs',
  'services/executor/src/xgovernor/installation.cjs',
  'services/executor/src/xgovernor/artifact-identity.cjs',
  'services/executor/src/xgovernor/client.cjs',
  'services/executor/src/xgovernor/command-diagnostics.cjs',
  'services/executor/src/xgovernor/trace.cjs',
  'services/executor/src/xgovernor/capture-worker.cjs',
  'packages/agent-runtime/index.cjs',
  'packages/agent-runtime/loader.cjs',
  'services/executor/runtimes/mcts/runtime.yaml',
  'services/executor/runtimes/opencode/runtime.yaml',
  'services/executor/src/mcts-config.cjs',
  'services/executor/src/mcts-runtime.cjs',
  'services/executor/src/git-source.cjs',
  'services/executor/src/git-source-workspace.cjs',
  'services/executor/src/source-policy-registry.cjs',
  'services/executor/src/benchmarks/swe-bench.cjs',
  'services/executor/src/benchmarks/swe-bench-images.cjs',
  'generated/benchmark-catalog/executors.cjs',
  'benchmarks/swe-bench/executor/git-source-policy.cjs',
  'agent_ras/platform_adapter/opencode/config_sync.js',
  'agent_fault_injection/pyproject.toml',
]

function usePackageRoot(t: TestContext, root: string) {
  const previousRoot = process.env.AGENT_INSIGHT_PACKAGE_ROOT
  const previousUser = process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
  process.env.AGENT_INSIGHT_PACKAGE_ROOT = root
  process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = 'setup-bundle-test'
  t.after(() => {
    if (previousRoot === undefined) delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
    else process.env.AGENT_INSIGHT_PACKAGE_ROOT = previousRoot
    if (previousUser === undefined) delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
    else process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER = previousUser
  })
}

test('standalone cwd still serves complete client and RAS archives from the package root', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-'))
  const previousCwd = process.cwd()
  const standalone = path.join(temporary, '.next', 'standalone')
  fs.mkdirSync(standalone, { recursive: true })
  usePackageRoot(t, repositoryRoot)
  process.chdir(standalone)
  t.after(() => {
    process.chdir(previousCwd)
    fs.rmSync(temporary, { recursive: true, force: true })
  })

  for (const [name, required] of [
    ['client', clientFiles],
    ['ras', [
      'scripts/agent-insight-home.cjs',
      'scripts/install-ras.js',
      'scripts/xiaoo-trace-collector/install.js',
      'scripts/xiaoo-trace-collector/manifest.js',
      'scripts/xiaoo-trace-collector/otel_spans.py',
      'agent_ras/platform_adapter/opencode/plugin.js',
    ]],
  ] as const) {
    const response = await GET(new Request(`http://localhost/api/ingest/setup/bundle?name=${name}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const archive = Buffer.from(await response.arrayBuffer())
    const listing = spawnSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' })
    assert.equal(listing.status, 0, listing.stderr)
    const entries = new Set(listing.stdout.split('\n'))
    for (const file of required) {
      assert.ok(entries.has(file), `${name} bundle must contain ${file}`)
      const extracted = spawnSync('tar', ['-xzOf', '-', file], { input: archive })
      assert.equal(extracted.status, 0, extracted.stderr.toString())
      assert.deepEqual(extracted.stdout, fs.readFileSync(path.join(repositoryRoot, file)))
    }
  }
})

test('incomplete client bundle returns missing entries instead of a partial archive', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-missing-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  usePackageRoot(t, temporary)
  for (const file of clientFiles.filter((file) => !file.startsWith('services/executor/src/'))) {
    const target = path.join(temporary, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'fixture')
  }
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=client'))
  assert.equal(response.status, 503)
  assert.deepEqual((await response.json()).missing, ['services/executor/src'])
})

test('installed executor loads package policies after the installation source moves away', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-executor-policy-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  usePackageRoot(t, repositoryRoot)
  const source = path.join(temporary, 'source')
  const home = path.join(temporary, 'home')
  fs.mkdirSync(source)
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=client'))
  assert.equal(response.status, 200)
  const archive = Buffer.from(await response.arrayBuffer())
  const extraction = spawnSync('tar', ['-xzf', '-', '-C', source], { input: archive })
  assert.equal(extraction.status, 0, extraction.stderr.toString())
  const installed = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(source, 'scripts/install-ras-client.js'))}).installRuntime()`], {
    env: { ...process.env, AGENT_INSIGHT_HOME: home }, encoding: 'utf8',
  })
  assert.equal(installed.status, 0, installed.stderr)
  fs.renameSync(source, path.join(temporary, 'moved-source'))
  const executorDir = path.join(home, 'client', 'runtime', 'executor')
  const loaded = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict')
    const path = require('node:path')
    const dir = ${JSON.stringify(executorDir)}
    const { createBenchmarkExecutor } = require(path.join(dir, 'index.cjs'))
    const executor = createBenchmarkExecutor({
      clientId: 'fixture', deviceCredential: 'fixture', insightBaseUrl: 'http://localhost',
      baseDir: ${JSON.stringify(path.join(home, 'client'))}, agentInsightHome: ${JSON.stringify(home)},
      runAgent: async () => { throw new Error('Agent must not execute') },
    })
    const policies = executor.runner.workspaceProviders.get('git').sourcePolicies
    assert.deepEqual([...policies.keys()], ['swe-bench'])
    assert.equal(policies.get('swe-bench').home, ${JSON.stringify(home)})
    const legacy = require(path.join(dir, 'benchmarks/swe-bench.cjs'))
    assert.equal(new legacy.SweBenchGitSourcePolicy({ home: ${JSON.stringify(home)}, env: { SWE_BENCH_GIT_SOURCE: '' } })
      .resolve({ repository: 'https://github.com/pallets/flask.git' }).remotes[0].name, 'gitee')
    executor.close()
  `], { encoding: 'utf8' })
  assert.equal(loaded.status, 0, loaded.stderr)
})

test('an existing RAS installer alone cannot produce a successful RAS bundle', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-bundle-ras-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  usePackageRoot(t, temporary)
  fs.mkdirSync(path.join(temporary, 'scripts'))
  fs.writeFileSync(path.join(temporary, 'scripts/install-ras.js'), 'fixture')
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=ras'))
  assert.equal(response.status, 503)
  assert.deepEqual(
    (await response.json()).missing,
    ['scripts/agent-insight-home.cjs', 'scripts/xiaoo-trace-collector', 'agent_ras'],
  )
})

test('bundle whitelist and authentication still apply with a configured package root', async (t) => {
  usePackageRoot(t, repositoryRoot)
  for (const name of ['../scripts', '__proto__', 'constructor']) {
    const response = await GET(new Request(`http://localhost/api/ingest/setup/bundle?name=${name}`))
    assert.equal(response.status, 400)
  }
  delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER
  const response = await GET(new Request('http://localhost/api/ingest/setup/bundle?name=client'))
  assert.equal(response.status, 401)
})
