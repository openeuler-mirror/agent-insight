import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import test from 'node:test'

const r = createRequire(import.meta.url)('../scripts/local-runtime.cjs')
function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-runtime-'))
  t.after(async () => {
    for (const name of ['web', 'core', 'clickhouse']) await r.stop(home, name)
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('new managed configuration is private and reused without rotating credentials', t => {
  const home = fixture(t)
  const file = r.newConfiguration(home, {})
  const before = fs.readFileSync(file, 'utf8')
  const config = r.readPrivate(file)
  assert.equal(config.control.backend, 'sqlite')
  assert.equal(fs.statSync(config.controller_key_file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(r.newConfiguration(home, {}), file)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(fs.existsSync(config.control.database), false)
  assert.equal(fs.existsSync(file + '.initializing'), true)
  const xml = fs.readFileSync(path.join(home, 'storage/clickhouse/config.xml'), 'utf8')
  assert.doesNotMatch(xml, new RegExp(config.clickhouse.password))
  assert.match(xml, /127\.0\.0\.1/)
})

test('legacy databases block implicit empty environment creation', t => {
  const home = fixture(t)
  fs.mkdirSync(path.join(home, 'data'))
  const source = path.join(home, 'data/witty_insight.db')
  fs.writeFileSync(source, 'historical rows')
  assert.throws(() => r.newConfiguration(home, {}), /旧业务数据库/)
  assert.equal(fs.readFileSync(source, 'utf8'), 'historical rows')
  assert.equal(fs.existsSync(path.join(home, 'storage')), false)
})

test('existing database without configuration and old relational DSNs are never reset', t => {
  const home = fixture(t)
  assert.throws(() => r.newConfiguration(home, { DATABASE_URL: 'postgresql://private' }), /旧数据库/)
  fs.mkdirSync(path.join(home, 'storage/core'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storage/core/core.db'), 'keep')
  assert.throws(() => r.newConfiguration(home, {}), /无配置/)
})

test('configured external Core does not provision a local database', t => {
  const home = fixture(t)
  assert.equal(r.configured(home, { AGENT_INSIGHT_STORAGE_CORE_URL: 'http://127.0.0.1:4444' }), null)
  assert.equal(fs.existsSync(path.join(home, 'storage')), false)
})

test('production start checks a deployed Core and performs no implicit provisioning', async t => {
  const home = fixture(t)
  await assert.rejects(r.productionStorage(home, {}, assert.fail), /已部署并运行/)
  assert.deepEqual(fs.readdirSync(home), [])
  const configured = { AGENT_INSIGHT_STORAGE_CORE_URL: 'http://127.0.0.1:4319' }
  assert.equal(await r.productionStorage(home, configured, async (env: NodeJS.ProcessEnv) => {
    assert.deepEqual(env, configured)
  }), configured)
  assert.deepEqual(fs.readdirSync(home), [])
})

test('private configuration rejects symlinks and world-readable files', t => {
  const home = fixture(t)
  const file = path.join(home, 'config.json')
  fs.writeFileSync(file, '{}', { mode: 0o644 })
  assert.throws(() => r.readPrivate(file), /0600/)
  fs.chmodSync(file, 0o600)
  fs.symlinkSync(file, path.join(home, 'link.json'))
  assert.throws(() => r.readPrivate(path.join(home, 'link.json')), /0600/)
})

test('startup lock rejects concurrent execution and releases for the next invocation', async t => {
  const home = fixture(t)
  const release = await r.lock(home)
  try { await assert.rejects(r.lock(home), /正在执行/) } finally { release() }
  const again = await r.lock(home)
  again()
})

test('unrelated listeners are refused and remain running', async t => {
  const home = fixture(t)
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const p = (server.address() as net.AddressInfo).port
    await assert.rejects(r.assertFree(p), /已占用/)
    await r.stop(home, 'web')
    assert.equal(server.listening, true)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('managed service is stopped by verified identity; stale PID never kills caller', async t => {
  const home = fixture(t)
  const service = path.join(home, 'fixture.cjs')
  const stopped = path.join(home, 'stopped')
  fs.writeFileSync(service, `require('fs').writeFileSync(${JSON.stringify(path.join(home, 'ready'))}, '1'); process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(stopped)}, '1');process.exit(0)});setInterval(()=>{},1000)`)
  const value = await r.launch(home, 'web', process.execPath, [service], process.env)
  for (let n = 0; n < 100 && !fs.existsSync(path.join(home, 'ready')); n++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(r.alive(value), true)
  await r.stop(home, 'web')
  assert.equal(fs.readFileSync(stopped, 'utf8'), '1')
  assert.equal(r.alive(value), false)
  r.privateWrite(path.join(home, 'run/web.json'), { home, root: r.ROOT, pid: process.pid, identity: 'old process' })
  await r.stop(home, 'web')
  assert.ok(r.identity(process.pid))
})

test('different Core origin or controller cannot silently attach to managed data', t => {
  const home = fixture(t)
  const config = r.readPrivate(r.newConfiguration(home, {}))
  assert.throws(() => r.coreEnvironment(config, { AGENT_INSIGHT_STORAGE_CORE_URL: 'http://127.0.0.1:9999' }), /不一致/)
  assert.throws(() => r.coreEnvironment(config, { AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE: '/different/key' }), /不一致/)
})


test('legacy mode is rejected before provisioning or downloading', async t => {
  const home = fixture(t)
  await assert.rejects(r.ensureStorage(home, { AGENT_INSIGHT_TRACE_STORAGE: 'sqlite' }, []), /Legacy storage/)
  assert.equal(fs.existsSync(path.join(home, 'storage')), false)
})

test('invalid private JSON does not echo credentials in error messages', t => {
  const home = fixture(t)
  const file = path.join(home, 'private.json')
  fs.writeFileSync(file, '{"password":"never-log-this", invalid}', { mode: 0o600 })
  assert.throws(() => r.readPrivate(file), error => error instanceof Error && !error.message.includes('never-log-this') && error.message.includes('JSON'))
})

test('cached binary is rechecked against its receipt before execution', async t => {
  const home = fixture(t)
  const installer = createRequire(import.meta.url)('../scripts/local-runtime-install.cjs')
  const entry = createRequire(import.meta.url)('../scripts/clickhouse-server-packages.cjs').target('auto', { portable: true }).packages[0]
  assert.ok(entry)
  const dir = path.join(home, 'runtime/clickhouse-26.8.1.2041')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'clickhouse'), 'tampered')
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ packageHash: entry.sha256, binaryHash: 'incorrect' }))
  await assert.rejects(installer.clickhouse(home, {}), /校验失败/)
})

test('verified native package may expand on first execution and remains reusable', async t => {
  const home = fixture(t)
  const installer = createRequire(import.meta.url)('../scripts/local-runtime-install.cjs')
  const dir = path.join(home, 'runtime/clickhouse-26.8.1.2041')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'fixture-native.download')
  fs.writeFileSync(file, `#!${process.execPath}\nrequire('fs').writeFileSync(process.argv[1], 'expanded binary');\n`)
  const asset = { name: 'fixture-native', size: fs.statSync(file).size, sha256: await installer.digest(file) }
  const dependencies = {
    target: () => ({ version: '26.8.1.2041', platform: process.platform, machine: 'fixture', packages: [asset] }),
    acquire: async () => file,
  }
  {
    const binary = await installer.clickhouse(home, {}, dependencies)
    assert.equal(fs.readFileSync(binary, 'utf8'), 'expanded binary')
    assert.equal(await installer.clickhouse(home, {}, dependencies), binary)
    await assert.rejects(installer.clickhouse(home, {}, { ...dependencies,
      target: () => ({ ...dependencies.target(), machine: 'other' }) }), /运行平台/)
  }
})


test('pinned Web dependency mismatch is detected before services start', t => {
  const home = fixture(t)
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ dependencies: { next: '16.4.6' } }))
  fs.mkdirSync(path.join(home, 'node_modules/next'), { recursive: true })
  fs.writeFileSync(path.join(home, 'node_modules/next/package.json'), '{"version":"16.4.3"}')
  assert.throws(() => r.checkWebDependencies(home), /安装版本.*不一致/)
  fs.writeFileSync(path.join(home, 'node_modules/next/package.json'), '{"version":"16.4.6"}')
  assert.doesNotThrow(() => r.checkWebDependencies(home))
})
