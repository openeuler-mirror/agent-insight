import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupTemporaryHomes, markTemporaryHome, TEMPORARY_HOME_OWNER_FILE } from '../src/lib/runtime-cleanup/temp'

const day = 86_400_000
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-cleanup-temp-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'user', 'isolated-home-test')
  await fs.mkdir(home, { recursive: true })
  return { root, home }
}
async function orphan(home: string, overrides: Record<string, unknown> = {}) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await once(child, 'exit')
  const createdAt = Date.now() - 2 * day
  await fs.writeFile(path.join(home, TEMPORARY_HOME_OWNER_FILE), JSON.stringify({
    version: 1, hostname: os.hostname(), ownerPid: pid, processGroupId: pid, createdAt, ...overrides,
  }))
  await fs.utimes(home, new Date(createdAt), new Date(createdAt))
}
async function collect(root: string) {
  const events = []
  for await (const event of cleanupTemporaryHomes({ root })) events.push(event)
  return events
}

test('reclaims old dead-owner homes incrementally without following symlinks', async t => {
  const { root, home } = await fixture(t)
  const outside = path.join(root, 'business-data')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'keep.txt'), 'business record')
  await fs.mkdir(path.join(home, 'nested'))
  await fs.writeFile(path.join(home, 'nested', 'cache.txt'), 'cache')
  await fs.symlink(outside, path.join(home, 'linked'))
  await orphan(home)
  const events = await collect(root)
  assert.ok(events.filter(e => e.kind === 'deleted').length >= 4)
  await assert.rejects(fs.stat(home), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'business record')
})

test('keeps active, unregistered, foreign-host and young homes', async t => {
  const { root, home } = await fixture(t)
  await markTemporaryHome(home)
  assert.equal(JSON.parse(await fs.readFile(path.join(home, TEMPORARY_HOME_OWNER_FILE), 'utf8')).ownerPid, process.pid)
  await orphan(home, { ownerPid: process.pid })
  await collect(root)
  await fs.stat(home)
  for (const overrides of [{ hostname: 'foreign-host' }, { processGroupId: null }, { createdAt: Date.now() }]) {
    await orphan(home, overrides)
    await collect(root)
    await fs.stat(home)
  }
  await fs.unlink(path.join(home, TEMPORARY_HOME_OWNER_FILE))
  await collect(root)
  await fs.stat(home)
})

test('keeps a dead-owner home while its child process group is still alive', async t => {
  const { root, home } = await fixture(t)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  t.after(async () => { child.kill(); await once(child, 'exit') })
  await orphan(home, { processGroupId: child.pid })
  await collect(root)
  await fs.stat(home)
})

test('stopping the scan early preserves the owner marker and allows continuation next run', async t => {
  const { root, home } = await fixture(t)
  for (let i = 0; i < 150; i++) await fs.writeFile(path.join(home, `cache-${i}`), 'x')
  await orphan(home)
  let count = 0
  for await (const event of cleanupTemporaryHomes({ root })) {
    if (event.kind === 'deleted' && ++count === 3) break
  }
  await fs.stat(path.join(home, TEMPORARY_HOME_OWNER_FILE))
  assert.ok((await fs.readdir(home)).length > 100)
  await collect(root)
  await assert.rejects(fs.stat(home), { code: 'ENOENT' })
})

test('does not follow a symlink runtime root or user directory', async t => {
  const { root, home } = await fixture(t)
  await orphan(home)
  const link = `${root}-link`
  await fs.symlink(root, link)
  t.after(() => fs.unlink(link))
  await collect(link)
  await fs.stat(home)
  await fs.symlink(path.dirname(home), path.join(root, 'linked-user'))
  await fs.unlink(path.join(home, TEMPORARY_HOME_OWNER_FILE))
  await collect(root)
  await fs.stat(home)
})

test('dry run leaves every candidate and marker intact', async t => {
  const { root, home } = await fixture(t)
  await fs.mkdir(path.join(home, 'nested'))
  await fs.writeFile(path.join(home, 'nested', 'cache'), 'keep')
  await orphan(home)
  const events = []
  for await (const event of cleanupTemporaryHomes({ root, dryRun: true })) events.push(event)
  assert.equal(events.filter(e => e.kind === 'deleted').length, 0)
  assert.ok(events.some(e => e.reason === 'dry-run'))
  assert.equal(await fs.readFile(path.join(home, 'nested', 'cache'), 'utf8'), 'keep')
  await fs.stat(path.join(home, TEMPORARY_HOME_OWNER_FILE))
})

test('marking a spawned child registers its process group for later checks', async t => {
  const { home } = await fixture(t)
  await markTemporaryHome(home, process.pid)
  assert.equal(JSON.parse(await fs.readFile(path.join(home, TEMPORARY_HOME_OWNER_FILE), 'utf8')).processGroupId, process.pid)
})

test('stops deletion when a new owner reclaims a previously orphaned home', async t => {
  const { root, home } = await fixture(t)
  await fs.writeFile(path.join(home, 'cache'), 'keep')
  await orphan(home)
  const scan = cleanupTemporaryHomes({ root })
  await scan.next()
  await scan.next()
  await scan.next()
  await markTemporaryHome(home, process.pid)
  for await (const event of scan) assert.notEqual(event.kind, 'deleted')
  assert.equal(await fs.readFile(path.join(home, 'cache'), 'utf8'), 'keep')
})

test('treats permission-denied process checks as alive', async t => {
  const { root, home } = await fixture(t)
  await orphan(home)
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  await collect(root)
  await fs.stat(home)
})
