import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { nextImagePreparationRevision, retireImagePreparationWindows, sendImagePreparationWindow } from '../src/lib/benchmark/image-preparation'
import { sweBenchAdapter } from '../benchmarks/swe-bench/adapter'

const { BenchmarkImagePool, imagePoolConfig } = require('../services/evaluator/src/image-pool.cjs')
const { poolError, DockerImageStore, desktopSpace } = require('../services/evaluator/src/image-pool-docker.cjs')
const { describeImages } = require('../benchmarks/swe-bench/evaluator/images.cjs')

type Image = { id: string; size: number; arch: string; references: string[]; digests: string[] }
class FakeDocker {
  free = 2000
  images = new Map<string, Image>()
  containers = new Set<string>()
  pulls: string[] = []
  removed: string[] = []
  beforePull: (() => Promise<void>) | undefined
  async initialize() { return { daemonId: 'test-daemon', arch: 'x86_64' } }
  async freeSpace() { return this.free }
  async refresh() { return new Map([...this.images].map(([id, image]) => [id, { Size: image.size, SharedSize: 0 }])) }
  async inspect(ref: string) {
    return [...this.images.values()].find((item) => item.id === ref || item.references.includes(ref) || item.digests.includes(ref)) || null
  }
  async referenced(id: string) { return this.containers.has(id) }
  async pull(ref: string) {
    this.pulls.push(ref)
    await this.beforePull?.()
    return this.add(ref)
  }
  add(ref: string) {
    const id = `sha256:${createHash('sha256').update(ref).digest('hex')}`
    const repository = ref.split('@')[0].replace(/:[^/:]+$/, '')
    const image = { id, size: 100, arch: 'amd64', references: ref.includes('@') ? [] : [ref],
      digests: [ref.includes('@') ? ref : `${repository}@${id}`] }
    this.images.set(id, image)
    this.free -= image.size
    return image
  }
  async remove(ref: string) {
    const image = await this.inspect(ref)
    assert.ok(image)
    assert.equal(this.containers.has(image.id), false)
    this.removed.push(image.id)
    this.images.delete(image.id)
    this.free += image.size
  }
}

const spec = (name: string) => ({ key: name, arch: 'x86_64', references: [`registry.example.test/cases/${name}:v1`] })
const owner = (name: string, benchmarkKey = 'bench-a') => ({ benchmarkKey, experimentId: `exp-${name}`, runId: `run-${name}` })
const config = { enabled: true, prefetch: false, reserveRatio: .3, highWatermark: .9, maxPulls: 2, waitMs: 1000 }

