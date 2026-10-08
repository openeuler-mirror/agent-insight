import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { useIsolatedHome } from './helpers/isolated-home'

const require = createRequire(import.meta.url)
const { installSharedModules } = require('../scripts/agent-trace-collectors/shared/install-modules.cjs')
const sharedSource = path.resolve('scripts/agent-trace-collectors/shared')
const oldTransport = fs.readFileSync('test/fixtures/collectors/trace-transport-pre-home.cjs')
const currentTransport = fs.readFileSync(path.join(sharedSource, 'trace-transport.cjs'))

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

test('September 7 released transport migrates without clearing collector data', async t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-sep07-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  const original = fs.readFileSync('test/fixtures/collectors/trace-transport-sep07.cjs')
  fs.writeFileSync(path.join(target, 'trace-transport.cjs'), original)
  fs.writeFileSync(path.join(target, 'pending.json'), '{"pending":true}')
  await installSharedModules(sharedSource, target, ['trace-transport.cjs'])
  assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), currentTransport)
  assert.equal(fs.readFileSync(path.join(target, 'pending.json'), 'utf8'), '{"pending":true}')
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'installation.json'), 'utf8'))
  assert.equal(manifest.sharedAbi, 1)
  assert.match(manifest.buildId, /^[a-f0-9]{64}$/)
  assert.ok(manifest.files['trace-transport.cjs'])
})

test('managed shared modules upgrade again from their receipt but reject edits and incompatible ABI', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-receipt-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const source = path.join(temporary, 'source'), target = path.join(temporary, 'target')
  fs.cpSync(sharedSource, source, { recursive: true })
  await installSharedModules(source, target, ['trace-transport.cjs'])
  fs.appendFileSync(path.join(source, 'trace-transport.cjs'), '\n// synthetic compatible release\n')
  await installSharedModules(source, target, ['trace-transport.cjs'])
  assert.deepEqual(fs.readFileSync(path.join(target, 'trace-transport.cjs')), fs.readFileSync(path.join(source, 'trace-transport.cjs')))
  fs.appendFileSync(path.join(target, 'trace-transport.cjs'), '// local edit\n')
  const before = fs.readFileSync(path.join(target, 'installation.json'))
  await assert.rejects(installSharedModules(source, target, ['trace-transport.cjs']), /Refusing to overwrite/)
  assert.deepEqual(fs.readFileSync(path.join(target, 'installation.json')), before)
  const receipt = JSON.parse(before.toString())
  receipt.sharedAbi = 2
  fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify(receipt))
  await assert.rejects(installSharedModules(source, target, ['trace-transport.cjs']), /Incompatible shared collector ABI/)
})

test('a partial shared upgrade does not certify edits to another managed module', async t => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-retained-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  await installSharedModules(sharedSource, target, ['trace-transport.cjs', 'pi-trace-helpers.cjs'])
  const manifest = fs.readFileSync(path.join(target, 'installation.json'))
  fs.appendFileSync(path.join(target, 'pi-trace-helpers.cjs'), '\n// local change\n')
  await assert.rejects(installSharedModules(sharedSource, target, ['trace-transport.cjs']), /Refusing to re-certify/)
  assert.deepEqual(fs.readFileSync(path.join(target, 'installation.json')), manifest)
})
