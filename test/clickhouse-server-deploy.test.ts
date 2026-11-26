import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { select, acquire, checkResponse } = require('../scripts/clickhouse-server-packages.cjs')
const deploy = require('../scripts/deploy-clickhouse.cjs')

function target(id: string, machine = 'aarch64') {
  return { platform: 'linux', machine, osRelease: 'ID=' + id + '\nVERSION_ID="22.04"\n' }
}

test('the target distro and architecture select the exact official package set', () => {
  for (const [id, machine, format, suffix] of [
    ['ubuntu', 'aarch64', 'deb', '_26.8.1.2041_arm64.deb'],
    ['debian', 'x86_64', 'deb', '_26.8.1.2041_amd64.deb'],
    ['rhel', 'aarch64', 'rpm', '-26.8.1.2041.aarch64.rpm'],
    ['rocky', 'x86_64', 'rpm', '-26.8.1.2041.x86_64.rpm'],
  ]) {
    const plan = select(target(id, machine))
    assert.equal(plan.format, format)
    assert.deepEqual(plan.packages.map((asset: { name: string }) => asset.name),
      ['clickhouse-common-static', 'clickhouse-server', 'clickhouse-client'].map(name => name + suffix))
    for (const asset of plan.packages) {
      assert.equal(new URL(asset.url).hostname, 'github.com')
      assert.ok(asset.id > 0 && asset.size > 0 && /^[0-9a-f]{64}$/.test(asset.sha256))
    }
  }
  for (const [machine, arch] of [['aarch64', 'arm64'], ['x86_64', 'amd64']]) {
    const plan = select(target('alpine', machine), 'tgz')
    assert.equal(plan.packages[0].name, 'clickhouse-common-static-26.8.1.2041-' + arch + '.tgz')
  }
  assert.throws(() => select({ ...target('ubuntu'), platform: 'win32' }), /不支持/)
  assert.throws(() => select(target('ubuntu'), 'rpm'), /不匹配/)
  assert.throws(() => select(target('ubuntu', 'riscv64')), /不支持/)
  assert.throws(() => select(target('alpine')), /--format tgz/)
})

test('macOS architectures and Linux without systemd choose official project-managed assets', () => {
  for (const [machine, name] of [['arm64', 'clickhouse-macos-aarch64'], ['x86_64', 'clickhouse-macos']]) {
    const plan = select({ platform: 'darwin', machine })
    assert.equal(plan.serviceManager, 'project')
    assert.equal(plan.packages[0].name, name)
    assert.ok(plan.packages[0].id && plan.packages[0].size && plan.packages[0].sha256.length === 64)
    assert.throws(() => select({ platform: 'darwin', machine }, 'deb'), /不匹配/)
  }
  const plan = select({ ...target('ubuntu'), systemd: false })
  assert.equal(plan.format, 'tgz')
  assert.equal(plan.serviceManager, 'project')
  assert.throws(() => select({ ...target('ubuntu'), systemd: false }, 'deb'), /systemd/)
  const { nativeMachine } = require('../scripts/clickhouse-server-packages.cjs')
  assert.equal(nativeMachine('darwin', 'x86_64', () => ({ status: 0, stdout: '1\n' })), 'aarch64')
  assert.equal(nativeMachine('darwin', 'x86_64', () => ({ status: 0, stdout: '0\n' })), 'x86_64')
  assert.equal(nativeMachine('linux', 'x86_64', assert.fail), 'x86_64')
})

test('safe content-range validation distinguishes complete replacement and resume', () => {
  assert.equal(checkResponse({ status: 206, range: 'bytes 3-5/6', count: 2, offset: 3, size: 6 }), 'append')
  assert.equal(checkResponse({ status: 206, range: 'bytes 2-5/6', count: 4, offset: 3, size: 6 }), '')
  assert.equal(checkResponse({ status: 206, range: 'bytes 3-5/7', count: 3, offset: 3, size: 6 }), '')
  assert.equal(checkResponse({ status: 200, range: '', count: 6, offset: 3, size: 6 }), 'replace')
  assert.equal(checkResponse({ status: 403, range: '', count: 6, offset: 0, size: 6 }), '')
})

test('Release Asset API resumes the same asset and verified cache needs no download', async t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-server-asset-'))
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }))
  const asset = { name: 'release.deb', size: 6, sha256: createHash('sha256').update('abcdef').digest('hex'),
    url: 'https://github.com/ClickHouse/ClickHouse/releases/download/tag/release.deb', id: 42 }
  const offsets: number[] = []
  const file = await acquire(asset, cache, undefined, (url: string, api: boolean, partial: string, _: string, offset: number) => {
    offsets.push(offset)
    if (api) {
      assert.match(url, /^https:\/\/api\.github\.com\/.*\/42$/)
      fs.appendFileSync(partial, 'def')
    } else fs.writeFileSync(partial, 'abc')
    return api ? 'HTTP 206' : 'curl 92'
  })
  assert.deepEqual(offsets, [0, 3])
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef')
  assert.equal(await acquire(asset, cache, undefined, assert.fail), file)
})

test('offline packages must match the approved digest', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-server-offline-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const cache = fs.mkdtempSync(path.join(workspace, 'cache-'))
  const asset = { name: 'release.rpm', size: 6, sha256: createHash('sha256').update('abcdef').digest('hex') }
  fs.writeFileSync(path.join(workspace, asset.name), 'ABCDEF')
  await assert.rejects(acquire(asset, cache, workspace, assert.fail), /SHA-256/)
  assert.deepEqual(fs.readdirSync(cache), [])
  fs.writeFileSync(path.join(workspace, asset.name), 'abcdef')
  assert.equal(fs.readFileSync(await acquire(asset, cache, workspace, assert.fail), 'utf8'), 'abcdef')
})

test('plan uses dedicated paths for TGZ and requires explicit apply for installation', () => {
  assert.throws(() => deploy.options([]), /--plan/)
  assert.throws(() => deploy.options(['--apply', '--package-dir', 'relative']), /--package-dir/)
  const opts = deploy.options(['--plan', '--format', 'tgz', '--port', '18123'])
  const plan = deploy.describe(select(target('ubuntu'), opts.format), opts)
  assert.equal(plan.service, 'agent-insight-clickhouse.service')
  assert.equal(plan.endpoint, 'http://127.0.0.1:18123')
  assert.equal(plan.dataDirectory, '/var/lib/agent-insight-clickhouse')
  assert.equal(plan.applyRequiresRoot, true)
})