async function fixture(t: TestContext, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-image-pool-'))
  const store = new FakeDocker()
  const logs: Record<string, unknown>[] = []
  const pool = new BenchmarkImagePool({ dataDir: directory, store, estimator: { estimate: async () => ({ bytes: 100, source: 'test' }) },
    config: { ...config, ...overrides }, lock: false, log: (event: Record<string, unknown>) => logs.push(event) })
  await pool.initialize()
  t.after(async () => { await pool.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { pool, store, directory, logs }
}

async function cache(pool: any, name: string) {
  const [image] = await pool.acquire(owner(name), [spec(name)])
  await pool.release(owner(name))
  return image
}

test('image pool defaults on without byte settings, can opt out, and validates remaining configuration', () => {
  assert.equal(imagePoolConfig({}).enabled, true)
  assert.equal(imagePoolConfig({ IMAGE_POOL_ENABLED: '' }).enabled, true)
  assert.equal(imagePoolConfig({ IMAGE_POOL_ENABLED: 'false' }).enabled, false)
  assert.throws(() => imagePoolConfig({ IMAGE_POOL_ENABLED: 'invalid' }))
  assert.throws(() => imagePoolConfig({ IMAGE_POOL_PREFETCH_ENABLED: 'true', IMAGE_POOL_MAX_PULLS: '1' }))
  assert.equal(imagePoolConfig({}).maxPulls, 2)
  assert.equal(imagePoolConfig({ IMAGE_POOL_ESTIMATE_BYTES: 'invalid', IMAGE_POOL_TEMPORARY_BYTES: 'invalid' }).estimateBytes, undefined)
})

test('different Benchmarks share one pull, budget and image protection but keep their own metadata', async (t) => {
  const { pool, store } = await fixture(t)
  const [a, b] = await Promise.all([
    pool.acquire(owner('a'), [{ ...spec('shared'), context: { consumer: 'a' } }]),
    pool.acquire(owner('b', 'bench-b'), [{ ...spec('shared'), key: 'other-case', context: { consumer: 'b' } }]),
  ])
  assert.equal(store.pulls.length, 1)
  assert.equal(a[0].imageId, b[0].imageId)
  assert.equal(b[0].consumer, 'b')
  assert.equal(b[0].key, 'other-case')
  assert.equal((await pool.budget()).occupied, 100)
  await pool.release(owner('a'))
  assert.equal(await pool.evictOne(true), false)
  await pool.release(owner('b', 'bench-b'))
  assert.equal(await pool.evictOne(true), true)
  assert.equal(store.removed.length, 1)
})

test('LRU deletes only the needed image and does not drain to a low watermark', async (t) => {
  const { pool, store } = await fixture(t)
  const first = await cache(pool, 'first')
  const second = await cache(pool, 'second')
  const third = await cache(pool, 'third')
  pool.state.images[first.imageId].lastUsedAt = 1
  pool.state.images[second.imageId].lastUsedAt = 2
  pool.state.images[third.imageId].lastUsedAt = 3
  store.free = 160
  await pool.acquire(owner('new'), [spec('new')])
  assert.deepEqual(store.removed, [first.imageId])
  assert.ok(await store.inspect(second.imageId))
  assert.ok(await store.inspect(third.imageId))
})

test('high watermark alone does not delete; external disk growth recovers just the safety gap', async (t) => {
  const { pool, store, logs } = await fixture(t)
  await cache(pool, 'one'); await cache(pool, 'two'); await cache(pool, 'three')
  store.free = 170
  await pool.maintain()
  assert.equal(store.removed.length, 0)
  assert.ok(logs.some((entry) => entry.event === 'high_watermark'))
  store.free = 50
  await pool.maintain()
  assert.equal(store.removed.length, 1)
  assert.equal((await pool.budget()).enough, true)
})

test('active images, external aliases and container references are never removed', async (t) => {
  const { pool, store } = await fixture(t)
  const [active] = await pool.acquire(owner('active'), [spec('active')])
  const external = await cache(pool, 'external')
  const container = await cache(pool, 'container')
  store.images.get(external.imageId)!.references.push('outside/example:keep')
  store.containers.add(container.imageId)
  await pool.evictOne(true)
  await pool.evictOne(true)
  assert.equal(await pool.evictOne(true), false)
  assert.equal(store.removed.length, 0)
  assert.ok(await store.inspect(active.imageId))
})

test('preexisting local images can be used but are not silently adopted for deletion', async (t) => {
  const { pool, store } = await fixture(t)
  pool.estimator = { estimate: async () => { throw new Error('cache hits must not query metadata') } }
  store.add(spec('external').references[0])
  await cache(pool, 'external')
  assert.equal(store.pulls.length, 0)
  assert.equal(await pool.evictOne(true), false)
  assert.equal((await pool.budget()).occupied, 0)
})

test('capacity reserve scales with actual free space without a fixed temporary-space floor', async (t) => {
  const { pool, store } = await fixture(t)
  store.free = 1000
  assert.equal((await pool.budget()).reserve, 300)
  store.free = 100
  assert.equal((await pool.budget()).reserve, 30)
  assert.equal((await pool.budget()).capacity, 70)
})

test('confirmed disk-full pull fails the request without changing source or poisoning the next case', async (t) => {
  const { pool, store } = await fixture(t)
  store.beforePull = async () => { throw poolError('IMAGE_POOL_SPACE_LOW', 'no space left on device', false) }
  await assert.rejects(pool.acquire(owner('disk-full'), [{ ...spec('disk-full'), references: ['mirror.example/case:v1', ...spec('disk-full').references] }]),
    { code: 'IMAGE_POOL_SPACE_LOW', retryable: false })
  assert.equal(store.pulls.length, 1)
  assert.deepEqual(pool.state.operations, {})
  assert.equal(pool.activePulls, 0)
  store.beforePull = undefined
  assert.equal((await pool.acquire(owner('next-case'), [spec('next-case')])).length, 1)
})

test('soft preparation protection is retractable; actual use protection is not', async (t) => {
  const { pool, store } = await fixture(t)
  const image = await cache(pool, 'future')
  pool.state.windows.future = { revision: 1, expiresAt: Date.now() + 60_000, specs: [spec('future')] }
  assert.equal(await pool.evictOne(false), false)
  assert.equal(await pool.evictOne(true), true)
  assert.deepEqual(store.removed, [image.imageId])
})

test('no deletion candidate produces bounded capacity error without starting a pull', async (t) => {
  const { pool, store } = await fixture(t, { waitMs: 25 })
  store.free = 60
  await assert.rejects(pool.acquire(owner('full'), [spec('full')]), { code: 'IMAGE_POOL_SPACE_LOW', retryable: false })
  await new Promise((resolve) => setTimeout(resolve, 110))
  assert.equal(store.pulls.length, 0)
  assert.deepEqual(pool.state.operations, {})
})

test('cancelling a waiter does not pretend that an in-flight Docker pull stopped', async (t) => {
  const { pool, store } = await fixture(t)
  let finish!: () => void
  let started!: () => void
  const pulling = new Promise<void>((resolve) => { started = resolve })
  store.beforePull = () => { started(); return new Promise<void>((resolve) => { finish = resolve }) }
  const controller = new AbortController()
  const requested = pool.acquire(owner('cancel'), [spec('cancel')], { signal: controller.signal })
  const rejected = assert.rejects(requested, { code: 'IMAGE_POOL_CANCELLED' })
  await pulling
  controller.abort()
  await rejected
  assert.equal(Object.keys(pool.state.operations).length, 1)
  finish()
  await Promise.all([...pool.inflight.values()])
  assert.equal(Object.keys(pool.state.operations).length, 0)
  assert.equal(Object.keys(Object.values(pool.state.images)[0] as object).includes('users'), true)
  assert.deepEqual((Object.values(pool.state.images)[0] as any).users, {})
})

test('a demand request can join and promote prefetch without deadlocking its priority gate', async (t) => {
  const { pool, store } = await fixture(t, { prefetch: true })
  await pool.updateWindow({ benchmarkKey: 'bench-a', experimentId: 'e' }, 1, [spec('join')])
  const images = await pool.acquire(owner('join'), [spec('join')])
  assert.equal(images.length, 1)
  assert.equal(store.pulls.length, 1)
})

test('windows ignore late updates and cancellation affects only its own experiment', async (t) => {
  const { pool } = await fixture(t, { prefetch: true })
  await cache(pool, 'shared')
  const a = { benchmarkKey: 'bench-a', experimentId: 'a' }
  const b = { benchmarkKey: 'bench-b', experimentId: 'b' }
  await pool.updateWindow(a, 1, [spec('shared')])
  await pool.updateWindow(b, 1, [spec('shared')])
  await pool.updateWindow(a, 3, [])
  assert.equal((await pool.updateWindow(a, 2, [spec('old')])).accepted, false)
  await Promise.all([...pool.inflight.values()])
  assert.equal(pool.protectedKeys().has(pool.key(spec('shared'))), true)
  await pool.updateWindow(b, 2, [])
  assert.equal(pool.protectedKeys().size, 0)
})

test('multi-image failure releases earlier acquisitions and never starts an incomplete case', async (t) => {
  const { pool, store } = await fixture(t)
  const one = await cache(pool, 'one')
  store.beforePull = async () => { throw poolError('IMAGE_POOL_PULL_FAILED', 'registry refused') }
  await assert.rejects(pool.acquire(owner('multi'), [spec('one'), spec('two')]))
  assert.deepEqual(pool.state.images[one.imageId].users, {})
})

test('unconfirmed Docker transport failure keeps its reservation and blocks new pulls', async (t) => {
  const { pool, store } = await fixture(t)
  store.beforePull = async () => { throw poolError('IMAGE_POOL_DOCKER_UNCERTAIN', 'connection lost') }
  await assert.rejects(pool.acquire(owner('first'), [spec('first')]))
  assert.equal((await pool.budget()).reserved, 100)
  await assert.rejects(pool.acquire(owner('second'), [spec('second')]), { code: 'IMAGE_POOL_RECOVERY_REQUIRED' })
  assert.equal(store.pulls.length, 1)
})

test('state survives Controller restart including users and uncertain deletion isolation', async (t) => {
  const { pool, store, directory } = await fixture(t)
  const [image] = await pool.acquire(owner('survivor'), [spec('survivor')])
  pool.state.images[image.imageId].deleting = true
  await pool.save()
  await pool.close()
  const recovered = new BenchmarkImagePool({ dataDir: directory, store, config, lock: false, log: () => {} })
  t.after(() => recovered.close())
  await recovered.initialize()
  assert.equal(Object.keys(recovered.state.images[image.imageId].users).length, 1)
  assert.equal(recovered.state.images[image.imageId].deleting, true)
  assert.equal(await recovered.evictOne(true), false)
})

test('frozen digest and moving-tag requests do not share a single-flight identity', async (t) => {
  const { pool } = await fixture(t)
  assert.notEqual(pool.key(spec('case')), pool.key({ ...spec('case'), references: [`registry.example.test/cases/case@sha256:${'a'.repeat(64)}`] }))
  await assert.rejects(pool.acquire(owner('local'), [{ ...spec('local'), references: [`sha256:${'b'.repeat(64)}`] }]), { code: 'IMAGE_POOL_FROZEN_UNAVAILABLE' })
})

test('an evicted frozen image is pulled by its digest, never by the old moving tag', async (t) => {
  const { pool, store } = await fixture(t)
  const frozen = await cache(pool, 'versioned')
  await pool.evictOne(true)
  const [image] = await pool.acquire(owner('retry'), [{ ...spec('versioned'), references: [frozen.pinnedImage] }])
  assert.equal(image.pinnedImage, frozen.pinnedImage)
  assert.deepEqual(store.pulls, [spec('versioned').references[0], frozen.pinnedImage])
})

test('definite registry errors fall back but architecture mismatch is rejected', async (t) => {
  const { pool, store } = await fixture(t)
  let count = 0
  store.beforePull = async () => { if (++count === 1) throw poolError('IMAGE_POOL_PULL_FAILED', 'mirror miss') }
  await pool.acquire(owner('fallback'), [{ ...spec('fallback'), references: ['mirror.example.test/case:v1', ...spec('fallback').references] }])
  assert.equal(store.pulls.length, 2)
  await assert.rejects(pool.acquire(owner('arch'), [{ ...spec('arch'), arch: 'arm64' }]), { code: 'IMAGE_POOL_SPEC_INVALID' })
})

test('SWE provider validates image scope before even a cache hit', () => {
  assert.throws(() => describeImages({ instance: { instance_id: 'pallets__flask-5014', image: 'untrusted.example/other:latest' } }, 'x86_64'))
  const result = describeImages({ instance: { instance_id: 'pallets__flask-5014', image: 'swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest' } }, 'x86_64')
  assert.equal(result.length, 1)
  assert.equal(result[0].arch, 'x86_64')
})

test('Docker adapter uses only non-force image removal, never broad prune', async () => {
  const calls: unknown[] = []
  const store = new DockerImageStore()
  store.request = async (...args: unknown[]) => { calls.push(args) }
  await store.remove('repository/image:v1')
  assert.deepEqual(calls, [['DELETE', '/images/repository%2Fimage%3Av1?force=false&noprune=true']])
})

test('acquisition racing an already-started eviction waits for deletion and prepares again', async (t) => {
  const { pool, store } = await fixture(t)
  await cache(pool, 'racing')
  let release!: () => void
  let began!: () => void
  const removing = new Promise<void>((resolve) => { began = resolve })
  const remove = store.remove.bind(store)
  store.remove = async (ref) => { began(); await new Promise<void>((resolve) => { release = resolve }); await remove(ref) }
  const deletion = pool.evictOne(true)
  await removing
  const acquiring = pool.acquire(owner('racing-now'), [spec('racing')])
  release()
  await deletion
  const [image] = await acquiring
  assert.ok(await store.inspect(image.imageId))
  assert.equal(Object.keys(pool.state.images[image.imageId].users).length, 1)
})

test('a cache hit under external disk pressure reclaims idle space before evaluation', async (t) => {
  const { pool, store } = await fixture(t)
  const needed = await cache(pool, 'needed')
  const idle = await cache(pool, 'idle')
  store.free = 50
  await pool.acquire(owner('needed-again'), [spec('needed')])
  assert.deepEqual(store.removed, [idle.imageId])
  assert.ok(await store.inspect(needed.imageId))
})

test('expired windows release soft protection and cannot be resurrected by stale revisions', async (t) => {
  const { pool } = await fixture(t, { prefetch: true })
  await cache(pool, 'expiring')
  const scope = { benchmarkKey: 'bench-a', experimentId: 'expired' }
  await pool.updateWindow(scope, 10, [spec('expiring')])
  await Promise.all([...pool.inflight.values()])
  pool.state.windows[JSON.stringify(['bench-a', 'expired'])].expiresAt = 0
  await pool.maintain()
  assert.equal(pool.protectedKeys().size, 0)
  assert.equal((await pool.updateWindow(scope, 9, [spec('old')])).accepted, false)
})

test('platform retires a cancelled experiment on its original target without clearing active windows', async () => {
  const previous = process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN
  process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN = 'fixture-token'
  const sent: Array<{ url: string; body: any }> = []
  const fetcher: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 202 })
  }
  try {
    await sendImagePreparationWindow({ benchmarkKey: 'fixture', evaluatorKey: 'fixture', experimentId: 'cancelled-window', revision: nextImagePreparationRevision(), cases: [{ image: 'allowed:tag' }] }, fetcher, 'http://original.example.test')
    await retireImagePreparationWindows(async () => true, fetcher)
    assert.equal(sent.length, 1)
    await retireImagePreparationWindows(async () => false, fetcher)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].url, sent[0].url)
    assert.deepEqual(sent[1].body.cases, [])
    assert.ok(sent[1].body.revision > sent[0].body.revision)
    await retireImagePreparationWindows(async () => false, fetcher)
    assert.equal(sent.length, 2)
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN
    else process.env.BENCHMARK_IMAGE_POOL_PREPARE_TOKEN = previous
  }
})

