import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { useIsolatedHome } from './helpers/isolated-home'

const require = createRequire(import.meta.url)
const { installSharedModules } = require('../scripts/agent-trace-collectors/shared/install-modules.cjs')
const sharedSource = path.resolve('scripts/agent-trace-collectors/shared')
const oldTransport = fs.readFileSync('test/fixtures/collectors/trace-transport-pre-home.cjs')
const currentTransport = fs.readFileSync(path.join(sharedSource, 'trace-transport.cjs'))
const deployedTransport = fs.readFileSync('test/fixtures/collectors/trace-transport-pre-workbuddy.cjs')
const deployedInstaller = fs.readFileSync('test/fixtures/collectors/install-modules-pre-workbuddy.cjs')

test('deployed upgrade fixtures match verified release fingerprints', () => {
  assert.equal(createHash('sha256').update(deployedTransport).digest('hex'),
    '9fda3fa4224105a48a6619f764c7bee04c1bdc0df32a74d880a295a1e5f03da6')
  assert.equal(createHash('sha256').update(deployedInstaller).digest('hex'),
    '8d54ec546990463477e30c9a20773f2b3c0c9845ee768ea7d8180286b8326e22')
})

for (const framework of ['pi-agent', 'codex', 'goal-plus']) {
  test(`${framework}: upgrade deployed release and old installer together, then reinstall`, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deployed-collector-upgrade-')))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    useIsolatedHome(t, home)
    process.env.AGENT_INSIGHT_API_KEY = 'test-deployed-upgrade-key'
    const collectors = path.join(home, '.agent-insight', 'collectors')
    const target = path.join(collectors, 'shared')
    const packageDir = path.join(collectors, framework)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'trace-transport.cjs'), deployedTransport)
    fs.writeFileSync(path.join(target, 'install-modules.cjs'), deployedInstaller)
    const installer = require(`../scripts/agent-trace-collectors/${framework}/install.cjs`)
    const source = path.resolve('scripts/agent-trace-collectors', framework)
    const run = () => framework === 'pi-agent'
      ? installer.installFiles(source, packageDir, target)
      : framework === 'codex'
        ? installer.installCollectorFiles(source, packageDir)
        : installer.install({ homeDir: home, sourceDir: source, skipVersionCheck: true })
    await run()
    assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), currentTransport)
    assert.deepEqual(fs.readFileSync(path.join(target, 'install-modules.cjs')),
      fs.readFileSync(path.join(sharedSource, 'install-modules.cjs')))
    const backups = fs.readdirSync(target).filter(name => name.endsWith('.bak'))
    assert.equal(backups.length, 2)
    for (const [name, bytes] of [['trace-transport.cjs', deployedTransport], ['install-modules.cjs', deployedInstaller]] as const) {
      const backup = backups.find(file => file.startsWith(`${name}.`))!
      assert.deepEqual(fs.readFileSync(path.join(target, backup)), bytes)
      assert.equal(fs.statSync(path.join(target, backup)).mode & 0o777, 0o600)
    }
    await run()
    assert.equal(fs.readdirSync(target).filter(name => name.endsWith('.bak')).length, 2)
  })
}

for (const framework of ['pi-agent', 'codex', 'goal-plus']) {
  for (const conflict of [false, true]) {
    test(`${framework}: ${conflict ? 'reject unknown edits before package writes' : 'upgrade known old shared transport and reinstall'}`, async (t) => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-upgrade-')))
      t.after(() => fs.rmSync(home, { recursive: true, force: true }))
      useIsolatedHome(t, home)
      process.env.AGENT_INSIGHT_API_KEY = 'test-upgrade-key'
      const collectors = path.join(home, '.agent-insight', 'collectors')
      const target = path.join(collectors, 'shared')
      const packageDir = path.join(collectors, framework)
      fs.mkdirSync(target, { recursive: true })
      const original = conflict ? Buffer.from('customized transport') : oldTransport
      fs.writeFileSync(path.join(target, 'trace-transport.cjs'), original)
      const installer = require(`../scripts/agent-trace-collectors/${framework}/install.cjs`)
      const source = path.resolve('scripts/agent-trace-collectors', framework)
      const run = () => framework === 'pi-agent'
        ? installer.installFiles(source, packageDir, target)
        : framework === 'codex'
          ? installer.installCollectorFiles(source, packageDir)
          : installer.install({ homeDir: home, sourceDir: source, skipVersionCheck: true })
      if (conflict) {
        await assert.rejects(run(), /Refusing to overwrite/)
        assert.equal(fs.existsSync(packageDir), false)
        assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), original)
        assert.equal(fs.readdirSync(target).length, 1)
      } else {
        await run()
        assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), currentTransport)
        const backups = fs.readdirSync(target).filter(name => name.endsWith('.bak'))
        assert.equal(backups.length, 1)
        assert.deepEqual(fs.readFileSync(path.join(target, backups[0])), oldTransport)
        assert.equal(fs.statSync(path.join(target, backups[0])).mode & 0o777, 0o600)
        await run()
        assert.equal(fs.readdirSync(target).filter(name => name.endsWith('.bak')).length, 1)
      }
    })
  }
}

test('later dependency conflict leaves the known old transport untouched', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-preflight-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  fs.writeFileSync(path.join(target, 'trace-transport.cjs'), oldTransport)
  fs.writeFileSync(path.join(target, 'pi-trace-helpers.cjs'), 'customized helper')
  await assert.rejects(installSharedModules(sharedSource, target, ['trace-transport.cjs', 'pi-trace-helpers.cjs']), /Refusing to overwrite/)
  assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), oldTransport)
  assert.equal(fs.readdirSync(target).length, 2)
})

test('shared transport symlinks are not overwritten', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-symlink-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  fs.symlinkSync(path.join(sharedSource, 'trace-transport.cjs'), path.join(target, 'trace-transport.cjs'))
  await assert.rejects(installSharedModules(sharedSource, target, ['trace-transport.cjs']), /non-regular/)
})

test('unknown installer edits prevent upgrading the deployed transport', async t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-installer-conflict-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  fs.writeFileSync(path.join(target, 'trace-transport.cjs'), deployedTransport)
  fs.writeFileSync(path.join(target, 'install-modules.cjs'), 'customized installer')
  await assert.rejects(installSharedModules(sharedSource, target, ['trace-transport.cjs']), /Refusing to overwrite/)
  assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), deployedTransport)
  assert.equal(fs.readdirSync(target).length, 2)
})
