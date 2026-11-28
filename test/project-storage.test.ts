import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const storage = createRequire(import.meta.url)('../scripts/project-storage.cjs')
function fixture(t: test.TestContext, backend = 'sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = {
    control: backend === 'sqlite' ? { backend, database: path.join(dir, 'core.db') } : {
      backend, dsn: 'postgresql://test:p%40ss@127.0.0.1:5432/test', schema: 'insight_test', artifacts: path.join(dir, 'artifacts'),
    },
    clickhouse: { endpoint: 'http://127.0.0.1:8123', database: 'insight_test', user: 'test', password: '' },
    runtime: { home: path.join(dir, 'runtime'), corePort: 14319, webPort: 13000 },
  }
  const file = path.join(dir, 'storage.local.json')
  const save = () => fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  save()
  return { dir, file, config, save }
}

test('valid examples are shipped but placeholders are rejected before any runtime writes', t => {
  const { file, dir } = fixture(t)
  for (const backend of ['sqlite', 'postgresql']) {
    const sample = fs.readFileSync(`config/storage.${backend}.example.json`, 'utf8')
    assert.doesNotThrow(() => JSON.parse(sample))
    fs.writeFileSync(file, sample)
    assert.throws(() => storage.readConfig(file), /填写|占位符/)
  }
  assert.deepEqual(fs.readdirSync(dir), ['storage.local.json'])
})
test('SQLite config preserves the explicit file path and never creates it during validation', t => {
  const { file, config } = fixture(t)
  assert.equal(storage.readConfig(file).control.database, config.control.database)
  assert.equal(fs.existsSync(config.control.database!), false)
})
test('PostgreSQL config supports escaped credentials and bounded connection timeout', t => {
  const { file } = fixture(t, 'postgresql')
  const config = storage.readConfig(file)
  assert.match(config.control.dsn, /p%40ss/)
  assert.match(config.control.dsn, /connect_timeout=10/)
})
test('configuration must be private and cannot be a symlink', t => {
  const { file, dir } = fixture(t)
  fs.chmodSync(file, 0o644)
  assert.throws(() => storage.readConfig(file), /0600/)
  fs.chmodSync(file, 0o600)
  const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link)
  assert.throws(() => storage.readConfig(link), /0600/)
})
test('omitted password fails while explicitly empty password is allowed', t => {
  const { file, config, save } = fixture(t)
  assert.equal(storage.readConfig(file).clickhouse.password, '')
  delete (config.clickhouse as any).password; save()
  assert.throws(() => storage.readConfig(file), /password/)
})
test('unsafe endpoint credentials and unknown options never appear in diagnostics', t => {
  const { file, config, save } = fixture(t)
  config.clickhouse.endpoint = 'http://secret:do-not-print@localhost:8123'; save()
  assert.throws(() => storage.readConfig(file), error => !String(error).includes('do-not-print'))
  config.clickhouse.endpoint = 'http://127.0.0.1:8123'
  ;(config as any).autoDeploy = true; save()
  assert.throws(() => storage.readConfig(file), /未知/)
})
test('legacy historical databases prevent implicit installation without modifying them', t => {
  const { file, config } = fixture(t)
  const old = path.join(config.runtime.home, 'data/witty_insight.db')
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'history')
  assert.throws(() => storage.legacyGuard(storage.readConfig(file), {}), /旧业务数据库/)
  assert.equal(fs.readFileSync(old, 'utf8'), 'history')
})
test('configuration derivation reuses private generated secrets on repeat runs', t => {
  const { file, config } = fixture(t)
  const normalized = storage.readConfig(file)
  const a = storage.configurationFile(normalized, config.runtime.home)
  const b = storage.configurationFile(normalized, config.runtime.home)
  assert.equal(a.cfg.cursor_secret_hex, b.cfg.cursor_secret_hex)
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(a.cfg.controller_key_file).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(config.runtime.home, 'runtime/clickhouse')), false)
})
test('stop uses the configured runtime home and does not stop the database record', async t => {
  const { file, config } = fixture(t)
  const run = path.join(config.runtime.home, 'run')
  fs.mkdirSync(run, { recursive: true })
  const record = path.join(run, 'clickhouse.json'); fs.writeFileSync(record, 'untouched')
  await storage.main(['stop', '--config', file])
  assert.equal(fs.readFileSync(record, 'utf8'), 'untouched')
})
test('application deployment entry rejects old provisioning options', t => {
  const { file } = fixture(t)
  const result = spawnSync('bash', ['scripts/deploy_server.sh', '--apply', '--package-dir', '/offline', '--config', file], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /不支持/)
})

test('pool and Trace query options survive configuration derivation', t => {
  const { file, config, save } = fixture(t, 'postgresql')
  Object.assign(config.control, { connection_pool: { enabled: true, max_size: 8 } })
  Object.assign(config, { trace_list_optimization: { enabled: false } })
  save()
  const loaded = storage.readConfig(file)
  assert.deepEqual(loaded.control.connection_pool, { enabled: true, max_size: 8 })
  assert.deepEqual(loaded.trace_list_optimization, { enabled: false })
})

test('pool configuration does not silently enable unsupported backends', t => {
  const { file, config, save } = fixture(t)
  Object.assign(config.control, { connection_pool: { enabled: true } }); save()
  assert.throws(() => storage.readConfig(file), /PostgreSQL/)
})

test('Core request capacity defaults to 64 and warns only on invalid overrides', t => {
  const { file, config, save } = fixture(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const effectiveCapacity = () => storage.configurationFile(storage.readConfig(file), config.runtime.home).cfg.max_concurrent_requests;
  assert.equal(effectiveCapacity(), 64);
  for (const value of [1, 96, 256]) {
    Object.assign(config, { max_concurrent_requests: value });
    save();
    assert.equal(effectiveCapacity(), value);
  }
  assert.equal(warn.mock.callCount(), 0);
  for (const value of [0, -1, 257, true, '96', 1.5, null, [], {}]) {
    Object.assign(config, { max_concurrent_requests: value });
    save();
    warn.mock.resetCalls();
    assert.equal(effectiveCapacity(), 64);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /max_concurrent_requests.*64/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).max_concurrent_requests, value);
  }
});