test('SWE preparation metadata excludes private patches, answers and test contracts', () => {
  const input = sweBenchAdapter.imagePreparationInput({ instanceId: 'case' } as any,
    { goldPatch: 'secret', evaluation: { image: 'allowed-image', test_patch: 'private tests' } } as any)
  assert.deepEqual(input, { instance: { instance_id: 'case', image: 'allowed-image' } })
})

test('Docker initialization rejects a mount pointing at the wrong filesystem', async () => {
  const store = new DockerImageStore({ diskPath: '/host-docker', controllerId: 'controller' })
  store.request = async (_method: string, endpoint: string) => endpoint === '/info'
    ? { ID: 'daemon', Architecture: 'x86_64', DockerRootDir: '/var/lib/docker' }
    : { Mounts: [{ Type: 'bind', Source: '/tmp', Destination: '/host-docker' }] }
  await assert.rejects(store.initialize(), { code: 'IMAGE_POOL_DISK_INVALID' })
})

test('Docker initialization rejects an unverified containerd image-store partition', async () => {
  const store = new DockerImageStore()
  store.request = async () => ({ ID: 'daemon', DockerRootDir: '/var/lib/docker', DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']] })
  await assert.rejects(store.initialize(), { code: 'IMAGE_POOL_DISK_UNSUPPORTED' })
})

function desktopFixture(containerd = true) {
  const info = { ID: 'desktop', DockerRootDir: '/var/lib/docker', Architecture: 'aarch64', OperatingSystem: 'Docker Desktop', OSType: 'linux',
    DriverStatus: containerd ? [['driver-type', 'io.containerd.snapshotter.v1']] : [] }
  const mounts = [
    { Type: 'bind', Source: '/var/lib/docker', Destination: '/host-docker', RW: false },
    { Type: 'bind', Source: '/var/lib/desktop-containerd', Destination: '/host-containerd', RW: false },
    { Type: 'bind', Source: '/Users/test/space-probe', Destination: '/host-mac-space', RW: false },
  ]
  const free: Record<string, number> = { '/host-docker': 2000, '/host-containerd': 1500, '/host-mac-space': 1000 }
  const accessed: string[] = []
  const calls: string[] = []
  const managers: any[] = []
  const store = new DockerImageStore({ diskMode: 'desktop-mac', diskPath: '/host-docker', hostDiskPath: '/host-mac-space',
    containerdPath: '/host-containerd', controllerId: 'controller', access: async (p: string) => { accessed.push(p) },
    readDesktopSpace: async (paths: string[]) => paths.map((p) => ({ path: p, free: free[p], files: 100, ffree: 50 })) })
  store.request = async (_method: string, endpoint: string) => {
    calls.push(endpoint)
    if (endpoint === '/info') return info
    if (endpoint === '/containers/controller/json') return { Id: 'controller', Mounts: mounts }
    if (endpoint.startsWith('/containers/json?')) return managers
    if (endpoint === '/system/df') return { Images: [] }
    throw new Error(endpoint)
  }
  return { store, info, mounts, free, accessed, calls, managers }
}

test('Desktop classic/containerd checks actual mounts and budgets against the tightest filesystem', async () => {
  for (const containerd of [true, false]) {
    const f = desktopFixture(containerd)
    assert.equal((await f.store.initialize()).arch, 'aarch64')
    assert.equal(await f.store.freeSpace(), 1000)
    f.free['/host-mac-space'] = 4000
    assert.equal(await f.store.freeSpace(), containerd ? 1500 : 2000)
    assert.equal(f.store.diskStatus.hostFreeBytes, 4000)
    assert.deepEqual(f.accessed, containerd ? ['/host-containerd/daemon/io.containerd.content.v1.content'] : [])
  }
})

test('Desktop rejects unknown daemons, missing/writable/wrong mounts and unknown containerd layouts', async () => {
  for (const mutate of [
    (f: ReturnType<typeof desktopFixture>) => { f.info.OperatingSystem = 'Colima' },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts[0].RW = true },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts[0].Source = '/tmp' },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts[1].Source = '/var/lib/docker' },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts[1].RW = true },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts.pop() },
    (f: ReturnType<typeof desktopFixture>) => { f.mounts[2].RW = true },
    (f: ReturnType<typeof desktopFixture>) => { f.store.diskPath = undefined },
    (f: ReturnType<typeof desktopFixture>) => { f.store.access = async () => { throw new Error('missing containerd data') } },
  ]) {
    const f = desktopFixture()
    mutate(f)
    await assert.rejects(f.store.initialize())
    assert.equal(f.calls.includes('/system/df'), false)
  }
})

