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
