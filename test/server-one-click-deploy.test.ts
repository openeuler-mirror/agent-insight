import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const server = require('../scripts/deploy-server.cjs')
const runtime = require('../scripts/local-runtime.cjs')
const packages = require('../scripts/clickhouse-server-packages.cjs')
const linux = (format: string) => packages.select({ platform: 'linux', machine: 'aarch64', osRelease: 'ID=ubuntu' }, format)
const mac = (format: string) => packages.select({ platform: 'darwin', machine: 'arm64' }, format)

function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-server-one-click-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test('macOS one-click shares managed storage with development and never calls the system installer', async t => {
  const home = fixture(t)
  const opts = server.options(['--apply', '--core-port', '14319', '--web-port', '13000', '--package-dir', '/offline'])
  const plan = server.deploymentPlan(home, {}, opts, mac)
  assert.equal(plan.mode, 'managed')
  assert.equal(plan.release.packages[0].name, 'clickhouse-macos-aarch64')
  assert.deepEqual(fs.readdirSync(home), [])
  const checked: number[] = []
  await server.prepareProject(home, {}, plan, opts, [], {
    assertFree: async (port: number) => checked.push(port),
    deployClickHouse: assert.fail,
    initializeCore: assert.fail,
    ensureStorage: async (_home: string, env: NodeJS.ProcessEnv) => {
      assert.equal(env.AGENT_INSIGHT_CLICKHOUSE_PACKAGE_DIR, '/offline')
      runtime.newConfiguration(home, env)
      return env
    },
  })
  assert.deepEqual(checked, [14319, 8123])
  const config = fs.readFileSync(plan.paths.configFile, 'utf8')
  const retry = server.deploymentPlan(home, {}, { action: '--apply' }, mac)
  assert.equal(retry.mode, 'managed')
  assert.equal(retry.corePort, 14319)
  assert.equal(retry.webPort, 13000)
  assert.equal(fs.readFileSync(plan.paths.configFile, 'utf8'), config)
  assert.throws(() => server.deploymentPlan(home, {}, { action: '--apply', corePort: 24319 }, mac), /显式变更/)
  assert.throws(() => server.deploymentPlan(home, {}, { action: '--apply', webPort: 14319 }, mac), /不同端口/)
  assert.equal(fs.existsSync(plan.paths.stateFile), false)
})

test('one-click plan uses target Linux packages and distinct ports without writing deployment state', t => {
  const home = fixture(t)
  const opts = server.options(['--plan', '--web-port', '13000', '--clickhouse-port', '18123'])
  const plan = server.deploymentPlan(home, {}, opts, linux)
  assert.equal(plan.backend, 'sqlite')
  assert.equal(plan.webPort, 13000)
  assert.equal(plan.release.format, 'deb')
  assert.equal(plan.release.packageArchitecture, 'arm64')
  assert.deepEqual(fs.readdirSync(home), [])
  assert.throws(() => server.deploymentPlan(home, {}, { ...opts, corePort: 18123 }, linux), /不同端口/)
  assert.throws(() => server.options(['--apply', '--web-port', '3000', '--web-port', '3001']), /用法/)
  assert.throws(() => server.options(['--apply', '--package-dir', '../assets']), /用法/)
})

test('legacy and development databases stop planning before ClickHouse can be selected', t => {
  const home = fixture(t)
  const opts = server.options(['--apply'])
  runtime.privateWrite(path.join(home, 'data/witty_insight.db'), 'old data')
  assert.throws(() => server.deploymentPlan(home, {}, opts, assert.fail), /旧业务库/)
  assert.equal(fs.readFileSync(path.join(home, 'data/witty_insight.db'), 'utf8'), 'old data')
  const dev = fixture(t)
  runtime.privateWrite(server.deploymentPaths(dev).database, 'existing Core')
  assert.throws(() => server.deploymentPlan(dev, {}, opts, assert.fail), /已有存储/)
})

test('retry reuses deployment identity and private Core configuration after a staged failure', async t => {
  const home = fixture(t)
  const opts = server.options(['--apply', '--format', 'tgz', '--core-port', '14319', '--web-port', '13000'])
  const steps: string[] = []
  const ids: string[] = []
  let interrupted = true
  const dependencies = {
    assertFree: async (port: number) => { assert.equal(port, 14319); steps.push('port') },
    python: () => '/python',
    deployClickHouse: async (_plan: unknown, _opts: unknown, state: { id: string }) => {
      ids.push(state.id)
      steps.push('clickhouse')
      return { endpoint: 'http://127.0.0.1:8123', database: 'agent_insight_core', user: 'agent_insight', password: 'a'.repeat(64) }
    },
    initializeCore: (file: string, python: string) => {
      const config = runtime.readPrivate(file)
      assert.equal(python, '/python')
      assert.equal(config.control.backend, 'sqlite')
      assert.equal(config.clickhouse.password, 'a'.repeat(64))
      if (interrupted) throw Error('interrupted before SQLite publication')
      steps.push('sqlite')
    },
    ensureStorage: async (_home: string, env: NodeJS.ProcessEnv) => {
      assert.equal(env.AGENT_INSIGHT_STORAGE_CORE_CONFIG, server.deploymentPaths(home).configFile)
      steps.push('core')
      return env
    },
  }
  const plan = server.deploymentPlan(home, {}, opts, linux)
  await assert.rejects(server.prepareProject(home, {}, plan, opts, [], dependencies), /interrupted/)
  const saved = fs.readFileSync(plan.paths.configFile, 'utf8')
  const key = fs.readFileSync(plan.paths.controller, 'utf8')
  assert.equal(fs.statSync(plan.paths.configFile).mode & 0o777, 0o600)
  assert.equal(fs.statSync(plan.paths.controller).mode & 0o777, 0o600)
  interrupted = false
  const retry = server.deploymentPlan(home, { AGENT_INSIGHT_PORT: '3000' }, server.options(['--apply']), linux)
  assert.equal(retry.webPort, 13000)
  assert.equal(retry.release.format, 'tgz')
  await server.prepareProject(home, {}, retry, opts, [], dependencies)
  assert.deepEqual(steps, ['port', 'clickhouse', 'port', 'clickhouse', 'sqlite', 'core'])
  assert.equal(ids[0], ids[1])
  assert.equal(fs.readFileSync(plan.paths.configFile, 'utf8'), saved)
  assert.equal(fs.readFileSync(plan.paths.controller, 'utf8'), key)
  assert.throws(() => server.deploymentPlan(home, {}, { ...opts, corePort: 24319 }, linux), /显式变更/)
})

test('explicit external Core configuration reuses the configured backend without sudo or SQLite creation', async t => {
  const home = fixture(t)
  const controller = path.join(home, 'deployment-controller')
  runtime.privateWrite(controller, 'c'.repeat(64))
  const file = path.join(home, 'external-core.json')
  runtime.privateWrite(file, { port: 14319, controller_key_file: controller, control: { backend: 'postgresql' } })
  const opts = server.options(['--apply', '--core-config', file])
  const plan = server.deploymentPlan(home, {}, opts, assert.fail)
  assert.equal(plan.backend, 'postgresql')
  await server.prepareProject(home, {}, plan, opts, [], {
    assertFree: async () => {},
    deployClickHouse: assert.fail,
    initializeCore: assert.fail,
    ensureStorage: async (_home: string, env: NodeJS.ProcessEnv) => {
      assert.equal(env.AGENT_INSIGHT_STORAGE_CORE_CONFIG, file)
      return env
    },
  })
  assert.equal(fs.existsSync(server.deploymentPaths(home).database), false)
})