test('Desktop read failures do not reuse previous free space and VM inode pressure blocks admission', async () => {
  const { store } = desktopFixture()
  await store.initialize()
  store.readDesktopSpace = async () => { throw new Error('host disk unavailable') }
  await assert.rejects(store.freeSpace(), { code: 'IMAGE_POOL_DISK_INVALID' })
  assert.equal(store.diskStatus.freeBytes, undefined)
  store.readDesktopSpace = async (paths: string[]) => paths.map((p) => ({ path: p, free: 1000, files: 100, ffree: 1 }))
  await assert.rejects(store.freeSpace(), { code: 'IMAGE_POOL_INODES_LOW' })
})

test('Desktop preflight can inspect storage without claiming a second manager; actual startup cannot', async () => {
  const f = desktopFixture()
  f.managers.push({ Id: 'existing-controller' })
  await assert.rejects(f.store.initialize(), { code: 'IMAGE_POOL_ALREADY_RUNNING' })
  f.store.checkManagers = false
  await f.store.initialize()
  assert.equal(f.store.diskStatus.freeBytes, 1000)
})

test('VirtioFS space probe uses fragment size, bounded execution, and rejects malformed statistics', async () => {
  const paths = ['/disk with spaces', '/host']
  const rows = paths.map((p) => ({ path: p, free: 1000, files: 100, ffree: 50 }))
  const execute = async (command: string, args: string[], options: any) => {
    assert.equal(command, 'python3')
    assert.match(args[1], /f_bavail\*s.f_frsize/)
    assert.doesNotMatch(args[1], /f_bsize/)
    assert.deepEqual(args.slice(2), paths)
    assert.equal(options.timeout, 5000)
    return { stdout: JSON.stringify(rows) }
  }
  assert.deepEqual(await desktopSpace(paths, execute), rows)
  for (const output of ['{}', '[]', 'invalid', JSON.stringify([{ ...rows[0], free: -1 }, rows[1]]),
    JSON.stringify([{ ...rows[0], path: '/wrong' }, rows[1]])]) {
    await assert.rejects(desktopSpace(paths, async () => ({ stdout: output })))
  }
})

test('low Mac host space blocks pulls even if the VM has plenty of free space', async (t) => {
  const { pool, store } = await fixture(t, { waitMs: 25 })
  const desktop = desktopFixture()
  await desktop.store.initialize()
  desktop.free['/host-mac-space'] = 60
  store.freeSpace = () => desktop.store.freeSpace()
  await assert.rejects(pool.acquire(owner('host-full'), [spec('host-full')]), { code: 'IMAGE_POOL_SPACE_LOW', retryable: false })
  await Promise.allSettled([...pool.inflight.values()])
  assert.equal(store.pulls.length, 0)
})

test('containerd estimates remain labelled and deletion cannot spend space not actually reclaimed', async (t) => {
  const { pool, store } = await fixture(t, { waitMs: 25 })
  ;(store as any).containerd = true
  const image = await cache(pool, 'containerd')
  await pool.maintain()
  assert.equal(pool.state.images[image.imageId].estimateQuality, 'containerd-logical-estimate')
  const remove = store.remove.bind(store)
  store.remove = async (ref) => { const before = store.free; await remove(ref); store.free = before }
  store.free = 60
  await assert.rejects(pool.acquire(owner('pending-gc'), [spec('pending-gc')]), { code: 'IMAGE_POOL_SPACE_LOW', retryable: false })
  await Promise.allSettled([...pool.inflight.values()])
  assert.deepEqual(store.removed, [image.imageId])
  assert.equal(store.pulls.length, 1)
})
